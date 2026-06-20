import { BaseVolumeViewport, cache, utilities } from '@cornerstonejs/core';
import { SegmentationRepresentations } from '../../enums';
import { getSegmentation, getCurrentLabelmapImageIdsForViewport, } from '../../stateManagement/segmentation/segmentationState';
import { getAnnotation } from '../../stateManagement';
import { isPointInsidePolyline3D } from '../math/polyline';
import { getLabelmapActorEntry } from '../../stateManagement/segmentation/helpers/getSegmentationActor';
export function getSegmentIndexAtWorldPoint(segmentationId, worldPoint, options = {}) {
    const segmentation = getSegmentation(segmentationId);
    const representationData = segmentation.representationData;
    const desiredRepresentation = options?.representationType ?? Object.keys(representationData)[0];
    if (!desiredRepresentation) {
        throw new Error(`Segmentation ${segmentationId} does not have any representations`);
    }
    switch (desiredRepresentation) {
        case SegmentationRepresentations.Labelmap:
            return getSegmentIndexAtWorldForLabelmap(segmentation, worldPoint, options);
        case SegmentationRepresentations.Contour:
            return getSegmentIndexAtWorldForContour(segmentation, worldPoint, options);
        default:
            return;
    }
}
export function getSegmentIndexAtWorldForLabelmap(segmentation, worldPoint, { viewport }) {
    const labelmapData = segmentation.representationData.Labelmap;
    if (viewport instanceof BaseVolumeViewport) {
        const { volumeId } = labelmapData;
        const segmentationVolume = cache.getVolume(volumeId);
        if (!segmentationVolume) {
            return;
        }
        const segmentIndex = segmentationVolume.imageData.getScalarValueFromWorld(worldPoint);
        return segmentIndex;
    }
    const segmentationImageIds = getCurrentLabelmapImageIdsForViewport(viewport.id, segmentation.segmentationId);
    if (segmentationImageIds.length > 1) {
        console.warn('Segment selection for labelmaps with multiple imageIds in stack viewports is not supported yet.');
        return;
    }
    const segmentationImageId = segmentationImageIds[0];
    const image = cache.getImage(segmentationImageId);
    if (!image) {
        return;
    }
    const segmentationActorEntry = getLabelmapActorEntry(viewport.id, segmentation.segmentationId);
    const imageData = segmentationActorEntry?.actor.getMapper().getInputData();
    const indexIJK = utilities.transformWorldToIndex(imageData, worldPoint);
    const dimensions = imageData.getDimensions();
    const voxelManager = (imageData.voxelManager ||
        utilities.VoxelManager.createScalarVolumeVoxelManager({
            dimensions,
            scalarData: imageData.getPointData().getScalars().getData(),
        }));
    const segmentIndex = voxelManager.getAtIJKPoint(indexIJK);
    return segmentIndex;
}
export function getSegmentIndexAtWorldForContour(segmentation, worldPoint, { viewport }) {
    const contourData = segmentation.representationData.Contour;
    const segmentIndices = Array.from(contourData.annotationUIDsMap.keys());
    const { viewPlaneNormal } = viewport.getCamera();
    for (const segmentIndex of segmentIndices) {
        const annotationsSet = contourData.annotationUIDsMap.get(segmentIndex);
        if (!annotationsSet) {
            continue;
        }
        for (const annotationUID of annotationsSet) {
            const annotation = getAnnotation(annotationUID);
            if (!annotation) {
                continue;
            }
            const { polyline } = annotation.data.contour;
            if (!utilities.isEqual(viewPlaneNormal, annotation.metadata.viewPlaneNormal)) {
                continue;
            }
            if (isPointInsidePolyline3D(worldPoint, polyline)) {
                return Number(segmentIndex);
            }
        }
    }
}
