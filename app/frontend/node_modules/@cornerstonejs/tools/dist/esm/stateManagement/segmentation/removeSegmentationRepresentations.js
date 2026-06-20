import SegmentationRepresentations from '../../enums/SegmentationRepresentations';
import labelmapDisplay from '../../tools/displayTools/Labelmap/labelmapDisplay';
import contourDisplay from '../../tools/displayTools/Contour/contourDisplay';
import { getSegmentationRepresentations } from './getSegmentationRepresentation';
import { getEnabledElementByViewportId } from '@cornerstonejs/core';
import { defaultSegmentationStateManager } from './SegmentationStateManager';
import { surfaceDisplay } from '../../tools/displayTools/Surface';
import { removeSegmentationListener } from './segmentationEventManager';
function removeSegmentationRepresentation(viewportId, specifier, immediate) {
    return _removeSegmentationRepresentations(viewportId, specifier, immediate);
}
function removeSegmentationRepresentations(viewportId, specifier, immediate) {
    return _removeSegmentationRepresentations(viewportId, specifier, immediate);
}
function _removeSegmentationRepresentations(viewportId, specifier, immediate) {
    const { segmentationId, type } = specifier;
    _removeRepresentationObject(viewportId, segmentationId, type, immediate);
    return defaultSegmentationStateManager.removeSegmentationRepresentations(viewportId, {
        segmentationId,
        type,
    });
}
function removeAllSegmentationRepresentations() {
    const state = defaultSegmentationStateManager.getAllViewportSegmentationRepresentations();
    state.forEach(({ viewportId, representations }) => {
        representations.forEach(({ segmentationId, type }) => {
            removeSegmentationRepresentation(viewportId, {
                segmentationId,
                type,
            });
        });
    });
    defaultSegmentationStateManager.resetState();
}
function removeLabelmapRepresentation(viewportId, segmentationId, immediate) {
    removeSegmentationRepresentation(viewportId, {
        segmentationId,
        type: SegmentationRepresentations.Labelmap,
    }, immediate);
}
function removeContourRepresentation(viewportId, segmentationId, immediate) {
    removeSegmentationRepresentation(viewportId, {
        segmentationId,
        type: SegmentationRepresentations.Contour,
    }, immediate);
}
function removeSurfaceRepresentation(viewportId, segmentationId, immediate) {
    removeSegmentationRepresentation(viewportId, {
        segmentationId,
        type: SegmentationRepresentations.Surface,
    }, immediate);
}
function _removeRepresentationObject(viewportId, segmentationId, type, immediate) {
    const representations = getSegmentationRepresentations(viewportId, {
        segmentationId,
        type,
    });
    representations.forEach((representation) => {
        if (representation.type === SegmentationRepresentations.Labelmap) {
            labelmapDisplay.removeRepresentation(viewportId, representation.segmentationId, immediate);
        }
        else if (representation.type === SegmentationRepresentations.Contour) {
            contourDisplay.removeRepresentation(viewportId, representation.segmentationId, immediate);
        }
        else if (representation.type === SegmentationRepresentations.Surface) {
            surfaceDisplay.removeRepresentation(viewportId, representation.segmentationId, immediate);
        }
        removeSegmentationListener(representation.segmentationId, representation.type);
    });
    const { viewport } = getEnabledElementByViewportId(viewportId) || {};
    if (viewport) {
        viewport.render();
    }
}
export { removeSegmentationRepresentation, removeSegmentationRepresentations, removeAllSegmentationRepresentations, removeLabelmapRepresentation, removeContourRepresentation, removeSurfaceRepresentation, };
