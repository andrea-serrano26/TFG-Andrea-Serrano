import { getToolGroupForViewport } from '../../store/ToolGroupManager';
import { invalidateBrushCursor } from '../../utilities/segmentation/invalidateBrushCursor';
import { getSegmentation } from './getSegmentation';
import { getViewportIdsWithSegmentation } from './getViewportIdsWithSegmentation';
import { triggerSegmentationModified } from './triggerSegmentationEvents';
import { getActiveSegmentIndex } from './getActiveSegmentIndex';
import { getSegmentationRepresentations } from './getSegmentationRepresentation';
function setActiveSegmentIndex(segmentationId, segmentIndex) {
    const segmentation = getSegmentation(segmentationId);
    if (typeof segmentIndex === 'string') {
        console.warn('segmentIndex is a string, converting to number');
        segmentIndex = Number(segmentIndex);
    }
    Object.values(segmentation.segments).forEach((segment) => {
        segment.active = false;
    });
    if (!segmentation.segments[segmentIndex]) {
        segmentation.segments[segmentIndex] = {
            segmentIndex,
            label: '',
            locked: false,
            cachedStats: {},
            active: false,
        };
    }
    if (segmentation.segments[segmentIndex].active !== true) {
        segmentation.segments[segmentIndex].active = true;
        triggerSegmentationModified(segmentationId);
    }
    const viewportIds = getViewportIdsWithSegmentation(segmentationId);
    viewportIds.forEach((viewportId) => {
        const representations = getSegmentationRepresentations(viewportId, {
            segmentationId,
        });
        representations.forEach((representation) => {
            if (!representation.segments[segmentIndex]) {
                representation.segments[segmentIndex] = {
                    visible: true,
                };
            }
        });
    });
    viewportIds.forEach((viewportId) => {
        const toolGroup = getToolGroupForViewport(viewportId);
        if (!toolGroup) {
            return;
        }
        invalidateBrushCursor(toolGroup.id);
    });
}
export { setActiveSegmentIndex, getActiveSegmentIndex };
