import { getRenderingEngines } from '../RenderingEngine/getRenderingEngine';
export default function getViewportsWithImageURI(imageURI) {
    const renderingEngines = getRenderingEngines();
    const viewports = [];
    renderingEngines.forEach((renderingEngine) => {
        const viewportsForRenderingEngine = renderingEngine.getViewports();
        viewportsForRenderingEngine.forEach((viewport) => {
            if (viewport.hasImageURI(imageURI)) {
                viewports.push(viewport);
            }
        });
    });
    return viewports;
}
