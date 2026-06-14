#!/usr/bin/env python3
"""
combine_kidney_tumor.py

Script para combinar máscaras de riñón (TotalSegmentator) y tumor en formato 3 clases.

Uso:
    python3 combine_kidney_tumor.py --kidney_dir ./kidney_masks --tumor_dir ./data_original --output_dir ./data

Output format:
    0 = Background
    1 = Kidney (parénquima renal sin tumor)
    2 = Tumor
"""

import nibabel as nib
import numpy as np
import glob
import os
import argparse
from scipy import ndimage

def resample_mask_to_reference(mask_data, mask_affine, ref_affine, ref_shape, order=0):
    """
    Resamplea una máscara al espacio de referencia usando transformaciones afines
    
    Args:
        mask_data: Datos de la máscara a resamplear
        mask_affine: Transformación afín de la máscara
        ref_affine: Transformación afín de referencia
        ref_shape: Shape del volumen de referencia
        order: Orden de interpolación (0=nearest para labels)
    
    Returns:
        Máscara resampleada en el espacio de referencia
    """
    from scipy.ndimage import affine_transform
    
    # Calcular transformación inversa
    inv_ref_affine = np.linalg.inv(ref_affine)
    combined_affine = inv_ref_affine @ mask_affine
    
    # Aplicar transformación
    resampled = affine_transform(
        mask_data,
        combined_affine[:3, :3],
        offset=combined_affine[:3, 3],
        output_shape=ref_shape,
        order=order,
        mode='constant',
        cval=0
    )
    
    return resampled


def combine_masks(kidney_path, tumor_path, output_path, verbose=True):
    """
    Combina máscaras de riñón (TotalSegmentator) y tumor en formato 3 clases
    
    Args:
        kidney_path: Ruta a la máscara del riñón
        tumor_path: Ruta a la máscara original del tumor
        output_path: Ruta de salida para la máscara combinada
        verbose: Imprimir información detallada
    
    Returns:
        Máscara combinada (numpy array) o None si hay error
    """
    try:
        # Cargar datos
        kidney_img = nib.load(kidney_path)
        tumor_img = nib.load(tumor_path)
        
        kidney_data = kidney_img.get_fdata()
        tumor_data = tumor_img.get_fdata()
        
        # Verificar shapes
        if kidney_data.shape != tumor_data.shape:
            if verbose:
                print(f"Shapes diferentes - Kidney: {kidney_data.shape}, Tumor: {tumor_data.shape}")
                print(f"Resampleando kidney al espacio del tumor...")
            
            # Resamplear kidney al espacio del tumor
            kidney_data = resample_mask_to_reference(
                kidney_data,
                kidney_img.affine,
                tumor_img.affine,
                tumor_data.shape,
                order=0  # Nearest neighbor para labels
            )
        
        # Crear máscara combinada
        combined = np.zeros_like(tumor_data, dtype=np.uint8)
        
        # Paso 1: Marcar riñón como clase 1
        # TotalSegmentator puede dar valores >1 si incluye ambos riñones
        # Los unificamos todos como clase 1
        combined[kidney_data > 0] = 1
        
        # Paso 2: Marcar tumor como clase 2 (sobrescribe riñón si hay overlap)
        combined[tumor_data > 0] = 2
        
        # Estadísticas
        n_kidney_only = np.sum(combined == 1)
        n_tumor = np.sum(combined == 2)
        n_background = np.sum(combined == 0)
        total = combined.size
        
        if verbose:
            case_name = os.path.basename(output_path)
            print(f"\n {case_name}:")
            print(f"   Background: {n_background:>10,} ({n_background/total*100:>5.1f}%)")
            print(f"   Kidney:     {n_kidney_only:>10,} ({n_kidney_only/total*100:>5.1f}%)")
            print(f"   Tumor:      {n_tumor:>10,} ({n_tumor/total*100:>5.1f}%)")
        
        # Validaciones de calidad
        warnings = []
        
        if n_kidney_only == 0:
            warnings.append("No hay riñón etiquetado")
        
        if n_tumor == 0:
            warnings.append("No hay tumor etiquetado")
        
        # Verificar que tumor está dentro o cerca del riñón
        if n_tumor > 0 and n_kidney_only > 0:
            kidney_mask = (combined == 1) | (combined == 2)  # Todo el riñón (con tumor)
            tumor_mask = combined == 2
            
            # Dilatar riñón para dar margen
            kidney_dilated = ndimage.binary_dilation(kidney_mask, iterations=10)
            
            tumor_near_kidney = tumor_mask & kidney_dilated
            overlap_pct = tumor_near_kidney.sum() / n_tumor * 100
            
            if overlap_pct < 70:
                warnings.append(f"Solo {overlap_pct:.1f}% del tumor está cerca del riñón")
        
        # Mostrar warnings
        if warnings and verbose:
            for warning in warnings:
                print(f"WARNING: {warning}")
        
        # Guardar
        # Usar affine del tumor (que es nuestra referencia)
        output_img = nib.Nifti1Image(combined, tumor_img.affine, tumor_img.header)
        nib.save(output_img, output_path)
        
        return combined
        
    except Exception as e:
        print(f"\n Error procesando {os.path.basename(tumor_path)}: {e}")
        return None


def main():
    parser = argparse.ArgumentParser(
        description='Combina máscaras de riñón (TotalSegmentator) y tumor en formato 3 clases',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Ejemplos de uso:
  python combine_kidney_tumor.py --kidney_dir ./kidney_masks --tumor_dir ./data_original --output_dir ./data
  python combine_kidney_tumor.py --kidney_dir ./ts_output --tumor_dir ./old_data --output_dir ./new_data --quiet

Formato de salida:
  0 = Background
  1 = Kidney (parénquima renal sin tumor)  
  2 = Tumor
        """
    )
    
    parser.add_argument('--kidney_dir', type=str, required=True,
                        help='Directorio con máscaras de riñón de TotalSegmentator')
    parser.add_argument('--tumor_dir', type=str, required=True,
                        help='Directorio con máscaras originales de tumor e imágenes CT')
    parser.add_argument('--output_dir', type=str, required=True,
                        help='Directorio de salida con máscaras combinadas')
    parser.add_argument('--kidney_suffix', type=str, default='_kidney.nii.gz',
                        help='Sufijo de archivos de riñón (default: _kidney.nii.gz)')
    parser.add_argument('--quiet', action='store_true',
                        help='Modo silencioso (menos output)')
    
    args = parser.parse_args()
    
    # Crear directorio de salida
    os.makedirs(args.output_dir, exist_ok=True)
    
    if not args.quiet:
        print("\n" + "="*70)
        print("COMBINANDO MÁSCARAS DE RIÑÓN Y TUMOR")
        print("="*70)
        print(f"\n Directorios:")
        print(f"   Riñones: {args.kidney_dir}")
        print(f"   Tumores: {args.tumor_dir}")
        print(f"   Salida:  {args.output_dir}")
    
    # Buscar todos los archivos de tumor
    tumor_pattern = f"{args.tumor_dir}/*_label.nii.gz"
    tumor_files = sorted(glob.glob(tumor_pattern))
    
    if len(tumor_files) == 0:
        print(f"\n No se encontraron archivos de tumor en: {tumor_pattern}")
        print("   Verifica que el directorio y el patrón sean correctos")
        return 1
    
    if not args.quiet:
        print(f"\n Encontrados {len(tumor_files)} casos con tumor")
    
    success_count = 0
    error_count = 0
    missing_kidney = []
    missing_image = []
    
    for i, tumor_file in enumerate(tumor_files, 1):
        # Obtener ID del caso
        case_id = os.path.basename(tumor_file).replace("_label.nii.gz", "")
        
        # Buscar archivo de riñón correspondiente
        kidney_file = f"{args.kidney_dir}/{case_id}{args.kidney_suffix}"
        
        if not os.path.exists(kidney_file):
            missing_kidney.append(case_id)
            error_count += 1
            continue
        
        # Archivo de imagen (copiar sin modificar)
        image_file = f"{args.tumor_dir}/{case_id}_image.nii.gz"
        
        if not os.path.exists(image_file):
            missing_image.append(case_id)
            error_count += 1
            continue
        
        # Rutas de salida
        output_label = f"{args.output_dir}/{case_id}_label.nii.gz"
        output_image = f"{args.output_dir}/{case_id}_image.nii.gz"
        
        # Combinar máscaras
        if not args.quiet:
            print(f"\n[{i}/{len(tumor_files)}] Procesando {case_id}...")
        
        result = combine_masks(kidney_file, tumor_file, output_label, verbose=not args.quiet)
        
        if result is not None:
            # Copiar imagen CT
            import shutil
            shutil.copy2(image_file, output_image)
            success_count += 1
            
            if args.quiet and i % 10 == 0:
                print(f"Procesados {i}/{len(tumor_files)} casos...")
        else:
            error_count += 1
    
    # Resumen
    print("\n" + "="*70)
    print("RESUMEN")
    print("="*70)
    print(f" Casos procesados correctamente: {success_count}/{len(tumor_files)}")
    
    if error_count > 0:
        print(f" Casos con errores: {error_count}")
        
        if missing_kidney:
            print(f"\n  Máscaras de riñón faltantes ({len(missing_kidney)}):")
            for case in missing_kidney[:5]:
                print(f"   - {case}")
            if len(missing_kidney) > 5:
                print(f"   ... y {len(missing_kidney)-5} más")
        
        if missing_image:
            print(f"\n  Imágenes CT faltantes ({len(missing_image)}):")
            for case in missing_image[:5]:
                print(f"   - {case}")
            if len(missing_image) > 5:
                print(f"   ... y {len(missing_image)-5} más")
    
    print(f"\n Dataset combinado guardado en: {args.output_dir}")
    print("="*70 + "\n")
    
    return 0 if error_count == 0 else 1


if __name__ == "__main__":
    exit(main())
