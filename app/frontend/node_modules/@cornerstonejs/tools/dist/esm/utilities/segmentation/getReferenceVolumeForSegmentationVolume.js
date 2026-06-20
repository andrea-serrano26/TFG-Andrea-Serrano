import { cache } from '@cornerstonejs/core';
export function getReferenceVolumeForSegmentationVolume(segmentationVolumeId) {
    const segmentationVolume = cache.getVolume(segmentationVolumeId);
    if (!segmentationVolume) {
        return null;
    }
    const referencedVolumeId = segmentationVolume.referencedVolumeId;
    let imageVolume;
    if (referencedVolumeId) {
        imageVolume = cache.getVolume(referencedVolumeId);
    }
    else {
        const imageIds = segmentationVolume.imageIds;
        const image = cache.getImage(imageIds[0]);
        const referencedImageId = image.referencedImageId;
        let volumeInfo = cache.getVolumeContainingImageId(referencedImageId);
        if (!volumeInfo?.volume) {
            volumeInfo = cache.getVolumeContainingImageId(image.imageId);
        }
        imageVolume = volumeInfo?.volume;
    }
    return imageVolume;
}
