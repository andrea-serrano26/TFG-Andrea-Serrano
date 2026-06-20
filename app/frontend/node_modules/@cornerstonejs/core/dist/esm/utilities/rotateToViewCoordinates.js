import { vec3 } from 'gl-matrix';
export function rotateToViewCoordinates(imageData, viewPlaneNormal, viewUp) {
    const viewRight = vec3.cross(vec3.create(), viewPlaneNormal, viewUp);
    vec3.normalize(viewRight, viewRight);
    const extent = imageData.getExtent();
    const xMin = extent[0];
    const xMax = extent[1] + 1;
    const yMin = extent[2];
    const yMax = extent[3] + 1;
    const zMin = extent[4];
    const zMax = extent[5] + 1;
    const corners = [
        [xMin, yMin, zMin],
        [xMax, yMin, zMin],
        [xMin, yMax, zMin],
        [xMax, yMax, zMin],
        [xMin, yMin, zMax],
        [xMax, yMin, zMax],
        [xMin, yMax, zMax],
        [xMax, yMax, zMax],
    ];
    const viewCorners = corners.map((corner) => {
        const worldPoint = [0, 0, 0];
        imageData.indexToWorld(corner, worldPoint);
        const viewPoint = [
            vec3.dot(worldPoint, viewRight),
            vec3.dot(worldPoint, viewUp),
            vec3.dot(worldPoint, viewPlaneNormal),
        ];
        return viewPoint;
    });
    return viewCorners;
}
