import pydicom
import os

def get_patient_metadata(dicom_filepath: str) -> dict:
    """
    Extrae metadatos clave del paciente de un archivo DICOM.
    Retorna un diccionario con las claves que espera el Frontend.
    """
    try:
        # force=True es vital para leer archivos que no tienen cabecera estricta
        ds = pydicom.dcmread(dicom_filepath, force=True)
        
        # Extraemos datos con valores por defecto seguros
        metadata = {
            "id": str(ds.get("PatientID", "N/A")),
            # Formateamos el nombre para que sea legible (quita caracteres raros DICOM)
            "nombre": str(ds.get("PatientName", "Anónimo")).replace('^', ' ').strip(),
            "sexo": str(ds.get("PatientSex", "O")),
            "fechaAdquisicion": str(ds.get("StudyDate", "N/A"))
        }
        return metadata
    
    except Exception as e:
        print(f" Error leyendo metadatos de {os.path.basename(dicom_filepath)}: {e}")
        # En caso de error, devolvemos estructura vacía pero válida
        return {
            "id": "N/A", 
            "nombre": "Paciente", 
            "sexo": "O", 
            "fechaAdquisicion": "N/A"
        }
