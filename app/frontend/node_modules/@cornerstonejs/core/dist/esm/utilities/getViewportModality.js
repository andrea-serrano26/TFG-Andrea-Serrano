function _getViewportModality(viewport, volumeId, getVolume) {
    if (!getVolume) {
        throw new Error('getVolume is required, use the utilities export instead ');
    }
    if (viewport.modality) {
        return viewport.modality;
    }
    if (viewport.setVolumes) {
        volumeId = volumeId ?? viewport.getVolumeId();
        if (!volumeId || !getVolume) {
            return;
        }
        const volume = getVolume(volumeId);
        return volume.metadata.Modality;
    }
    throw new Error('Invalid viewport type');
}
export { _getViewportModality };
