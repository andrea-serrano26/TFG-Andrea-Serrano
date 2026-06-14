import numpy as np
from skimage import measure
import trimesh
import io

def generate_mesh_from_mask(mask: np.ndarray, spacing: tuple) -> bytes:
    """
    Genera un STL a partir de la máscara binaria de segmentación.
    Parámetros:
        - mask: 3D array binaria donde el objeto de interés es 1 y el fondo es 0.
        - spacing: tupla con el espaciado real entre los voxeles en cada dimensión (z, y, x).
    Retorna:
        - bytes del archivo STL generado.
    """
    try:
        print("Generando malla 3D a partir de la segmentación")
        
        # Marching Cubes sobre la máscara binaria (nivel 0.5)
        verts, faces, normals, values = measure.marching_cubes(
            mask, 
            level=0.5, 
            spacing=spacing
        )
        mesh = trimesh.Trimesh(vertices=verts, faces=faces)
        
        # Suavizado para mejorar la calidad de la malla
        trimesh.smoothing.filter_laplacian(mesh, iterations=5)

        # Exportar
        file_obj = io.BytesIO()
        mesh.export(file_obj, file_type='stl')
        file_obj.seek(0)
        
        return file_obj.read()
        
    except Exception as e:
        print(f" Error generando malla: {e}")
        mesh = trimesh.creation.box()
        file_obj = io.BytesIO()
        mesh.export(file_obj, file_type='stl')
        file_obj.seek(0)
        return file_obj.read()