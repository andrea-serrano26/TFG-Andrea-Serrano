import { getRenderingEngines, getRenderingEngine, } from '../RenderingEngine/getRenderingEngine';
function getViewportsWithVolumeURI(volumeURI, renderingEngineId) {
    const renderingEngines = renderingEngineId
        ? [getRenderingEngine(renderingEngineId)]
        : getRenderingEngines();
    const targetViewports = [];
    renderingEngines.forEach((renderingEngine) => {
        const viewports = renderingEngine.getVolumeViewports();
        const filteredViewports = viewports.filter((vp) => vp.hasVolumeURI(volumeURI));
        targetViewports.push(...filteredViewports);
    });
    return targetViewports;
}
export default getViewportsWithVolumeURI;
