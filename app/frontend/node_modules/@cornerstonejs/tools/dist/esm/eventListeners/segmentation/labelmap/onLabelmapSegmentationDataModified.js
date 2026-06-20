import { VolumeViewport, getEnabledElementByViewportId, StackViewport, } from '@cornerstonejs/core';
import { SegmentationRepresentations } from '../../../enums';
import { performVolumeLabelmapUpdate } from './performVolumeLabelmapUpdate';
import { performStackLabelmapUpdate } from './performStackLabelmapUpdate';
import { getSegmentation } from '../../../stateManagement/segmentation/getSegmentation';
import { getViewportIdsWithSegmentation } from '../../../stateManagement/segmentation/getViewportIdsWithSegmentation';
const getViewportByViewportId = (viewportId) => {
    const enabledElement = getEnabledElementByViewportId(viewportId);
    return enabledElement?.viewport ?? undefined;
};
const onLabelmapSegmentationDataModified = function (evt) {
    const { segmentationId, modifiedSlicesToUse } = evt.detail;
    const { representationData } = getSegmentation(segmentationId);
    const viewportIds = getViewportIdsWithSegmentation(segmentationId);
    const hasVolumeViewport = viewportIds.some((viewportId) => {
        const viewport = getViewportByViewportId(viewportId);
        return viewport instanceof VolumeViewport;
    });
    const hasStackViewport = viewportIds.some((viewportId) => {
        const viewport = getViewportByViewportId(viewportId);
        return viewport instanceof StackViewport;
    });
    const hasBothStackAndVolume = hasVolumeViewport && hasStackViewport;
    viewportIds.forEach((viewportId) => {
        const viewport = getViewportByViewportId(viewportId);
        if (viewport instanceof VolumeViewport) {
            performVolumeLabelmapUpdate({
                modifiedSlicesToUse: hasBothStackAndVolume ? [] : modifiedSlicesToUse,
                representationData,
                type: SegmentationRepresentations.Labelmap,
            });
        }
        if (viewport instanceof StackViewport) {
            performStackLabelmapUpdate({
                viewportIds,
                segmentationId,
            });
        }
    });
};
export default onLabelmapSegmentationDataModified;
