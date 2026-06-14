#!/usr/bin/env python3
"""
generate_masks_3d.py  —  Genera máscaras de segmentación para el test set
======================================================================

Carga los 5 modelos entrenados (UNet 3D Residual) desde
kits_winner/checkpoints/fold_{0-4}_best.pth y genera la predicción
de ensemble para cada caso del test set (kidney_063-077).

Las máscaras guardadas tienen EXACTAMENTE las mismas dimensiones y
affine que la imagen original, por lo que se pueden superponer
directamente en ITK-SNAP o 3D Slicer sin ningún paso adicional.

Clases en la máscara de salida:
  0 → fondo
  1 → riñón (parénquima, sin tumor)
  2 → tumor renal

Salida:
  masks_test/
    kidney_001_pred.nii.gz
    kidney_001_gt.nii.gz       ← ground truth en espacio original
    ...

Uso:
  python3 generate_masks.py
  python3 generate_masks.py --data_dir ./data_cropped --ckpt_dir ./kits_winner/checkpoints
"""

import os, json, argparse, warnings
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
CKPT_DIR    = "./kits_winner/checkpoints"
OUTPUT_DIR  = "./masks_test"


# Preprocesamiento (extraído de nnUNetPlans.json 3d_fullres)
TARGET_SPACING = (1.0, 1.0, 1.0)           # original_median_spacing_after_transp
HU_CLIP_MIN    = -64.35255432128906        # foreground percentile_00_5
HU_CLIP_MAX    = 273.7598571777344         # foreground percentile_99_5
NORM_MEAN      = 120.24785614013672        # foreground mean
NORM_STD       = 65.7291259765625          # foreground std

# Arquitectura
ARCH          = "residual"
PATCH_SIZE    = (112, 112, 192)
N_CLASSES     = 3
INIT_FEATURES = 24 if ARCH != "plain" else 30
MAX_FEATURES  = 320
N_LEVELS      = 4
SW_OVERLAP    = 0.5
USE_TTA       = True

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")

os.makedirs(OUTPUT_DIR, exist_ok=True)


# =============================================================================
# ARQUITECTURA (copia exacta del script de entrenamiento)
# =============================================================================

class ConvNormAct(nn.Module):
    def __init__(self, in_ch, out_ch, kernel=3, stride=1, act="lrelu"):
        super().__init__()
        self.conv = nn.Conv3d(in_ch, out_ch, kernel, stride=stride,
                              padding=kernel//2, bias=False)
        self.norm = nn.InstanceNorm3d(out_ch, affine=True)
        self.act  = (nn.LeakyReLU(0.01, inplace=True) if act == "lrelu"
                     else nn.ReLU(inplace=True))
    def forward(self, x):
        return self.act(self.norm(self.conv(x)))


class PlainBlock(nn.Module):
    def __init__(self, in_ch, out_ch, stride=1):
        super().__init__()
        self.seq = nn.Sequential(
            ConvNormAct(in_ch,  out_ch, stride=stride, act="lrelu"),
            ConvNormAct(out_ch, out_ch, stride=1,      act="lrelu"),
        )
    def forward(self, x): return self.seq(x)


class ResBlock(nn.Module):
    def __init__(self, in_ch, out_ch, stride=1):
        super().__init__()
        self.c1 = nn.Conv3d(in_ch,  out_ch, 3, stride=stride, padding=1, bias=False)
        self.n1 = nn.InstanceNorm3d(out_ch, affine=True); self.a1 = nn.ReLU(inplace=True)
        self.c2 = nn.Conv3d(out_ch, out_ch, 3, stride=1,      padding=1, bias=False)
        self.n2 = nn.InstanceNorm3d(out_ch, affine=True); self.a2 = nn.ReLU(inplace=True)
        self.skip = (nn.Sequential(
                         nn.Conv3d(in_ch, out_ch, 1, stride=stride, bias=False),
                         nn.InstanceNorm3d(out_ch, affine=True))
                     if in_ch != out_ch or stride != 1 else nn.Identity())
    def forward(self, x):
        r = self.skip(x); x = self.a1(self.n1(self.c1(x)))
        x = self.n2(self.c2(x)); return self.a2(x + r)


class PreActResBlock(nn.Module):
    def __init__(self, in_ch, out_ch, stride=1):
        super().__init__()
        self.n1=nn.InstanceNorm3d(in_ch, affine=True);  self.a1=nn.ReLU(inplace=True)
        self.c1=nn.Conv3d(in_ch,  out_ch,3,stride=stride,padding=1,bias=False)
        self.n2=nn.InstanceNorm3d(out_ch,affine=True);  self.a2=nn.ReLU(inplace=True)
        self.c2=nn.Conv3d(out_ch, out_ch,3,stride=1,    padding=1,bias=False)
        self.skip=(nn.Conv3d(in_ch,out_ch,1,stride=stride,bias=False)
                   if in_ch!=out_ch or stride!=1 else nn.Identity())
    def forward(self, x):
        r=self.skip(x); x=self.c1(self.a1(self.n1(x))); x=self.c2(self.a2(self.n2(x)))
        return x+r


class KiTSUNet(nn.Module):
    def __init__(self, arch=ARCH, in_ch=1, out_ch=N_CLASSES,
                 init_f=None, max_f=MAX_FEATURES, n_levels=N_LEVELS):
        super().__init__()
        self.arch=arch; self.n_levels=n_levels
        if init_f is None: init_f = 30 if arch=="plain" else 24
        feats = [min(init_f*(2**i), max_f) for i in range(n_levels+1)]
        self.feats = feats

        self.enc = nn.ModuleList(); self.down = nn.ModuleList()
        self.enc.append(self._enc_block(in_ch, feats[0], n=1, stride=1))
        for lvl in range(n_levels):
            act = "lrelu" if arch=="plain" else "relu"
            self.down.append(nn.Sequential(
                nn.Conv3d(feats[lvl], feats[lvl+1], 3, stride=2, padding=1, bias=False),
                nn.InstanceNorm3d(feats[lvl+1], affine=True),
                nn.LeakyReLU(0.01,inplace=True) if act=="lrelu" else nn.ReLU(inplace=True),
            ))
            n_blk = 1 if arch=="plain" else (lvl+2)
            self.enc.append(self._enc_block(feats[lvl+1], feats[lvl+1], n=n_blk, stride=1))

        self.up=nn.ModuleList(); self.dec=nn.ModuleList(); self.ds_head=nn.ModuleList()
        for lvl in range(n_levels-1,-1,-1):
            self.up.append(nn.ConvTranspose3d(feats[lvl+1], feats[lvl], 2, stride=2))
            n_dec=2 if arch=="plain" else 1
            act_d="lrelu" if arch=="plain" else "relu"
            self.dec.append(self._dec_block(feats[lvl]*2, feats[lvl], n=n_dec, act=act_d))
            self.ds_head.append(nn.Conv3d(feats[lvl], out_ch, 1))
        self._init_weights()

    def _enc_block(self, in_ch, out_ch, n, stride):
        if self.arch=="plain": return PlainBlock(in_ch, out_ch, stride=stride)
        blks, ic = [], in_ch
        Cls = ResBlock if self.arch=="residual" else PreActResBlock
        for i in range(n):
            blks.append(Cls(ic, out_ch, stride=(stride if i==0 else 1))); ic=out_ch
        return nn.Sequential(*blks)

    def _dec_block(self, in_ch, out_ch, n, act):
        if n==1: return ConvNormAct(in_ch, out_ch, act=act)
        return nn.Sequential(ConvNormAct(in_ch,out_ch,act=act), ConvNormAct(out_ch,out_ch,act=act))

    def _init_weights(self):
        for m in self.modules():
            if isinstance(m,(nn.Conv3d,nn.ConvTranspose3d)):
                nn.init.kaiming_normal_(m.weight,mode="fan_out",nonlinearity="relu")
                if m.bias is not None: nn.init.zeros_(m.bias)
            elif isinstance(m,nn.InstanceNorm3d):
                if m.weight is not None: nn.init.ones_(m.weight)
                if m.bias   is not None: nn.init.zeros_(m.bias)

    def forward(self, x):
        skips=[]; out=self.enc[0](x); skips.append(out)
        for lvl in range(self.n_levels):
            out=self.down[lvl](out); out=self.enc[lvl+1](out)
            if lvl < self.n_levels-1: skips.append(out)
        ds_outs=[]
        for i,(up,dec,head) in enumerate(zip(self.up,self.dec,self.ds_head)):
            out=up(out); skip=skips[-(i+1)]
            if out.shape!=skip.shape:
                out=F.interpolate(out,size=skip.shape[2:],mode="trilinear",align_corners=False)
            out=torch.cat([out,skip],dim=1); out=dec(out); ds_outs.append(head(out))
        # Invertir: el decoder construye ds_outs de menor a mayor resolucion.
        # Al invertir, ds_outs[0] = resolución completa (mayor detalle) ->
        # DS_WEIGHTS[0]=1.0 pondera el nivel mas detallado y sliding_window
        # usa out[0] correctamente (shape = patch_size completo).
        return ds_outs[::-1]


# =============================================================================
# CARGA DE CHECKPOINTS
# =============================================================================

def load_fold_model(fold, ckpt_dir, device):
    """Carga el modelo del fold indicado desde su checkpoint."""
    ckpt_path = os.path.join(ckpt_dir, f"fold_{fold}_best.pth")
    if not os.path.exists(ckpt_path):
        raise FileNotFoundError(f"No se encontró el checkpoint: {ckpt_path}")

    ckpt  = torch.load(ckpt_path, map_location=device)
    model = KiTSUNet().to(device)
    model.load_state_dict(ckpt["model_state_dict"])
    model.eval()

    td = ckpt.get("tumor_dice", float("nan"))
    kd = ckpt.get("kidney_dice", float("nan"))
    ep = ckpt.get("epoch", "?")
    print(f"  Fold {fold}: cargado epoch={ep}  Kidney={kd:.4f}  Tumor={td:.4f}  "
          f"({ckpt_path})")
    return model


def load_all_models(ckpt_dir, device):
    """Carga los 5 modelos de los 5 folds."""
    models = []
    for fold in range(5):
        try:
            models.append(load_fold_model(fold, ckpt_dir, device))
        except FileNotFoundError as e:
            print(f"  AVISO: {e} - este fold será omitido del ensemble")
    if not models:
        raise RuntimeError("No se encontró ningún checkpoint en " + ckpt_dir)
    print(f"  Ensemble: {len(models)} modelos cargados\n")
    return models


# =============================================================================
# PREPROCESAMIENTO - IDÉNTICO AL ENTRENAMIENTO
# =============================================================================

def preprocess(img_path):
    """
    Carga y preprocesa una imagen CT para inferencia.
    Devuelve:
      img_proc  : [Z', H', W'] float32  (resampleado, clipado, normalizado)
      orig_nib  : objeto nibabel original (para recuperar affine/header)
      zoom_back : factores de zoom para volver al espacio original
    """
    nib_obj  = nib.load(img_path)
    img      = nib_obj.get_fdata(dtype=np.float32)
    orig_sp  = np.abs(np.array(nib_obj.header.get_zooms()[:3], dtype=np.float32))

    zoom_fwd  = (orig_sp / np.array(TARGET_SPACING, dtype=np.float32)).tolist()
    zoom_back = (np.array(TARGET_SPACING, dtype=np.float32) / orig_sp).tolist()

    img_r = ndimage.zoom(img, zoom_fwd, order=1, prefilter=False)
    img_r = np.clip(img_r, HU_CLIP_MIN, HU_CLIP_MAX)
    img_r = (img_r - NORM_MEAN) / NORM_STD

    return img_r, nib_obj, zoom_back


# =============================================================================
# SLIDING WINDOW + TTA - IDÉNTICO AL ENTRENAMIENTO
# =============================================================================

def _gaussian_map(patch_size):
    def g1d(n):
        s = n / 8.0
        x = np.arange(n) - n // 2
        w = np.exp(-0.5 * (x / s) ** 2)
        return (w / w.max()).astype(np.float32)
    gz, gy, gx = g1d(patch_size[0]), g1d(patch_size[1]), g1d(patch_size[2])
    return gz[:, None, None] * gy[None, :, None] * gx[None, None, :]


def sliding_window(model, img_np, patch_size=PATCH_SIZE,
                   overlap=SW_OVERLAP, device=None):
    if device is None:
        device = next(model.parameters()).device
    model.eval()

    H, W, D = img_np.shape
    ph, pw, pd = patch_size
    sh = max(1, int(ph * (1 - overlap)))
    sw = max(1, int(pw * (1 - overlap)))
    sd = max(1, int(pd * (1 - overlap)))
    gmap = _gaussian_map(patch_size)

    ph_p = max(0, ph - H); pw_p = max(0, pw - W); pd_p = max(0, pd - D)
    if ph_p or pw_p or pd_p:
        img_np = np.pad(img_np, [(0, ph_p), (0, pw_p), (0, pd_p)], mode="reflect")
    HP, WP, DP = img_np.shape

    acc = np.zeros((N_CLASSES, HP, WP, DP), dtype=np.float32)
    wt  = np.zeros((HP, WP, DP), dtype=np.float32)

    def starts(total, p, s):
        lst = list(range(0, total - p + 1, s))
        if not lst or lst[-1] + p < total:
            lst.append(max(0, total - p))
        return sorted(set(lst))

    zs = starts(HP, ph, sh)
    ys = starts(WP, pw, sw)
    xs = starts(DP, pd, sd)

    with torch.no_grad():
        for z0 in zs:
            for y0 in ys:
                for x0 in xs:
                    patch = img_np[z0:z0+ph, y0:y0+pw, x0:x0+pd]
                    t     = torch.tensor(patch[None, None],
                                         dtype=torch.float32).to(device)
                    out   = model(t)
                    out   = out[0] if isinstance(out, (list, tuple)) else out
                    prob  = torch.softmax(out, dim=1).squeeze(0).cpu().numpy()
                    acc[:, z0:z0+ph, y0:y0+pw, x0:x0+pd] += prob * gmap
                    wt[      z0:z0+ph, y0:y0+pw, x0:x0+pd] += gmap

    acc /= np.maximum(wt[None], 1e-8)
    return acc[:, :H, :W, :D]


def sliding_window_tta(model, img_np, patch_size=PATCH_SIZE, device=None):
    """TTA: original + 3 flips axiales."""
    preds = [sliding_window(model, img_np, patch_size, device=device)]
    for ax in (0, 1, 2):
        fl = np.flip(img_np, axis=ax).copy()
        p  = sliding_window(model, fl, patch_size, device=device)
        preds.append(np.flip(p, axis=ax + 1).copy())
    return np.mean(preds, axis=0)


def ensemble_predict(models, img_np, device, use_tta=USE_TTA):
    """Ensemble de N modelos: promedio de softmax y argmax."""
    infer_fn  = sliding_window_tta if use_tta else sliding_window
    prob_sum  = None
    for m in models:
        p = infer_fn(m, img_np, PATCH_SIZE, device=device)
        prob_sum = p if prob_sum is None else prob_sum + p
    return np.argmax(prob_sum / len(models), axis=0).astype(np.int16)


# =============================================================================
# RESAMPLEO DE VUELTA AL ESPACIO ORIGINAL
# =============================================================================

def resample_pred_to_original(pred_resampled, orig_shape, zoom_back):
    """
    Resamplea la predicción (en espacio TARGET_SPACING) de vuelta al
    espacio original de la imagen con order=0 (nearest-neighbor).

    pred_resampled : [Z', H', W'] int
    orig_shape     : (Z, H, W) del volumen original
    zoom_back      : factores de zoom inverso

    El clip final garantiza que el resultado tenga exactamente el mismo
    tamaño que la imagen original (sin errores de redondeo de zoom).
    """
    pred_back = ndimage.zoom(pred_resampled.astype(np.float32),
                             zoom_back, order=0, prefilter=False)

    # Ajustar a orig_shape exacto (diferencias de ±1 px por redondeo)
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
    models = load_all_models(args.ckpt_dir, DEVICE)

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
        cid = d["case_id"]
        img_path = d["image"]
        lab_path = d["label"]

        print(f"  [{cid}] Inferencia...", end="", flush=True)

        # Preprocesar e inferir
        img_proc, orig_nib, zoom_back = preprocess(img_path)
        orig_shape = orig_nib.get_fdata().shape
        
        pred_resampled = ensemble_predict(models, img_proc, DEVICE, use_tta)
        pred_orig = resample_pred_to_original(pred_resampled, orig_shape, zoom_back)

        # Guardar Predicción
        pred_path = os.path.join(args.output_dir, f"{cid}_pred.nii.gz")
        nib.save(nib.Nifti1Image(pred_orig, orig_nib.affine, orig_nib.header), pred_path)

        # Guardar GT (Copia directa del label de nnU-Net)
        gt_path = os.path.join(args.output_dir, f"{cid}_gt.nii.gz")
        os.system(f"cp {lab_path} {gt_path}")

        # CORRECCIÓN: Usar orig_nib.affine para calcular el volumen del vóxel
        affine_mat = orig_nib.affine
        vox_vol = float(np.abs(np.linalg.det(affine_mat[:3, :3])))  # mm³/vóxel
        
        n_kidney = int((pred_orig > 0).sum())
        n_tumor  = int((pred_orig == 2).sum())
        
        summary.append({
            "case_id":         cid,
            "pred_path":       pred_path,
            "gt_path":         gt_path,
            "orig_shape":      str(orig_shape),
            "resampled_shape": str(img_proc.shape),
            "tta":             use_tta,
            "kidney_voxels":   n_kidney,
            "tumor_voxels":    n_tumor,
            "kidney_vol_mL":   round(n_kidney * vox_vol / 1000, 2),
            "tumor_vol_mL":    round(n_tumor  * vox_vol / 1000, 2),
        })
        print(f" OK")

    pd.DataFrame(summary).to_csv(os.path.join(args.output_dir, "masks_summary.csv"), index=False)

if __name__ == "__main__":
    main()
