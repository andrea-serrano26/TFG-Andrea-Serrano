export function handleUseSegmentCenterIndex({ operationData, existingValue, index, }) {
    const { previewSegmentIndex, memo, centerSegmentIndexInfo, previewOnHover, segmentIndex, } = operationData;
    const { hasPreviewIndex, hasSegmentIndex, segmentIndex: centerSegmentIndex, } = centerSegmentIndexInfo;
    if (centerSegmentIndex === 0 && hasSegmentIndex && hasPreviewIndex) {
        if (existingValue === segmentIndex) {
            return;
        }
        if (previewOnHover) {
            return;
        }
        if (existingValue === previewSegmentIndex) {
            memo.voxelManager.setAtIndex(index, 0);
            return;
        }
        return;
    }
    if (centerSegmentIndex === 0 && hasSegmentIndex && !hasPreviewIndex) {
        if (existingValue === 0 || existingValue !== segmentIndex) {
            return;
        }
        memo.voxelManager.setAtIndex(index, previewSegmentIndex);
        centerSegmentIndexInfo.changedIndices.push(index);
        return;
    }
    if (centerSegmentIndex === 0 && !hasSegmentIndex && hasPreviewIndex) {
        if (existingValue === segmentIndex) {
            return;
        }
        if (previewOnHover) {
            return;
        }
        if (existingValue === previewSegmentIndex) {
            memo.voxelManager.setAtIndex(index, 0);
            return;
        }
        return;
    }
    if (centerSegmentIndex === 0 && !hasSegmentIndex && !hasPreviewIndex) {
        if (existingValue === segmentIndex) {
            return;
        }
        if (existingValue === previewSegmentIndex) {
            memo.voxelManager.setAtIndex(index, previewSegmentIndex);
            return;
        }
        return;
    }
    if (centerSegmentIndex === previewSegmentIndex &&
        hasSegmentIndex &&
        hasPreviewIndex) {
        if (existingValue === segmentIndex) {
            return;
        }
        memo.voxelManager.setAtIndex(index, previewSegmentIndex);
        return;
    }
    if (centerSegmentIndex === previewSegmentIndex &&
        !hasSegmentIndex &&
        hasPreviewIndex) {
        if (existingValue === segmentIndex) {
            return;
        }
        memo.voxelManager.setAtIndex(index, previewSegmentIndex);
        return;
    }
    if (centerSegmentIndex === segmentIndex &&
        hasSegmentIndex &&
        hasPreviewIndex) {
        if (existingValue === segmentIndex) {
            return;
        }
        memo.voxelManager.setAtIndex(index, previewSegmentIndex);
        return;
    }
    if (centerSegmentIndex === segmentIndex &&
        hasSegmentIndex &&
        !hasPreviewIndex) {
        if (existingValue === segmentIndex) {
            return;
        }
        memo.voxelManager.setAtIndex(index, previewSegmentIndex);
        return;
    }
}
