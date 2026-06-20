import { cache, utilities } from '@cornerstonejs/core';
import { getSegmentation } from '../getSegmentation';
import { triggerSegmentationDataModified } from '../triggerSegmentationEvents';
import { createLabelmapMemo } from '../../../utilities/segmentation/createLabelmapMemo';
const { DefaultHistoryMemo } = utilities.HistoryMemo;
export function clearSegmentValue(segmentationId, segmentIndex, options) {
    const segmentation = getSegmentation(segmentationId);
    if (segmentation.representationData.Labelmap) {
        const { representationData } = segmentation;
        const labelmapData = representationData.Labelmap;
        if ('imageIds' in labelmapData || 'volumeId' in labelmapData) {
            const items = 'imageIds' in labelmapData
                ? labelmapData.imageIds.map((imageId) => cache.getImage(imageId))
                : [cache.getVolume(labelmapData.volumeId)];
            items.forEach((item) => {
                if (!item) {
                    return;
                }
                const { voxelManager } = item;
                const memo = options?.recordHistory
                    ? createLabelmapMemo(segmentationId, voxelManager)
                    : null;
                const useVoxelManager = memo?.voxelManager ?? voxelManager;
                voxelManager.forEach(({ value, index }) => {
                    if (value === segmentIndex) {
                        useVoxelManager.setAtIndex(index, 0);
                    }
                });
                if (memo?.commitMemo()) {
                    DefaultHistoryMemo.push(memo);
                }
            });
        }
        triggerSegmentationDataModified(segmentationId);
    }
    else {
        throw new Error('Invalid segmentation type, only labelmap is supported right now');
    }
}
