import { getRenderingEngines } from '../RenderingEngine/getRenderingEngine';
function getViewportsWithVolumeId(volumeId) {
    const renderingEngines = getRenderingEngines();
    const targetViewports = [];
    renderingEngines.forEach((renderingEngine) => {
        const viewports = renderingEngine.getVolumeViewports();
        const filteredViewports = viewports.filter((vp) => vp.hasVolumeId(volumeId));
        targetViewports.push(...filteredViewports);
    });
    return targetViewports;
}
export default getViewportsWithVolumeId;
