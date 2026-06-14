#!/usr/bin/env python3
"""
train_kits_25d_multiplane.py  -  CSA-Net 2.5D con fusión ortogonal de tres planos
===================================================================================

Extensión de train_kits_25d.py que entrena y hace inferencia procesando
tripletes de los tres planos anatómicos:

  Axial    (z-1, z, z+1)  ->  triplete [3, H, W]  - plano clínico principal
  Sagital  (x-1, x, x+1)  ->  triplete [3, Z, H]  - contexto lateral
  Coronal  (y-1, y, y+1)  ->  triplete [3, Z, W]  - contexto anterior-posterior

IDEA CENTRAL — Fusión ortogonal de planos
==========================================
Un modelo ÚNICO se entrena con tripletes aleatorios de los tres planos.
En inferencia, se genera un volumen de probabilidades por cada plano,
y se promedian (fusión por media de softmax):

  P_final(x) = w_ax · P_ax(x) + w_sag · P_sag(x) + w_cor · P_cor(x)
  pred = argmax P_final

PROTOCOLO (mismo que el resto del pipeline para comparación robusta):
  - Splits   : Mismos que nnUNet porque coge el mismo directorio de casos y labels
  - Preproceso: spacing (1.0, 1.0, 1.0), clip HU, z-score foreground
  - Optimizador: SGD Nesterov mom=0.99 lr=0.01 wd=3e-5, PolyLR^0.9
  - Pérdida  : CE + Dice con deep supervision [1.0, 0.5, 0.25, 0.125]
  - Métricas : Dice riñón, Dice tumor, Composita = √(Dk·Dt)
"""

import os, json, random, time, warnings
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
warnings.filterwarnings("ignore")

import numpy as np
import nibabel as nib
import torch
import torch.nn as nn
import torch.nn.functional as F
from glob import glob
from scipy import ndimage
import pandas as pd
from torch.utils.data import Dataset, DataLoader
from torch.cuda.amp import GradScaler, autocast

# =============================================================================
# CONFIGURACIÓN
# =============================================================================

DATA_DIR      = os.path.expanduser("~/nnUNet_raw/Dataset002_Kidney/imagesTr")
LABEL_DIR     = os.path.expanduser("~/nnUNet_raw/Dataset002_Kidney/labelsTr")
OUTPUT_DIR    = "./kits_25d_multiplane"
DEVICE        = torch.device("cuda" if torch.cuda.is_available() else "cpu")
NNUNET_SPLITS = os.path.expanduser(
    "~/nnUNet_preprocessed/Dataset002_Kidney/splits_final.json"
)

# Preprocesamiento - IDÉNTICO al 3D y al script axial original
TARGET_SPACING = (1.0, 1.0, 1.0)           # original_median_spacing_after_transp
HU_CLIP_MIN    = -64.35255432128906        # foreground percentile_00_5
HU_CLIP_MAX    = 273.7598571777344         # foreground percentile_99_5
NORM_MEAN      = 120.24785614013672        # foreground mean
NORM_STD       = 65.7291259765625          # foreground std

# Arquitectura CSA-Net 2.5D
PATCH_SIZE_2D  = (256, 256)
N_CLASSES      = 3
INIT_FEATURES  = 32
MAX_FEATURES   = 256
N_LEVELS       = 4
N_HEADS        = 8

# Pesos de muestreo por plano durante entrenamiento
# Probabilidad de seleccionar cada plano en cada batch de entrenamiento.
# Igual peso por defecto: el modelo ve los 3 planos con igual frecuencia.
PLANE_WEIGHTS_TRAIN = (1/3, 1/3, 1/3)   # axial, sagital, coronal

# Pesos de fusión durante inferencia 
# Pesos para el promedio ponderado de probabilidades en inferencia.
# Igual por defecto. 
PLANE_WEIGHTS_INFER = (1.0, 1.0, 1.0)   # axial, sagital, coronal

# Entrenamiento
BATCHES_PER_EPOCH = 250
EPOCHS            = 500
BATCH_SIZE        = 8
LR_INIT           = 0.01
MOMENTUM          = 0.99
WEIGHT_DECAY      = 3e-5
POLY_POWER        = 0.9
DS_WEIGHTS        = [1.0, 0.5, 0.25, 0.125]
POS_FRAC          = 0.33
SW_OVERLAP        = 0.5
USE_TTA           = True
SEED              = 42

for _d in [OUTPUT_DIR, f"{OUTPUT_DIR}/checkpoints",
           f"{OUTPUT_DIR}/logs", f"{OUTPUT_DIR}/results"]:
    os.makedirs(_d, exist_ok=True)


def set_seed(s=42):
    random.seed(s); np.random.seed(s); torch.manual_seed(s)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(s)


set_seed(SEED)

_feats        = [min(INIT_FEATURES * (2**i), MAX_FEATURES) for i in range(N_LEVELS + 1)]
BOTTLENECK_CH = _feats[-1]

print("\n" + "=" * 80)
print("  KiTS - CSA-Net 2.5D MULTI-PLANO (axial + sagital + coronal)")
print(f"  spacing={TARGET_SPACING} mm")
print(f"  patch={PATCH_SIZE_2D}  features={_feats}  n_heads={N_HEADS}")
print(f"  pesos entrenamiento: axial={PLANE_WEIGHTS_TRAIN[0]:.2f}  "
      f"sagital={PLANE_WEIGHTS_TRAIN[1]:.2f}  "
      f"coronal={PLANE_WEIGHTS_TRAIN[2]:.2f}")
print(f"  pesos inferencia   : axial={PLANE_WEIGHTS_INFER[0]:.1f}  "
      f"sagital={PLANE_WEIGHTS_INFER[1]:.1f}  "
      f"coronal={PLANE_WEIGHTS_INFER[2]:.1f}")
print(f"  bs={BATCH_SIZE}  {BATCHES_PER_EPOCH}×{EPOCHS} iters  SGD Nesterov")
print("=" * 80)


# =============================================================================
# CARGA DE SPLITS - IDÉNTICA A nnUNet
# =============================================================================

def load_splits_exact(splits_file, images_dir, labels_dir):
    """
    Carga los splits de nnUNet leyendo directamente de las carpetas de nnUNet_raw.
    Garantiza que el ID del JSON coincida con el archivo físico real.
    """
    if not os.path.exists(splits_file):
        raise FileNotFoundError(f"No se encontro {splits_file}")

    with open(splits_file) as f:
        splits = json.load(f)

    # Buscar imágenes (kidney_001_0000.nii.gz) y labels (kidney_001.nii.gz)[cite: 5]
    all_imgs = glob(os.path.join(images_dir, "*_0000.nii.gz"))
    
    id_to_paths = {}
    for img_path in all_imgs:
        # Extraer ID: "kidney_001_0000.nii.gz" -> "kidney_001"
        case_id = os.path.basename(img_path).replace("_0000.nii.gz", "")
        lab_path = os.path.join(labels_dir, f"{case_id}.nii.gz")
        
        if os.path.exists(lab_path):
            id_to_paths[case_id] = {"image": img_path, "label": lab_path, "case_id": case_id}

    # Procesar Folds según el JSON[cite: 6]
    splits_iter = splits if isinstance(splits, list) else list(splits.values())
    fold_data = []
    
    print("\n  SINCRONIZACIÓN DE SPLITS (nnU-Net Raw Dir):")
    for fold_idx, sp in enumerate(splits_iter):
        tr_ids = sp["train"]
        vl_ids = sp["val"]

        # Cargar solo los casos que existen físicamente[cite: 13]
        train = [id_to_paths[k] for k in tr_ids if k in id_to_paths]
        val   = [id_to_paths[k] for k in vl_ids if k in id_to_paths]
        
        fold_data.append({
            "train": train, 
            "val": val,
            "train_ids": tr_ids, 
            "val_ids": vl_ids
        })
        print(f"   Fold {fold_idx}: {len(train):3d} train, {len(val):3d} val")

    # Identificar casos de TEST (no están en el archivo de splits)[cite: 1, 5]
    ids_in_splits = set()
    for sp in splits_iter:
        ids_in_splits.update(sp["train"])
        ids_in_splits.update(sp["val"])
    
    # Nota: Los casos de test real suelen estar en 'imagesTs'[cite: 2]
    # Aquí identificamos los que están en Tr pero no en el split
    ids_test = sorted(set(id_to_paths.keys()) - ids_in_splits)
    test_data = [id_to_paths[k] for k in ids_test if k in id_to_paths]
    
    return fold_data, test_data


# =============================================================================
# PREPROCESAMIENTO
# =============================================================================

def load_preprocess(img_path, lab_path, spacing=TARGET_SPACING):
    img_nib = nib.load(img_path)
    lab_nib = nib.load(lab_path)
    img = img_nib.get_fdata(dtype=np.float32)
    lab = lab_nib.get_fdata().astype(np.int64)
    orig_sp = np.abs(np.array(img_nib.header.get_zooms()[:3], dtype=np.float32))
    zoom = (orig_sp / np.array(spacing, dtype=np.float32)).tolist()
    img_r = ndimage.zoom(img, zoom, order=1, prefilter=False)
    lab_r = ndimage.zoom(lab.astype(np.float32), zoom,
                            order=0, prefilter=False).astype(np.int64)
    img_r = np.clip(img_r, HU_CLIP_MIN, HU_CLIP_MAX)
    img_r = (img_r - NORM_MEAN) / NORM_STD
    return img_r, lab_r


# =============================================================================
# ARQUITECTURA CSA-NET 2.5D 
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
    """CSA - Ecuación 1 de Kumar et al., 2024."""
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
    """ISA - Ecuación 2 de Kumar et al., 2024."""
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
    """CSA-Net 2.5D. 

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


def build_model():
    m = CSANet25D()
    n = sum(p.numel() for p in m.parameters() if p.requires_grad)
    print(f"  [CSA-Net 2.5D Multi-plano]  params={n:,}  "
          f"feats={_feats}  n_heads={N_HEADS}")
    return m


# =============================================================================
# LOSS 
# =============================================================================

def _dice_loss(ps, t_oh, smooth=1e-5):
    loss, cnt = 0.0, 0
    for c in range(1, ps.shape[1]):
        p   = ps[:, c].reshape(-1); t = t_oh[:, c].reshape(-1)
        num = 2.0 * (p * t).sum() + smooth
        den = p.sum() + t.sum() + smooth
        loss += 1.0 - num / den; cnt += 1
    return loss / max(cnt, 1)


def combined_loss(logits, target):
    tgt = target.squeeze(1).long() if target.dim() == logits.dim() else target.long()
    ce  = F.cross_entropy(logits, tgt)
    ps  = torch.softmax(logits, dim=1); nc = ps.shape[1]
    toh = F.one_hot(tgt, num_classes=nc)
    perm = [0, toh.ndim - 1] + list(range(1, toh.ndim - 1))
    toh = toh.permute(*perm).float()
    return ce + _dice_loss(ps, toh)


def deep_supervision_loss(outputs, target):
    total, tw = torch.tensor(0.0, device=target.device), 0.0
    for out, w in zip(outputs, DS_WEIGHTS[:len(outputs)]):
        if out.shape[-2:] != target.shape[-2:]:
            tgt = F.interpolate(
                target.float().unsqueeze(1) if target.dim() == 3 else target.float(),
                size=out.shape[-2:], mode="nearest"
            ).squeeze(1).long()
        else:
            tgt = target.squeeze(1).long() if target.dim() == 4 else target.long()
        total += w * combined_loss(out, tgt)
        tw    += w
    return total / tw


# =============================================================================
# MUESTREO DE TRIPLETES - TRES PLANOS
# =============================================================================

def _crop_or_pad_2d(arr, target):
    result = np.zeros(target, dtype=arr.dtype)
    slcs_src = []; slcs_dst = []
    for s, d in zip(arr.shape, target):
        if s >= d:
            st = (s - d) // 2
            slcs_src.append(slice(st, st + d)); slcs_dst.append(slice(0, d))
        else:
            st = (d - s) // 2
            slcs_src.append(slice(0, s));       slcs_dst.append(slice(st, st + s))
    result[tuple(slcs_dst)] = arr[tuple(slcs_src)]
    return result


def sample_triplet_axial(img, lab, patch_size=PATCH_SIZE_2D, pos_frac=POS_FRAC):
    """
    Triplete axial (z-1, z, z+1).  Parche H×W del plano axial.
    Idéntico a sample_triplet() del script original.
    img [Z, H, W],  lab [Z, H, W]  ->  triplet [3, ph, pw],  label [ph, pw]
    """
    Z, H, W = img.shape; ph, pw = patch_size
    pad_h = max(0, ph - H); pad_w = max(0, pw - W)
    if pad_h or pad_w:
        img = np.pad(img, [(0,0),(0,pad_h),(0,pad_w)], mode="reflect")
        lab = np.pad(lab, [(0,0),(0,pad_h),(0,pad_w)], mode="constant")
        H, W = img.shape[1], img.shape[2]

    # Elegir z con sesgo a foreground
    if random.random() < pos_frac:
        fg_z = np.where(lab.any(axis=(1,2)))[0]
        z = int(fg_z[np.random.randint(len(fg_z))]) if len(fg_z) > 0 else Z // 2
    else:
        z = np.random.randint(Z)
    z_prev = max(0, z-1); z_next = min(Z-1, z+1)
    lab_c  = lab[z]

    # Elegir posición in-plane con sesgo a foreground
    if random.random() < pos_frac:
        fg_yx = np.argwhere(lab_c > 0)
        if len(fg_yx) > 0:
            c  = fg_yx[np.random.randint(len(fg_yx))]
            y0 = int(np.clip(c[0] - ph//2, 0, H-ph))
            x0 = int(np.clip(c[1] - pw//2, 0, W-pw))
        else:
            y0 = np.random.randint(0, max(1, H-ph+1))
            x0 = np.random.randint(0, max(1, W-pw+1))
    else:
        y0 = np.random.randint(0, max(1, H-ph+1))
        x0 = np.random.randint(0, max(1, W-pw+1))

    triplet = np.stack([
        img[z_prev, y0:y0+ph, x0:x0+pw],
        img[z,      y0:y0+ph, x0:x0+pw],
        img[z_next, y0:y0+ph, x0:x0+pw],
    ], axis=0)
    return triplet.astype(np.float32), lab_c[y0:y0+ph, x0:x0+pw]


def sample_triplet_sagital(img, lab, patch_size=PATCH_SIZE_2D, pos_frac=POS_FRAC):
    """
    Triplete sagital (x-1, x, x+1).  Parche Z×H del plano sagital.

    El plano sagital en img[Z,H,W] es img[:,:,x] -> forma [Z, H].
    El parche [ph, pw] se extrae directamente de [Z, H] con sliding window,
    de forma consistente con el plano axial.
    """
    Z, H, W = img.shape; ph, pw = patch_size
    # Pad en Z y H si el volumen es más pequeño que el parche
    pad_z = max(0, ph - Z); pad_h = max(0, pw - H)
    if pad_z or pad_h:
        img = np.pad(img, [(0,pad_z),(0,pad_h),(0,0)], mode="reflect")
        lab = np.pad(lab, [(0,pad_z),(0,pad_h),(0,0)], mode="constant")
        Z, H = img.shape[0], img.shape[1]

    # Elegir x con sesgo a foreground
    if random.random() < pos_frac:
        fg_x = np.where(lab.any(axis=(0,1)))[0]   # columnas con foreground
        x = int(fg_x[np.random.randint(len(fg_x))]) if len(fg_x) > 0 else W // 2
    else:
        x = np.random.randint(W)
    x_prev = max(0, x-1); x_next = min(W-1, x+1)

    # Elegir posición en el plano [Z, H] con sesgo a foreground
    lab_c = lab[:, :, x]           # [Z, H] - etiqueta del corte central sagital
    if random.random() < pos_frac:
        fg_zh = np.argwhere(lab_c > 0)   # [N, 2]: dim0=Z, dim1=H
        if len(fg_zh) > 0:
            c  = fg_zh[np.random.randint(len(fg_zh))]
            z0 = int(np.clip(c[0] - ph//2, 0, Z-ph))
            h0 = int(np.clip(c[1] - pw//2, 0, H-pw))
        else:
            z0 = np.random.randint(0, max(1, Z-ph+1))
            h0 = np.random.randint(0, max(1, H-pw+1))
    else:
        z0 = np.random.randint(0, max(1, Z-ph+1))
        h0 = np.random.randint(0, max(1, H-pw+1))

    # Parche [ph, pw] extraído del plano [Z, H]
    triplet = np.stack([
        img[z0:z0+ph, h0:h0+pw, x_prev],
        img[z0:z0+ph, h0:h0+pw, x],
        img[z0:z0+ph, h0:h0+pw, x_next],
    ], axis=0)
    return triplet.astype(np.float32), lab_c[z0:z0+ph, h0:h0+pw]


def sample_triplet_coronal(img, lab, patch_size=PATCH_SIZE_2D, pos_frac=POS_FRAC):
    """
    Triplete coronal (y-1, y, y+1).  Parche Z×W del plano coronal.

    El plano coronal en img[Z,H,W] es img[:,y,:] -> forma [Z, W].
    """
    Z, H, W = img.shape; ph, pw = patch_size
    pad_z = max(0, ph - Z); pad_w = max(0, pw - W)
    if pad_z or pad_w:
        img = np.pad(img, [(0,pad_z),(0,0),(0,pad_w)], mode="reflect")
        lab = np.pad(lab, [(0,pad_z),(0,0),(0,pad_w)], mode="constant")
        Z, W = img.shape[0], img.shape[2]

    # Elegir y con sesgo a foreground
    if random.random() < pos_frac:
        fg_y = np.where(lab.any(axis=(0,2)))[0]   # filas con foreground
        y = int(fg_y[np.random.randint(len(fg_y))]) if len(fg_y) > 0 else H // 2
    else:
        y = np.random.randint(H)
    y_prev = max(0, y-1); y_next = min(H-1, y+1)

    # Elegir posición en el plano [Z, W] con sesgo a foreground
    lab_c = lab[:, y, :]           # [Z, W]
    if random.random() < pos_frac:
        fg_zw = np.argwhere(lab_c > 0)   # dim0=Z, dim1=W
        if len(fg_zw) > 0:
            c  = fg_zw[np.random.randint(len(fg_zw))]
            z0 = int(np.clip(c[0] - ph//2, 0, Z-ph))
            w0 = int(np.clip(c[1] - pw//2, 0, W-pw))
        else:
            z0 = np.random.randint(0, max(1, Z-ph+1))
            w0 = np.random.randint(0, max(1, W-pw+1))
    else:
        z0 = np.random.randint(0, max(1, Z-ph+1))
        w0 = np.random.randint(0, max(1, W-pw+1))

    triplet = np.stack([
        img[z0:z0+ph, y_prev, w0:w0+pw],
        img[z0:z0+ph, y,      w0:w0+pw],
        img[z0:z0+ph, y_next, w0:w0+pw],
    ], axis=0)
    return triplet.astype(np.float32), lab_c[z0:z0+ph, w0:w0+pw]


def sample_triplet_multiplane(img, lab, patch_size=PATCH_SIZE_2D,
                              pos_frac=POS_FRAC,
                              weights=PLANE_WEIGHTS_TRAIN):
    """
    Selecciona aleatoriamente un plano (axial / sagital / coronal)
    con los pesos indicados y muestrea un triplete de ese plano.
    """
    plane = random.choices(["axial", "sagital", "coronal"], weights=weights)[0]
    if plane == "axial":
        return sample_triplet_axial(img, lab, patch_size, pos_frac)
    elif plane == "sagital":
        return sample_triplet_sagital(img, lab, patch_size, pos_frac)
    else:
        return sample_triplet_coronal(img, lab, patch_size, pos_frac)


# =============================================================================
# DATA AUGMENTATION - mismos valores que Unet 3D Residual
# =============================================================================

def augment_2d(triplet, label):
    """Augmentación in-plane idéntica al original. Válida para los 3 planos."""
    if random.random() < 0.5:
        triplet = np.flip(triplet, axis=2).copy(); label = np.flip(label, axis=1).copy()
    if random.random() < 0.5:
        triplet = np.flip(triplet, axis=1).copy(); label = np.flip(label, axis=0).copy()
    
    if random.random() < 0.3:
        ang = random.uniform(-30, 30)
        for i in range(3):
            triplet[i] = ndimage.rotate(triplet[i], ang, reshape=False, order=1)
        label = ndimage.rotate(label.astype(np.float32), ang,
                               reshape=False, order=0).astype(np.int64)
    
    if random.random() < 0.3:
        sc = random.uniform(0.80, 1.20)
        orig_shape = triplet.shape[1:]
        scaled = np.stack([ndimage.zoom(triplet[i], sc, order=1, prefilter=False)
                           for i in range(3)], axis=0)
        triplet_new = np.zeros_like(triplet)
        for i in range(3):
            triplet_new[i] = _crop_or_pad_2d(scaled[i], orig_shape)
        triplet = triplet_new
        lz = ndimage.zoom(label.astype(np.float32), sc, order=0, prefilter=False)
        label = _crop_or_pad_2d(lz.astype(np.int64), orig_shape)
    
    if random.random() < 0.3: triplet = triplet * random.uniform(0.70, 1.30)
    
    if random.random() < 0.3:
        mn = triplet.mean(); triplet = (triplet - mn) * random.uniform(0.70, 1.30) + mn
    
    if random.random() < 0.3:
        g = random.uniform(0.7, 1.5); mn, mx = triplet.min(), triplet.max()
        if mx > mn:
            triplet = (np.clip((triplet-mn)/(mx-mn),0,1)**g)*(mx-mn)+mn
   
    if random.random() < 0.2:
        triplet += np.random.normal(0, random.uniform(0,0.1),
                                    triplet.shape).astype(np.float32)
    
    return triplet.astype(np.float32), label.astype(np.int64)


# =============================================================================
# DATASET - MUESTREO MULTI-PLANO EN ENTRENAMIENTO
# =============================================================================

class RyC25DDataset(Dataset):
    def __init__(self, data_dicts, is_train=True):
        self.is_train   = is_train
        self.patch_size = PATCH_SIZE_2D
        self.n = BATCHES_PER_EPOCH * BATCH_SIZE if is_train else len(data_dicts)
        tag = "train" if is_train else "val"
        print(f"  [Dataset {tag}] cargando {len(data_dicts)} vols...",
              end="", flush=True)
        t0 = time.time()
        self.vols = []
        for d in data_dicts:
            img, lab = load_preprocess(d["image"], d["label"])
            self.vols.append((img, lab, d["case_id"]))
        print(f" OK ({len(self.vols)} casos, {time.time()-t0:.0f}s)")

    def __len__(self):
        return self.n

    def __getitem__(self, idx):
        if self.is_train:
            img, lab, _ = self.vols[random.randint(0, len(self.vols) - 1)]
            # Muestreo multi-plano 
            triplet, label = sample_triplet_multiplane(
                img, lab, self.patch_size, POS_FRAC, PLANE_WEIGHTS_TRAIN
            )
            triplet, label = augment_2d(triplet, label)
            return (torch.tensor(triplet, dtype=torch.float32),
                    torch.tensor(label,   dtype=torch.long))
        else:
            img, lab, cid = self.vols[idx]
            return img, lab, cid


# =============================================================================
# INFERENCIA - TRES PLANOS CON SLIDING WINDOW INDEPENDIENTE
# =============================================================================

def _gaussian_map_2d(patch_size):
    def g1d(n):
        s = n / 8.0; x = np.arange(n) - n // 2
        w = np.exp(-0.5 * (x / s) ** 2)
        return (w / w.max()).astype(np.float32)
    gy, gx = g1d(patch_size[0]), g1d(patch_size[1])
    return gy[:, np.newaxis] * gx[np.newaxis, :]


def _sw_starts(total, p, s):
    lst = list(range(0, total - p + 1, s))
    if not lst or lst[-1] + p < total:
        lst.append(max(0, total - p))
    return sorted(set(lst))


def sliding_window_axial(model, img_np, patch_size=PATCH_SIZE_2D,
                         overlap=SW_OVERLAP, device=None):
    """
    Sliding window axial.
    Itera sobre z; sliding window in-plane sobre [H, W].
    Retorna: [N_CLASSES, Z, H, W]
    """
    if device is None: device = next(model.parameters()).device
    model.eval()
    Z, H, W = img_np.shape; ph, pw = patch_size
    sh = max(1, int(ph*(1-overlap))); sw = max(1, int(pw*(1-overlap)))
    gmap = _gaussian_map_2d(patch_size)

    pad_h = max(0, ph-H); pad_w = max(0, pw-W)
    if pad_h or pad_w:
        img_np = np.pad(img_np, [(0,0),(0,pad_h),(0,pad_w)], mode="reflect")
    HP, WP = img_np.shape[1], img_np.shape[2]

    acc = np.zeros((N_CLASSES, Z, HP, WP), dtype=np.float32)
    wt  = np.zeros((Z, HP, WP),            dtype=np.float32)
    ys  = _sw_starts(HP, ph, sh); xs = _sw_starts(WP, pw, sw)

    with torch.no_grad():
        for z_idx in range(Z):
            z_prev = max(0, z_idx-1); z_next = min(Z-1, z_idx+1)
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
    """
    Sliding window sagital - itera sobre x; sliding window en [Z, H].

    Para cada columna x del volumen:
      - Triplete: img[:, :, x-1], img[:, :, x], img[:, :, x+1]
      - Sliding window sobre el plano [Z, H] con parche [ph, pw]
      - Acumula en acc[:, :, :, x]

    Retorna: [N_CLASSES, Z, H, W]
    """
    if device is None: device = next(model.parameters()).device
    model.eval()
    Z, H, W = img_np.shape; ph, pw = patch_size
    sh = max(1, int(ph*(1-overlap))); sw = max(1, int(pw*(1-overlap)))
    gmap = _gaussian_map_2d(patch_size)

    # Pad en Z y H si el volumen es más pequeño que el parche
    pad_z = max(0, ph-Z); pad_h = max(0, pw-H)
    if pad_z or pad_h:
        img_np = np.pad(img_np, [(0,pad_z),(0,pad_h),(0,0)], mode="reflect")
    ZP, HP = img_np.shape[0], img_np.shape[1]

    acc = np.zeros((N_CLASSES, ZP, HP, W), dtype=np.float32)
    wt  = np.zeros((ZP, HP, W),            dtype=np.float32)
    zs  = _sw_starts(ZP, ph, sh); hs = _sw_starts(HP, pw, sw)

    with torch.no_grad():
        for x_idx in range(W):
            x_prev = max(0, x_idx-1); x_next = min(W-1, x_idx+1)
            for z0 in zs:
                for h0 in hs:
                    # Parche extraído del plano sagital [Z, H]
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
    return acc[:, :Z, :H, :]   # trim padding


def sliding_window_coronal(model, img_np, patch_size=PATCH_SIZE_2D,
                            overlap=SW_OVERLAP, device=None):
    """
    Sliding window coronal - itera sobre y; sliding window en [Z, W].

    Para cada fila y del volumen:
      - Triplete: img[:, y-1, :], img[:, y, :], img[:, y+1, :]
      - Sliding window sobre el plano [Z, W] con parche [ph, pw]
      - Acumula en acc[:, :, y, :]

    Retorna: [N_CLASSES, Z, H, W]
    """
    if device is None: device = next(model.parameters()).device
    model.eval()
    Z, H, W = img_np.shape; ph, pw = patch_size
    sh = max(1, int(ph*(1-overlap))); sw = max(1, int(pw*(1-overlap)))
    gmap = _gaussian_map_2d(patch_size)

    pad_z = max(0, ph-Z); pad_w = max(0, pw-W)
    if pad_z or pad_w:
        img_np = np.pad(img_np, [(0,pad_z),(0,0),(0,pad_w)], mode="reflect")
    ZP, WP = img_np.shape[0], img_np.shape[2]

    acc = np.zeros((N_CLASSES, ZP, H, WP), dtype=np.float32)
    wt  = np.zeros((ZP, H, WP),            dtype=np.float32)
    zs  = _sw_starts(ZP, ph, sh); ws = _sw_starts(WP, pw, sw)

    with torch.no_grad():
        for y_idx in range(H):
            y_prev = max(0, y_idx-1); y_next = min(H-1, y_idx+1)
            for z0 in zs:
                for w0 in ws:
                    # Parche extraído del plano coronal [Z, W]
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
    return acc[:, :Z, :, :W]   # trim padding


def sliding_window_multiplane(model, img_np, patch_size=PATCH_SIZE_2D,
                               overlap=SW_OVERLAP, device=None,
                               plane_weights=PLANE_WEIGHTS_INFER):
    """
    Fusión ortogonal de los tres planos.

    Ejecuta los tres sliding windows independientemente y combina
    las probabilidades como promedio ponderado:

      P_fusion = w_ax·P_ax + w_sag·P_sag + w_cor·P_cor

    Retorna: [N_CLASSES, Z, H, W] probabilidades fusionadas
    """
    w_ax, w_sag, w_cor = plane_weights
    total_w = w_ax + w_sag + w_cor

    prob_ax  = sliding_window_axial(model, img_np, patch_size, overlap, device)
    prob_sag = sliding_window_sagital(model, img_np, patch_size, overlap, device)
    prob_cor = sliding_window_coronal(model, img_np, patch_size, overlap, device)

    return (w_ax * prob_ax + w_sag * prob_sag + w_cor * prob_cor) / total_w


def sliding_window_tta_multiplane(model, img_np, patch_size=PATCH_SIZE_2D,
                                   device=None,
                                   plane_weights=PLANE_WEIGHTS_INFER):
    """
    TTA + fusión multi-plano.

    TTA: original + flip H + flip W del volumen 3D.
    Para cada TTA, se ejecuta la inferencia multi-plano completa.
    Resultado: promedio de 3 TTA × 3 planos = 9 probabilidades.
    """
    preds = [sliding_window_multiplane(
        model, img_np, patch_size, SW_OVERLAP, device, plane_weights
    )]

    # Flip H (eje 1 del volumen 3D)
    fl_h = np.flip(img_np, axis=1).copy()
    p_h  = sliding_window_multiplane(model, fl_h, patch_size, SW_OVERLAP,
                                      device, plane_weights)
    preds.append(np.flip(p_h, axis=2).copy())   # revertir flip en eje H de prob

    # Flip W (eje 2 del volumen 3D)
    fl_w = np.flip(img_np, axis=2).copy()
    p_w  = sliding_window_multiplane(model, fl_w, patch_size, SW_OVERLAP,
                                      device, plane_weights)
    preds.append(np.flip(p_w, axis=3).copy())   # revertir flip en eje W de prob

    return np.mean(preds, axis=0)


# =============================================================================
# MÉTRICAS - IDÉNTICAS AL ORIGINAL
# =============================================================================

def dice_kidney(pred, lab):
    p = pred > 0; t = lab > 0
    i = np.logical_and(p, t).sum(); u = p.sum() + t.sum()
    return 2.0 * i / u if u > 0 else 1.0


def dice_tumor(pred, lab):
    p = pred == 2; t = lab == 2
    i = np.logical_and(p, t).sum(); u = p.sum() + t.sum()
    return 2.0 * i / u if u > 0 else 1.0


def composite(kd, td):
    return float(np.sqrt(kd * td))


# =============================================================================
# ENTRENAMIENTO
# =============================================================================

class EarlyStopping:
    def __init__(self, patience=150, min_delta=1e-4):
        self.patience = patience; self.min_delta = min_delta
        self.counter  = 0;       self.best       = None

    def __call__(self, score):
        if self.best is None or score > self.best + self.min_delta:
            self.best = score; self.counter = 0; return False
        self.counter += 1
        return self.counter >= self.patience


def poly_lr(epoch):
    return max((1.0 - epoch / EPOCHS) ** POLY_POWER, 1e-3)


def train_epoch(model, loader, optimizer, scaler, device, epoch):
    model.train(); total, steps = 0.0, 0
    for triplets, labels in loader:
        triplets = triplets.to(device); labels = labels.to(device)
        optimizer.zero_grad()
        with autocast():
            out  = model(triplets)
            loss = deep_supervision_loss(out, labels)
        scaler.scale(loss).backward()
        scaler.unscale_(optimizer)
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        scaler.step(optimizer); scaler.update()
        total += loss.item(); steps += 1
        if steps % 50 == 0:
            print(f"    Batch {steps}/{len(loader)} | Loss: {total/steps:.4f}")
    return total / max(steps, 1)


def validate(model, val_dataset, device):
    """
    Validación RÁPIDA durante el entrenamiento - solo plano axial.
    La validación con los 3 planos sería ×5 más lenta por época.
    La evaluación final usa sliding_window_multiplane.
    """
    model.eval(); kds, tds = [], []
    with torch.no_grad():
        for img, lab, _ in val_dataset.vols:
            prob = sliding_window_axial(model, img, PATCH_SIZE_2D, device=device)
            pred = np.argmax(prob, axis=0)
            kds.append(dice_kidney(pred, lab))
            tds.append(dice_tumor(pred, lab))
    return float(np.mean(kds)), float(np.mean(tds))


# =============================================================================
# EVALUACIÓN FINAL CON FUSIÓN MULTI-PLANO
# =============================================================================

def evaluate_test_ensemble(fold_models, test_data, device, use_tta=USE_TTA):
    """
    Test set con ensemble de 5 folds + fusión multi-plano (+ TTA opcional).
    """
    if not test_data:
        print("  No hay datos de test disponibles."); return {}, []

    print("\n" + "-" * 80)
    print(f"  EVALUACIÓN TEST SET ({len(test_data)} casos, ensemble 5 folds, "
          f"3 planos{'+ TTA' if use_tta else ''})")
    print("-" * 80)

    infer_fn = (sliding_window_tta_multiplane if use_tta
                else sliding_window_multiplane)
    kds, tds, results = [], [], []

    for d in test_data:
        cid = d["case_id"]
        img, lab = load_preprocess(d["image"], d["label"])
        print(f"  [{cid}]  inferencia multi-plano...", end="  ", flush=True)

        prob_sum = None
        for m in fold_models:
            m.eval()
            with torch.no_grad():
                p = infer_fn(m, img, PATCH_SIZE_2D, device=device)
            prob_sum = p if prob_sum is None else prob_sum + p

        pred = np.argmax(prob_sum / len(fold_models), axis=0)
        kd = dice_kidney(pred, lab); td = dice_tumor(pred, lab)
        kds.append(kd); tds.append(td)
        results.append({"case_id": cid, "kidney_dice": kd,
                        "tumor_dice": td, "composite_dice": composite(kd, td)})
        print(f"Kidney={kd:.4f}  Tumor={td:.4f}  Composite={composite(kd,td):.4f}")

    kd_m = float(np.mean(kds)); td_m = float(np.mean(tds))
    print(f"\n  TEST - Ensemble 5 folds, 3 planos:")
    print(f"    Kidney    : {kd_m:.4f} ± {np.std(kds):.4f}")
    print(f"    Tumor     : {td_m:.4f} ± {np.std(tds):.4f}")
    print(f"    Composite : {composite(kd_m, td_m):.4f}")

    pd.DataFrame(results).to_csv(
        f"{OUTPUT_DIR}/results/test_per_case.csv", index=False)
    summary = {"kidney": kd_m, "tumor": td_m,
               "composite": composite(kd_m, td_m),
               "kidney_std": float(np.std(kds)), "tumor_std": float(np.std(tds))}
    pd.DataFrame([summary]).to_csv(
        f"{OUTPUT_DIR}/results/test_summary.csv", index=False)
    return summary, results


def evaluate_lofo(fold_models, fold_data, device, use_tta=USE_TTA):
    """
    Leave-one-fold-out con fusión multi-plano — protocolo nnUNet.
    """
    print("\n" + "-" * 80)
    print("  EVALUACIÓN LEAVE-ONE-FOLD-OUT (3 planos, protocolo nnUNet)")
    print("-" * 80)

    infer_fn = (sliding_window_tta_multiplane if use_tta
                else sliding_window_multiplane)

    case_to_fold = {}
    for fi, fd in enumerate(fold_data):
        for d in fd["val"]: case_to_fold[d["case_id"]] = fi

    processed = {}
    for fd in fold_data:
        for d in fd["val"]:
            cid = d["case_id"]
            if cid not in processed:
                processed[cid] = load_preprocess(d["image"], d["label"])

    all_res = []; kds_s, tds_s, kds_e, tds_e = [], [], [], []

    for cid, (img, lab) in sorted(processed.items()):
        fi = case_to_fold[cid]; m = fold_models[fi]; m.eval()

        # Single model (protocolo nnUNet)
        with torch.no_grad():
            prob = infer_fn(m, img, PATCH_SIZE_2D, device=device)
        pred = np.argmax(prob, axis=0)
        kd_s = dice_kidney(pred, lab); td_s = dice_tumor(pred, lab)
        kds_s.append(kd_s); tds_s.append(td_s)

        # Ensemble otros 4 folds
        others = [mm for i, mm in enumerate(fold_models) if i != fi]
        prob_sum = None
        for mm in others:
            mm.eval()
            with torch.no_grad():
                p = infer_fn(mm, img, PATCH_SIZE_2D, device=device)
            prob_sum = p if prob_sum is None else prob_sum + p
        pred_e = np.argmax(prob_sum / len(others), axis=0)
        kd_e = dice_kidney(pred_e, lab); td_e = dice_tumor(pred_e, lab)
        kds_e.append(kd_e); tds_e.append(td_e)

        print(f"  {cid} [fold{fi}]  "
              f"single -> K={kd_s:.4f} T={td_s:.4f} C={composite(kd_s,td_s):.4f}  |  "
              f"ens4 -> K={kd_e:.4f} T={td_e:.4f} C={composite(kd_e,td_e):.4f}")

        all_res.append({
            "case_id": cid, "val_fold": fi,
            "kidney_single": kd_s, "tumor_single": td_s,
            "composite_single": composite(kd_s, td_s),
            "kidney_ens4":   kd_e, "tumor_ens4":   td_e,
            "composite_ens4": composite(kd_e, td_e),
        })

    kd_s_m = float(np.mean(kds_s)); td_s_m = float(np.mean(tds_s))
    kd_e_m = float(np.mean(kds_e)); td_e_m = float(np.mean(tds_e))

    print("\n" + "=" * 80)
    print("  RESULTADOS FINALES (3 planos):")
    print()
    print("  Single model (fold de validación, protocolo nnUNet):")
    print(f"    Kidney    : {kd_s_m:.4f} ± {np.std(kds_s):.4f}")
    print(f"    Tumor     : {td_s_m:.4f} ± {np.std(tds_s):.4f}")
    print(f"    Composite : {composite(kd_s_m, td_s_m):.4f}")
    print()
    print("  Ensemble 4 folds (ningún modelo vio el caso):")
    print(f"    Kidney    : {kd_e_m:.4f} ± {np.std(kds_e):.4f}")
    print(f"    Tumor     : {td_e_m:.4f} ± {np.std(tds_e):.4f}")
    print(f"    Composite : {composite(kd_e_m, td_e_m):.4f}")
    print("=" * 80)

    pd.DataFrame(all_res).to_csv(
        f"{OUTPUT_DIR}/results/lofo_per_case.csv", index=False)
    summary = {
        "kidney_single":    kd_s_m, "tumor_single":    td_s_m,
        "composite_single": composite(kd_s_m, td_s_m),
        "kidney_ens4":      kd_e_m, "tumor_ens4":      td_e_m,
        "composite_ens4":   composite(kd_e_m, td_e_m),
    }
    pd.DataFrame([summary]).to_csv(
        f"{OUTPUT_DIR}/results/lofo_summary.csv", index=False)
    return summary


# =============================================================================
# MAIN
# =============================================================================

def main():
    try:
        # Carga exacta: sincroniza IDs del JSON con archivos físicos en imagesTr/labelsTr
        fold_data, test_data = load_splits_exact(NNUNET_SPLITS, DATA_DIR, LABEL_DIR)
        
        # Definimos N_FOLDS según los datos cargados
        N_FOLDS = len(fold_data)
        
        print(f"\n Splits cargados correctamente: {N_FOLDS} folds encontrados.")
        print(f" Casos totales en imagesTr disponibles para Train/Val: {len(test_data) + sum(len(f['val']) for f in fold_data)}")
    except Exception as e:
        print(f"\nError crítico al cargar splits: {e}")
        return

    all_fold_results = [];
    trained_models = []

    # Bucle de entrenamiento por Fold
    for fold in range(N_FOLDS):
        print("\n" + "=" * 80)
        print(f"  FOLD {fold+1}/{N_FOLDS}  "
              f"(train={len(fold_data[fold]['train'])}  "
              f"val={len(fold_data[fold]['val'])})")
        print("=" * 80)

        # Preparación de Datasets usando la lógica de nnU-Net
        train_ds = RyC25DDataset(fold_data[fold]["train"], is_train=True)
        val_ds   = RyC25DDataset(fold_data[fold]["val"],   is_train=False)
        
        train_loader = DataLoader(
            train_ds, batch_size=BATCH_SIZE, shuffle=True,
            num_workers=4, pin_memory=True, drop_last=True
        )

	# Construcción del modelo CSA-2.5D Multiplane
        model     = build_model().to(DEVICE)
        optimizer = torch.optim.SGD(model.parameters(), lr=LR_INIT,
                                    momentum=MOMENTUM, weight_decay=WEIGHT_DECAY,
                                    nesterov=True)
        scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, poly_lr)
        scaler    = GradScaler()
        stopper   = EarlyStopping(patience=150)

        best_tumor = -1.0
        best_kidney = 0.0
        best_epoch = 0    
        best_state  = None
        history = []   
        t0 = time.time()

	# Ciclo de Épocas
        for epoch in range(1, EPOCHS + 1):
            loss_train = train_epoch(model, train_loader, optimizer, scaler, DEVICE, epoch)
            scheduler.step()

            # Validación rápida (solo axial) para no ralentizar el entrenamiento
            kd, td = validate(model, val_ds, DEVICE)
            lr  = optimizer.param_groups[0]["lr"]
            ela = (time.time() - t0) / 60.0

            print(f"  Época {epoch:>4}/{EPOCHS} | Loss: {loss_train:.4f} | "
                  f"Kidney(ax): {kd:.4f} | Tumor(ax): {td:.4f} | "
                  f"Composite: {composite(kd,td):.4f} | "
                  f"LR: {lr:.2e} | {ela:.1f}min")
            history.append({"epoch": epoch, "loss": loss_train, "kidney_ax": kd, "tumor_ax": td, "lr": lr})

            # Guardar mejor modelo basado en Dice de Tumor
            if td > best_tumor:
                best_tumor  = td
                best_kidney = kd
                best_epoch = epoch
                best_state  = {k: v.cpu().clone() for k, v in model.state_dict().items()}
                
                torch.save({
                    "epoch": epoch, "fold": fold,
                    "arch": "CSANet25D_MultiPlane",
                    "spacing": TARGET_SPACING, "patch_2d": PATCH_SIZE_2D,
                    "plane_weights_train": PLANE_WEIGHTS_TRAIN,
                    "plane_weights_infer": PLANE_WEIGHTS_INFER,
                    "model_state_dict": model.state_dict(),
                    "tumor_dice_ax": td, "kidney_dice_ax": kd,
                }, f"{OUTPUT_DIR}/checkpoints/fold_{fold}_best.pth")
                print(f">>> Nuevo mejor (axial) — Kidney={kd:.4f}  "
                      f"Tumor={td:.4f}  Composite={composite(kd,td):.4f}")

            if stopper(td):
                print(f"\n  Early stopping en época {epoch}")
                break

	# Guardar log del fold y limpiar memoria
        pd.DataFrame(history).to_csv(
            f"{OUTPUT_DIR}/logs/fold_{fold}_history.csv", index=False)

        if best_state is not None:
            model.load_state_dict({k: v.to(DEVICE) for k, v in best_state.items()})
        
        trained_models.append(model)
        all_fold_results.append({
            "fold": fold, "best_epoch": best_epoch,
            "kidney_val_ax": best_kidney, "tumor_val_ax": best_tumor,
            "composite_val_ax": composite(best_kidney, best_tumor),
        })
        
        print(f"\n  [Fold {fold+1}]  "
              f"Kidney(ax)={best_kidney:.4f}  Tumor(ax)={best_tumor:.4f}  "
              f"Composite(ax)={composite(best_kidney, best_tumor):.4f}  "
              f"(época {best_epoch})")
        torch.cuda.empty_cache()

    # Resumen k-fold (axial, para comparación directa durante entrenamiento) 
    df = pd.DataFrame(all_fold_results)
    df.to_csv(f"{OUTPUT_DIR}/results/kfold_val_summary.csv", index=False)
    kd_val_m = df["kidney_val_ax"].mean(); td_val_m = df["tumor_val_ax"].mean()

    print("\n" + "=" * 80)
    print("  RESUMEN K-FOLD VALIDACIÓN (axial, protocolo rápido durante entrenamiento):")
    print(f"    Kidney    : {kd_val_m:.4f} ± {df['kidney_val_ax'].std():.4f}")
    print(f"    Tumor     : {td_val_m:.4f} ± {df['tumor_val_ax'].std():.4f}")
    print(f"    Composite : "
          f"{df['composite_val_ax'].mean():.4f} ± {df['composite_val_ax'].std():.4f}")
    print("=" * 80)

    # Evaluación test set (multi-plano)
    print("\n  Evaluación en TEST SET (kidney_063-077, 3 planos)...")
    test_summary, _ = evaluate_test_ensemble(trained_models, test_data, DEVICE)

    # Evaluación LOFO (multi-plano, protocolo nnUNet)
    print("\n  Evaluación Leave-One-Fold-Out (3 planos)...")
    lofo_summary = evaluate_lofo(trained_models, fold_data, DEVICE, use_tta=USE_TTA)

    # Tabla comparativa
    lofo_kd = lofo_summary.get("kidney_single", float("nan"))
    lofo_td = lofo_summary.get("tumor_single",  float("nan"))

    print("\n" + "=" * 80)
    if test_summary:
        print(f"  {'CSA-Net 2.5D multi-plano (test)':<42} "
              f"{test_summary['kidney']:>8.4f} "
              f"{test_summary['tumor']:>8.4f} "
              f"{test_summary['composite']:>10.4f}")
    print("=" * 80)
    print(f"\n  Resultados guardados en: {OUTPUT_DIR}/")


if __name__ == "__main__":
    main()
