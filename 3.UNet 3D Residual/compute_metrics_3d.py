"""
compute_metrics.py  -  Métricas de segmentación para UNet 3D Residual
-----------------------------------------------------------------------------

Calcula las siguientes métricas sobre las máscaras generadas por
generate_masks.py, separadas para riñón y tumor:

  • Dice           - coeficiente de solapamiento F1
  • IoU            - Intersection over Union (Jaccard)
  • HD95           - percentil 95 de la distancia de Hausdorff (mm)
  • HDmax          - distancia de Hausdorff clásica (mm)
  • SSIM           - Structural Similarity Index (sobre volúmenes binarios)
  • Volumen pred   - volumen predicho (mL)
  • Volumen GT     - volumen de referencia (mL)
  • Error vol (%)  - error relativo de volumen
  • Precision      - TP / (TP + FP)
  • Recall         - TP / (TP + FN)  [= Sensibilidad]
  • Especificidad  - TN / (TN + FP)

Definición de clases (protocolo KiTS):
  Riñón : label > 0  (parénquima + tumor = cualquier tejido renal)
  Tumor : label == 2 (solo la masa tumoral)
  
Salida
  CSV  : masks_dir/metrics_csanet25d.csv  (una fila por caso + fila MEAN±STD)
  JSON : masks_dir/metrics_csanet25d.json (summary + per_case)

Uso:
  python compute_metrics.py --masks_dir ./masks_test
  python compute_metrics.py --masks_dir ./masks_test --output_json ./metrics.json
"""

import os
import json
import argparse
import warnings
warnings.filterwarnings("ignore")

import numpy as np
import nibabel as nib
import pandas as pd
from glob import glob
from scipy import ndimage
from scipy.ndimage import distance_transform_edt, generate_binary_structure
from skimage.metrics import structural_similarity as ssim_fn


try:
    from medpy.metric.binary import hd95 as _medpy_hd95
    from medpy.metric.binary import hd    as _medpy_hd
    _HAVE_MEDPY = True
    print("INFO: medpy disponible -> HD95/HDmax idénticos a nnUNet ")
except ImportError:
    _HAVE_MEDPY = False
    print("AVISO: medpy no instalado -> HD95 con implementación propia ")


# -----------------------------------------------------------------------------
# MÉTRICAS INDIVIDUALES
# -----------------------------------------------------------------------------

def _binary_stats(pred_bin: np.ndarray, gt_bin: np.ndarray):
    """TP, FP, FN, TN sobre arrays booleanos."""
    tp = float(np.logical_and( pred_bin,  gt_bin).sum())
    fp = float(np.logical_and( pred_bin, ~gt_bin).sum())
    fn = float(np.logical_and(~pred_bin,  gt_bin).sum())
    tn = float(np.logical_and(~pred_bin, ~gt_bin).sum())
    return tp, fp, fn, tn


def dice(pred_bin: np.ndarray, gt_bin: np.ndarray) -> float:
    """Dice = 2·TP / (2·TP + FP + FN). 1.0 si ambos vacíos."""
    tp, fp, fn, _ = _binary_stats(pred_bin, gt_bin)
    denom = 2 * tp + fp + fn
    return 1.0 if denom == 0 else 2 * tp / denom


def iou(pred_bin: np.ndarray, gt_bin: np.ndarray) -> float:
    """IoU (Jaccard) = TP / (TP + FP + FN). 1.0 si ambos vacíos."""
    tp, fp, fn, _ = _binary_stats(pred_bin, gt_bin)
    denom = tp + fp + fn
    return 1.0 if denom == 0 else tp / denom


def precision(pred_bin: np.ndarray, gt_bin: np.ndarray) -> float:
    """Precision = TP / (TP + FP)."""
    tp, fp, _, _ = _binary_stats(pred_bin, gt_bin)
    if tp + fp == 0:
        return 1.0 if np.sum(gt_bin) == 0 else 0.0
    return tp / (tp + fp)


def recall(pred_bin: np.ndarray, gt_bin: np.ndarray) -> float:
    """Recall = Sensibilidad = TP / (TP + FN)."""
    tp, _, fn, _ = _binary_stats(pred_bin, gt_bin)
    return 1.0 if (tp + fn) == 0 else tp / (tp + fn)


def specificity(pred_bin: np.ndarray, gt_bin: np.ndarray) -> float:
    """Especificidad = TN / (TN + FP)."""
    _, fp, _, tn = _binary_stats(pred_bin, gt_bin)
    return 1.0 if (tn + fp) == 0 else tn / (tn + fp)


# -----------------------------------------------------------------------------
# HD95 / HDMAX  - implementación idéntica a medpy (= nnUNet)
# -----------------------------------------------------------------------------

def _surface_distances(result: np.ndarray,
                        reference: np.ndarray,
                        voxelspacing: tuple,
                        connectivity: int = 1) -> np.ndarray:
    """
    Distancias desde cada vóxel de la superficie de `result`
    hasta la superficie más cercana de `reference`, en mm.

    Implementación idéntica a medpy.metric.binary.__surface_distances:
      · Superficie = XOR(vol, erosion(vol))
      · binary_erosion con border_value=1  <- clave para resultados correctos
      · Conectividad mediante generate_binary_structure
      · EDT sobre el complementario de la superficie de reference

    voxelspacing: (sz, sy, sx) - mismo orden que las dimensiones del array
                  (tal como devuelve nibabel header.get_zooms())
    """
    # Estructura de conectividad
    footprint = generate_binary_structure(result.ndim, connectivity)

    # Superficie de result: vóxeles en el borde del foreground
    # border_value=1 garantiza que los vóxeles en el borde del volumen
    # NO sean considerados como borde de la superficie (medpy usa esto)
    result_border = result ^ ndimage.binary_erosion(
        result, structure=footprint, border_value=1
    )

    # Superficie de reference
    reference_border = reference ^ ndimage.binary_erosion(
        reference, structure=footprint, border_value=1
    )

    # EDT desde la superficie de reference (en mm)
    dt = distance_transform_edt(~reference_border, sampling=voxelspacing)

    # Distancias: para cada punto de la superficie de result, distancia al GT
    return dt[result_border]


def hausdorff_95_and_max(pred_bin: np.ndarray,
                          gt_bin: np.ndarray,
                          voxel_spacing: tuple = (1.0, 1.0, 1.0)):
    """
    HD95 y Hausdorff máximo en mm.

    Si medpy está instalado -> resultado idéntico al de nnUNet.
    Si no -> implementación propia fiel a medpy.

    Devuelve (hd95, hdmax). Si pred o GT están vacíos -> (None, None).

    voxel_spacing: (sz, sy, sx) en mm, en el MISMO orden que las
                   dimensiones del array numpy (igual que nibabel zooms).
    """
    if not pred_bin.any() or not gt_bin.any():
        return None, None

    if _HAVE_MEDPY:
        try:
            # medpy recibe voxelspacing en el mismo orden que el array
            h95  = float(_medpy_hd95(pred_bin, gt_bin,
                                      voxelspacing=voxel_spacing))
            hmax = float(_medpy_hd(  pred_bin, gt_bin,
                                      voxelspacing=voxel_spacing))
            return h95, hmax
        except Exception as e:
            print(f"\n  ¡AVISO medpy falló ({e}), usando implementación propia!")

    # Implementación propia idéntica a medpy
    d1 = _surface_distances(pred_bin, gt_bin,  voxel_spacing)  # pred -> gt
    d2 = _surface_distances(gt_bin,  pred_bin, voxel_spacing)  # gt   -> pred
    all_d = np.hstack([d1, d2])

    hd95  = float(np.percentile(all_d, 95))
    hdmax = float(np.max(all_d))
    return hd95, hdmax


# -----------------------------------------------------------------------------
# SSIM 3D
# -----------------------------------------------------------------------------

def ssim_3d(pred_bin: np.ndarray, gt_bin: np.ndarray) -> float:
    """
    SSIM sobre volúmenes binarios en [0, 1].

    Intenta cálculo 3D nativo. Si falla (volúmenes muy grandes o
    versiones antiguas de scikit-image), promedia corte a corte axial.
    Devuelve 1.0 si ambos volúmenes están vacíos.
    """
    p = pred_bin.astype(np.float32)
    g = gt_bin.astype(np.float32)

    if p.sum() == 0 and g.sum() == 0:
        return 1.0

    try:
        return float(ssim_fn(p, g, data_range=1.0))
    except Exception:
        vals = []
        for z in range(p.shape[0]):
            if p[z].max() > 0 or g[z].max() > 0:
                try:
                    vals.append(float(ssim_fn(p[z], g[z], data_range=1.0)))
                except Exception:
                    pass
        return float(np.mean(vals)) if vals else float("nan")


# -----------------------------------------------------------------------------
# VOLUMEN
# -----------------------------------------------------------------------------

def volume_mL(binary_vol: np.ndarray, voxel_spacing: tuple) -> float:
    """Volumen en mL = nº vóxeles × vol/vóxel [mm³] / 1000."""
    return float(binary_vol.sum()) * float(np.prod(voxel_spacing)) / 1000.0


# -----------------------------------------------------------------------------
# MÉTRICAS COMPLETAS POR CASO Y ESTRUCTURA
# -----------------------------------------------------------------------------

def compute_all_metrics(pred: np.ndarray,
                         gt: np.ndarray,
                         voxel_spacing: tuple,
                         label_name: str) -> dict:
    """
    Calcula todas las métricas para una estructura.

    pred, gt: arrays 3D int16 en el espacio original
    voxel_spacing: (sz, sy, sx) en mm — del header del GT
    label_name: "kidney" | "tumor"

    Clases KiTS:
      kidney -> pred > 0   / gt > 0
      tumor  -> pred == 2  / gt == 2
    """
    if label_name == "kidney":
        pred_bin = pred > 0
        gt_bin   = gt   > 0
    else:
        pred_bin = pred == 2
        gt_bin   = gt   == 2

    # Métricas de solapamiento 
    dsc  = dice(pred_bin, gt_bin)
    jac  = iou(pred_bin, gt_bin)
    prec = precision(pred_bin, gt_bin)
    rec  = recall(pred_bin, gt_bin)
    spec = specificity(pred_bin, gt_bin)

    # Métricas de distancia 
    hd95, hdmax = hausdorff_95_and_max(pred_bin, gt_bin, voxel_spacing)

    # Volumen 
    vol_pred = volume_mL(pred_bin, voxel_spacing)
    vol_gt   = volume_mL(gt_bin,   voxel_spacing)
    vol_err  = (abs(vol_pred - vol_gt) / vol_gt * 100.0
                if vol_gt > 0 else None)

    # SSIM 
    ss = ssim_3d(pred_bin, gt_bin)

    def _r(x, n):
        """Redondea o devuelve None si el valor no es finito."""
        if x is None or (isinstance(x, float) and not np.isfinite(x)):
            return None
        return round(float(x), n)

    return {
        f"{label_name}_dice": _r(dsc, 6),
        f"{label_name}_iou": _r(jac, 6),
        f"{label_name}_hd95_mm": _r(hd95, 4),
        f"{label_name}_hdmax_mm": _r(hdmax, 4),
        f"{label_name}_ssim": _r(ss, 6),
        f"{label_name}_vol_pred_mL": _r(vol_pred, 3),
        f"{label_name}_vol_gt_mL": _r(vol_gt, 3),
        f"{label_name}_vol_err_pct": _r(vol_err, 2),
        f"{label_name}_precision": _r(prec, 6),
        f"{label_name}_recall": _r(rec, 6),
        f"{label_name}_sensitivity": _r(rec, 6),   
        f"{label_name}_specificity": _r(spec, 6),
    }


# -----------------------------------------------------------------------------
# CARGA DE PARES PRED / GT
# -----------------------------------------------------------------------------

def load_pairs_from_masks_dir(masks_dir: str) -> list:
    """
    Busca pares {cid}_pred.nii.gz / {cid}_gt.nii.gz en masks_dir.
    Devuelve lista de dicts: {case_id, pred_path, gt_path}.

    generate_masks.py guarda:
      kidney_001_pred.nii.gz - predicción en espacio original
      kidney_001_gt.nii.gz - GT en espacio original (mismo affine/header)
    """
    pred_files = sorted(glob(os.path.join(masks_dir, "*.nii.gz")))
    pairs = []
    for pf in pred_files:
        cid = os.path.basename(pf).replace("_pred.nii.gz", "")
        gf  = os.path.join(masks_dir, f"{cid}_gt.nii.gz")
        if not os.path.exists(gf):
            print(f"  AVISO: no se encontró GT para {cid} "
                  f"({gf}) — caso omitido")
            continue
        pairs.append({"case_id": cid, "pred_path": pf, "gt_path": gf})

    if not pairs:
        raise FileNotFoundError(
            f"No se encontraron pares pred/gt en {masks_dir}\n"
            "Asegúrate de haber ejecutado generate_masks.py primero."
        )
    return pairs


# -----------------------------------------------------------------------------
# MAIN
# -----------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Métricas de segmentación para UNet 3D Residual (KiTS)"
    )
    parser.add_argument(
        "--masks_dir", default="./masks_test",
        help="Directorio con *_pred.nii.gz y *_gt.nii.gz "
             "(generados por generate_masks.py)"
    )
    parser.add_argument(
        "--output_csv", default=None,
        help="Ruta del CSV de salida "
             "(default: masks_dir/metrics_unet3d_residual.csv)"
    )
    parser.add_argument(
        "--output_json", default=None,
        help="Ruta del JSON de salida "
             "(default: masks_dir/metrics_unet3d_residual.json)"
    )
    args = parser.parse_args()

    if args.output_csv is None:
        args.output_csv = os.path.join(
            args.masks_dir, "metrics_unet3d_residual.csv"
        )
    if args.output_json is None:
        args.output_json = os.path.join(
            args.masks_dir, "metrics_unet3d_residual.json"
        )

    print("\n" + "=" * 70)
    print("  CÁLCULO DE MÉTRICAS — UNet 3D Residual")
    print(f"  Máscaras    : {args.masks_dir}")
    print(f"  Salida CSV  : {args.output_csv}")
    print(f"  Salida JSON : {args.output_json}")
    print(f"  HD95 backend: {'medpy (= nnUNet)' if _HAVE_MEDPY else 'implementación propia'}")
    print("=" * 70)

    # Cargar pares 
    pairs = load_pairs_from_masks_dir(args.masks_dir)
    print(f"\n  {len(pairs)} casos encontrados:")
    for p in pairs:
        print(f"    {p['case_id']}")
    print()

    all_rows = []   # para CSV
    json_cases = {}   # para JSON

    for d in pairs:
        cid = d["case_id"]
        pred_path = d["pred_path"]
        gt_path = d["gt_path"]

        print(f"  [{cid}]", end="  ", flush=True)

        # Cargar volúmenes
        pred_nib = nib.load(pred_path)
        gt_nib   = nib.load(gt_path)

        pred = np.round(pred_nib.get_fdata()).astype(np.int16)
        gt = np.round(gt_nib.get_fdata()).astype(np.int16)

        # Verificar dimensiones
        if pred.shape != gt.shape:
            print(f"ERROR dimensiones: pred={pred.shape} vs gt={gt.shape} "
                  f"- caso omitido")
            continue

        # Spacing en mm desde el header del GT
        # generate_masks.py guarda el GT con el affine/header de la imagen
        # original, por lo que este spacing es el correcto para calcular
        # distancias en mm en el espacio físico real.
        voxel_spacing = tuple(
            abs(float(x)) for x in gt_nib.header.get_zooms()[:3]
        )

        print(
            f"shape={pred.shape}  "
            f"spacing=({voxel_spacing[0]:.3f},{voxel_spacing[1]:.3f},"
            f"{voxel_spacing[2]:.3f}) mm",
            end="  ", flush=True
        )

        # Calcular métricas
        print("riñón…", end="", flush=True)
        m_kidney = compute_all_metrics(pred, gt, voxel_spacing, "kidney")

        print("  tumor…", end="", flush=True)
        m_tumor  = compute_all_metrics(pred, gt, voxel_spacing, "tumor")

        print("Acabado")

        # Imprimir resumen por caso
        k_hd  = m_kidney["kidney_hd95_mm"]
        t_hd  = m_tumor["tumor_hd95_mm"]
        print(
            f"    Riñón -> Dice={m_kidney['kidney_dice']:.4f}  "
            f"IoU={m_kidney['kidney_iou']:.4f}  "
            f"HD95={k_hd if k_hd is not None else 'N/A'} mm  "
            f"Vol_GT={m_kidney['kidney_vol_gt_mL']:.1f} mL"
        )
        print(
            f"    Tumor -> Dice={m_tumor['tumor_dice']:.4f}  "
            f"IoU={m_tumor['tumor_iou']:.4f}  "
            f"HD95={t_hd if t_hd is not None else 'N/A'} mm  "
            f"Vol_GT={m_tumor['tumor_vol_gt_mL']:.1f} mL"
        )
        print()

        # Acumular para CSV
        row = {
            "case_id": cid,
            "voxel_spacing_mm": str(voxel_spacing),
            "shape": str(pred.shape),
        }
        row.update(m_kidney)
        row.update(m_tumor)
        all_rows.append(row)

        # Acumular para JSON
        json_cases[cid] = {
            "voxel_spacing_mm": list(voxel_spacing),
            "shape":            list(pred.shape),
            "pred_path":        pred_path,
            "gt_path":          gt_path,
            "kidney":           {k.replace("kidney_", ""): v
                                 for k, v in m_kidney.items()},
            "tumor":            {k.replace("tumor_", ""): v
                                 for k, v in m_tumor.items()},
        }

    if not all_rows:
        print("  ERROR: no se pudo procesar ningún caso.")
        return

    # DataFrame y CSV
    df = pd.DataFrame(all_rows)
    numeric_cols = [c for c in df.columns
                    if c not in ("case_id", "voxel_spacing_mm", "shape")]
    for col in numeric_cols:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    # Resumen estadístico
    METRIC_PAIRS = [
        ("Dice",           "dice"),
        ("IoU",            "iou"),
        ("HD95 (mm)",      "hd95_mm"),
        ("HDmax (mm)",     "hdmax_mm"),
        ("SSIM",           "ssim"),
        ("Vol pred (mL)",  "vol_pred_mL"),
        ("Vol GT (mL)",    "vol_gt_mL"),
        ("Vol err (%)",    "vol_err_pct"),
        ("Precision",      "precision"),
        ("Recall",         "recall"),
        ("Sensibilidad",   "sensitivity"),
        ("Especificidad",  "specificity"),
    ]

    print("=" * 70)
    print("  RESUMEN ESTADÍSTICO (media ± std)")
    print("=" * 70)

    json_summary = {}

    def print_block_and_summarize(title, prefix):
        print(f"\n  {title}")
        print(f"  {'Métrica':<18} {'Media':>9}  {'Std':>9}  "
              f"{'Min':>9}  {'Max':>9}  {'N':>4}")
        print(f"  {'-'*62}")
        block_summary = {}
        for label, key in METRIC_PAIRS:
            col  = f"{prefix}_{key}"
            if col not in df.columns:
                continue
            vals = df[col].dropna()
            if len(vals) == 0:
                print(f"  {label:<18}  {'—':>9}  {'—':>9}  {'—':>9}  {'—':>9}  {'0':>4}")
                block_summary[key] = None
                continue
            m, s, mn, mx = vals.mean(), vals.std(), vals.min(), vals.max()
            print(f"  {label:<18}  {m:>9.4f}  {s:>9.4f}  "
                  f"{mn:>9.4f}  {mx:>9.4f}  {len(vals):>4}")
            block_summary[key] = {
                "mean": round(float(m),  6),
                "std":  round(float(s),  6),
                "min":  round(float(mn), 6),
                "max":  round(float(mx), 6),
                "n":    int(len(vals)),
            }
        return block_summary

    json_summary["kidney"] = print_block_and_summarize(
        "RIÑÓN (label > 0 = parénquima + tumor)", "kidney"
    )
    json_summary["tumor"] = print_block_and_summarize(
        "TUMOR (label == 2)", "tumor"
    )

    # Guardar CSV con fila de resumen 
    summary_row = {"case_id": "MEAN±STD", "voxel_spacing_mm": "", "shape": ""}
    for _, key in METRIC_PAIRS:
        for prefix in ("kidney", "tumor"):
            col  = f"{prefix}_{key}"
            if col not in df.columns:
                continue
            vals = df[col].dropna()
            summary_row[col] = (
                f"{vals.mean():.4f}±{vals.std():.4f}"
                if len(vals) > 0 else "nan"
            )
    df_out = pd.concat([df, pd.DataFrame([summary_row])], ignore_index=True)
    df_out.to_csv(args.output_csv, index=False)

    # Guardar JSON
    json_output = {
        "description": (
            "Métricas de test - UNet 3D Residual (KiTS). "
            "Clases: kidney (label>0), tumor (label==2). "
            f"HD95 backend: {'medpy (= nnUNet)' if _HAVE_MEDPY else 'implementación propia'}."
        ),
        "masks_dir":    args.masks_dir,
        "hd95_backend": "medpy" if _HAVE_MEDPY else "own_edt",
        "n_cases":      len(all_rows),
        "summary":      json_summary,
        "per_case":     json_cases,
    }
    with open(args.output_json, "w", encoding="utf-8") as f:
        json.dump(json_output, f, indent=2, ensure_ascii=False)

    # Tabla comparativa
    mean_kd = df["kidney_dice"].mean()
    std_kd  = df["kidney_dice"].std()
    mean_td = df["tumor_dice"].mean()
    std_td  = df["tumor_dice"].std()

    print("\n" + "=" * 70)
    print(f"  CSV  guardado en : {args.output_csv}")
    print(f"  JSON guardado en : {args.output_json}")
    print("=" * 70 + "\n")


if __name__ == "__main__":
    main()
