"""
localizer.py - Localización de riñones con TotalSegmentator
Intenta en orden: Python API → CLI (totalsegmentator) → CLI (TotalSegmentator) → fallback heurístico
"""

import os
import shutil
import tempfile
import subprocess
import warnings
import numpy as np
import nibabel as nib

warnings.filterwarnings("ignore")

import multiprocessing as _mp
_IS_MAIN = _mp.current_process().name == "MainProcess"

try:
    from totalsegmentator.python_api import totalsegmentator as _totalseg_api
    TOTALSEG_AVAILABLE = True
    if _IS_MAIN:
        print("[LOCALIZER] TotalSegmentator disponible")
except ImportError:
    TOTALSEG_AVAILABLE = False
    if _IS_MAIN:
        print("[LOCALIZER] TotalSegmentator NO instalado → usando fallback heurístico")


# ─── helpers ─────────────────────────────────────────────────────────────────

def _mask_to_bbox(mask: np.ndarray):
    """Bounding box (z0,z1,y0,y1,x0,x1) de una máscara binaria ZYX."""
    coords = np.where(mask > 0)
    if len(coords[0]) == 0:
        return None
    return (int(coords[0].min()), int(coords[0].max()) + 1,
            int(coords[1].min()), int(coords[1].max()) + 1,
            int(coords[2].min()), int(coords[2].max()) + 1)


def _build_result(kidney_left: np.ndarray, kidney_right: np.ndarray) -> dict:
    left_bbox  = _mask_to_bbox(kidney_left)  if kidney_left.sum()  > 0 else None
    right_bbox = _mask_to_bbox(kidney_right) if kidney_right.sum() > 0 else None
    success = (left_bbox is not None) or (right_bbox is not None)
    return {
        "success":      success,
        "kidney_mask":  np.clip(kidney_left + kidney_right, 0, 1).astype(np.uint8),
        "left":         left_bbox,
        "right":        right_bbox,
    }


def _nii_to_mask_zyx(nii_path: str) -> np.ndarray:
    """Lee un NIfTI y devuelve array binario en orden ZYX."""
    data_xyz = np.round(nib.load(nii_path).get_fdata()).astype(np.uint8)
    return np.transpose(data_xyz, (2, 1, 0))      # XYZ → ZYX


def _volume_to_nifti(volume_hu: np.ndarray, spacing: tuple) -> nib.Nifti1Image:
    """Convierte el volumen ZYX a NIfTI con la orientación correcta (XYZ)."""
    sz, sy, sx = spacing
    vol_xyz = np.transpose(volume_hu, (2, 1, 0))  # ZYX → XYZ
    affine  = np.diag([sx, sy, sz, 1.0])
    return nib.Nifti1Image(vol_xyz.astype(np.float32), affine)


# ─── intento 1: Python API ────────────────────────────────────────────────────

def _try_python_api(input_nii: nib.Nifti1Image) -> dict:
    """
    Usa la Python API de TotalSegmentator con ml=True (salida multilabel).
    Labels en task 'total': kidney_left=17, kidney_right=18.
    """
    output_nii = _totalseg_api(
        input_nii,
        None,                                           # output=None → devuelve NIfTI
        roi_subset=["kidney_left", "kidney_right"],
        fast=True,
        ml=True,
        verbose=False,
    )
    mask_xyz = np.round(output_nii.get_fdata()).astype(np.int16)
    mask     = np.transpose(mask_xyz, (2, 1, 0))       # XYZ → ZYX

    kidney_left  = (mask == 17).astype(np.uint8)
    kidney_right = (mask == 18).astype(np.uint8)

    # Algunas versiones reetiquetan roi_subset a 1, 2, ...
    if kidney_left.sum() == 0 and kidney_right.sum() == 0:
        unique = np.unique(mask[mask > 0])
        if len(unique) >= 2:
            kidney_left  = (mask == unique[0]).astype(np.uint8)
            kidney_right = (mask == unique[1]).astype(np.uint8)
        elif len(unique) == 1:
            kidney_left  = (mask == unique[0]).astype(np.uint8)

    result = _build_result(kidney_left, kidney_right)
    if not result["success"]:
        raise RuntimeError("API devolvió máscara vacía")
    print(f"[LOCALIZER] Python API OK — izq:{result['left']}  der:{result['right']}")
    return result


# ─── intento 2: CLI ───────────────────────────────────────────────────────────

def _try_cli(input_nii: nib.Nifti1Image) -> dict:
    """
    Llama a TotalSegmentator via CLI.
    Salida: directorio → kidney_left.nii.gz / kidney_right.nii.gz
    No se usa -ml para evitar confusión con etiquetas.
    """
    tmp_dir    = tempfile.mkdtemp()
    input_path = os.path.join(tmp_dir, "input.nii.gz")
    output_dir = os.path.join(tmp_dir, "output")
    os.makedirs(output_dir, exist_ok=True)

    try:
        nib.save(input_nii, input_path)

        # Probar ambos nombres de comando (mayúsculas y minúsculas)
        last_err = ""
        success  = False
        for cmd_name in ["totalsegmentator", "TotalSegmentator"]:
            cmd = [
                cmd_name,
                "-i",  input_path,
                "-o",  output_dir,
                "--roi_subset", "kidney_left", "kidney_right",
                "--fast",
            ]
            print(f"[LOCALIZER] Probando CLI: {' '.join(cmd)}")
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
            if proc.returncode == 0:
                success = True
                break
            last_err = proc.stderr[-400:]

        if not success:
            raise RuntimeError(f"CLI retornó error:\n{last_err}")

        # Leer archivos de salida individuales
        left_path  = os.path.join(output_dir, "kidney_left.nii.gz")
        right_path = os.path.join(output_dir, "kidney_right.nii.gz")

        # Forma del volumen ZYX (para crear arrays vacíos si falta algún riñón)
        vol_shape_xyz = input_nii.shape
        zeros_zyx     = np.zeros(
            (vol_shape_xyz[2], vol_shape_xyz[1], vol_shape_xyz[0]), dtype=np.uint8
        )

        kidney_left  = _nii_to_mask_zyx(left_path)  if os.path.exists(left_path)  else zeros_zyx.copy()
        kidney_right = _nii_to_mask_zyx(right_path) if os.path.exists(right_path) else zeros_zyx.copy()

        result = _build_result(kidney_left, kidney_right)
        if not result["success"]:
            raise RuntimeError("CLI devolvió máscara vacía")

        print(f"[LOCALIZER] CLI OK — izq:{result['left']}  der:{result['right']}")
        return result

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


# ─── intento 3: fallback heurístico ──────────────────────────────────────────

def _fallback_localize(volume_hu: np.ndarray, spacing: tuple) -> dict:
    """
    Heurística morfológica cuando TotalSegmentator no está disponible.
    Umbral HU renal + connected components + split izq/der por centroide X.
    """
    from scipy import ndimage

    print("[LOCALIZER] Usando fallback heurístico...")
    z, y, x = volume_hu.shape

    # Rango HU para corteza renal sin contraste
    tissue = (volume_hu > 10) & (volume_hu < 90)
    tissue = ndimage.binary_opening(tissue,  iterations=2)
    tissue = ndimage.binary_closing(tissue,  iterations=3)

    labeled, n = ndimage.label(tissue)
    if n == 0:
        print("[LOCALIZER] Fallback: no se encontró tejido renal")
        return {"success": False, "kidney_mask": None, "left": None, "right": None}

    sizes   = ndimage.sum(tissue, labeled, range(1, n + 1))
    top_two = np.argsort(sizes)[-2:] + 1

    kidney_mask = np.zeros((z, y, x), dtype=np.uint8)
    for lbl in top_two:
        kidney_mask[labeled == lbl] = 1

    # Separar izquierda/derecha por centroide X global
    coords_x  = np.where(kidney_mask > 0)[2]
    x_centroid = int(coords_x.mean()) if len(coords_x) else x // 2

    kidney_left_full  = kidney_mask.copy(); kidney_left_full[:, :, x_centroid:] = 0
    kidney_right_full = kidney_mask.copy(); kidney_right_full[:, :, :x_centroid] = 0

    result = _build_result(kidney_left_full, kidney_right_full)
    print(f"[LOCALIZER] Fallback OK — izq:{result['left']}  der:{result['right']}")
    return result


# ─── función pública ──────────────────────────────────────────────────────────

def locate_kidneys_with_totalseg(volume_hu: np.ndarray, spacing: tuple) -> dict:
    """
    Localiza riñones en un volumen CT.
    Devuelve:
        {
          success: bool,
          kidney_mask: ndarray ZYX uint8 (puede ser None si falla todo),
          left:  (z0,z1,y0,y1,x0,x1) en vóxeles del volumen original, o None,
          right: (z0,z1,y0,y1,x0,x1) en vóxeles del volumen original, o None,
        }
    """
    if not TOTALSEG_AVAILABLE:
        return _fallback_localize(volume_hu, spacing)

    input_nii = _volume_to_nifti(volume_hu, spacing)

    # 1. Python API
    try:
        return _try_python_api(input_nii)
    except Exception as e:
        print(f"[LOCALIZER] Python API falló: {e}")

    # 2. CLI
    try:
        return _try_cli(input_nii)
    except Exception as e:
        print(f"[LOCALIZER] CLI falló: {e}")

    # 3. Heurística
    return _fallback_localize(volume_hu, spacing)


def expand_bbox(bbox: tuple, margin_mm: int, spacing: tuple) -> tuple:
    """
    Expande un bounding box (z0,z1,y0,y1,x0,x1) en vóxeles originales
    añadiendo margin_mm milímetros en cada dirección.
    NO aplica clamp — el caller debe clampar a los límites del volumen.
    """
    sz, sy, sx = spacing
    z0, z1, y0, y1, x0, x1 = bbox
    mz = int(margin_mm / sz) + 1
    my = int(margin_mm / sy) + 1
    mx = int(margin_mm / sx) + 1
    return (max(0, z0 - mz), z1 + mz,
            max(0, y0 - my), y1 + my,
            max(0, x0 - mx), x1 + mx)