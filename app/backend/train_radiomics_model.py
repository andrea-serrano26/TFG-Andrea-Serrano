"""
train_radiomics_model.py
========================
Replica  el pipeline del notebook codigo.ipynb para obtener las mismas métricas que en el TFG de Vera.

USO:
  python3 train_radiomics_model.py --input /ruta/Imagenes_segmentaciones --output app/backend/app/services
"""

#--------------------------------------------------------------------------------------------------------
# Imports iguales a los del notebook (más extras para procesamiento de imágenes y manejo de archivos)
#--------------------------------------------------------------------------------------------------------

# Imports estándar
import os
import sys
import json
import argparse
import nrrd

# Imports de procesamiento de datos
import numpy as np
import pandas as pd
import joblib

# Imports de procesamiento de imágenes y extracción de features
import SimpleITK as sitk
from radiomics import featureextractor
from scipy.ndimage import binary_dilation, binary_erosion

# Imports de análisis estadístico y modelado (ML)
import pingouin as pg
from sklearn.preprocessing import StandardScaler
from sklearn.feature_selection import VarianceThreshold
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.model_selection import (train_test_split, cross_val_score, StratifiedKFold)
from sklearn.metrics import (accuracy_score, precision_score, recall_score, f1_score,classification_report, roc_auc_score)

#--------------------------------------------------------------------------------------------------------
# Parámetros del pipeline 
#--------------------------------------------------------------------------------------------------------

ICC_THRESHOLD  = 0.75
DILATION_ITERS = 1
EROSION_ITERS  = 1
THRESH_VAR     = 0.01
THRESH_CORR    = 0.95


#--------------------------------------------------------------------------------------------------------
# FUNCIONES IGUALES QUE EL NOTEBOOK 
#--------------------------------------------------------------------------------------------------------

def load_nrrd_as_sitk(path: str) -> sitk.Image:
    """
    Carga un archivo NRRD y lo convierte a SimpleITK Image.
    """
    arr, _ = nrrd.read(path)
    return sitk.GetImageFromArray(arr.astype(np.float32))


def load_mask_as_sitk(path: str) -> sitk.Image:
    """
    Carga un archivo NRRD de máscara y lo convierte a SimpleITK Image (uint8).
    """
    arr, _ = nrrd.read(path)
    return sitk.GetImageFromArray(arr.astype(np.uint8))


def extract_features_from_sitk(sitk_img: sitk.Image, sitk_mask: sitk.Image) -> dict:
    """
    Extrae features radiómicas usando PyRadiomics a partir de una imagen y su máscara.
    Verifica que las dimensiones de la imagen y la máscara sean compatibles.
    Devuelve un diccionario con las features extraídas.
    """

    if sitk_img.GetSize() != sitk_mask.GetSize():
        raise ValueError(f"Tamaños incompatibles: {sitk_img.GetSize()} vs {sitk_mask.GetSize()}")
    ext = featureextractor.RadiomicsFeatureExtractor()
    raw = ext.execute(sitk_img, sitk_mask)
    return dict(raw)


def simulate_resegmentation(sitk_mask: sitk.Image, method: str, iterations: int) -> sitk.Image:
    """
    Simula una segunda segmentación modificando la máscara original.
    
    Parametros:
    - sitk_mask: máscara original como SimpleITK Image
    - method: 'dilation' o 'erosion'. Se usa para simular una resegmentación
    - iterations: número de iteraciones para dilatación/erosión
    
    Devuelve una nueva máscara modificada como SimpleITK Image.
    """

    mask_arr = sitk.GetArrayFromImage(sitk_mask)
    struct = np.ones((3, 3, 3))
    if method == 'dilation':
        mask_arr_mod = binary_dilation(mask_arr, structure=struct, iterations=iterations)
    elif method == 'erosion':
        mask_arr_mod = binary_erosion(mask_arr, structure=struct, iterations=iterations)
    else:
        raise ValueError("method debe ser 'dilation' o 'erosion'")
    mask_mod = sitk.GetImageFromArray(mask_arr_mod.astype(np.uint8))
    mask_mod.CopyInformation(sitk_mask)
    return mask_mod


def simulate_interpolation(sitk_img: sitk.Image, new_spacing: tuple) -> sitk.Image:
    """
    Remuestrea la imagen a un spacing ligeramente modificado.
    
     Parametros:
     - sitk_img: imagen original como SimpleITK Image
     - new_spacing: tupla con el nuevo spacing (e.g. (sx, sy, sz))
     
    Devuelve una nueva imagen remuestreada como SimpleITK Image.
    """

    original_spacing = sitk_img.GetSpacing()
    original_size    = sitk_img.GetSize()
    new_size = [int(round(osz * ospc / nspc))
                for osz, ospc, nspc in zip(original_size, original_spacing, new_spacing)]
    resample = sitk.ResampleImageFilter()
    resample.SetOutputSpacing(new_spacing)
    resample.SetSize(new_size)
    resample.SetOutputDirection(sitk_img.GetDirection())
    resample.SetOutputOrigin(sitk_img.GetOrigin())
    resample.SetInterpolator(sitk.sitkLinear)
    return resample.Execute(sitk_img)


def simulate_interpolation_mask(sitk_mask: sitk.Image, new_spacing: tuple) -> sitk.Image:
    """
    Remuestrea la máscara a un spacing ligeramente modificado usando interpolación nearest neighbor.
    
     Parametros:
     - sitk_mask: máscara original como SimpleITK Image
     - new_spacing: tupla con el nuevo spacing (e.g. (sx, sy, sz))
     
    Devuelve una nueva máscara remuestreada como SimpleITK Image.
    """

    original_spacing = sitk_mask.GetSpacing()
    original_size    = sitk_mask.GetSize()
    new_size = [int(round(osz * ospc / nspc))
                for osz, ospc, nspc in zip(original_size, original_spacing, new_spacing)]
    resample = sitk.ResampleImageFilter()
    resample.SetOutputSpacing(new_spacing)
    resample.SetSize(new_size)
    resample.SetOutputDirection(sitk_mask.GetDirection())
    resample.SetOutputOrigin(sitk_mask.GetOrigin())
    resample.SetInterpolator(sitk.sitkNearestNeighbor)
    return resample.Execute(sitk_mask)


def convert_columns_to_numeric(df: pd.DataFrame) -> pd.DataFrame:
    """
    Intenta convertir cada columna a numérica. Si una columna no se puede convertir (e.g. contiene texto o arrays), se elimina.
    Devuelve un nuevo DataFrame con solo columnas numéricas.
    """
    df2  = df.copy()
    drop = []
    for col in df2.columns:
        try:
            def extract_scalar(val):
                if hasattr(val, 'ndim') and val.ndim == 0:
                    return val.item()
                if hasattr(val, '__len__') and not isinstance(val, str):
                    try:
                        if len(val) == 1:
                            return float(list(val)[0])
                    except Exception:
                        pass
                return val
            series     = df2[col].apply(extract_scalar)
            series_num = pd.to_numeric(series, errors='coerce')
            if series_num.isna().any():
                drop.append(col)
            else:
                df2[col] = series_num.astype(float)
        except Exception:
            drop.append(col)
    if drop:
        print(f"  Columnas eliminadas ({len(drop)}): {drop[:5]}{'...' if len(drop)>5 else ''}")
    return df2.drop(columns=drop)


def remove_diagnostics_columns(df: pd.DataFrame) -> pd.DataFrame:
    cols = [c for c in df.columns if c.startswith('diagnostics_')]
    return df.drop(columns=cols)


def compute_icc(df_pair: pd.DataFrame, feature_col: str) -> dict:
    icc_df = pg.intraclass_corr(
        data=df_pair, targets='subject', raters='method', ratings=feature_col
    )
    icc2 = icc_df.loc[icc_df['Type'] == 'ICC2', 'ICC'].values[0]
    icc3 = icc_df.loc[icc_df['Type'] == 'ICC3', 'ICC'].values[0]
    return {'ICC2': icc2, 'ICC3': icc3}


def analyze_icc(df_orig, df_dil, df_ero, df_interp) -> pd.DataFrame:
    orig_m   = df_orig.copy();   orig_m['method']   = 'original'
    dil_m    = df_dil.copy();    dil_m['method']    = 'reseg_dil'
    ero_m    = df_ero.copy();    ero_m['method']    = 'reseg_ero'
    interp_m = df_interp.copy(); interp_m['method'] = 'interp'

    features = [c for c in orig_m.columns if c not in ('subject', 'method', 'cancer')]
    results  = {}
    for feat in features:
        try:
            pair_dil = pd.concat([orig_m[['subject','method',feat]],
                                  dil_m[['subject','method',feat]]], ignore_index=True)
            icc_dil  = compute_icc(pair_dil, feat)

            pair_ero = pd.concat([orig_m[['subject','method',feat]],
                                  ero_m[['subject','method',feat]]], ignore_index=True)
            icc_ero  = compute_icc(pair_ero, feat)

            pair_int = pd.concat([orig_m[['subject','method',feat]],
                                  interp_m[['subject','method',feat]]], ignore_index=True)
            icc_int  = compute_icc(pair_int, feat)

            results[feat] = {
                'ICC2_resegmentation_dil': icc_dil['ICC2'],
                'ICC3_resegmentation_dil': icc_dil['ICC3'],
                'ICC2_resegmentation_ero': icc_ero['ICC2'],
                'ICC3_resegmentation_ero': icc_ero['ICC3'],
                'ICC2_interpolation':      icc_int['ICC2'],
                'ICC3_interpolation':      icc_int['ICC3'],
            }
        except Exception as e:
            print(f"  ⚠  ICC no calculable para '{feat}': {e}")
    return pd.DataFrame.from_dict(results, orient='index')


def filter_features_by_icc(df_icc: pd.DataFrame, thresh: float = 0.75) -> list:
    mask = (
        (df_icc['ICC2_resegmentation_dil'] >= thresh) &
        (df_icc['ICC3_resegmentation_dil'] >= thresh) &
        (df_icc['ICC2_resegmentation_ero'] >= thresh) &
        (df_icc['ICC3_resegmentation_ero'] >= thresh) &
        (df_icc['ICC2_interpolation']      >= thresh) &
        (df_icc['ICC3_interpolation']      >= thresh)
    )
    return df_icc.index[mask].tolist()


#--------------------------------------------------------------------------------------------------------
# preprocess_features 
#--------------------------------------------------------------------------------------------------------

def preprocess_features(df: pd.DataFrame, label_column: str, threshold_corr: float = 0.95, threshold_var:  float = 0.01):
    """
    Idéntica a la función del notebook:
      1. Separa X e y
      2. VarianceThreshold
      3. Elimina alta correlación (Pearson > threshold_corr)
      4. StandardScaler
    Devuelve: X_scaled (DataFrame), y (Series), removed (list)
    """
    n_variables = len(df.columns)

    X = df.drop(columns=[label_column])
    y = df[label_column]

    # Baja varianza
    var_selector   = VarianceThreshold(threshold=threshold_var)
    X_var_filtered = pd.DataFrame(
        var_selector.fit_transform(X),
        columns=X.columns[var_selector.get_support()]
    )
    removed_low_var = list(set(X.columns) - set(X_var_filtered.columns))
    print(f"  Se eliminaron {len(removed_low_var)} variables con baja varianza.")

    # Alta correlación
    corr_matrix = X_var_filtered.corr().abs()
    upper   = corr_matrix.where(np.triu(np.ones(corr_matrix.shape), k=1).astype(bool))
    to_drop = [col for col in upper.columns if any(upper[col] > threshold_corr)]
    X_filtered = X_var_filtered.drop(columns=to_drop)
    print(f"  Se eliminaron {len(to_drop)} variables altamente correlacionadas.")

    # StandardScaler
    scaler   = StandardScaler()
    X_scaled = pd.DataFrame(
        scaler.fit_transform(X_filtered),
        columns=X_filtered.columns,
        index=X.index
    )
    print(f"  Se han eliminado {len(removed_low_var + to_drop)} de {n_variables} variables.")
    print(f"  Features finales: {len(X_scaled.columns)}")

    return X_scaled, y, removed_low_var + to_drop

#--------------------------------------------------------------------------------------------------------
# Construcción del dataset
#--------------------------------------------------------------------------------------------------------

def build_dataset(input_dir: str, max_num: int):
    rows_orig = []; rows_dil = []; rows_ero = []; rows_interp = []

    for num in range(1, max_num + 1):
        for ext in ['oc', 'ccr']:
            if num in (36, 42) and ext == 'oc':
                continue

            img_path  = os.path.join(input_dir, ext, f"Seg{num}{ext}", f"serie{num}{ext}.nrrd")
            mask_path = os.path.join(input_dir, ext, f"Seg{num}{ext}", f"{ext}{num}.nrrd")

            if not os.path.exists(img_path) or not os.path.exists(mask_path):
                continue

            print(f"  Extrayendo {num}{ext}... ", end="", flush=True)
            try:
                cancer  = (ext == 'ccr')
                subject = str(num) + ('1' if cancer else '0')

                sitk_img  = load_nrrd_as_sitk(img_path)
                sitk_mask = load_mask_as_sitk(mask_path)

                if sitk_img.GetSize() != sitk_mask.GetSize():
                    raise ValueError("Tamaños incompatibles")

                # Original
                f = extract_features_from_sitk(sitk_img, sitk_mask)
                f.update({'cancer': cancer, 'subject': subject, 'method': 'original'})
                rows_orig.append(f)

                # Dilatación
                mask_dil = simulate_resegmentation(sitk_mask, 'dilation', DILATION_ITERS)
                f = extract_features_from_sitk(sitk_img, mask_dil)
                f.update({'cancer': cancer, 'subject': subject, 'method': 'reseg_dil'})
                rows_dil.append(f)

                # Erosión
                mask_ero = simulate_resegmentation(sitk_mask, 'erosion', EROSION_ITERS)
                f = extract_features_from_sitk(sitk_img, mask_ero)
                f.update({'cancer': cancer, 'subject': subject, 'method': 'reseg_ero'})
                rows_ero.append(f)

                # Interpolación
                _orig_spacing = sitk_img.GetSpacing()
                _new_spacing  = tuple(s + 0.1 for s in _orig_spacing)
                img_i  = simulate_interpolation(sitk_img, _new_spacing)
                mask_i = simulate_interpolation_mask(sitk_mask, _new_spacing)
                f = extract_features_from_sitk(img_i, mask_i)
                f.update({'cancer': cancer, 'subject': subject, 'method': 'interpolation'})
                rows_interp.append(f)

                print("✓")
            except Exception as e:
                print(f"⚠  {e}")

    if not rows_orig:
        print(" No se encontraron casos.")
        sys.exit(1)

    return (pd.DataFrame(rows_orig), pd.DataFrame(rows_dil),
            pd.DataFrame(rows_ero),  pd.DataFrame(rows_interp))


def clean_df(df: pd.DataFrame, label: str = "") -> pd.DataFrame:
    special = [c for c in ('subject', 'method', 'cancer') if c in df.columns]
    saved   = df[special].copy()
    feat_cols = [c for c in df.columns if c not in special]
    df2 = remove_diagnostics_columns(df[feat_cols])
    df2 = convert_columns_to_numeric(df2)
    lbl = f" [{label}]" if label else ""
    print(f"  clean_df{lbl}: {len(feat_cols)} → {len(df2.columns)} features numéricas")
    return pd.concat([saved, df2], axis=1)


def filter_df1_by_common(df1, df2, df3, df4) -> pd.DataFrame:
    """Idéntica al notebook: conserva en df1 solo columnas comunes a df2, df3, df4."""
    common = set(df2.columns) & set(df3.columns) & set(df4.columns)
    cols   = [c for c in df1.columns if c in common]
    return df1[cols].copy()


#--------------------------------------------------------------------------------------------------------
# Pipeline principal 
#--------------------------------------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Entrena GradientBoosting replicando el TFG de Vera.")
    ap.add_argument("--input",   required=True,  help="Carpeta Segmentaciones")
    ap.add_argument("--output",  default="app/services", help="Carpeta de salida")
    ap.add_argument("--max_num", type=int, default=100,  help="Número máximo de casos")
    args = ap.parse_args()
    os.makedirs(args.output, exist_ok=True)

    # 1. Extracción 
    print("\n[1/6] Extrayendo features radiómicas (4 escenarios)...")
    df_orig, df_dil, df_ero, df_interp = build_dataset(args.input, args.max_num)
    print(f"\n  Casos: {len(df_orig)}  |  CCR: {df_orig['cancer'].sum()}  |  Oncocitoma: {(~df_orig['cancer']).sum()}")

    # 2. Limpieza 
    print("\n[2/6] Limpiando DataFrames...")
    df_orig = clean_df(df_orig, "original")
    df_dil = clean_df(df_dil, "dilatación")
    df_ero = clean_df(df_ero, "erosión")
    df_interp = clean_df(df_interp, "interpolación")

    # 3. ICC 
    print(f"\n[3/6] Calculando ICC (umbral ≥ {ICC_THRESHOLD})... (puede tardar varios minutos)")
    feat_cols = [c for c in df_orig.columns if c not in ('subject', 'method', 'cancer')]

    df_icc = analyze_icc(
        df_orig[feat_cols + ['subject']],
        df_dil[feat_cols  + ['subject']],
        df_ero[feat_cols  + ['subject']],
        df_interp[feat_cols + ['subject']]
    )

    good_features = filter_features_by_icc(df_icc, thresh=ICC_THRESHOLD)
    print(f"  Features que pasan ICC: {len(good_features)} de {len(feat_cols)}")

    if not good_features:
        print("  Ninguna feature pasó el filtro ICC.")
        sys.exit(1)

    # 4. df_machine_learning 
    # Construir df_filt_* con solo las good_features + columnas especiales
    def filt(df):
        cols = [c for c in good_features if c in df.columns]
        special = [c for c in ('subject','method','cancer') if c in df.columns]
        return df[special + cols]

    df_filt_dil = filt(df_dil)
    df_filt_ero = filt(df_ero)
    df_filt_interp = filt(df_interp)

    df_machine_learning = filter_df1_by_common(
        filt(df_orig), df_filt_dil, df_filt_ero, df_filt_interp
    )

    # Añadir columna cancer (notebook: df_machine_learning['cancer'] viene de df_clean)
    df_machine_learning['cancer'] = df_orig['cancer'].values
    print(f"\n  df_machine_learning: {len(df_machine_learning)} filas × {len(df_machine_learning.columns)-1} features")

    # Eliminar columnas no-feature antes de preprocesar
    cols_to_drop = [c for c in ('subject', 'method') if c in df_machine_learning.columns]
    df_machine_learning = df_machine_learning.drop(columns=cols_to_drop)

    # 5. Preprocesado
    print("\n[4/6] Preprocesando (varianza + correlación + StandardScaler)...")
    X_reseg, y_reseg, removed = preprocess_features(df_machine_learning, 'cancer')
    feat_names = list(X_reseg.columns)

    # 6. Split y entrenamiento
    print("\n[5/6] Entrenando GradientBoosting (config exacta del notebook)...")
    print("  random_state=0, max_depth=3 (default sklearn), n_estimators=100, lr=0.1")
    print("  train_test_split: test_size=0.2, random_state=42, stratify=y\n")

    # Split idéntico al notebook
    X_train, X_test, y_train, y_test = train_test_split(
        X_reseg, y_reseg,
        test_size=0.2,
        random_state=42,   
        stratify=y_reseg
    )

    # Configuración idéntica al notebook
    model = GradientBoostingClassifier(
        n_estimators=100,
        learning_rate=0.1,
        max_depth=3,       
        random_state=0     
    )

    # Entrenar SOLO con X_train (igual que el notebook)
    model.fit(X_train.to_numpy(), y_train.to_numpy())

    # Evaluación idéntica al notebook (evaluate_model)
    y_pred = model.predict(X_test.to_numpy())
    y_prob = model.predict_proba(X_test.to_numpy())[:, 1]

    print("=" * 50)
    print("RESULTADOS SOBRE TEST SET:")
    print(f"  Accuracy : {accuracy_score(y_test, y_pred):.4f}")
    print(f"  Precision: {precision_score(y_test, y_pred):.4f}")
    print(f"  Recall   : {recall_score(y_test, y_pred):.4f}")
    print(f"  F1 Score : {f1_score(y_test, y_pred):.4f}")
    print(f"  AUC-ROC  : {roc_auc_score(y_test, y_prob):.4f}")
    print("\nClassification Report:")
    print(classification_report(y_test, y_pred, target_names=['Oncocitoma (0)', 'CCR (1)']))
    print("=" * 50)

    # Validación cruzada adicional (5-fold estratificado)
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    auc_cv = cross_val_score(model, X_reseg, y_reseg, cv=cv, scoring='roc_auc')
    acc_cv = cross_val_score(model, X_reseg, y_reseg, cv=cv, scoring='accuracy')
    print(f"\nValidación cruzada 5-fold (sobre todos los datos):")
    print(f"  AUC-ROC medio: {auc_cv.mean():.4f} ± {auc_cv.std()*2:.4f}")
    print(f"  Accuracy media: {acc_cv.mean():.2%}")

    # 7. Re-fitear scaler solo sobre X_train para guardarlo correctamente 
    scaler_prod = StandardScaler()
    scaler_prod.fit(X_reseg[feat_names])   # fit sobre todos los datos (igual que el notebook)

    # 8. Guardar artefactos 
    print(f"\n[6/6] Guardando artefactos en '{args.output}/'...")

    model_path = os.path.join(args.output, "radiomics_model.pkl")
    scaler_path = os.path.join(args.output, "radiomics_scaler.pkl")
    feats_path = os.path.join(args.output, "radiomics_features.json")

    joblib.dump(model, model_path)
    joblib.dump(scaler_prod, scaler_path)
    with open(feats_path, "w") as f:
        json.dump(feat_names, f, indent=2)

    print(f"  radiomics_model.pkl -> GradientBoosting ({len(feat_names)} features)")
    print(f"  radiomics_scaler.pkl -> StandardScaler")
    print(f"  radiomics_features.json -> lista de {len(feat_names)} features")
    print("\n  Entrenamiento completado.")


if __name__ == "__main__":
    main()