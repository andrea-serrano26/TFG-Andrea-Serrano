import { getEnabledElement } from '@cornerstonejs/core';
import { getLabelmapActorUID } from '../../../stateManagement/segmentation/helpers/getSegmentationActor';
function removeLabelmapFromElement(element, segmentationId) {
    const enabledElement = getEnabledElement(element);
    const { viewport } = enabledElement;
    viewport.removeActors([getLabelmapActorUID(viewport.id, segmentationId)]);
}
export default removeLabelmapFromElement;
