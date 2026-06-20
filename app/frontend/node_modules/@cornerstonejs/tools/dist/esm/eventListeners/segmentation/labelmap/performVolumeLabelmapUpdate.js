import { cache } from '@cornerstonejs/core';
export function performVolumeLabelmapUpdate({ modifiedSlicesToUse, representationData, type, }) {
    const segmentationVolume = cache.getVolume(representationData[type].volumeId);
    if (!segmentationVolume) {
        console.warn('segmentation not found in cache');
        return;
    }
    const { imageData, vtkOpenGLTexture } = segmentationVolume;
    let slicesToUpdate;
    if (modifiedSlicesToUse?.length > 0) {
        slicesToUpdate = modifiedSlicesToUse;
    }
    else {
        const numSlices = imageData.getDimensions()[2];
        slicesToUpdate = [...Array(numSlices).keys()];
    }
    slicesToUpdate.forEach((i) => {
        vtkOpenGLTexture.setUpdatedFrame(i);
    });
    imageData.modified();
}
