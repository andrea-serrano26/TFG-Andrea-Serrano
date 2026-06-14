#!/usr/bin/env python3
"""
generate_masks_csanet25d.py  —  Máscaras de test para CSA-Net 2.5D Multi-plano
================================================================================

Carga los 5 modelos entrenados (CSA-Net 2.5D) desde
kits_25d_multiplane/checkpoints/fold_{0-4}_best.pth y genera la predicción
de ensemble para cada caso del test set (kidney_001-015) de la carpeta labelsTs de nnUNet

PIPELINE DE INFERENCIA (idéntico al de entrenamiento)
------------------------------------------------------
1. Preprocesamiento:
     · Resampleo a TARGET_SPACING = (1.0, 1.0, 1.0) mm
     · Clip HU [-64, 273] + z-score foreground
2. Inferencia multi-plano con sliding window gaussiano:
     · Plano axial   (z-1, z, z+1) → probabilidades [C, Z, H, W]
     · Plano sagital (x-1, x, x+1) → probabilidades [C, Z, H, W]
     · Plano coronal (y-1, y, y+1) → probabilidades [C, Z, H, W]
     · Fusión: P = (w_ax·P_ax + w_sag·P_sag + w_cor·P_cor) / Σw
3. TTA (Test-Time Augmentation):
     · Original + flip-H + flip-W → promedio de 3
4. Ensemble de 5 folds:
     · Promedio de probabilidades de los 5 modelos -> argmax
5. Resampleo de vuelta al espacio original (nearest-neighbor, order=0)
6. Guardado con el affine/header de la imagen original

Salida:
  kits_25d_multiplane/masks_test/
    kidney_063_pred.nii.gz <- predicción en espacio original
    kidney_063_gt.nii.gz <- GT en espacio original
    ...

Uso:
  python generate_masks_csanet25d.py
  python generate_masks_csanet25d.py --data_dir ./data_cropped \\
                                      --ckpt_dir ./kits_25d_multiplane/checkpoints \\
                                      --output_dir ./kits_25d_multiplane/masks_test
  python generate_masks_csanet25d.py --no_tta   # más rápido, sin TTA
"""

import os
import json
import argparse
import warnings
warnings.filterwarnings("ignore")

import numpy as np
import nibabel as nib
import pandas as pd
import torch
import torch.nn as nn
import torch.nn.functional as F
from glob import glob
from scipy import ndimage

# =============================================================================
# PARÁMETROS — IDÉNTICOS AL ENTRENAMIENTO
# =============================================================================

DATA_DIR_TS = os.path.expanduser("~/nnUNet_raw/Dataset002_Kidney/imagesTs")
LABEL_DIR_TS = os.path.expanduser("~/nnUNet_raw/Dataset002_Kidney/labelsTs")
CKPT_DIR    = "./kits_25d_multiplane/checkpoints"
OUTPUT_DIR  = "./kits_25d_multiplane/masks_test"


# Preprocesamiento (idéntico al script de entrenamiento)
TARGET_SPACING = (1.0, 1.0, 1.0)           # original_median_spacing_after_transp
HU_CLIP_MIN    = -64.35255432128906        # foreground percentile_00_5
HU_CLIP_MAX    = 273.7598571777344         # foreground percentile_99_5
NORM_MEAN      = 120.24785614013672        # foreground mean
NORM_STD       = 65.7291259765625          # foreground std

# Arquitectura CSA-Net 2.5D (idéntica al entrenamiento)
PATCH_SIZE_2D  = (256, 256)
N_CLASSES      = 3
INIT_FEATURES  = 32
MAX_FEATURES   = 256
N_LEVELS       = 4
N_HEADS        = 8

# Pesos de fusión multi-plano (se sobreescriben con los del checkpoint)
PLANE_WEIGHTS_INFER = (1.0, 1.0, 1.0)  # axial, sagital, coronal

SW_OVERLAP = 0.5
USE_TTA    = True

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")

os.makedirs(OUTPUT_DIR, exist_ok=True)


# =============================================================================
# ARQUITECTURA CSA-NET 2.5D — COPIA EXACTA DEL ENTRENAMIENTO
# =============================================================================

class ConvNormAct2D(nn.Module):
    def __init__(self, in_ch, out_ch, kernel=3, stride=1):
        super().__init__()
        self.conv = nn.Conv2d(in_ch, out_ch, kernel, stride=stride,
                              padding=kernel // 2, bias=False)
        self.norm = nn.InstanceNorm2d(out_ch, affine=True)
        self.act  = nn.ReLU(inplace=True)

    def forward(self, x):
        return self.act(self.norm(self.conv(x)))


class ResBlock2D(nn.Module):
    def __init__(self, in_ch, out_ch, stride=1):
        super().__init__()
        self.c1   = nn.Conv2d(in_ch, out_ch, 3, stride=stride, padding=1, bias=False)
        self.n1   = nn.InstanceNorm2d(out_ch, affine=True)
        self.act1 = nn.ReLU(inplace=True)
        self.c2   = nn.Conv2d(out_ch, out_ch, 3, stride=1, padding=1, bias=False)
        self.n2   = nn.InstanceNorm2d(out_ch, affine=True)
        self.act2 = nn.ReLU(inplace=True)
        self.skip = (
            nn.Sequential(
                nn.Conv2d(in_ch, out_ch, 1, stride=stride, bias=False),
                nn.InstanceNorm2d(out_ch, affine=True)
            ) if (in_ch != out_ch or stride != 1) else nn.Identity()
        )

    def forward(self, x):
        r = self.skip(x)
        x = self.act1(self.n1(self.c1(x)))
        x = self.n2(self.c2(x))
        return self.act2(x + r)


class CrossSliceAttention(nn.Module):
    """CSA — Ecuación 1 de Kumar et al., 2024."""
    def __init__(self, C, n_heads=N_HEADS):
        super().__init__()
        assert C % (2 * n_heads) == 0
        self.n_heads  = n_heads
        self.head_dim = C // (2 * n_heads)
        self.scale = self.head_dim ** -0.5
        self.W_phi = nn.Conv2d(C, C // 2, 1, bias=False)
        self.W_psi = nn.Conv2d(C, C // 2, 1, bias=False)
        self.W_theta = nn.Conv2d(C, C // 2, 1, bias=False)
        self.W_g = nn.Conv2d(C // 2, C, 1, bias=False)
        self.norm = nn.InstanceNorm2d(C, affine=True)

    def forward(self, fc, fn):
        B, C, H, W = fc.shape
        N  = H * W; d = self.head_dim; nh = self.n_heads
        key = self.W_phi(fc).reshape(B, nh, d, N)
        val = self.W_psi(fc).reshape(B, nh, d, N)
        qry = self.W_theta(fn).reshape(B, nh, d, N)
        attn = torch.einsum('bndi,bndj->bnij', qry, key) * self.scale
        attn = F.softmax(attn, dim=-1)
        out  = torch.einsum('bnij,bndj->bndi', attn, val)
        out  = out.reshape(B, C // 2, H, W)
        return self.norm(self.W_g(out) + fc)


class InSliceAttention(nn.Module):
    """ISA — Ecuación 2 de Kumar et al., 2024."""
    def __init__(self, C, n_heads=N_HEADS):
        super().__init__()
        assert C % (2 * n_heads) == 0
        self.n_heads  = n_heads
        self.head_dim = C // (2 * n_heads)
        self.scale    = self.head_dim ** -0.5
        self.W_alpha  = nn.Conv2d(C, C // 2, 1, bias=False)
        self.W_beta   = nn.Conv2d(C, C // 2, 1, bias=False)
        self.W_gamma  = nn.Conv2d(C, C // 2, 1, bias=False)
        self.W_eps    = nn.Conv2d(C // 2, C, 1, bias=False)
        self.norm     = nn.InstanceNorm2d(C, affine=True)

    def forward(self, fc):
        B, C, H, W = fc.shape
        N  = H * W; d = self.head_dim; nh = self.n_heads
        q = self.W_alpha(fc).reshape(B, nh, d, N)
        k = self.W_beta(fc).reshape(B, nh, d, N)
        v = self.W_gamma(fc).reshape(B, nh, d, N)
        attn = torch.einsum('bndi,bndj->bnij', q, k) * self.scale
        attn = F.softmax(attn, dim=-1)
        out  = torch.einsum('bnij,bndj->bndi', attn, v)
        out  = out.reshape(B, C // 2, H, W)
        return self.norm(self.W_eps(out) + fc)


class CSANet25D(nn.Module):
    """CSA-Net 2.5D — arquitectura idéntica al original.

    El modelo NO sabe en qué plano está operando: recibe [B, 3, H, W]
    y devuelve logits [B, N_CLASSES, H, W]. La fusión de planos se hace
    FUERA del modelo, en las funciones de inferencia.
    """
    def __init__(self, in_ch_per_slice=1, out_ch=N_CLASSES,
                 init_f=INIT_FEATURES, max_f=MAX_FEATURES,
                 n_levels=N_LEVELS, n_heads=N_HEADS):
        super().__init__()
        self.n_levels = n_levels
        feats = [min(init_f * (2**i), max_f) for i in range(n_levels + 1)]
        self.feats = feats
        C_bot = feats[-1]

        self.enc  = nn.ModuleList()
        self.down = nn.ModuleList()
        self.enc.append(nn.Sequential(
            ConvNormAct2D(in_ch_per_slice, feats[0]),
            ResBlock2D(feats[0], feats[0]),
        ))
        for lvl in range(n_levels):
            self.down.append(nn.Sequential(
                nn.Conv2d(feats[lvl], feats[lvl+1], 3,
                          stride=2, padding=1, bias=False),
                nn.InstanceNorm2d(feats[lvl+1], affine=True),
                nn.ReLU(inplace=True),
            ))
            n_blk = min(lvl + 2, 3)
            self.enc.append(nn.Sequential(
                *[ResBlock2D(feats[lvl+1], feats[lvl+1]) for _ in range(n_blk)]
            ))

        self.csa_prev = CrossSliceAttention(C_bot, n_heads)
        self.csa_next = CrossSliceAttention(C_bot, n_heads)
        self.isa = InSliceAttention(C_bot, n_heads)
        self.attn_reduce = nn.Sequential(
            nn.Conv2d(C_bot * 3, C_bot, 1, bias=False),
            nn.InstanceNorm2d(C_bot, affine=True),
            nn.ReLU(inplace=True),
        )

        self.up = nn.ModuleList()
        self.dec = nn.ModuleList()
        self.ds_head = nn.ModuleList()
        for lvl in range(n_levels - 1, -1, -1):
            self.up.append(
                nn.ConvTranspose2d(feats[lvl+1], feats[lvl], 2, stride=2)
            )
            self.dec.append(nn.Sequential(
                ConvNormAct2D(feats[lvl] * 2, feats[lvl]),
                ResBlock2D(feats[lvl], feats[lvl]),
            ))
            self.ds_head.append(nn.Conv2d(feats[lvl], out_ch, 1))
        self._init_weights()

    def _init_weights(self):
        for m in self.modules():
            if isinstance(m, (nn.Conv2d, nn.ConvTranspose2d)):
                nn.init.kaiming_normal_(m.weight, mode="fan_out",
                                        nonlinearity="relu")
                if m.bias is not None: nn.init.zeros_(m.bias)
            elif isinstance(m, nn.InstanceNorm2d):
                if m.weight is not None: nn.init.ones_(m.weight)
                if m.bias   is not None: nn.init.zeros_(m.bias)

    def _encode_all(self, x):
        skips = []
        out = self.enc[0](x)
        skips.append(out)
        for lvl in range(self.n_levels):
            out = self.down[lvl](out)
            out = self.enc[lvl + 1](out)
            if lvl < self.n_levels - 1:
                skips.append(out)
        return out, skips

    def forward(self, x):
        B = x.shape[0]
        prev = x[:, 0:1]; center = x[:, 1:2]; nxt = x[:, 2:3]
        all_in = torch.cat([prev, center, nxt], dim=0)
        all_bot, all_skips = self._encode_all(all_in)
        f_prev = all_bot[:B]; f_center = all_bot[B:2*B]; f_next = all_bot[2*B:]
        c_skips = [s[B:2*B] for s in all_skips]
        csa_p = self.csa_prev(f_center, f_prev)
        csa_n = self.csa_next(f_center, f_next)
        isa = self.isa(f_center)
        feat = self.attn_reduce(torch.cat([csa_p, csa_n, isa], dim=1))
        out = feat; ds_outs = []
        for i, (up, dec, head) in enumerate(zip(self.up, self.dec, self.ds_head)):
            out = up(out)
            skip = c_skips[-(i + 1)]
            if out.shape[-2:] != skip.shape[-2:]:
                out = F.interpolate(out, size=skip.shape[-2:],
                                    mode="bilinear", align_corners=False)
            out = dec(torch.cat([out, skip], dim=1))
            ds_outs.append(head(out))
        return ds_outs[::-1]


# =============================================================================
# CARGA DE CHECKPOINTS
# =============================================================================

def load_fold_model(fold: int, ckpt_dir: str, device):
    """Carga el modelo del fold indicado y devuelve (model, plane_weights)."""
    ckpt_path = os.path.join(ckpt_dir, f"fold_{fold}_best.pth")
    if not os.path.exists(ckpt_path):
        raise FileNotFoundError(f"Checkpoint no encontrado: {ckpt_path}")

    ckpt  = torch.load(ckpt_path, map_location=device)
    model = CSANet25D().to(device)
    model.load_state_dict(ckpt["model_state_dict"])
    model.eval()

    # Recuperar pesos de fusión guardados en el checkpoint
    pw = ckpt.get("plane_weights_infer", PLANE_WEIGHTS_INFER)

    kd = ckpt.get("kidney_dice_ax", float("nan"))
    td = ckpt.get("tumor_dice_ax",  float("nan"))
    ep = ckpt.get("epoch", "?")
    print(f"    Fold {fold}: epoch={ep}  Kidney(ax)={kd:.4f}  "
          f"Tumor(ax)={td:.4f}  weights={pw}  ({ckpt_path})")
    return model, tuple(pw)


def load_all_models(ckpt_dir: str, device):
    """Carga los 5 modelos y comprueba consistencia de pesos de fusión."""
    models = []
    plane_weights_list = []
    for fold in range(5):
        try:
            m, pw = load_fold_model(fold, ckpt_dir, device)
            models.append(m)
            plane_weights_list.append(pw)
        except FileNotFoundError as e:
            print(f"    AVISO: {e} - fold omitido del ensemble")

    if not models:
        raise RuntimeError(f"No se encontró ningún checkpoint en {ckpt_dir}")

    # Usar los pesos del primer checkpoint disponible
    plane_weights = plane_weights_list[0]
    print(f"\n    Ensemble: {len(models)} modelos  "
          f"pesos fusión: axial={plane_weights[0]}  "
          f"sagital={plane_weights[1]}  coronal={plane_weights[2]}\n")
    return models, plane_weights


# =============================================================================
# PREPROCESAMIENTO
# =============================================================================

def preprocess(img_path: str, spacing=TARGET_SPACING):
    """
    Carga imagen, resamplea a TARGET_SPACING, clip HU y z-score.
    Devuelve (img_resampled [Z,H,W] float32, orig_nib, zoom_back).
    """
    img_nib = nib.load(img_path)
    img     = img_nib.get_fdata(dtype=np.float32)
    orig_sp = np.abs(np.array(img_nib.header.get_zooms()[:3], dtype=np.float32))
    zoom    = (orig_sp / np.array(spacing, dtype=np.float32)).tolist()
    img_r   = ndimage.zoom(img, zoom, order=1, prefilter=False)
    img_r   = np.clip(img_r, HU_CLIP_MIN, HU_CLIP_MAX)
    img_r   = (img_r - NORM_MEAN) / NORM_STD
    zoom_back = tuple(1.0 / z for z in zoom)
    return img_r.astype(np.float32), img_nib, zoom_back


# =============================================================================
# INFERENCIA MULTI-PLANO (idéntica al script de entrenamiento)
# =============================================================================

def _gaussian_map_2d(patch_size):
    def g1d(n):
        s = n / 8.0; x = np.arange(n) - n // 2
        w = np.exp(-0.5 * (x / s) ** 2)
        return (w / w.max()).astype(np.float32)
    gy, gx = g1d(patch_size[0]), g1d(patch_size[1])
    return gy[:, np.newaxis] * gx[np.newaxis, :]


def _sw_starts(total: int, p: int, s: int):
    lst = list(range(0, total - p + 1, s))
    if not lst or lst[-1] + p < total:
        lst.append(max(0, total - p))
    return sorted(set(lst))


def sliding_window_axial(model, img_np, patch_size=PATCH_SIZE_2D,
                          overlap=SW_OVERLAP, device=None):
    """Sliding window axial [Z, H, W] → [N_CLASSES, Z, H, W]."""
    if device is None:
        device = next(model.parameters()).device
    model.eval()
    Z, H, W = img_np.shape; ph, pw = patch_size
    sh = max(1, int(ph * (1 - overlap))); sw = max(1, int(pw * (1 - overlap)))
    gmap = _gaussian_map_2d(patch_size)

    pad_h = max(0, ph - H); pad_w = max(0, pw - W)
    if pad_h or pad_w:
        img_np = np.pad(img_np, [(0,0),(0,pad_h),(0,pad_w)], mode="reflect")
    HP, WP = img_np.shape[1], img_np.shape[2]

    acc = np.zeros((N_CLASSES, Z, HP, WP), dtype=np.float32)
    wt  = np.zeros((Z, HP, WP),            dtype=np.float32)
    ys  = _sw_starts(HP, ph, sh); xs = _sw_starts(WP, pw, sw)

    with torch.no_grad():
        for z_idx in range(Z):
            z_prev = max(0, z_idx - 1); z_next = min(Z - 1, z_idx + 1)
            for y0 in ys:
                for x0 in xs:
                    triplet = np.stack([
                        img_np[z_prev, y0:y0+ph, x0:x0+pw],
                        img_np[z_idx,  y0:y0+ph, x0:x0+pw],
                        img_np[z_next, y0:y0+ph, x0:x0+pw],
                    ], axis=0)
                    t    = torch.tensor(triplet[None], dtype=torch.float32).to(device)
                    out  = model(t)
                    out  = out[0] if isinstance(out, (list, tuple)) else out
                    prob = torch.softmax(out, dim=1).squeeze(0).cpu().numpy()
                    acc[:, z_idx, y0:y0+ph, x0:x0+pw] += prob * gmap[None]
                    wt[      z_idx, y0:y0+ph, x0:x0+pw] += gmap

    acc /= np.maximum(wt[None], 1e-8)
    return acc[:, :, :H, :W]


def sliding_window_sagital(model, img_np, patch_size=PATCH_SIZE_2D,
                            overlap=SW_OVERLAP, device=None):
    """Sliding window sagital [Z, H, W] → [N_CLASSES, Z, H, W]."""
    if device is None:
        device = next(model.parameters()).device
    model.eval()
    Z, H, W = img_np.shape; ph, pw = patch_size
    sh = max(1, int(ph * (1 - overlap))); sw = max(1, int(pw * (1 - overlap)))
    gmap = _gaussian_map_2d(patch_size)

    pad_z = max(0, ph - Z); pad_h = max(0, pw - H)
    if pad_z or pad_h:
        img_np = np.pad(img_np, [(0,pad_z),(0,pad_h),(0,0)], mode="reflect")
    ZP, HP = img_np.shape[0], img_np.shape[1]

    acc = np.zeros((N_CLASSES, ZP, HP, W), dtype=np.float32)
    wt  = np.zeros((ZP, HP, W),            dtype=np.float32)
    zs  = _sw_starts(ZP, ph, sh); hs = _sw_starts(HP, pw, sw)

    with torch.no_grad():
        for x_idx in range(W):
            x_prev = max(0, x_idx - 1); x_next = min(W - 1, x_idx + 1)
            for z0 in zs:
                for h0 in hs:
                    triplet = np.stack([
                        img_np[z0:z0+ph, h0:h0+pw, x_prev],
                        img_np[z0:z0+ph, h0:h0+pw, x_idx],
                        img_np[z0:z0+ph, h0:h0+pw, x_next],
                    ], axis=0)
                    t    = torch.tensor(triplet[None], dtype=torch.float32).to(device)
                    out  = model(t)
                    out  = out[0] if isinstance(out, (list, tuple)) else out
                    prob = torch.softmax(out, dim=1).squeeze(0).cpu().numpy()
                    acc[:, z0:z0+ph, h0:h0+pw, x_idx] += prob * gmap[None]
                    wt[      z0:z0+ph, h0:h0+pw, x_idx] += gmap

    acc /= np.maximum(wt[None], 1e-8)
    return acc[:, :Z, :H, :]


def sliding_window_coronal(model, img_np, patch_size=PATCH_SIZE_2D,
                            overlap=SW_OVERLAP, device=None):
    """Sliding window coronal [Z, H, W] → [N_CLASSES, Z, H, W]."""
    if device is None:
        device = next(model.parameters()).device
    model.eval()
    Z, H, W = img_np.shape; ph, pw = patch_size
    sh = max(1, int(ph * (1 - overlap))); sw = max(1, int(pw * (1 - overlap)))
    gmap = _gaussian_map_2d(patch_size)

    pad_z = max(0, ph - Z); pad_w = max(0, pw - W)
    if pad_z or pad_w:
        img_np = np.pad(img_np, [(0,pad_z),(0,0),(0,pad_w)], mode="reflect")
    ZP, WP = img_np.shape[0], img_np.shape[2]

    acc = np.zeros((N_CLASSES, ZP, H, WP), dtype=np.float32)
    wt  = np.zeros((ZP, H, WP),            dtype=np.float32)
    zs  = _sw_starts(ZP, ph, sh); ws = _sw_starts(WP, pw, sw)

    with torch.no_grad():
        for y_idx in range(H):
            y_prev = max(0, y_idx - 1); y_next = min(H - 1, y_idx + 1)
            for z0 in zs:
                for w0 in ws:
                    triplet = np.stack([
                        img_np[z0:z0+ph, y_prev, w0:w0+pw],
                        img_np[z0:z0+ph, y_idx,  w0:w0+pw],
                        img_np[z0:z0+ph, y_next, w0:w0+pw],
                    ], axis=0)
                    t    = torch.tensor(triplet[None], dtype=torch.float32).to(device)
                    out  = model(t)
                    out  = out[0] if isinstance(out, (list, tuple)) else out
                    prob = torch.softmax(out, dim=1).squeeze(0).cpu().numpy()
                    acc[:, z0:z0+ph, y_idx, w0:w0+pw] += prob * gmap[None]
                    wt[      z0:z0+ph, y_idx, w0:w0+pw] += gmap

    acc /= np.maximum(wt[None], 1e-8)
    return acc[:, :Z, :, :W]


def sliding_window_multiplane(model, img_np, patch_size=PATCH_SIZE_2D,
                               overlap=SW_OVERLAP, device=None,
                               plane_weights=PLANE_WEIGHTS_INFER):
    """
    Fusión ortogonal: P = (w_ax·P_ax + w_sag·P_sag + w_cor·P_cor) / Σw
    Retorna [N_CLASSES, Z, H, W].
    """
    w_ax, w_sag, w_cor = plane_weights
    total_w = w_ax + w_sag + w_cor

    prob_ax  = sliding_window_axial(model, img_np, patch_size, overlap, device)
    prob_sag = sliding_window_sagital(model, img_np, patch_size, overlap, device)
    prob_cor = sliding_window_coronal(model, img_np, patch_size, overlap, device)

    return (w_ax * prob_ax + w_sag * prob_sag + w_cor * prob_cor) / total_w


def sliding_window_tta_multiplane(model, img_np, patch_size=PATCH_SIZE_2D,
                                   overlap=SW_OVERLAP, device=None,
                                   plane_weights=PLANE_WEIGHTS_INFER):
    """
    TTA (original + flip-H + flip-W) × fusión multi-plano = 9 predicciones.
    Retorna [N_CLASSES, Z, H, W] como promedio de las 3 TTA.
    """
    preds = [sliding_window_multiplane(
        model, img_np, patch_size, overlap, device, plane_weights
    )]

    # Flip H (eje 1 del volumen 3D Z,H,W)
    fl_h = np.flip(img_np, axis=1).copy()
    p_h  = sliding_window_multiplane(model, fl_h, patch_size, overlap,
                                      device, plane_weights)
    preds.append(np.flip(p_h, axis=2).copy())   # revertir eje H en probabilidades

    # Flip W (eje 2 del volumen 3D)
    fl_w = np.flip(img_np, axis=2).copy()
    p_w  = sliding_window_multiplane(model, fl_w, patch_size, overlap,
                                      device, plane_weights)
    preds.append(np.flip(p_w, axis=3).copy())   # revertir eje W en probabilidades

    return np.mean(preds, axis=0)


# =============================================================================
# ENSEMBLE DE 5 FOLDS
# =============================================================================

def ensemble_predict(models, img_np, device, use_tta: bool,
                      plane_weights=PLANE_WEIGHTS_INFER):
    """
    Promedia las probabilidades de los N modelos y devuelve argmax.
    Cada modelo usa TTA + multi-plano (o solo multi-plano si use_tta=False).
    """
    infer_fn = (sliding_window_tta_multiplane if use_tta
                else sliding_window_multiplane)

    prob_sum = None
    for i, m in enumerate(models):
        print(f"      fold {i}...", end="", flush=True)
        p = infer_fn(m, img_np, PATCH_SIZE_2D, SW_OVERLAP, device, plane_weights)
        prob_sum = p if prob_sum is None else prob_sum + p
    print()

    return np.argmax(prob_sum / len(models), axis=0).astype(np.int16)


# =============================================================================
# RESAMPLEO AL ESPACIO ORIGINAL
# =============================================================================

def resample_pred_to_original(pred_resampled: np.ndarray,
                               orig_shape: tuple,
                               zoom_back: tuple) -> np.ndarray:
    """
    Resamplea la predicción (en espacio TARGET_SPACING) de vuelta al
    espacio original con order=0 (nearest-neighbor para etiquetas discretas).
    Ajusta a orig_shape exacto para evitar errores de ±1 vóxel.
    """
    pred_back = ndimage.zoom(pred_resampled.astype(np.float32),
                             zoom_back, order=0, prefilter=False)
    result = np.zeros(orig_shape, dtype=np.int16)
    sz = tuple(min(pred_back.shape[i], orig_shape[i]) for i in range(3))
    result[:sz[0], :sz[1], :sz[2]] = pred_back[:sz[0], :sz[1], :sz[2]]
    return result


# =============================================================================
# IDENTIFICACIÓN DE CASOS DE TEST
# =============================================================================

def get_test_cases_from_nnunet(images_ts_dir, labels_ts_dir):
    """Identifica los casos directamente desde la carpeta de test de nnU-Net."""
    # nnU-Net usa el formato: kidney_001_0000.nii.gz
    all_imgs = sorted(glob(os.path.join(images_ts_dir, "*_0000.nii.gz")))
    
    test_cases = []
    for img_path in all_imgs:
        case_id = os.path.basename(img_path).replace("_0000.nii.gz", "")
        lab_path = os.path.join(labels_ts_dir, f"{case_id}.nii.gz")
        
        if os.path.exists(lab_path):
            test_cases.append({
                "image": img_path,
                "label": lab_path,
                "case_id": case_id
            })
    return test_cases


# =============================================================================
# MAIN
# =============================================================================

def main():
    parser = argparse.ArgumentParser()
    # Se actualizan los nombres de las variables para evitar NameError[cite: 9]
    parser.add_argument("--data_dir",   default=DATA_DIR_TS)
    parser.add_argument("--labels_dir", default=LABEL_DIR_TS)
    parser.add_argument("--ckpt_dir",   default=CKPT_DIR)
    parser.add_argument("--output_dir", default=OUTPUT_DIR)
    parser.add_argument("--no_tta",     action="store_true")
    args = parser.parse_args()

    use_tta = not args.no_tta
    os.makedirs(args.output_dir, exist_ok=True)

    print("\n" + "=" * 70)
    print("  GENERACIÓN DE MÁSCARAS - TEST SET nnU-Net")
    print(f" Imágenes: {args.data_dir}")
    print(f" Salida: {args.output_dir}")
    print("=" * 70)

    # Cargar checkpoints 
    print("\n  Cargando checkpoints...")
    models, plane_weights = load_all_models(args.ckpt_dir, DEVICE)

    # Identificar casos de test 
    print("\n  Buscando casos en imagesTs...")
    test_cases = get_test_cases_from_nnunet(args.data_dir, args.labels_dir)

    if not test_cases:
        print(f"  ERROR: No se encontraron casos en {args.data_dir}")
        return

    # Procesar cada caso
    print(f"\n  Procesando {len(test_cases)} casos...\n")
    summary = []

    for d in test_cases:
        cid      = d["case_id"]
        img_path = d["image"]
        lab_path = d["label"]

        print(f"  [{cid}]")

        # Preprocesar imagen
        print(f"    Preprocesando...", end="", flush=True)
        img_proc, orig_nib, zoom_back = preprocess(img_path)
        orig_shape = tuple(int(s) for s in orig_nib.get_fdata().shape[:3])
        affine     = orig_nib.affine
        header     = orig_nib.header

        print(f"  original={orig_shape}  "
              f"resampleado={img_proc.shape}  "
              f"TTA={'sí' if use_tta else 'no'}")

        # Inferencia ensemble
        print(f"    Inferencia ({len(models)} folds × "
              f"{'3 TTA × ' if use_tta else ''}3 planos):")
        pred_resampled = ensemble_predict(
            models, img_proc, DEVICE, use_tta, plane_weights
        )

        # Resampleo al espacio original
        print(f"    Resampleando {pred_resampled.shape} -> {orig_shape}...",
              end="", flush=True)
        pred_orig = resample_pred_to_original(pred_resampled, orig_shape, zoom_back)

        assert pred_orig.shape == orig_shape, (
            f"ERROR dimensiones: pred={pred_orig.shape} vs original={orig_shape}"
        )
        print("  OK")

        # Guardar predicción 
        pred_path = os.path.join(args.output_dir, f"{cid}_pred.nii.gz")
        pred_nib  = nib.Nifti1Image(pred_orig, affine, header)
        pred_nib.header.set_data_dtype(np.int16)
        nib.save(pred_nib, pred_path)

        # Guardar GT en espacio original 
        # El GT se guarda con el affine/header de la imagen original para
        # garantizar que pred y GT estén en el mismo espacio (mismas
        # dimensiones, mismo voxel spacing) -> métricas correctas.
        gt_path  = os.path.join(args.output_dir, f"{cid}_gt.nii.gz")
        lab_nib  = nib.load(lab_path)
        lab_data = np.round(lab_nib.get_fdata()).astype(np.int16)
        gt_out   = nib.Nifti1Image(lab_data, affine, header)
        gt_out.header.set_data_dtype(np.int16)
        nib.save(gt_out, gt_path)

        print(f"pred : {pred_path}  clases={np.unique(pred_orig).tolist()}")
        print(f"gt   : {gt_path}    clases={np.unique(lab_data).tolist()}")

        vox_vol = float(np.abs(np.linalg.det(affine[:3, :3])))  # mm³/vóxel
        n_kidney = int((pred_orig > 0).sum())
        n_tumor  = int((pred_orig == 2).sum())
        summary.append({
            "case_id":         cid,
            "pred_path":       pred_path,
            "gt_path":         gt_path,
            "orig_shape":      str(orig_shape),
            "resampled_shape": str(img_proc.shape),
            "plane_weights":   str(plane_weights),
            "tta":             use_tta,
            "kidney_voxels":   n_kidney,
            "tumor_voxels":    n_tumor,
            "kidney_vol_mL":   round(n_kidney * vox_vol / 1000, 2),
            "tumor_vol_mL":    round(n_tumor  * vox_vol / 1000, 2),
        })
        print()

    # Resumen 
    df = pd.DataFrame(summary)
    csv_path = os.path.join(args.output_dir, "masks_summary.csv")
    df.to_csv(csv_path, index=False)

    print("=" * 74)
    print(f"  COMPLETADO — {len(summary)} máscaras generadas")
    print(f"  Resumen CSV : {csv_path}")
    print("=" * 74)


if __name__ == "__main__":
    main()
