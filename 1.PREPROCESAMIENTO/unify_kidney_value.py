#!/usr/bin/env python3
"""
unify_kidney_values.py

Script para convertir máscaras de riñón donde left=1 y right=2 a una máscara unificada donde ambos riñones = 1

"""

import nibabel as nib
import numpy as np
import glob
import os
import argparse


def unify_kidney_values(input_path, output_path, verbose=True):
    """
    Convierte máscara de riñón con valores 1 y 2 a solo valor 1
    
    Args:
        input_path: Ruta a la máscara original (valores: 0, 1, 2)
        output_path: Ruta de salida (valores: 0, 1)
        verbose: Mostrar información
    
    Returns:
        True si éxito, False si error
    """
    try:
        # Cargar máscara
        img = nib.load(input_path)
        data = img.get_fdata()
        
        # Verificar valores únicos
        unique_values = np.unique(data)
        
        if verbose:
            case_name = os.path.basename(input_path)
            print(f"\n {case_name}")
            print(f"Valores originales: {unique_values}")
        
        # Crear nueva máscara
        # Cualquier valor > 0 se convierte en 1
        unified = np.zeros_like(data, dtype=np.uint8)
        unified[data > 0] = 1
        
        # Estadísticas
        n_kidney = np.sum(unified == 1)
        n_background = np.sum(unified == 0)
        total = unified.size
        
        if verbose:
            print(f"Valores finales: {np.unique(unified)}")
            print(f"Background: {n_background:,} ({n_background/total*100:.1f}%)")
            print(f"Kidney (unified): {n_kidney:,} ({n_kidney/total*100:.1f}%)")
        
        # Guardar
        output_img = nib.Nifti1Image(unified, img.affine, img.header)
        nib.save(output_img, output_path)
        
        if verbose:
            print(f" Guardado en: {output_path}")
        
        return True
        
    except Exception as e:
        print(f"\n Error procesando {os.path.basename(input_path)}: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(
        description='Unifica valores de riñones izquierdo y derecho a un solo valor (1)',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    
    parser.add_argument('--input_dir', type=str, required=True,
                        help='Directorio con máscaras originales de TotalSegmentator')
    parser.add_argument('--output_dir', type=str, required=True,
                        help='Directorio de salida con máscaras unificadas')
    parser.add_argument('--pattern', type=str, default='*.nii.gz',
                        help='Patrón de archivos a procesar (default: *.nii.gz)')
    parser.add_argument('--suffix', type=str, default='_kidney.nii.gz',
                        help='Sufijo para archivos de salida (default: _kidney.nii.gz)')
    parser.add_argument('--quiet', action='store_true',
                        help='Modo silencioso')
    
    args = parser.parse_args()
    
    # Crear directorio de salida
    os.makedirs(args.output_dir, exist_ok=True)
    
    if not args.quiet:
        print("\n" + "="*70)
        print("UNIFICANDO VALORES DE RIÑONES")
        print("="*70)
        print(f"\n Directorios:")
        print(f"   Entrada: {args.input_dir}")
        print(f"   Salida:  {args.output_dir}")
    
    # Buscar archivos
    search_pattern = os.path.join(args.input_dir, args.pattern)
    input_files = sorted(glob.glob(search_pattern))
    
    if len(input_files) == 0:
        print(f"\n No se encontraron archivos en: {search_pattern}")
        return 1
    
    if not args.quiet:
        print(f"\n Encontrados {len(input_files)} archivos")
    
    success_count = 0
    error_count = 0
    
    for i, input_file in enumerate(input_files, 1):
        # Determinar nombre de salida
        base_name = os.path.basename(input_file)
        
        # Si el archivo ya tiene un sufijo específico, mantenerlo
        # Si no, añadir el sufijo especificado
        if not base_name.endswith(args.suffix):
            # Quitar .nii.gz y añadir sufijo
            output_name = base_name.replace('.nii.gz', args.suffix)
        else:
            output_name = base_name
        
        output_path = os.path.join(args.output_dir, output_name)
        
        if not args.quiet:
            print(f"\n[{i}/{len(input_files)}] Procesando...")
        
        success = unify_kidney_values(input_file, output_path, verbose=not args.quiet)
        
        if success:
            success_count += 1
        else:
            error_count += 1
        
        if args.quiet and i % 10 == 0:
            print(f"Procesados {i}/{len(input_files)} archivos...")
    
    # Resumen
    print("\n" + "="*70)
    print("RESUMEN")
    print("="*70)
    print(f" Archivos procesados correctamente: {success_count}/{len(input_files)}")
    
    if error_count > 0:
        print(f" Archivos con errores: {error_count}")
    
    print(f"\n Máscaras unificadas guardadas en: {args.output_dir}")
    print("="*70 + "\n")
    
    return 0 if error_count == 0 else 1


if __name__ == "__main__":
    exit(main())