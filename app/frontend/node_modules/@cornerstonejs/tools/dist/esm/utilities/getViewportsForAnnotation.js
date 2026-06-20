import { getEnabledElements, utilities as csUtils } from '@cornerstonejs/core';
const { isEqual } = csUtils;
export default function getViewportsForAnnotation(annotation) {
    const { metadata } = annotation;
    return getEnabledElements()
        .filter((enabledElement) => {
        if (enabledElement.FrameOfReferenceUID === metadata.FrameOfReferenceUID) {
            const viewport = enabledElement.viewport;
            const { viewPlaneNormal, viewUp } = viewport.getCamera();
            return (isEqual(viewPlaneNormal, metadata.viewPlaneNormal) &&
                (!metadata.viewUp || isEqual(viewUp, metadata.viewUp)));
        }
        return;
    })
        .map((enabledElement) => enabledElement.viewport);
}
