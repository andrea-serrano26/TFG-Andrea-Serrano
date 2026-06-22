import os
import io
import base64
import numpy as np
import pydicom
from PIL import Image
from collections import OrderedDict
from threading import Lock
from concurrent.futures import ThreadPoolExecutor

#--------------------------------------------------------------------------------------------------------------------------------
# Almacena el volumen y máscara actualmente activos para acceso rápido, evitando recargar desde disco.

memory_cache = {
    "session_id": None,
    "volume": None,
    "mask": None,
    "spacing": (1.0, 1.0, 1.0),
    "file_type": "dicom",
}
#--------------------------------------------------------------------------------------------------------------------------------

#--------------------------------------------------------------------------------------------------------------------------------
# Caché LRU para slices renderizados: clave = (session_id, view, slice_index, is_mask, wc, ww)

_SLICE_CACHE_CAPACITY = 128
_slice_cache: OrderedDict = OrderedDict()
_slice_cache_lock = Lock() # Evitar condiciones de carrera

def _cache_get(key: tuple) -> str | None:
    """
    Obtiene slice renderizado de la caché LRU. Si se encuentra, lo mueve al final para marcarlo como recientemente usado.
    """
    with _slice_cache_lock:
        if key in _slice_cache:
            _slice_cache.move_to_end(key)
            return _slice_cache[key]
        return None

def _cache_put(key: tuple, value: str):
    """
    Agrega un slice renderizado a la caché LRU. Si la caché excede su capacidad, elimina el item menos recientemente usado.
    """
    with _slice_cache_lock:
        if key in _slice_cache:
            _slice_cache.move_to_end(key)
        else:
            if len(_slice_cache) >= _SLICE_CACHE_CAPACITY:
                _slice_cache.popitem(last=False)
        _slice_cache[key] = value

def clear_slice_cache():
    """
    Limpia toda la caché de slices renderizados. Se llama cuando se actualiza la máscara para asegurar que los slices se vuelvan 
    a renderizar con los cambios."""
    with _slice_cache_lock:
        _slice_cache.clear()

#--------------------------------------------------------------------------------------------------------------------------------

#--------------------------------------------------------------------------------------------------------------------------------
# WINDOWING 

def auto_window(arr: np.ndarray) -> tuple[float, float]:
    """
    Calcula ventana diagnóstica global a partir del array (puede ser un slice o el volumen completo).
    Para CT abdominal: soft tissue W=400 L=40 estándar como fallback.
    Usa percentiles P2/P98 del tejido blando para ajustar a cada paciente.
    """
    tissue = arr[(arr > -200) & (arr < 800)]
    if tissue.size < 100:
        return 40.0, 400.0

    p02, p98 = np.percentile(tissue, [2, 98])
    ww = float(max(150, min(600, p98 - p02)))
    wc = float(max(-80, min(160, (p02 + p98) / 2.0)))

    return wc, ww

#--------------------------------------------------------------------------------------------------------------------------------

#--------------------------------------------------------------------------------------------------------------------------------
# CARGA DE VOLUMEN DICOM, CARGA DE MÁSCARA NIfTI Y RENDERIZADO DE SLICES CON ASPECT RATIO FÍSICO

def load_volume_data(upload_dir, session_id):
    """
    Flujo completo:
    1. ¿Ya está en caché? -> devolver inmediato
    2. Leer todos los archivos .dcm de la carpeta
    3. Ordenar por posición Z 
    4. Stackear arrays -> volumen 3D
    5. Aplicar RescaleSlope/RescaleIntercept -> valores HU
    6. Calcular espaciado físico (mm entre vóxeles)
    7. Crear máscara vacía (todos ceros)
    8. Guardar en memory_cache
    9. Limpiar caché de slices
    10. Devolver volumen, máscara y espaciado
    """
    # 1. Verificar si ya está en caché
    if memory_cache["session_id"] == session_id and memory_cache["volume"] is not None:
        return memory_cache["volume"], memory_cache["mask"], memory_cache["spacing"]

    session_path = os.path.join(upload_dir, session_id)
    
    # 2. Leer todos los archivos .dcm de la carpeta
    files = [os.path.join(session_path, f)
             for f in os.listdir(session_path) if f.lower().endswith(".dcm")]

    slices = []
    for f in files:
        try:
            ds = pydicom.dcmread(f, force=True) # force=True para leer DICOMs no estándar
            slices.append(ds)
        except Exception as e:
            print(f"  Error leyendo {f}: {e}")
    
    if not slices:
        raise ValueError(f"No se encontraron DICOMs válidos en {session_path}")
    
    # 3. Ordenar por posición Z (ImagePositionPatient[2])
    slices.sort(key=lambda s: float(s.ImagePositionPatient[2]))
    vol_data = np.stack([s.pixel_array.astype(np.float32) for s in slices])
    
    # 5. Aplicar RescaleSlope/RescaleIntercept para obtener valores HU
    slope = float(slices[0].get("RescaleSlope", 1))
    intercept = float(slices[0].get("RescaleIntercept", 0))
    volume = vol_data * slope + intercept
    
    # 6. Calcular espaciado físico (mm entre vóxeles)
    # El spacing en Z se calcula a partir de la diferencia entre las posiciones Z de los primeros dos slices.
    # El spacing en Y/X se obtiene de PixelSpacing (en mm).
    # Si hay algún error, se usa un fallback de (1.0, 1.0, 1.0).
    try:
        z_s = abs(float(slices[1].ImagePositionPatient[2]) -
                  float(slices[0].ImagePositionPatient[2]))
        y_s = float(slices[0].PixelSpacing[0])
        x_s = float(slices[0].PixelSpacing[1])
        spacing = (z_s, y_s, x_s)
    except Exception:
        spacing = (1.0, 1.0, 1.0)
    
    # 7. Crear máscara vacía (todos ceros)
    mask = np.zeros_like(volume, dtype=np.uint8)
    # Calcular ventana global a partir del volumen completo.
    # Usar slices centrales (30-70% del volumen) donde está el tejido de interés.
    z = volume.shape[0]
    z0, z1 = int(z * 0.30), int(z * 0.70)
    wc_global, ww_global = auto_window(volume[z0:z1])

    # 8/9. Guardar en memory_cache y limpiar caché de slices
    clear_slice_cache()
    memory_cache.update({
        "session_id": session_id,
        "volume": volume,
        "mask": mask,
        "spacing": spacing,
        "file_type": "dicom",
        "wc": wc_global,   # Ventana global — misma para todos los slices
        "ww": ww_global,
    })

    print(f" DICOM cargado: shape={volume.shape}  spacing={spacing}  WC={wc_global:.0f} WW={ww_global:.0f}")
    
    return volume, mask, spacing


def load_nrrd_volume(upload_dir, session_id):
    """
    Carga un volumen desde un archivo NRRD (.nrrd o .nhdr).
    Equivalente a load_volume_data pero para el formato NRRD.

    Flujo:
    1. ¿Ya está en caché? -> devolver inmediato
    2. Buscar el primer archivo .nrrd / .nhdr en la carpeta de sesión
    3. Leer con SimpleITK (preserva spacing, orientación y valores HU)
    4. Convertir a array numpy ZYX float32
    5. Extraer spacing físico (sz, sy, sx)
    6. Calcular ventana global (misma lógica que DICOM)
    7. Guardar en memory_cache
    8. Devolver volumen, máscara vacía y spacing
    """
    if memory_cache["session_id"] == session_id and memory_cache["volume"] is not None:
        return memory_cache["volume"], memory_cache["mask"], memory_cache["spacing"]

    import SimpleITK as sitk

    session_path = os.path.join(upload_dir, session_id)
    nrrd_file = None
    for f in os.listdir(session_path):
        if f.lower().endswith((".nrrd", ".nhdr")):
            nrrd_file = os.path.join(session_path, f)
            break

    if nrrd_file is None:
        raise ValueError(f"No se encontró ningún archivo NRRD en {session_path}")

    sitk_img = sitk.ReadImage(nrrd_file)

    # SimpleITK usa orden XYZ; convertir a ZYX para ser consistente con DICOM
    arr_xyz = sitk.GetArrayFromImage(sitk_img)   # ya devuelve ZYX (z,y,x)
    volume  = arr_xyz.astype(np.float32)

    # Spacing en SimpleITK: (sx, sy, sz) -> reordenar a (sz, sy, sx)
    sp = sitk_img.GetSpacing()                   # (sx, sy, sz)
    spacing = (float(sp[2]), float(sp[1]), float(sp[0]))

    mask = np.zeros_like(volume, dtype=np.uint8)

    z = volume.shape[0]
    z0, z1 = int(z * 0.30), int(z * 0.70)
    wc_global, ww_global = auto_window(volume[z0:z1])

    clear_slice_cache()
    memory_cache.update({
        "session_id": session_id,
        "volume":     volume,
        "mask":       mask,
        "spacing":    spacing,
        "file_type":  "nrrd",
        "wc":         wc_global,
        "ww":         ww_global,
    })

    print(f" NRRD cargado: shape={volume.shape}  spacing={spacing}  WC={wc_global:.0f} WW={ww_global:.0f}")
    return volume, mask, spacing


def numpy_to_base64(
    arr: np.ndarray,
    is_mask: bool  = False,
    spacing_row: float = 1.0,
    spacing_col: float = 1.0,
    cache_key: tuple = (),
    max_px: int = 2048,
    wc: float = None,
    ww: float = None,
    preserve_hu: bool = False,
) -> str:
    """
    Convierte slice 2D numpy a PNG base64 con aspect ratio físico.
    max_px=2048 para mayor resolución en zoom moderado.
    Aplica UnsharpMask para mejorar la nitidez percibida (similar a visores profesionales).
    """
    if cache_key:
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached

    # Fórmula del aspect ratio físico replicada en EditorScreen:
    # aspect_ratio = (spacing_row / spacing_col)
    # Si el spacing en filas es 3mm y en columnas 0,7mm, hay que estirar la imagen un factor
    # de 3/0,7 = 4,285714 para que se vea correctamente.
    # Se usa el spacing mínimo como referencia para que la imagen no exceda max_px en ninguna dimensión.
    rows, cols = arr.shape[:2]
    # Calcular dimensiones con aspect ratio físico
    phys_h = rows * spacing_row
    phys_w = cols * spacing_col
    min_sp = min(spacing_row, spacing_col)   
    out_h = max(1, round(phys_h / min_sp))
    out_w = max(1, round(phys_w / min_sp))
    
    # Redimensionar si excede max_px
    scale = min(1.0, max_px / max(out_h, out_w))
    if scale < 1.0:
        out_h = max(1, round(out_h * scale))
        out_w = max(1, round(out_w * scale))
    
    buf = io.BytesIO()

    if is_mask:
        #MÁSCARA
        # Se construye un array RGBA donde los píxeles de la máscara (valor > 0) se colorean con un color semitransparente.
        # El resto queda en [0,0,0,0] (transparente).
        rgba = np.zeros((rows, cols, 4), dtype=np.uint8)
        rgba[arr > 0] = [255, 207, 38, 180]
        img = Image.fromarray(rgba, "RGBA")
        if (out_h, out_w) != (rows, cols):
            # NEAREST para preservar bordes nítidos de la máscara.
            img = img.resize((out_w, out_h), Image.NEAREST)
        img.save(buf, format="PNG", compress_level=1)
    
    else:
        # CT
        if preserve_hu:
            # Opción 1: Preservar HU lineales (escala lineal completa)
            # Útil para debug o para exportar datos sin procesar
            min_val = float(arr.min())
            max_val = float(arr.max())
            if max_val - min_val > 0:
                normalized = ((arr - min_val) / (max_val - min_val) * 65535).astype(np.uint16)
            else:
                normalized = np.zeros_like(arr, dtype=np.uint16)
            img_array = (normalized // 256).astype(np.uint8)
            img = Image.fromarray(img_array, mode="L")
            
        else:
            # Opción 2: Windowing médico estándar
            # Usar WC/WW proporcionados o calcular automáticamente
            if wc is not None and ww is not None:
                use_wc, use_ww = float(wc), float(ww)
            else:
                use_wc, use_ww = auto_window(arr)
            
            # Aplicar windowing con clip
            lo = use_wc - use_ww / 2.0
            hi = use_wc + use_ww / 2.0
            windowed = np.clip(arr, lo, hi)
            
            # Normalizar a 0-65535
            if hi - lo > 0:
                normalized = ((windowed - lo) / (hi - lo) * 65535).astype(np.uint16)
            else:
                normalized = np.zeros_like(windowed, dtype=np.uint16)
            
            # Convertir a uint8 para PIL (manteniendo rango completo)
            # Usamos división por 256 en lugar de desplazamiento para preservar gradientes
            img_array = (normalized // 256).astype(np.uint8)
            img = Image.fromarray(img_array, mode="L")
        
        # Redimensionar si es necesario (usar LANCZOS para CT)
        if (out_h, out_w) != (rows, cols):
            img = img.resize((out_w, out_h), Image.LANCZOS)

        # Unsharp mask — realza bordes igual que los visores profesionales de CT
        from PIL import ImageFilter
        img = img.filter(ImageFilter.UnsharpMask(radius=0.6, percent=120, threshold=2))
        
        img.save(buf, format="PNG", compress_level=1)
    
    result = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    
    if cache_key:
        _cache_put(cache_key, result)
    
    return result
#--------------------------------------------------------------------------------------------------------------------------------

#--------------------------------------------------------------------------------------------------------------------------------
# RENDERIZADO EN PARALELO DE LAS 6 VISTAS (3 CT + 3 MÁSCARAS) PARA MEJORAR TIEMPOS DE RESPUESTA

_render_executor = ThreadPoolExecutor(max_workers=3, thread_name_prefix="slice_render")

def render_views_parallel(
    session_id: str,
    volume: np.ndarray,
    mask:   np.ndarray,
    spacing: tuple,
    slice_a: int, slice_s: int, slice_c: int,
    wc: float = None, 
    ww: float = None, 
) -> dict:
    """
    Renderiza las 6 imágenes (3 CT + 3 máscaras) en paralelo.
    
    Args:
        wc: Window center (HU) - si None usa auto_window
        ww: Window width (HU) - si None usa auto_window
    """
    sz, sy, sx = spacing
    z,  y,  x  = volume.shape

    ia = max(0, min(slice_a, z-1))
    is_ = max(0, min(slice_s, x-1))
    ic = max(0, min(slice_c, y-1))

    def render(view, idx, is_mask):
        # Cada vista extrae un plano 2D distinto del volumen 3D y lo convierte a base64.
        # La vista axial es un corte directo en Z sin transformacion.
        # La vista sagital y coronal aplican np.flipud para que el eje vertical (Z) quede orientado
        # con la cabeza arriba.
        ck = (session_id, view, idx, is_mask, wc, ww)  # Incluir wc/ww en caché
        
        if view == "axial":
            arr = mask[ia, :, :] if is_mask else volume[ia, :, :]
            sr, sc = sy, sx
        elif view == "sagital":
            arr = np.flipud(mask[:, :, is_]) if is_mask else np.flipud(volume[:, :, is_])
            sr, sc = sz, sy
        else:  # coronal
            arr = np.flipud(mask[:, ic, :]) if is_mask else np.flipud(volume[:, ic, :])
            sr, sc = sz, sx
        
        # Pasar wc/ww a numpy_to_base64
        return numpy_to_base64(
            arr, 
            is_mask=is_mask, 
            spacing_row=sr, 
            spacing_col=sc, 
            cache_key=ck,
            wc=wc if not is_mask else None,   # Solo aplicar windowing a CT
            ww=ww if not is_mask else None,
        )

    jobs = [
        ("axial", ia, False), ("axial", ia,  True),
        ("sagital", is_, False), ("sagital", is_, True),
        ("coronal", ic, False), ("coronal", ic,  True),
    ]

    futures = [_render_executor.submit(render, v, idx, m) for v, idx, m in jobs]
    results = [f.result() for f in futures]

    return {
        "axial": results[0],
        "axial_mask": results[1],
        "sagital": results[2],
        "sagital_mask": results[3],
        "coronal": results[4],
        "coronal_mask": results[5],
        "dimensions": {"x": x, "y": y, "z": z},
        "spacing": {"z": sz, "y": sy, "x": sx},
    }

#--------------------------------------------------------------------------------------------------------------------------------

#--------------------------------------------------------------------------------------------------------------------------------
# HELPER PARA CLAMP DE ÍNDICES DE SLICES (evita out-of-bounds)
def clamp(val, max_val):
    return max(0, min(int(val), max_val))

#--------------------------------------------------------------------------------------------------------------------------------