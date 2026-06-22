import os
import json
import numbers
import numpy as np

try:
    import SimpleITK as sitk
    from radiomics import featureextractor
    RADIOMICS_OK = True
except ImportError:
    RADIOMICS_OK = False
    print("PyRadiomics no instalado - se usará heurística morfológica")

try:
    import joblib
    JOBLIB_OK = True
except ImportError:
    JOBLIB_OK = False

_HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(_HERE, "radiomics_model.pkl")
SCALER_PATH = os.path.join(_HERE, "radiomics_scaler.pkl")
FEATS_PATH = os.path.join(_HERE, "radiomics_features.json")

_cache: dict = {}

#-------------------------------------------------------------------------------
# CARGA DEL MODELO CON CACHÉ
# Patrón idéntico a memory_cache de dicom_processor.py, pero sin dependencia de Flask. Se usa en analyze_tumor() para
# predecir si el tumor es CCR u Oncocitoma.

def load_model():
    """
    Carga el modelo de ML, el scaler y la lista de features desde archivos. Usa caché para evitar recargas.
    """
    if _cache:
        return _cache.get("model"), _cache.get("scaler"), _cache.get("feats")
    if not JOBLIB_OK or not os.path.exists(MODEL_PATH):
        return None, None, None
    _cache["model"]  = joblib.load(MODEL_PATH)
    _cache["scaler"] = joblib.load(SCALER_PATH) if os.path.exists(SCALER_PATH) else None
    _cache["feats"]  = json.load(open(FEATS_PATH)) if os.path.exists(FEATS_PATH) else None
    print("Modelo de radiómica cargado (GradientBoosting)")
    return _cache["model"], _cache["scaler"], _cache["feats"]

#-------------------------------------------------------------------------------

#-------------------------------------------------------------------------------
# CONVERSIÓN ENTRE ARRAYS Y IMÁGENES SIMPLEITK
# PyRadiomics requiere imágenes SimpleITK con spacing correcto. Durante el entrenamiento, 
# los NRRD se cargaron sin spacing, por lo que PyRadiomics asumió (1.0, 1.0, 1.0). 
# Para que las features extraídas en inferencia sean comparables, hay que remuestrear al mismo espacio antes de llamar a PyRadiomics.
def to_sitk(arr_zyx: np.ndarray, spacing_zyx: tuple):
    import SimpleITK as sitk
    sz, sy, sx = spacing_zyx
    img = sitk.GetImageFromArray(arr_zyx)
    img.SetSpacing((float(sx), float(sy), float(sz))) # SetSpacing espera (sx, sy, sz), en mi pipeline usamos (sz, sy, sx) para consistencia con DICOM y NumPy
    return img
 

def is_num(v):
    if isinstance(v, numbers.Number):
        return True
    try:
        float(v); return True
    except Exception:
        return False


def resample_to_unit_spacing(sitk_img: "sitk.Image", is_mask: bool = False) -> "sitk.Image":
    """
    Remuestrea una imagen SimpleITK a spacing (1.0, 1.0, 1.0) mm.

    Durante el entrenamiento del modelo radiómico, los archivos NRRD se cargaron
    con nrrd.read() sin asignar spacing, por lo que PyRadiomics los procesó con
    spacing implícito (1.0, 1.0, 1.0). Para que los features extraídos en
    inferencia sean comparables con los del entrenamiento, hay que remuestrear
    al mismo espacio antes de llamar a PyRadiomics.

    Args:
        sitk_img : imagen o máscara SimpleITK con su spacing real del DICOM.
        is_mask  : si True, usa interpolación nearest-neighbor (preserva etiquetas);
                   si False, usa interpolación lineal (imagen CT).
    Returns:
        Imagen remuestreada a spacing (1.0, 1.0, 1.0).
    """
    import SimpleITK as sitk

    original_spacing = sitk_img.GetSpacing()          # (sx, sy, sz) en mm
    original_size    = sitk_img.GetSize()              # (nx, ny, nz) en vóxeles

    # Calcular nuevo tamaño para mantener el campo de visión físico
    new_spacing = (1.0, 1.0, 1.0)
    new_size = [
        int(round(osz * ospc / nspc))
        for osz, ospc, nspc in zip(original_size, original_spacing, new_spacing)
    ]

    resample = sitk.ResampleImageFilter()
    resample.SetOutputSpacing(new_spacing)
    resample.SetSize(new_size)
    resample.SetOutputDirection(sitk_img.GetDirection())
    resample.SetOutputOrigin(sitk_img.GetOrigin())
    resample.SetInterpolator(
        sitk.sitkNearestNeighbor if is_mask else sitk.sitkLinear
    )
    # Para máscaras, usar el valor de fondo 0
    resample.SetDefaultPixelValue(0)
    return resample.Execute(sitk_img)

#-------------------------------------------------------------------------------

#-------------------------------------------------------------------------------
# EXTRACCIÓN DE FEATURES RADIÓMICAS
def extract_radiomics(mask_zyx, volume_zyx, spacing_zyx) -> dict:
    if not RADIOMICS_OK:
        return {}

    # Binarizar: tumor=2 -> tumor=1 (convención entrenamiento radiómico)
    mask_bin  = (mask_zyx == 2).astype(np.uint8)

    # Construir imágenes SimpleITK con el spacing real del DICOM
    sitk_vol  = to_sitk(volume_zyx.astype(np.float32), spacing_zyx)
    sitk_mask = to_sitk(mask_bin, spacing_zyx)

    if sitk_vol.GetSize() != sitk_mask.GetSize():
        return {}

    # Remuestrear a (1.0, 1.0, 1.0) para replicar el spacing implícito del entrenamiento.
    # Durante el entrenamiento los NRRDs se cargaron sin spacing -> PyRadiomics asumió (0.1, 0.1, 0.1).
    # Si no se hace este paso, features geométricas (volumen, distancias GLRLM) difieren
    # respecto a los valores vistos durante el entrenamiento y el modelo no es comparable.
    sitk_vol  = resample_to_unit_spacing(sitk_vol,  is_mask=False)
    sitk_mask = resample_to_unit_spacing(sitk_mask, is_mask=True)

    ext = featureextractor.RadiomicsFeatureExtractor()
    ext.settings["minimumROIDimensions"] = 1
    ext.settings["minimumROISize"] = 1
    try:
        raw = ext.execute(sitk_vol, sitk_mask, label=1)
        return {k: float(v) for k, v in raw.items()
                if not k.startswith("diagnostics_") and is_num(v)}
    except Exception as e:
        print(f"PyRadiomics error: {e}")
        return {}


def morfologicas(mask: np.ndarray, volume_hu: np.ndarray, spacing_zyx: tuple) -> dict:
    '''
    Calcula métricas morfológicas simples del tumor a partir de la máscara y el volumen.
    Devuelve un diccionario con:
        - volumen (cm3)
        - diametroMaximo (cm)
    '''
    sz, sy, sx = spacing_zyx
    voxel_vol  = sx * sy * sz  
    n_vox      = int(np.sum(mask > 0))
    vol_mm3    = n_vox * voxel_vol
    vol_cm3    = vol_mm3 / 1000.0

    if n_vox == 0:
        return {
            "volumen": 0.0,
            "diametroMaximo": 0.0,
        }

    # Diámetro máximo (bounding box físico)
    pts = np.argwhere(mask > 0)
    diam_z = (pts[:,0].max() - pts[:,0].min()) * sz
    diam_y = (pts[:,1].max() - pts[:,1].min()) * sy
    diam_x = (pts[:,2].max() - pts[:,2].min()) * sx
    diam_cm = max(diam_z, diam_y, diam_x) / 10.0
    
    return {
        "volumen": round(vol_cm3, 2),
        "diametroMaximo": round(diam_cm, 2),
    }

def analyze_tumor(mask: np.ndarray, volume_hu: np.ndarray, spacing: tuple) -> dict:
    '''
    Analiza la máscara y el volumen para extraer métricas morfológicas y radiómicas, y clasifica el tumor como Carcinoma de Células Renales (CCR) u Oncocitoma'''
    tumor_voxels = int(np.sum(mask == 2))
    print(f"Vóxeles con label=2: {tumor_voxels}")
    
    metricas  = morfologicas(mask, volume_hu, spacing)
    rad_feats = extract_radiomics(mask, volume_hu, spacing)

    model, scaler, feat_names = load_model()
    
    # Verificar que el modelo existe
    if model is None:
        raise ValueError("Modelo de ML no disponible. Verificar archivos .pkl")
    
    if feat_names is None:
        raise ValueError("Lista de features no disponible")
    
    if not rad_feats:
        raise ValueError("No se pudieron extraer features radiómicas")

    try:
        import pandas as pd
        row = {f: rad_feats.get(f, 0.0) for f in feat_names}
        X   = pd.DataFrame([row])
        
        if scaler is not None:
            X = pd.DataFrame(scaler.transform(X), columns=feat_names)
        
        # Clasificación binaria directa, sin probabilidad asociada.
        # Convención del entrenamiento: clase 1 = CCR, clase 0 = Oncocitoma.
        pred   = model.predict(X.to_numpy())[0]
        is_ccr = bool(int(pred) == 1)
        source = "model"
    
    except Exception as e:
        raise RuntimeError(f"Error en inferencia del modelo: {e}")

    print(f"Predicción del clasificador: {'CCR' if is_ccr else 'Oncocitoma'}")
    print(f"Features entrada: {X.to_numpy()}")


    highlight = {}
    if rad_feats:
        claves = {
            "original_firstorder_Mean":    "FO·Media",
            "original_firstorder_Entropy": "FO·Entropía",
            "original_shape_VoxelVolume":  "Shape·Volumen",
            "original_glcm_Contrast":      "GLCM·Contraste",
            "original_glrlm_RunEntropy":   "GLRLM·Entropía",
        }
        for k, label in claves.items():
            if k in rad_feats:
                highlight[label] = round(rad_feats[k], 4)

    return {
        "diagnostico": "Carcinoma de Células Renales (CCR)" if is_ccr else "Oncocitoma",
        "isBenign": not is_ccr,
        "source": source,
        "metricas": metricas,
        "radiomicsHighlight": highlight,
    }