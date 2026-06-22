"""
BASE DE DATOS SQLITE PARA ANÁLISIS RENAL
- Almacena análisis por paciente, incluyendo:
  - Máscara segmentación (gzipada)
  - Volumen CT (gzipado)
  - Spacing (resolución voxel)
  - Reporte HTML generado
  - Resultados del análisis radiómico (guardados como JSON)
- Esquema no-destructivo: ALTER TABLE para añadir columnas nuevas sin perder datos existentes
"""

import sqlite3
import os
import gzip
import json
import struct
import numpy as np
from typing import Optional, Dict, Any
from datetime import datetime

_DB_DIR  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DB_PATH = os.path.join(_DB_DIR, "kidney_analysis.db")


class Database:
    def __init__(self):
        self.db_path = _DB_PATH
        self._init_db()

    #------------------------------------------------------------------------------------------------------------------
    # ESQUEMA DE LA BASE DE DATOS
    #------------------------------------------------------------------------------------------------------------------
    def _init_db(self):
        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()

        c.execute("""
            CREATE TABLE IF NOT EXISTS patient_analyses (
                patient_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                report_html TEXT NOT NULL,

                mask_blob BLOB NOT NULL,
                mask_shape_z INTEGER NOT NULL,
                mask_shape_y INTEGER NOT NULL,
                mask_shape_x INTEGER NOT NULL,

                source TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                patient_name TEXT,
                patient_sex TEXT,
                acquisition_date TEXT
            )
        """)

        # Migración no-destructiva: añadir columnas nuevas si no existen
        existing = {row[1] for row in c.execute("PRAGMA table_info(patient_analyses)")}
        new_cols = [
            ("volume_blob", "BLOB"),
            ("volume_shape_z", "INTEGER"),
            ("volume_shape_y", "INTEGER"),
            ("volume_shape_x", "INTEGER"),
            ("spacing_blob", "BLOB"),
            ("analysis_json", "TEXT"),  
            ("images_json", "TEXT"),   
        ]
        for col, typedef in new_cols:
            if col not in existing:
                try:
                    c.execute(f"ALTER TABLE patient_analyses ADD COLUMN {col} {typedef}")
                except Exception:
                    pass

        conn.commit()
        conn.close()
        print(f"  Base de datos inicializada: {self.db_path}")


    #------------------------------------------------------------------------------------------------------------------
    # GUARDAR ANÁLISIS
    #------------------------------------------------------------------------------------------------------------------
    def save_analysis(
        self,
        patient_id: str,
        report_html: str,
        mask_array: np.ndarray,
        session_id: str,
        source: str,
        patient_name: str = "",
        patient_sex: str = "",
        acquisition_date: str = "",
        volume_array: Optional[np.ndarray] = None,
        spacing: tuple = (1.0, 1.0, 1.0), 
        analysis_result: Optional[dict] = None,
        images: dict = None,
    ) -> bool:
        try:
            # Código de compresión de máscara y volumen 
            mz, my, mx = mask_array.shape
            mask_blob  = gzip.compress(mask_array.astype(np.uint8).tobytes(), compresslevel=6)

            volume_blob  = None
            vz = vy = vx = None
            if volume_array is not None:
                vz, vy, vx  = volume_array.shape
                vol_i16     = np.clip(volume_array, -32768, 32767).astype(np.int16)
                volume_blob = gzip.compress(vol_i16.tobytes(), compresslevel=6)

            # Codificación correcta del spacing como blob de 3 doubles (24 bytes)
            if len(spacing) != 3:
                print(f"Error: spacing tiene longitud {len(spacing)}. Usando (1.0, 1.0, 1.0)")
                spacing = (1.0, 1.0, 1.0)
            spacing_blob = struct.pack("3d", float(spacing[0]), float(spacing[1]), float(spacing[2]))
            
            analysis_json = json.dumps(analysis_result) if analysis_result else None

            conn = sqlite3.connect(self.db_path)
            c = conn.cursor()
            c.execute("""
                INSERT OR REPLACE INTO patient_analyses
                (patient_id, session_id, report_html,
                 mask_blob, mask_shape_z, mask_shape_y, mask_shape_x,
                 volume_blob, volume_shape_z, volume_shape_y, volume_shape_x,
                 spacing_blob, analysis_json,
                 source, timestamp, patient_name, patient_sex, acquisition_date)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (
                patient_id, session_id, report_html,
                mask_blob, int(mz), int(my), int(mx),
                volume_blob, vz, vy, vx,
                spacing_blob, analysis_json,
                source, datetime.now().isoformat(),
                patient_name, patient_sex, acquisition_date,
            ))
            conn.commit()
            conn.close()

            mb_vol  = len(volume_blob) / 1e6 if volume_blob else 0
            mb_mask = len(mask_blob)   / 1e6
            has_an  = " análisis" if analysis_json else "sin análisis"
            print(f"[DB] Guardado {patient_id}: máscara {mb_mask:.1f}MB | volumen {mb_vol:.1f}MB | spacing={spacing} | {has_an}")
            return True

        except Exception as e:
            print(f" [DB] Error CRÍTICO guardando {patient_id}: {e}")
            import traceback; traceback.print_exc()
            return False


    #------------------------------------------------------------------------------------------------------------------
    # RECUPERAR ANÁLISIS - proceso inverso al anterior: descompresión + reconstrucción de arrays
    #------------------------------------------------------------------------------------------------------------------
    def get_analysis(self, patient_id: str) -> Optional[Dict[str, Any]]:
        try:
            conn = sqlite3.connect(self.db_path)
            c = conn.cursor()
            c.execute("""
                SELECT session_id, report_html,
                       mask_blob, mask_shape_z, mask_shape_y, mask_shape_x,
                       volume_blob, volume_shape_z, volume_shape_y, volume_shape_x,
                       spacing_blob, analysis_json,
                       source, timestamp, patient_name, patient_sex, acquisition_date
                FROM patient_analyses
                WHERE patient_id = ?
            """, (patient_id,))
            row = c.fetchone()
            conn.close()
            if not row: return None

            (session_id, report_html,
             mask_blob, mz, my, mx,
             volume_blob, vz, vy, vx,
             spacing_blob, analysis_json,
             source, timestamp, p_name, p_sex, p_date) = row

            # Reconstrucción de Máscara 
            mask_bytes = gzip.decompress(mask_blob)
            mask_array = np.frombuffer(mask_bytes, dtype=np.uint8).reshape((mz, my, mx)).copy()

            # Reconstrucción de Volumen
            volume_array = None
            if volume_blob:
                try:
                    vol_bytes = gzip.decompress(volume_blob)
                    # El shape está guardado en la BD (vz, vy, vx)
                    if vz is not None and vy is not None and vx is not None:
                        vol_i16 = np.frombuffer(vol_bytes, dtype=np.int16).reshape((vz, vy, vx)).copy()
                        volume_array = vol_i16.astype(np.float32)
                    else:
                        print(f"  [DB] Advertencia: volumen guardado sin shape. Ignorando.")
                except Exception as e:
                    print(f"  [DB] Error al descomprimir/reshape el volumen: {e}")
                    volume_array = None

            # Reconstrucción de Spacing
            spacing = (1.0, 1.0, 1.0)
            if spacing_blob:
                try:
                    spacing = struct.unpack("3d", spacing_blob)
                except Exception as e:
                    print(f" [DB] Error al descomprimir spacing: {e}")

            analysis_result = json.loads(analysis_json) if analysis_json else None

            return {
                "session_id": session_id,
                "report_html": report_html,
                "mask_array": mask_array,
                "volume_array": volume_array,
                "spacing": spacing, 
                "analysis_result": analysis_result,
                "images": {}, 
                "source": source,
                "timestamp": timestamp,
                "patient_name": p_name or "Paciente",
                "patient_sex": p_sex or "O",
                "acquisition_date": p_date or "N/A",
            }

        except Exception as e:
            print(f"  [DB] Error recuperando {patient_id}: {e}")
            import traceback; traceback.print_exc()
            return None

db = Database()