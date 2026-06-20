import { vec3 } from 'gl-matrix';
import * as metaData from '../metaData';
import calculateSpacingBetweenImageIds from './calculateSpacingBetweenImageIds';
export default function sortImageIdsAndGetSpacing(imageIds, scanAxisNormal) {
    const { imagePositionPatient: referenceImagePositionPatient, imageOrientationPatient, } = metaData.get('imagePlaneModule', imageIds[0]);
    if (!scanAxisNormal) {
        const rowCosineVec = vec3.fromValues(imageOrientationPatient[0], imageOrientationPatient[1], imageOrientationPatient[2]);
        const colCosineVec = vec3.fromValues(imageOrientationPatient[3], imageOrientationPatient[4], imageOrientationPatient[5]);
        scanAxisNormal = vec3.create();
        vec3.cross(scanAxisNormal, rowCosineVec, colCosineVec);
    }
    const usingWadoUri = imageIds[0].split(':')[0] === 'wadouri';
    const zSpacing = calculateSpacingBetweenImageIds(imageIds);
    let sortedImageIds;
    function getDistance(imageId) {
        const { imagePositionPatient } = metaData.get('imagePlaneModule', imageId);
        const positionVector = vec3.create();
        vec3.sub(positionVector, referenceImagePositionPatient, imagePositionPatient);
        return vec3.dot(positionVector, scanAxisNormal);
    }
    if (!usingWadoUri) {
        const distanceImagePairs = imageIds.map((imageId) => {
            const distance = getDistance(imageId);
            return {
                distance,
                imageId,
            };
        });
        distanceImagePairs.sort((a, b) => b.distance - a.distance);
        sortedImageIds = distanceImagePairs.map((a) => a.imageId);
    }
    else {
        const prefetchedImageIds = [
            imageIds[0],
            imageIds[Math.floor(imageIds.length / 2)],
        ];
        sortedImageIds = imageIds;
        const firstImageDistance = getDistance(prefetchedImageIds[0]);
        const middleImageDistance = getDistance(prefetchedImageIds[1]);
        if (firstImageDistance - middleImageDistance < 0) {
            sortedImageIds.reverse();
        }
    }
    const { imagePositionPatient: origin } = metaData.get('imagePlaneModule', sortedImageIds[0]);
    const result = {
        zSpacing,
        origin,
        sortedImageIds,
    };
    return result;
}
