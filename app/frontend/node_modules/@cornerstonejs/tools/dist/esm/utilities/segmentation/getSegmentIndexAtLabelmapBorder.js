import { BaseVolumeViewport, cache, utilities } from '@cornerstonejs/core';
import { getSegmentation, getCurrentLabelmapImageIdForViewport, } from '../../stateManagement/segmentation/segmentationState';
import { getLabelmapActorEntry } from '../../stateManagement/segmentation/helpers';
export function getSegmentIndexAtLabelmapBorder(segmentationId, worldPoint, { viewport, searchRadius }) {
    const segmentation = getSegmentation(segmentationId);
    const labelmapData = segmentation.representationData.Labelmap;
    if (viewport instanceof BaseVolumeViewport) {
        const { volumeId } = labelmapData;
        const segmentationVolume = cache.getVolume(volumeId);
        if (!segmentationVolume) {
            return;
        }
        const voxelManager = segmentationVolume.voxelManager;
        const imageData = segmentationVolume.imageData;
        const indexIJK = utilities.transformWorldToIndex(imageData, worldPoint);
        const segmentIndex = voxelManager.getAtIJK(indexIJK[0], indexIJK[1], indexIJK[2]);
        const canvasPoint = viewport.worldToCanvas(worldPoint);
        const onEdge = isSegmentOnEdgeCanvas(canvasPoint, segmentIndex, viewport, imageData, searchRadius);
        return onEdge ? segmentIndex : undefined;
    }
    const segmentationImageId = getCurrentLabelmapImageIdForViewport(viewport.id, segmentationId);
    const image = cache.getImage(segmentationImageId);
    if (!image) {
        return;
    }
    const segmentationActorEntry = getLabelmapActorEntry(viewport.id, segmentationId);
    const imageData = segmentationActorEntry?.actor.getMapper().getInputData();
    const indexIJK = utilities.transformWorldToIndex(imageData, worldPoint);
    const dimensions = imageData.getDimensions();
    const voxelManager = (imageData.voxelManager ||
        utilities.VoxelManager.createScalarVolumeVoxelManager({
            dimensions,
            scalarData: imageData.getPointData().getScalars().getData(),
        }));
    const segmentIndex = voxelManager.getAtIJKPoint(indexIJK);
    const onEdge = isSegmentOnEdgeIJK(indexIJK, dimensions, voxelManager, segmentIndex);
    return onEdge ? segmentIndex : undefined;
}
function isSegmentOnEdge(getNeighborIndex, segmentIndex, searchRadius = 1) {
    const neighborRange = Array.from({ length: 2 * searchRadius + 1 }, (_, i) => i - searchRadius);
    for (const deltaI of neighborRange) {
        for (const deltaJ of neighborRange) {
            for (const deltaK of neighborRange) {
                if (deltaI === 0 && deltaJ === 0 && deltaK === 0) {
                    continue;
                }
                const neighborIndex = getNeighborIndex(deltaI, deltaJ, deltaK);
                if (neighborIndex !== undefined && segmentIndex !== neighborIndex) {
                    return true;
                }
            }
        }
    }
    return false;
}
function isSegmentOnEdgeIJK(indexIJK, dimensions, voxelManager, segmentIndex, searchRadius) {
    const getNeighborIndex = (deltaI, deltaJ, deltaK) => {
        const neighborIJK = [
            indexIJK[0] + deltaI,
            indexIJK[1] + deltaJ,
            indexIJK[2] + deltaK,
        ];
        return voxelManager.getAtIJK(neighborIJK[0], neighborIJK[1], neighborIJK[2]);
    };
    return isSegmentOnEdge(getNeighborIndex, segmentIndex, searchRadius);
}
function isSegmentOnEdgeCanvas(canvasPoint, segmentIndex, viewport, imageData, searchRadius) {
    const getNeighborIndex = (deltaI, deltaJ) => {
        const neighborCanvas = [canvasPoint[0] + deltaI, canvasPoint[1] + deltaJ];
        const worldPoint = viewport.canvasToWorld(neighborCanvas);
        const voxelManager = imageData.get('voxelManager').voxelManager;
        const indexIJK = utilities.transformWorldToIndex(imageData, worldPoint);
        return voxelManager.getAtIJK(indexIJK[0], indexIJK[1], indexIJK[2]);
    };
    return isSegmentOnEdge(getNeighborIndex, segmentIndex, searchRadius);
}
