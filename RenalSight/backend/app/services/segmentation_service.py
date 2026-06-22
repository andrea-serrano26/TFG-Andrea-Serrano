"""
segmentation_service.py - Pipeline con localizador externo (TotalSegmentator / fallback)
Fase 1: TotalSegmentator localiza los riñones en el volumen original (~30-60 s)
Fase 2: KiTSUNet solo en la ROI del riñón afectado, a 1mm isotropico (~2-4 min)
Tiempo total estimado en M1: < 5 minutos
"""

from __future__ import annotations
import logging
import os
import platform
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from scipy import ndimage

from app.services.localizer import locate_kidneys_with_totalseg, expand_bbox

logger = logging.getLogger(__name__)

#-------------------------------------------------------------------------------
# CONSTANTES — IDÉNTICAS AL ENTRENAMIENTO

TARGET_SPACING = (1.0, 1.0, 1.0)
HU_CLIP_MIN    = -64.35255432128906
HU_CLIP_MAX    = 273.7598571777344
NORM_MEAN      = 120.24785614013672
NORM_STD       = 65.7291259765625
PATCH_SIZE     = (112, 112, 192)
N_CLASSES      = 3
ROI_MARGIN_MM  = 80   # 30mm era insuficiente

#-------------------------------------------------------------------------------

#-------------------------------------------------------------------------------
# CONFIGURACIÓN DE OVERLAP Y TTA
# En CPU puro se usa 0.25 para mantener el tiempo en ~5-7 min.
_IS_APPLE_SILICON = platform.machine() == "arm64" and platform.system() == "Darwin"
OVERLAP_GPU = 0.50   # CUDA o MPS — rápido, misma calidad que entrenamiento
OVERLAP_CPU = 0.25   # CPU puro — compromiso velocidad/calidad
USE_TTA     = False  # Desactivado 

#-------------------------------------------------------------------------------

_HERE = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR          = os.environ.get("KITS_MODELS_DIR", os.path.join(_HERE, "models", "kits_winner"))
CHECKPOINT_TEMPLATE = "fold_{fold}_best.pth"
N_FOLDS = 5

class ModelNotFoundError(RuntimeError): pass

#-------------------------------------------------------------------------------
# ARQUITECTURA UNET 3D RESIDUAL (idéntica a la de entrenamiento)

class ConvNormAct(nn.Module):
    def __init__(self, in_ch, out_ch, kernel=3, stride=1, act="lrelu"):
        super().__init__()
        self.conv = nn.Conv3d(in_ch, out_ch, kernel, stride=stride, padding=kernel//2, bias=False)
        self.norm = nn.InstanceNorm3d(out_ch, affine=True)
        self.act  = nn.LeakyReLU(0.01, inplace=True) if act == "lrelu" else nn.ReLU(inplace=True)
    def forward(self, x): return self.act(self.norm(self.conv(x)))

class ResBlock(nn.Module):
    def __init__(self, in_ch, out_ch, stride=1):
        super().__init__()
        self.c1 = nn.Conv3d(in_ch, out_ch, 3, stride=stride, padding=1, bias=False)
        self.n1 = nn.InstanceNorm3d(out_ch, affine=True); self.a1 = nn.ReLU(inplace=True)
        self.c2 = nn.Conv3d(out_ch, out_ch, 3, stride=1,    padding=1, bias=False)
        self.n2 = nn.InstanceNorm3d(out_ch, affine=True); self.a2 = nn.ReLU(inplace=True)
        self.skip = (
            nn.Sequential(
                nn.Conv3d(in_ch, out_ch, 1, stride=stride, bias=False),
                nn.InstanceNorm3d(out_ch, affine=True),
            ) if in_ch != out_ch or stride != 1 else nn.Identity()
        )
    def forward(self, x):
        r = self.skip(x)
        x = self.a1(self.n1(self.c1(x)))
        x = self.n2(self.c2(x))
        return self.a2(x + r)

class KiTSUNet(nn.Module):
    def __init__(self, arch="residual", in_ch=1, out_ch=N_CLASSES, init_f=24, max_f=320, n_levels=4):
        super().__init__()
        self.n_levels = n_levels
        feats = [min(init_f * (2 ** i), max_f) for i in range(n_levels + 1)]
        self.enc  = nn.ModuleList()
        self.down = nn.ModuleList()
        self.enc.append(nn.Sequential(ResBlock(in_ch, feats[0])))
        for lvl in range(n_levels):
            self.down.append(nn.Sequential(
                nn.Conv3d(feats[lvl], feats[lvl+1], 3, stride=2, padding=1, bias=False),
                nn.InstanceNorm3d(feats[lvl+1], affine=True),
                nn.ReLU(inplace=True),
            ))
            self.enc.append(nn.Sequential(*[ResBlock(feats[lvl+1], feats[lvl+1]) for _ in range(lvl+2)]))
        self.up      = nn.ModuleList()
        self.dec     = nn.ModuleList()
        self.ds_head = nn.ModuleList()
        for lvl in range(n_levels - 1, -1, -1):
            self.up.append(nn.ConvTranspose3d(feats[lvl+1], feats[lvl], 2, stride=2))
            self.dec.append(ConvNormAct(feats[lvl] * 2, feats[lvl], act="relu"))
            self.ds_head.append(nn.Conv3d(feats[lvl], out_ch, 1))

    def forward(self, x):
        skips = []; out = self.enc[0](x); skips.append(out)
        for lvl in range(self.n_levels):
            out = self.down[lvl](out); out = self.enc[lvl+1](out)
            if lvl < self.n_levels - 1: skips.append(out)
        ds = []
        for i, (up, dec, head) in enumerate(zip(self.up, self.dec, self.ds_head)):
            out = up(out); skip = skips[-(i+1)]
            if out.shape != skip.shape:
                out = F.interpolate(out, size=skip.shape[2:], mode="trilinear", align_corners=False)
            out = torch.cat([out, skip], dim=1); out = dec(out); ds.append(head(out))
        return ds[::-1]

#-------------------------------------------------------------------------------

#-------------------------------------------------------------------------------
# DISPOSITIVO

def _get_device() -> torch.device:
    if torch.cuda.is_available():
        return torch.device("cuda")
    # Cadena de prioridad: CUDA > MPS > CPU
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")

def _empty_cache(device: torch.device):
    if device.type == "cuda":
        torch.cuda.empty_cache()
    elif device.type == "mps":
        torch.mps.empty_cache()

def _load_checkpoint(fold: int) -> KiTSUNet:
    """Carga el checkpoint de KiTSUNet para un fold específico."""
    path = os.path.join(MODELS_DIR, CHECKPOINT_TEMPLATE.format(fold=fold))
    if not os.path.isfile(path):
        raise ModelNotFoundError(f"Falta checkpoint: {path}")
    device = _get_device()
    ckpt   = torch.load(path, map_location=device, weights_only=False) # map_location evita error en MPS si el checkpoint fue guardado en CUDA
                                                                       # weights_only=False evita error en MPS si el checkpoint fue guardado en CPU
    model  = KiTSUNet().to(device)
    model.load_state_dict(ckpt.get("model_state_dict", ckpt))
    model.eval()
    return model

#-------------------------------------------------------------------------------

#-------------------------------------------------------------------------------
# SLIDING WINDOW

def _gaussian_map(patch_size):
    """Genera un mapa de pesos gaussianos 3D para ponderar los parches en la inferencia."""
    def g1d(n):
        s = n / 8.0; x = np.arange(n) - n // 2
        w = np.exp(-0.5 * (x / s) ** 2); return (w / w.max()).astype(np.float32)
    gz, gy, gx = g1d(patch_size[0]), g1d(patch_size[1]), g1d(patch_size[2])
    return gz[:, None, None] * gy[None, :, None] * gx[None, None, :]

def _sliding_window_single(model, img_np: np.ndarray, patch_size=PATCH_SIZE,
                           overlap: float = OVERLAP_GPU) -> np.ndarray:
    """
    Sliding window idéntico a generate_masks_3d.py:
    - Padding con mode='reflect' (igual que training)
    - Strip del padding en el resultado final
    - Gaussian weighting
    """
    device = next(model.parameters()).device
    H, W, D = img_np.shape
    ph, pw, pd = patch_size

    # Padding reflect si el volumen es más pequeño que el patch (igual que training)
    ph_p = max(0, ph - H); pw_p = max(0, pw - W); pd_p = max(0, pd - D)
    if ph_p or pw_p or pd_p:
        img_np = np.pad(img_np, [(0, ph_p), (0, pw_p), (0, pd_p)], mode="reflect")
    HP, WP, DP = img_np.shape

    sh = max(1, int(ph * (1 - overlap)))
    sw = max(1, int(pw * (1 - overlap)))
    sd = max(1, int(pd * (1 - overlap)))

    def starts(total, p, s):
        lst = list(range(0, total - p + 1, s))
        if not lst or lst[-1] + p < total:
            lst.append(max(0, total - p))
        return sorted(set(lst))

    zs = starts(HP, ph, sh)
    ys = starts(WP, pw, sw)
    xs = starts(DP, pd, sd)

    gmap = _gaussian_map(patch_size)
    acc  = np.zeros((N_CLASSES, HP, WP, DP), dtype=np.float32)
    wt   = np.zeros((HP, WP, DP), dtype=np.float32)
    #total_patches = len(zs) * len(ys) * len(xs)

    with torch.no_grad():
        for z0 in zs:
            for y0 in ys:
                for x0 in xs:
                    patch = img_np[z0:z0+ph, y0:y0+pw, x0:x0+pd]
                    # torch.tensor() no acepta arrays no-contiguos en MPS.
                    # np.ascontiguousarray garantiza memoria contigua antes de la conversión.
                    t     = torch.from_numpy(
                                np.ascontiguousarray(patch[None, None], dtype=np.float32)
                            ).to(device)
                    out   = model(t)
                    out   = out[0] if isinstance(out, (list, tuple)) else out
                    prob  = torch.softmax(out, dim=1).squeeze(0).cpu().numpy()
                    acc[:, z0:z0+ph, y0:y0+pw, x0:x0+pd] += prob * gmap
                    wt[      z0:z0+ph, y0:y0+pw, x0:x0+pd] += gmap

    acc /= np.maximum(wt[None], 1e-8)
    return acc[:, :H, :W, :D]  # strip padding


def sliding_window(model, img_np: np.ndarray, overlap: float = OVERLAP_GPU,
                   progress_fn=None) -> np.ndarray:
    """
    Sliding window con TTA opcional.
    En M1 USE_TTA=False (evita segfault por np.flip sobre arrays grandes).
    En GPU USE_TTA=True (igual que generate_masks_3d.py).

    La TTA usa suma acumulada en lugar de lista de arrays para reducir
    el pico de memoria de 4×N a 2×N (solo el acumulador + el array actual).
    """
    if not USE_TTA:
        if progress_fn: progress_fn("Sliding window (sin TTA)...")
        return _sliding_window_single(model, img_np, overlap=overlap)

    # TTA: original + 3 flips axiales
    # Se usa suma acumulada (no lista) para evitar 4 copias simultáneas en RAM
    if progress_fn: progress_fn("TTA 1/4 (original)...")
    prob_sum = _sliding_window_single(model, img_np, overlap=overlap)

    for i, ax in enumerate((0, 1, 2)):
        if progress_fn: progress_fn(f"TTA {i+2}/4 (flip eje {ax})...")
        fl   = np.flip(img_np, axis=ax).copy()
        pred = _sliding_window_single(model, fl, overlap=overlap)
        # Deshacer el flip en el eje de clases (ax+1 porque eje 0 = clases)
        pred = np.flip(pred, axis=ax + 1).copy()
        prob_sum += pred
        del fl, pred   # liberar inmediatamente

    return prob_sum / 4.0

#-------------------------------------------------------------------------------
# PIPELINE PRINCIPAL

def run_segmentation(volume_hu: np.ndarray, spacing: tuple,
                     use_ensemble: bool = False, use_tta: bool = False,
                     return_kidney: bool = False, progress_fn=None) -> np.ndarray:
    """
    Pipeline en dos fases:
      Fase 1: TotalSegmentator localiza el riñón afectado (~30-60 s)
      Fase 2: KiTSUNet segmenta el tumor solo en la ROI del riñón (~2-4 min)

    El bbox de TotalSegmentator está en el espacio del volumen ORIGINAL.
    Se convierte correctamente al espacio ISO (1mm/vóxel) antes de recortar vol_norm.
    """
    def _progress(msg: str):
        logger.info(msg)
        if progress_fn: progress_fn(msg)

    device  = _get_device()
    overlap = OVERLAP_GPU if device.type in ("cuda", "mps") else OVERLAP_CPU
    _progress(f"[SEG] Dispositivo: {device} | overlap={overlap} | TTA={USE_TTA}")

    # 1. Resampleo a 1 mm isotropico 
    _progress("[SEG] Resampleando a 1 mm isotropico...")
    sz, sy, sx = spacing
    zoom_fwd = (sz / TARGET_SPACING[0], sy / TARGET_SPACING[1], sx / TARGET_SPACING[2])
    vol_iso  = ndimage.zoom(volume_hu, zoom_fwd, order=1, prefilter=False)
    vol_norm = (np.clip(vol_iso, HU_CLIP_MIN, HU_CLIP_MAX) - NORM_MEAN) / NORM_STD
    logger.info(f"[SEG] Vol iso: {vol_iso.shape}")

    # 2. Localizar riñones (TotalSegmentator o fallback)
    _progress("[SEG] Localizando riñones...")
    loc = locate_kidneys_with_totalseg(volume_hu, spacing)

    if not loc["success"] or (loc["left"] is None and loc["right"] is None):
        _progress("[SEG] No se encontraron riñones — máscara vacía")
        return np.zeros(volume_hu.shape, dtype=np.uint8)

    # 3. Fusionar todos los riñones en un único ROI combinado
    bboxes = [b for b in [loc["left"], loc["right"]] if b is not None]
    if not bboxes:
        _progress("[SEG] No se encontraron riñones — máscara vacía")
        return np.zeros(volume_hu.shape, dtype=np.uint8)

    merged = (min(b[0] for b in bboxes), max(b[1] for b in bboxes),
              min(b[2] for b in bboxes), max(b[3] for b in bboxes),
              min(b[4] for b in bboxes), max(b[5] for b in bboxes))
    _progress(f"[SEG] {len(bboxes)} riñón/es → bbox combinado: {merged}")

    # 4. Expandir -> convertir a espacio ISO 
    z0o, z1o, y0o, y1o, x0o, x1o = expand_bbox(merged, ROI_MARGIN_MM, spacing)
    Z, Y, X = vol_norm.shape
    z0 = max(0, int(z0o * sz));  z1 = min(Z, int(np.ceil(z1o * sz)))
    y0 = max(0, int(y0o * sy));  y1 = min(Y, int(np.ceil(y1o * sy)))
    x0 = max(0, int(x0o * sx));  x1 = min(X, int(np.ceil(x1o * sx)))

    # Garantía: ROI ≥ PATCH_SIZE en cada dimensión (casos extremos)
    ph, pw, pd = PATCH_SIZE
    if z1-z0 < ph: mid=(z0+z1)//2; z0=max(0,mid-ph//2); z1=min(Z,z0+ph)
    if y1-y0 < pw: mid=(y0+y1)//2; y0=max(0,mid-pw//2); y1=min(Y,y0+pw)
    if x1-x0 < pd: mid=(x0+x1)//2; x0=max(0,mid-pd//2); x1=min(X,x0+pd)

    _progress(f"[SEG] ROI iso: Z[{z0}-{z1}]({z1-z0}v) Y[{y0}-{y1}]({y1-y0}v) X[{x0}-{x1}]({x1-x0}v)")

    # 5. Recortar (padding reflect solo si la garantía anterior falla) 
    vol_crop = vol_norm[z0:z1, y0:y1, x0:x1].copy()
    ch, cw, cd = vol_crop.shape
    if ch < ph or cw < pw or cd < pd:
        vol_crop = np.pad(
            vol_crop,
            ((0, max(0,ph-ch)), (0, max(0,pw-cw)), (0, max(0,pd-cd))),
            mode="reflect",
        )
        _progress(f"[SEG] Padding reflect: {(ch,cw,cd)} → {vol_crop.shape}")

    # 6. Inferencia 
    _progress("[SEG] Cargando KiTSUNet fold 0...")
    model = _load_checkpoint(0)
    _progress(f"[SEG] Sliding window (overlap={overlap})...")
    prob = sliding_window(model, vol_crop, overlap=overlap, progress_fn=progress_fn)
    del model
    _empty_cache(device)

    # 7. Pegar resultado 
    pred_crop = np.argmax(prob, axis=0).astype(np.uint8)[:ch, :cw, :cd]
    mask_iso  = np.zeros(vol_iso.shape, dtype=np.uint8)
    mask_iso[z0:z1, y0:y1, x0:x1] = pred_crop
    _progress(f"[SEG] Vóxeles tumor en ROI: {int((pred_crop==2).sum())}")

    # 8. Revertir al espacio original 
    zoom_back      = tuple(1.0 / z for z in zoom_fwd)
    tumor_iso      = (mask_iso == 2).astype(np.float32) # Solo el tumor (clase 2)
    tumor_rev      = ndimage.zoom(tumor_iso, zoom_back, order=0)

    res = np.zeros(volume_hu.shape, dtype=np.uint8)
    s   = tuple(slice(0, min(a, b)) for a, b in zip(tumor_rev.shape, volume_hu.shape))
    res[s] = (tumor_rev[s] > 0.5).astype(np.uint8) * 2

    n_tumor = int((res == 2).sum())
    _progress(f"[SEG] COMPLETADO — vóxeles tumor: {n_tumor}")
    return res