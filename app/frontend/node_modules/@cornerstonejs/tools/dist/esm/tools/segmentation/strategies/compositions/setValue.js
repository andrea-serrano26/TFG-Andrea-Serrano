import StrategyCallbacks from '../../../../enums/StrategyCallbacks';
import { handleUseSegmentCenterIndex } from '../utils/handleUseSegmentCenterIndex';
export default {
    [StrategyCallbacks.INTERNAL_setValue]: (operationData, { value, index }) => {
        const { segmentsLocked, previewSegmentIndex, memo, segmentationVoxelManager, centerSegmentIndexInfo, segmentIndex, } = operationData;
        const existingValue = segmentationVoxelManager.getAtIndex(index);
        if (segmentsLocked.includes(value)) {
            return;
        }
        if (!centerSegmentIndexInfo && existingValue === segmentIndex) {
            return;
        }
        if (centerSegmentIndexInfo?.segmentIndex !== 0 &&
            existingValue === segmentIndex) {
            return;
        }
        if (centerSegmentIndexInfo?.segmentIndex === null) {
            memo.voxelManager.setAtIndex(index, previewSegmentIndex ?? segmentIndex);
            return;
        }
        if (!previewSegmentIndex) {
            let useSegmentIndex = segmentIndex;
            if (centerSegmentIndexInfo) {
                useSegmentIndex = centerSegmentIndexInfo.segmentIndex;
            }
            memo.voxelManager.setAtIndex(index, useSegmentIndex);
            return;
        }
        handleUseSegmentCenterIndex({
            operationData,
            existingValue,
            index,
        });
    },
};
