#!/usr/bin/env python3
"""
convert_to_nnunet_format.py - Convierte tus datos a formato nnU-Net

FORMATO nnU-Net:
- Nombres: [CASE_ID]_[MODALITY].nii.gz
- Labels: [CASE_ID].nii.gz
- JSON con metadata

"""

import os
import json
import shutil
from pathlib import Path
from tqdm import tqdm
import nibabel as nib
import numpy as np


def create_dataset_json(output_folder, num_training, modality="CT"):
    """
    Crea dataset.json requerido por nnU-Net
    
    Args:
        output_folder: Directorio del dataset
        num_training: Número de casos de entrenamiento
        modality: Modalidad de imagen (CT, MRI, etc.)
    """
    dataset_json = {
        "channel_names": {
            "0": modality
        },
        "labels": {
            "background": 0,
            "kidney": 1,
            "tumor": 2
        },
        "numTraining": num_training,
        "file_ending": ".nii.gz",
        "name": "Kidney",
        "description": "Kidney and tumor segmentation from CT scans",
        "reference": "Hospital Ramon y Cajal",
        "licence": "Your licence",
        "release": "1.0"
    }
    
    json_path = os.path.join(output_folder, "dataset.json")
    with open(json_path, 'w') as f:
        json.dump(dataset_json, f, indent=4)
    
    print(f" dataset.json creado: {json_path}")
    return json_path


def convert_to_nnunet(
    input_dir="./data_cropped",
    output_base="~/nnUNet_raw",
    dataset_id="001",
    dataset_name="Kidney",
    test_split=0.2
):
    """
    Convierte datos a formato nnU-Net
    
    Args:
        input_dir: Directorio con mis datos (case_XXXXX_image/label.nii.gz)
        output_base: Base de nnUNet_raw (debe estar en $nnUNet_raw)
        dataset_id: ID del dataset -> 001
        dataset_name: Kidney
        test_split: Fracción para test set (0.2 = 20%)
    """
    
    # Expandir paths
    output_base = os.path.expanduser(output_base)
    input_dir = os.path.abspath(input_dir)
    
    # Crear estructura nnU-Net
    dataset_folder = os.path.join(output_base, f"Dataset{dataset_id}_{dataset_name}")
    images_tr = os.path.join(dataset_folder, "imagesTr")
    labels_tr = os.path.join(dataset_folder, "labelsTr")
    images_ts = os.path.join(dataset_folder, "imagesTs")  
    labels_ts = os.path.join(dataset_folder, "labelsTs")  
    
    for folder in [images_tr, labels_tr, images_ts, labels_ts]:
        os.makedirs(folder, exist_ok=True)
    
    print("\n" + "="*70)
    print("CONVERSIÓN A FORMATO nnU-Net")
    print("="*70)
    print(f" Input:  {input_dir}")
    print(f" Output: {dataset_folder}")
    print(f" Dataset ID: {dataset_id}")
    print(f" Test split: {test_split*100:.0f}%")
    
    # Buscar todos los casos
    image_files = sorted(Path(input_dir).glob("*_image.nii.gz"))
    
    if len(image_files) == 0:
        print(f"\n No se encontraron imágenes en {input_dir}")
        print("   Formato esperado: case_XXXXX_image.nii.gz")
        return
    
    print(f"\n Casos encontrados: {len(image_files)}")
    
    # Split train/test
    num_cases = len(image_files)
    num_test = int(num_cases * test_split)
    num_train = num_cases - num_test
    
    print(f"   Entrenamiento: {num_train} casos")
    print(f"   Test: {num_test} casos")
    
    # Shuffle para split aleatorio
    import random
    random.seed(42)
    indices = list(range(num_cases))
    random.shuffle(indices)
    
    train_indices = indices[:num_train]
    test_indices = indices[num_train:]
    
    print("\n" + "="*70)
    print("CONVIRTIENDO CASOS:")
    print("="*70)
    
    # Convertir casos de entrenamiento
    for idx, case_idx in enumerate(tqdm(train_indices, desc="Train")):
        image_path = image_files[case_idx]
        label_path = str(image_path).replace('_image.nii.gz', '_label.nii.gz')
        
        if not os.path.exists(label_path):
            print(f"\n  Label no encontrado: {label_path}")
            continue
        
        # Nuevo nombre nnU-Net: kidney_001_0000.nii.gz
        new_id = f"{dataset_name.lower()}_{idx+1:03d}"
        
        # Copiar imagen (añadir _0000 para modalidad 0)
        new_image_name = f"{new_id}_0000.nii.gz"
        new_image_path = os.path.join(images_tr, new_image_name)
        shutil.copy2(image_path, new_image_path)
        
        # Copiar label
        new_label_name = f"{new_id}.nii.gz"
        new_label_path = os.path.join(labels_tr, new_label_name)
        shutil.copy2(label_path, new_label_path)
    
    # Convertir casos de test
    for idx, case_idx in enumerate(tqdm(test_indices, desc="Test ")):
        image_path = image_files[case_idx]
        label_path = str(image_path).replace('_image.nii.gz', '_label.nii.gz')
        
        if not os.path.exists(label_path):
            continue
        
        new_id = f"{dataset_name.lower()}_{idx+1:03d}"
        
        # Test images
        new_image_name = f"{new_id}_0000.nii.gz"
        new_image_path = os.path.join(images_ts, new_image_name)
        shutil.copy2(image_path, new_image_path)
        
        # Test labels (para evaluación)
        new_label_name = f"{new_id}.nii.gz"
        new_label_path = os.path.join(labels_ts, new_label_name)
        shutil.copy2(label_path, new_label_path)
    
    # Crear dataset.json
    create_dataset_json(dataset_folder, num_train)
    
    # Verificar labels
    print("\n" + "="*70)
    print("VERIFICANDO LABELS:")
    print("="*70)
    
    # Verificar que labels tienen valores 0, 1, 2
    sample_label = nib.load(os.path.join(labels_tr, os.listdir(labels_tr)[0]))
    label_data = sample_label.get_fdata()
    unique_values = np.unique(label_data)
    
    print(f"   Valores únicos en labels: {unique_values}")
    
    if not all(v in [0, 1, 2] for v in unique_values):
        print("     ADVERTENCIA: Labels tienen valores inesperados")
        print("      Esperado: [0, 1, 2]")
        print(f"      Encontrado: {unique_values}")
    else:
        print("    Labels correctos (0=background, 1=kidney, 2=tumor)")
    
    print("\n" + "="*70)
    print("CONVERSIÓN COMPLETADA")
    
    return dataset_folder


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Convertir datos a formato nnU-Net')
    parser.add_argument('--input', type=str, default='./data_cropped',
                       help='Directorio con datos cropped')
    parser.add_argument('--output', type=str, default='~/nnUNet_raw',
                       help='Base nnUNet_raw')
    parser.add_argument('--dataset-id', type=str, default='001',
                       help='ID del dataset')
    parser.add_argument('--dataset-name', type=str, default='Kidney',
                       help='Nombre del dataset')
    parser.add_argument('--test-split', type=float, default=0.2,
                       help='Fracción para test set')
    
    args = parser.parse_args()
    
    # Verificar que nnUNet_raw está configurado
    nnunet_raw = os.environ.get('nnUNet_raw')
    if not nnunet_raw:
        print("\n  ADVERTENCIA: Variable $nnUNet_raw no configurada")
        print("\n   Ejecuta:")
        print("   export nnUNet_raw=~/nnUNet_raw")
        print("   export nnUNet_preprocessed=~/nnUNet_preprocessed")
        print("   export nnUNet_results=~/nnUNet_results")
        print("\n   O añade a ~/.bashrc para que sea permanente")
        print("\n   Usando valor por defecto: ~/nnUNet_raw")
    
    convert_to_nnunet(
        input_dir=args.input,
        output_base=args.output,
        dataset_id=args.dataset_id,
        dataset_name=args.dataset_name,
        test_split=args.test_split
    )
