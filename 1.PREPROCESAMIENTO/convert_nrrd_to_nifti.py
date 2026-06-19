# Las imágenes TC están en formato .nrrd -> no compatible con redes neuronales.
# Hay que transformar .nrrd a .nii.gz (NIfTI) para poder entrenar el modelo de segmentación automática.


import os
import SimpleITK as sitk
from pathlib import Path

# CONFIGURACIÓN 
IMAGES_FOLDER = "/Users/andrea/Downloads/UNIVERSIDAD/TFG/Casos" 
LABELS_FOLDER = "/Users/andrea/Downloads/UNIVERSIDAD/TFG/Segmentaciones"
OUTPUT_FOLDER = "/Users/andrea/Downloads/UNIVERSIDAD/TFG/Dataset_entrenamiento_nifti"

def convert_and_organize(images_dir, labels_dir, output_dir):
    """
    Convierte NRRD a NIfTI y organiza los datos en la estructura estándar nnU-Net.
    """

    # Crear estructura estándar
    images_tr_dir = os.path.join(output_dir, "imagesTr")
    labels_tr_dir = os.path.join(output_dir, "labelsTr")

    os.makedirs(images_tr_dir, exist_ok=True)
    os.makedirs(labels_tr_dir, exist_ok=True)

    # Listar archivos
    image_files = sorted(Path(images_dir).glob("*.nrrd"))
    label_files = sorted(Path(labels_dir).glob("*.nrrd"))

    print(f"Encontradas {len(image_files)} imágenes TC")
    print(f"Encontradas {len(label_files)} segmentaciones")

    # PROCESAR IMÁGENES 
    for file_path in image_files:
        filename = file_path.name
        patient_id = filename.replace(".nrrd", "")

        try:
            image = sitk.ReadImage(str(file_path))
        except Exception as e:
            print(f"Error leyendo imagen {filename}: {e}")
            continue

        # Estandarizar orientación. Si no aplico RAS (Rigth, Anterior, Superior), los TC se pueden ver girados
        image = sitk.DICOMOrient(image, 'RAS')

        # Convertir a Float32 solo los TC, no las máscaras. Hago esto para poder hacer operaciones matemáticas complejas (PyTorch)
        image = sitk.Cast(image, sitk.sitkFloat32)

        new_name = f"{patient_id}_0000.nii.gz"
        output_path = os.path.join(images_tr_dir, new_name)

        sitk.WriteImage(image, output_path)
        print(f"Imagen convertida: {filename} -> {new_name}")

    # PROCESAR MÁSCARAS 
    for file_path in label_files:
        filename = file_path.name
        patient_id = filename.replace("_seg.nrrd", "")

        try:
            label = sitk.ReadImage(str(file_path))
        except Exception as e:
            print(f"Error leyendo máscara {filename}: {e}")
            continue

        # Estandarizar orientación
        label = sitk.DICOMOrient(label, 'RAS')

        # Convertir a enteros (máscaras)
        label = sitk.Cast(label, sitk.sitkUInt8)

        new_name = f"{patient_id}.nii.gz"
        output_path = os.path.join(labels_tr_dir, new_name)

        sitk.WriteImage(label, output_path)
        print(f"Máscara convertida: {filename} -> {new_name}")

    print("\nProceso finalizado correctamente.")
    print(f"Datos guardados en: {output_dir}")

if __name__ == "__main__":
    convert_and_organize(IMAGES_FOLDER, LABELS_FOLDER, OUTPUT_FOLDER)
