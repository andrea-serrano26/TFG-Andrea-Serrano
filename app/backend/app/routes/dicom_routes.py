"""
dicom_routes.py
Rutas de FastAPI para manejo de DICOMs, renderizado de vistas, edición de máscaras, análisis de radiómica y gestión de sesiones. 
Incluye endpoints para subir DICOMs, obtener vistas ortogonales, ejecutar inferencia, cargar máscaras NIfTI, analizar tumores,
editar máscaras, guardar análisis en base de datos y abrir informes HTML. 
Utiliza caché en memoria para mejorar rendimiento y reducir accesos a disco. 
Maneja errores con HTTPException y devuelve respuestas JSON estructuradas para el frontend.
"""

import os
import uuid
import shutil
import tempfile
import subprocess
import sys
import logging
import numpy as np
from fastapi import APIRouter, UploadFile, File, HTTPException, Body, Query, BackgroundTasks
from fastapi.responses import Response
import platform
import asyncio

from app.services.dicom_processor import (
    load_volume_data, load_nrrd_volume, numpy_to_base64,
    update_mask_from_edit, load_nifti_mask,
    render_views_parallel, clear_slice_cache,
    memory_cache, clamp as dp_clamp,
)

from app.services.segmentation_service import ( 
    run_segmentation, ModelNotFoundError, MODELS_DIR,N_FOLDS, CHECKPOINT_TEMPLATE,
)
from app.services.mesh_generator import generate_mesh_from_mask
from app.services.radiomics_service import analyze_tumor
from app.utils.dicom_utils import get_patient_metadata
from app.database import db


router = APIRouter()
BASE_DIR   = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)
clamp = dp_clamp

logger = logging.getLogger(__name__)

# Dict de estado por sesión para que el frontend pueda hacer polling
# { session_id: { "status": "idle"|"running"|"done"|"error", "progress": 0-100,
#                 "voxels": int, "volume_cm3": float, "error": str } }
_inference_status: dict = {}

#--------------------------------------------------------------------------------------------------------------------------------
# FUNCIÓN AUXILIAR PARA OBTENER VOLUMEN, MÁSCARA Y SPACING DESDE CACHÉ O DISCO

def _get_volume_mask_spacing(session_id: str):
    """
    Devuelve (volume, mask, spacing) desde caché o disco.
    - "saved_*"  → sesión recuperada de BD, solo en caché.
    - "nrrd_*"   → sesión NRRD, carga con SimpleITK.
    - resto      → sesión DICOM normal.
    """
    if session_id.startswith("saved_"):
        if memory_cache["session_id"] != session_id:
            raise HTTPException(status_code=404, detail=f"Sesión {session_id} no encontrada en caché")
        return memory_cache["volume"], memory_cache["mask"], memory_cache["spacing"]
    if session_id.startswith("nrrd_"):
        return load_nrrd_volume(UPLOAD_DIR, session_id)
    return load_volume_data(UPLOAD_DIR, session_id)
#--------------------------------------------------------------------------------------------------------------------------------

#--------------------------------------------------------------------------------------------------------------------------------
# ENDPOINTS DE CARGA E INICIALIZACIÓN -> LoadScreen.tsx

@router.post("/api/upload-dicom")
async def upload_dicom(files: list[UploadFile] = File(...)):
    """
    Recibe archivos subidos por el usuario: DICOM (.dcm) o NRRD (.nrrd / .nhdr).
    - DICOM: crea sesión normal con UUID; extrae metadatos del paciente del primer .dcm.
    - NRRD:  crea sesión con prefijo "nrrd_" + UUID; metadatos no disponibles (formato no los incluye).
    En ambos casos carga el volumen en caché y devuelve dimensiones y spacing al frontend.
    """
    session_id   = str(uuid.uuid4())
    session_path = os.path.join(UPLOAD_DIR, session_id)
    os.makedirs(session_path, exist_ok=True)

    patient_info = {"id": "Desconocido", "nombre": "Paciente", "sexo": "O", "fechaAdquisicion": "N/A"}
    files_saved  = 0
    has_nrrd     = False
    has_dicom    = False

    for file in files:
        name = file.filename
        if not name or name.startswith("."): continue
        path = os.path.join(session_path, os.path.basename(name))
        with open(path, "wb") as b: shutil.copyfileobj(file.file, b)
        files_saved += 1
        ext = name.lower()
        if ext.endswith((".nrrd", ".nhdr")):
            has_nrrd = True
        elif ext.endswith(".dcm"):
            has_dicom = True
            if files_saved == 1:
                try: patient_info = get_patient_metadata(path)
                except: pass

    try:
        if has_nrrd and not has_dicom:
            # Renombrar carpeta de sesión con prefijo nrrd_ para que
            # _get_volume_mask_spacing use el cargador correcto
            nrrd_session_id   = "nrrd_" + session_id
            nrrd_session_path = os.path.join(UPLOAD_DIR, nrrd_session_id)
            os.rename(session_path, nrrd_session_path)
            session_id   = nrrd_session_id
            vol, mask, spacing = load_nrrd_volume(UPLOAD_DIR, session_id)
        else:
            vol, mask, spacing = load_volume_data(UPLOAD_DIR, session_id)

        return {
            "success":      True,
            "session_id":   session_id,
            "patient_info": patient_info,
            "total_slices": vol.shape[0],
            "dimensions":   {"z": vol.shape[0], "y": vol.shape[1], "x": vol.shape[2]},
            "spacing":      {"z": spacing[0], "y": spacing[1], "x": spacing[2]},
        }
    except Exception as e:
        return {"success": False, "error": str(e)}
    
    
@router.get("/api/volume-info/{session_id}")
async def get_volume_info(session_id: str):
    """
    Devuelve dimensiones y spacing del volumen para configurar las vistas.
    Soporta sesiones DICOM y NRRD.
    """
    volume, _, spacing = _get_volume_mask_spacing(session_id)
    z, y, x = volume.shape
    return {"dimensions": {"z": z, "y": y, "x": x},
            "spacing":    {"z": spacing[0], "y": spacing[1], "x": spacing[2]}}

#--------------------------------------------------------------------------------------------------------------------------------

#--------------------------------------------------------------------------------------------------------------------------------
# ENDPOINTS DE VISUALIZACIÓN Y RENDERIZADO DE VISTAS ORTOGONALES

@router.get("/api/get-views/{session_id}/{slice_a}/{slice_s}/{slice_c}")
async def get_views(
    session_id: str, 
    slice_a: int, 
    slice_s: int, 
    slice_c: int,
    wc: float = Query(None, description="Window center (HU)"),
    ww: float = Query(None, description="Window width (HU)"),
):
    """
    Renderiza las 3 vistas ortogonales en paralelo usando LRU caché.
    Parámetros opcionales:
        wc: Window center (HU) 
        ww: Window width (HU)
    Si el volumen no está disponible (registro antiguo), devuelve imágenes en negro.
    Usa render_views_parallel para procesamiento en paralelo.
    """
    try:
        volume, mask, spacing = _get_volume_mask_spacing(session_id)
 
        if volume is None:
            z, y, x  = mask.shape
            sz, sy, sx = spacing
            blank_yx = np.zeros((y, x), dtype=np.float32)
            blank_zy = np.zeros((z, y), dtype=np.float32)
            blank_zx = np.zeros((z, x), dtype=np.float32)
            return {
                "axial": numpy_to_base64(blank_yx, spacing_row=sy, spacing_col=sx),
                "axial_mask": numpy_to_base64(mask[dp_clamp(slice_a,z-1),:,:], is_mask=True, spacing_row=sy, spacing_col=sx),
                "sagital": numpy_to_base64(blank_zy, spacing_row=sz, spacing_col=sy),
                "sagital_mask": numpy_to_base64(np.flipud(mask[:,:,dp_clamp(slice_s,x-1)]), is_mask=True, spacing_row=sz, spacing_col=sy),
                "coronal": numpy_to_base64(blank_zx, spacing_row=sz, spacing_col=sx),
                "coronal_mask": numpy_to_base64(np.flipud(mask[:,dp_clamp(slice_c,y-1),:]), is_mask=True, spacing_row=sz, spacing_col=sx),
                "dimensions": {"x": x, "y": y, "z": z},
                "spacing": {"z": sz, "y": sy, "x": sx},
                "no_volume": True,
            }
 
        return render_views_parallel(
            session_id, volume, mask, spacing, slice_a, slice_s, slice_c,
            # Usar WC/WW de la caché global (computados del volumen completo al cargar)
            # Si se pasan como query params, tienen prioridad (el usuario ajustó manualmente)
            wc if wc is not None else memory_cache.get("wc"),
            ww if ww is not None else memory_cache.get("ww"),
        )
 
    except HTTPException: raise
    except Exception as e:
        import traceback; print(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))
     
 
#--------------------------------------------------------------------------------------------------------------------------------

#--------------------------------------------------------------------------------------------------------------------------------
# ENDPOINTS DE MÁSCARA
 
# En M1/M2/M3 el MPS no garantiza todas las ops 3D; forzar modo rápido
_IS_APPLE_SILICON = platform.machine() == "arm64" and platform.system() == "Darwin"

USE_ENSEMBLE = os.environ.get("USE_ENSEMBLE", "false" if _IS_APPLE_SILICON else "true").lower() == "true"
USE_TTA = os.environ.get("USE_TTA", "false").lower() == "true"
 
@router.post("/api/run-inference/{session_id}")
async def run_inference(session_id: str, background_tasks: BackgroundTasks):
    """
    Lanza la segmentación en background (no bloquea el event loop).
    Devuelve 200 inmediatamente; el frontend hace polling a /api/inference-status.
    """
    if memory_cache.get("session_id") != session_id:
        raise HTTPException(status_code=404,
            detail=f"Sesión '{session_id}' no encontrada en caché. Recarga los archivos DICOM.")

    volume = memory_cache.get("volume")
    if volume is None:
        raise HTTPException(status_code=404,
            detail="Volumen CT no disponible. Recarga los archivos DICOM.")

    # Si ya hay una inferencia en curso, no lanzar otra
    if _inference_status.get(session_id, {}).get("status") == "running":
        return {"success": True, "status": "already_running"}

    spacing = memory_cache.get("spacing", (1.0, 1.0, 1.0))
    available_folds = [
        fold for fold in range(N_FOLDS)
        if os.path.isfile(os.path.join(MODELS_DIR, CHECKPOINT_TEMPLATE.format(fold=fold)))
    ]
    folds_to_use = available_folds if USE_ENSEMBLE else ([available_folds[0]] if available_folds else [])

    logger.info(f"[INFERENCE] Sesión={session_id} | Shape={volume.shape} | "
                f"Spacing={spacing} | Folds={folds_to_use} | TTA={USE_TTA}")

    _inference_status[session_id] = {"status": "running", "progress": 0,
                                     "voxels": 0, "volume_cm3": 0.0}

    async def _run():
        try:
            mask = await asyncio.to_thread(
                run_segmentation,
                volume_hu    = volume,
                spacing      = spacing,
                use_ensemble = USE_ENSEMBLE,
                use_tta      = USE_TTA,
            )
            memory_cache["mask"] = mask
            memory_cache.pop("stl_cache", None)
            n_vox   = int(mask.sum())
            vox_vol = float(spacing[0]) * float(spacing[1]) * float(spacing[2])
            vol_cm3 = round(n_vox * vox_vol / 1000.0, 2)
            _inference_status[session_id] = {
                "status": "done", "progress": 100,
                "voxels": n_vox, "volume_cm3": vol_cm3,
            }
            logger.info(f"[INFERENCE] Completado → {n_vox} vóxeles | ~{vol_cm3} cm³")

        except ModelNotFoundError as exc:
            _inference_status[session_id] = {"status": "error", "error": str(exc)}
            logger.error(f"[INFERENCE] Modelo no encontrado: {exc}")

        except Exception as exc:
            import traceback
            _inference_status[session_id] = {"status": "error", "error": str(exc)}
            logger.error(f"[INFERENCE] Error inesperado:\n{traceback.format_exc()}")

    background_tasks.add_task(_run)
    return {"success": True, "status": "started"}


@router.get("/api/inference-status/{session_id}")
@router.get("/api/inference-status/{session_id}/{ax}/{sag}/{cor}")
async def inference_status(session_id: str, ax: int = 0, sag: int = 0, cor: int = 0):
    """
    Polling del estado de la inferencia. Acepta la URL con o sin coordenadas de slice.
    Devuelve: { status, progress, voxels, volume_cm3 }
    """
    if memory_cache.get("session_id") != session_id:
        raise HTTPException(status_code=404, detail="Sesión no encontrada")

    info = _inference_status.get(session_id, {"status": "idle", "progress": 0,
                                               "voxels": 0, "volume_cm3": 0.0})
    return info
 


@router.post("/api/edit-mask-slice/{session_id}")
async def edit_mask_slice(session_id: str, payload: dict = Body(...)):
    """
    Carga la máscara editada de un slice específico (axial/sagital/coronal) y actualiza la máscara completa en caché.
    El payload debe contener:
    - view: "axial", "sagital" o "coronal
    - slice_idx: índice del slice editado
    - mask_slice: array 2D con la máscara editada para ese slice (en formato base64 o array numérico)
    La función actualiza solo el slice correspondiente en la máscara completa, manteniendo el resto intacto.
    Después de actualizar la máscara, se invalida la caché de slices renderizados para que se vuelvan a generar 
    con la nueva máscara al solicitar las vistas.
    """
    try:
        if memory_cache["session_id"] != session_id or memory_cache["volume"] is None:
            raise HTTPException(status_code=404, detail="Sesión no encontrada en caché")

        # Si la máscara no existe aún, inicializarla como ceros (edición manual sin segmentación previa)
        mask = memory_cache.get("mask")
        if mask is None:
            volume_tmp = memory_cache["volume"]
            mask = np.zeros_like(volume_tmp, dtype=np.uint8)
            memory_cache["mask"] = mask
            print(f"  [edit-mask-slice] Máscara inicializada como ceros ({mask.shape})")

        z, y, x   = memory_cache["volume"].shape
        view      = payload["view"]
        slice_idx = int(payload["slice_idx"])
        raw       = np.array(payload["mask_slice"], dtype=np.uint8)

        if view == "axial":
            idx = clamp(slice_idx, z - 1); h, w = raw.shape
            mask[idx, :min(h,y), :min(w,x)] = raw[:y, :x]
        elif view == "sagital":
            idx = clamp(slice_idx, x - 1); restored = np.flipud(raw); h, w = restored.shape
            mask[:min(h,z), :min(w,y), idx] = restored[:z, :y]
        elif view == "coronal":
            idx = clamp(slice_idx, y - 1); restored = np.flipud(raw); h, w = restored.shape
            mask[:min(h,z), idx, :min(w,x)] = restored[:z, :x]
        else:
            raise HTTPException(status_code=400, detail=f"Vista desconocida: {view}")

        memory_cache["mask"] = mask
        memory_cache.pop("stl_cache", None) 
        return {"success": True}
    except HTTPException: raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/save-mask/{session_id}")
async def save_mask_endpoint(session_id: str):
    """
    Guarda la máscara editada en formato .npy y .nii.gz (si nibabel está disponible) en la carpeta de la sesión.
    """
    try:
        if memory_cache["session_id"] != session_id:
            raise HTTPException(status_code=404, detail="Sesión no encontrada")
        mask         = memory_cache["mask"]
        spacing      = memory_cache["spacing"]
        session_path = os.path.join(UPLOAD_DIR, session_id)
        npy_path     = os.path.join(session_path, "mask_edited.npy")
        np.save(npy_path, mask)
        try:
            import nibabel as nib
            mask_ras = np.transpose(mask[:, ::-1, :], (2, 1, 0))
            affine   = np.diag([spacing[2], spacing[1], spacing[0], 1.0])
            nib.save(nib.Nifti1Image(mask_ras.astype(np.int16), affine),
                     os.path.join(session_path, "mask_edited.nii.gz"))
        except Exception as e:
            print(f"  No se pudo guardar NIfTI: {e}")
        return {"success": True, "voxels": int(mask.sum()), "npy_path": npy_path}
    except HTTPException: raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/get-mask-volume/{session_id}")
async def get_mask_volume(session_id: str):
    """
    Devuelve la máscara completa en formato base64 junto con sus dimensiones y cantidad de voxels.
    Si la máscara no existe aún (sesión nueva sin segmentación), la inicializa como ceros
    para que el editor pueda cargar y permitir edición manual desde cero.
    """
    try:
        import base64 as b64
        if memory_cache["session_id"] != session_id:
            raise HTTPException(status_code=404, detail="Sesión no encontrada en caché")

        mask = memory_cache.get("mask")
        if mask is None:
            volume = memory_cache.get("volume")
            if volume is None:
                raise HTTPException(status_code=404, detail="Volumen no disponible en caché")
            mask = np.zeros_like(volume, dtype=np.uint8)
            memory_cache["mask"] = mask
            print(f"  [get-mask-volume] Máscara inicializada como ceros ({mask.shape})")

        z, y, x = mask.shape
        return {"success": True, "data": b64.b64encode(mask.flatten().tobytes()).decode(),
                "shape": {"z": z, "y": y, "x": x}, "voxels": int(mask.sum())}
    except HTTPException: raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

#--------------------------------------------------------------------------------------------------------------------------------

#--------------------------------------------------------------------------------------------------------------------------------
# ENDPOINTS DE MALLADO 3D

@router.get("/api/get-3d-model/{session_id}")
async def get_3d_model(session_id: str):
    try:
        if memory_cache["session_id"] != session_id:
            raise HTTPException(status_code=404, detail="Sesión no encontrada")

        mask    = memory_cache.get("mask")
        spacing = memory_cache.get("spacing", (1.0, 1.0, 1.0))

        # TumorViewer3D detecta blob.size < 200 -> estado 'empty', sin reintentar.
        _EMPTY_STL = b'\x00' * 80 + b'\x00\x00\x00\x00'

        n_tumor = int((mask == 2).sum()) if mask is not None else 0
        if n_tumor == 0:
            return Response(content=_EMPTY_STL, media_type="application/octet-stream",
                            headers={"Content-Disposition": f"inline; filename=tumor_{session_id}.stl"})

        cached_stl = memory_cache.get("stl_cache")
        if cached_stl is None:
            # Pasar solo los vóxeles de tumor (clase 2) al generador de malla
            tumor_mask = (mask == 2).astype(np.uint8)
            stl_bytes  = await asyncio.to_thread(generate_mesh_from_mask, tumor_mask, spacing)
            memory_cache["stl_cache"] = stl_bytes
        else:
            stl_bytes = cached_stl

        return Response(content=stl_bytes, media_type="application/octet-stream",
                        headers={"Content-Disposition": f"inline; filename=tumor_{session_id}.stl"})
    except HTTPException: raise
    except Exception as e:
        import traceback; print(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))

#--------------------------------------------------------------------------------------------------------------------------------

#--------------------------------------------------------------------------------------------------------------------------------
# ENDPOINTS DE ANÁLISIS RADIÓMICO

@router.post("/api/analyze-tumor/{session_id}")
async def analyze_tumor_endpoint(session_id: str):
    """
    Ejecuta el análisis radiómico del tumor usando la máscara y el volumen en caché.
    Devuelve un JSON con los resultados del análisis para mostrar en el frontend.
    Si el volumen no está disponible (registro antiguo), el análisis se ejecuta solo con la máscara pero indicando que el 
    análisis es limitado por falta de volumen CT.
    """
    try:
        if memory_cache["session_id"] != session_id:
            raise HTTPException(status_code=404, detail=f"Sesión {session_id} no encontrada")
        if memory_cache["mask"] is None:
            raise HTTPException(status_code=404, detail="Máscara no encontrada")

        mask    = memory_cache["mask"]
        volume  = memory_cache.get("volume")
        spacing = memory_cache.get("spacing", (1.0, 1.0, 1.0))

        # Verificar que hay vóxeles de tumor (clase 2) antes de lanzar el análisis
        n_tumor = int((mask == 2).sum())
        if n_tumor == 0:
            return {
                "success": False,
                "error": (
                    "La máscara no contiene región tumoral.\n"
                    "Aplica la segmentación automática o pinta el tumor "
                    "manualmente en el editor antes de analizar."
                )
            }

        if volume is None:
            volume = np.zeros_like(mask, dtype=np.float32)
            print("  Análisis sin volumen CT, usando array vacío")

        analysis = analyze_tumor(mask, volume, spacing)
        return {"success": True, "analysis": analysis}

    except HTTPException: raise
    except Exception as e:
        import traceback; print(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))
    
#--------------------------------------------------------------------------------------------------------------------------------

#--------------------------------------------------------------------------------------------------------------------------------
# ENDPOINTS DE GESTIÓN DE SESIONES Y BASE DE DATOS

@router.post("/api/save-analysis")
async def save_analysis_endpoint(payload: dict = Body(...)):
    """
    Guarda análisis completo:
    - Volumen CT desde memory_cache (int16 + gzip)
    - Resultados del análisis radiómico (JSON) para no recalcular al recuperar
    - Máscara + metadatos + informe HTML
    """
    try:
        patient_id = payload.get("patient_id")
        session_id = payload.get("session_id")
        report_html = payload.get("report_html")
        source = payload.get("source", "viewer")
        patient_name = payload.get("patient_name", "")
        patient_sex = payload.get("patient_sex", "")
        acquisition_date = payload.get("acquisition_date", "")
        analysis_result = payload.get("analysis_result")   # resultados del análisis

        if not patient_id or not session_id or not report_html:
            raise HTTPException(status_code=400, detail="Faltan campos obligatorios")

        if memory_cache["session_id"] != session_id or memory_cache["mask"] is None:
            raise HTTPException(status_code=404, detail="Sesión o máscara no encontrada en caché")

        mask = memory_cache["mask"]
        volume = memory_cache.get("volume")
        spacing = memory_cache.get("spacing", (1.0, 1.0, 1.0))

        success = db.save_analysis(
            patient_id=patient_id,
            report_html=report_html,
            mask_array=mask,
            session_id=session_id,
            source=source,
            patient_name=patient_name,
            patient_sex=patient_sex,
            acquisition_date=acquisition_date,
            volume_array=volume,
            spacing=spacing,
            analysis_result=analysis_result,
        )

        if not success:
            raise HTTPException(status_code=500, detail="Error guardando en BD")

        # Borrar carpeta de la sesión -> ya está todo en BD
        session_path = os.path.join(UPLOAD_DIR, session_id)
        if os.path.isdir(session_path):
            try:
                shutil.rmtree(session_path)
                print(f"  Carpeta de sesión eliminada: {session_id}")
            except Exception as e_rm:
                print(f"  No se pudo eliminar {session_id}: {e_rm}")

        return {"success": True, "message": f"Análisis guardado para {patient_id}"}

    except HTTPException: raise
    except Exception as e:
        import traceback; print(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/load-analysis-full/{patient_id}")
async def load_analysis_full_endpoint(patient_id: str):
    """
    Llamado en LoadScreen.tsx cuando el usuario ingresa un ID de paciente para cargar un análisis guardado.
    Recupera análisis guardado:
      1. Restaura volumen CT + máscara en memory_cache
      2. Devuelve los resultados del análisis YA GUARDADOS 
      3. Si no hay resultados guardados (registro antiguo), devuelve None para que
         el frontend los recalcule
    """
    try:
        result = db.get_analysis(patient_id)
        if not result:
            return {"success": False, "error": "Análisis no encontrado"}

        temp_session_id = f"saved_{patient_id}"
        volume_array    = result.get("volume_array")
        mask_array      = result["mask_array"]
        spacing         = result.get("spacing", (1.0, 1.0, 1.0))

        # Restaurar en memory_cache para que get-views sirva slices bajo demanda
        memory_cache.update({
            "session_id": temp_session_id,
            "volume":     volume_array,
            "mask":       mask_array,
            "spacing":    spacing,
            "file_type":  "saved",
        })

        z, y, x = mask_array.shape
        has_vol = volume_array is not None
        if has_vol:
            vz, vy, vx = volume_array.shape
            print(f" Análisis cargado: volumen {vz}×{vy}×{vx} + máscara en memory_cache")
        else:
            print(f"  Análisis antiguo: solo máscara {z}×{y}×{x} (sin volumen CT)")

        dims = {"x": volume_array.shape[2] if has_vol else x,
                "y": volume_array.shape[1] if has_vol else y,
                "z": volume_array.shape[0] if has_vol else z}

        return {
            "success": True,
            "session_id": temp_session_id,
            "patient_data": {
                "id": patient_id,
                "nombre": result["patient_name"],
                "sexo": result["patient_sex"],
                "fechaAdquisicion": result["acquisition_date"],
            },
            "source": result["source"],
            "timestamp": result["timestamp"],
            "dimensions": dims,
            "spacing": {"z": spacing[0], "y": spacing[1], "x": spacing[2]},
            "has_volume": has_vol,
            "analysis_result": result.get("analysis_result"),  
        }

    except Exception as e:
        import traceback; print(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))

#--------------------------------------------------------------------------------------------------------------------------------

#--------------------------------------------------------------------------------------------------------------------------------
# ENDPOINTS DE INFORMES Y VISUALIZACIÓN EXTERNA

@router.post("/api/open-report")
async def open_report_endpoint(payload: dict = Body(...)):
    """
    Escribe el HTML del informe a un archivo temporal y lo abre con el
    navegador/visor del sistema operativo.
    Necesario en pywebview donde window.open() con blob URLs no funciona.
    """
    try:
        html       = payload.get("html", "")
        patient_id = payload.get("patient_id", "informe")

        if not html:
            raise HTTPException(status_code=400, detail="HTML vacío")

        # Crear archivo temporal persistente (se queda hasta que el SO lo elimine)
        tmp_dir  = tempfile.gettempdir()
        tmp_path = os.path.join(tmp_dir, f"informe_{patient_id}.html")
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(html)

        # Abrir con el visor por defecto del SO
        if sys.platform == "darwin":
            subprocess.Popen(["open", tmp_path])
        elif sys.platform == "win32":
            os.startfile(tmp_path)
        else:
            subprocess.Popen(["xdg-open", tmp_path])

        return {"success": True, "path": tmp_path}

    except HTTPException: raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    
#--------------------------------------------------------------------------------------------------------------------------------