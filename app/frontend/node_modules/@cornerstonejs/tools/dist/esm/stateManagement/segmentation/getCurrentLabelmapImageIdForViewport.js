import { defaultSegmentationStateManager } from './SegmentationStateManager';
export function getCurrentLabelmapImageIdForViewport(viewportId, segmentationId) {
    const imageIds = getCurrentLabelmapImageIdsForViewport(viewportId, segmentationId);
    if (!imageIds?.length) {
        return;
    }
    return imageIds[0];
}
export function getCurrentLabelmapImageIdsForViewport(viewportId, segmentationId) {
    const segmentationStateManager = defaultSegmentationStateManager;
    return segmentationStateManager.getCurrentLabelmapImageIdsForViewport(viewportId, segmentationId);
}
export function getLabelmapImageIdsForImageId(imageId, segmentationId) {
    const segmentationStateManager = defaultSegmentationStateManager;
    return segmentationStateManager.getLabelmapImageIdsForImageId(imageId, segmentationId);
}
