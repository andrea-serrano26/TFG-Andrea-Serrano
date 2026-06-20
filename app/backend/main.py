import os
import shutil
import time
import threading
import uvicorn
import webview
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routes.dicom_routes import router as dicom_router, UPLOAD_DIR
from fastapi.staticfiles import StaticFiles

app = FastAPI()

# Configuración CORS para permitir solicitudes desde el frontend en localhost:3000 -> puerto de vite
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/dicom", StaticFiles(directory=UPLOAD_DIR), name="dicom")
app.include_router(dicom_router)

# Función para limpiar sesiones huérfanas en /uploads (tras dos horas sin modificación y sin análisis guardado en BD)
def cleanup_orphan_sessions(max_age_hours: float = 2.0):
    """
    Elimina carpetas de sesión en /uploads que lleven más de max_age_hours
    sin ser modificadas y no tengan análisis guardado en BD.
    Se llama al arrancar la app — limpia sesiones de cierres anteriores.
    """
    if not os.path.isdir(UPLOAD_DIR):
        return

    now = time.time()
    max_age = max_age_hours * 3600
    removed = 0
    kept = 0

    for name in os.listdir(UPLOAD_DIR):
        folder = os.path.join(UPLOAD_DIR, name)
        if not os.path.isdir(folder):
            continue
        try:
            age = now - os.path.getmtime(folder)
            if age > max_age:
                shutil.rmtree(folder, ignore_errors=True)
                removed += 1
            else:
                kept += 1
        except Exception as e:
            print(f" No se pudo limpiar {name}: {e}")

    if removed:
        print(f" Limpieza /uploads: {removed} sesión(es) huérfana(s) eliminada(s), {kept} reciente(s) conservada(s)")
    else:
        print(f" Limpieza /uploads: sin sesiones huérfanas ({kept} reciente(s))")

# Arrancar el servidor FastAPI en un hilo separado para no bloquear la interfaz web
def start_server():
    uvicorn.run(app, host="127.0.0.1", port=8000)


if __name__ == "__main__":
    # Limpiar sesiones huérfanas de arranques anteriores
    cleanup_orphan_sessions(max_age_hours=2.0)

    t = threading.Thread(target=start_server)
    t.daemon = True
    t.start()

    # Abrir la ventana de la aplicación web con PyWebView (conexión a localhost:3000, puerto de Vite)
    webview.create_window(
        title='Sistema de Análisis Renal',
        url='http://localhost:3000',
        width=1280,
        height=800,
        resizable=True,
    )
    webview.start()