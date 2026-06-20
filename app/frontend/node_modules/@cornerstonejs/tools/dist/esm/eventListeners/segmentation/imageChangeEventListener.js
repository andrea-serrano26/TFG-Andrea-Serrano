import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import { BaseVolumeViewport, getEnabledElement, Enums, getEnabledElementByIds, cache, utilities, } from '@cornerstonejs/core';
import { triggerSegmentationRender } from '../../stateManagement/segmentation/SegmentationRenderingEngine';
import { updateLabelmapSegmentationImageReferences } from '../../stateManagement/segmentation/updateLabelmapSegmentationImageReferences';
import { getCurrentLabelmapImageIdsForViewport } from '../../stateManagement/segmentation/getCurrentLabelmapImageIdForViewport';
import { SegmentationRepresentations } from '../../enums';
import { getLabelmapActorEntries } from '../../stateManagement/segmentation/helpers/getSegmentationActor';
import { getSegmentationRepresentations } from '../../stateManagement/segmentation/getSegmentationRepresentation';
const enable = function (element) {
    if (!element) {
        return;
    }
    const enabledElement = getEnabledElement(element);
    if (!enabledElement) {
        return;
    }
    const { viewport } = enabledElement;
    if (viewport instanceof BaseVolumeViewport) {
        return;
    }
    element.addEventListener(Enums.Events.PRE_STACK_NEW_IMAGE, _imageChangeEventListener);
    element.addEventListener(Enums.Events.IMAGE_RENDERED, _imageChangeEventListener);
};
const disable = function (element) {
    element.removeEventListener(Enums.Events.PRE_STACK_NEW_IMAGE, _imageChangeEventListener);
    element.removeEventListener(Enums.Events.IMAGE_RENDERED, _imageChangeEventListener);
};
const perViewportManualTriggers = new Map();
function _imageChangeEventListener(evt) {
    const eventData = evt.detail;
    const { viewportId, renderingEngineId } = eventData;
    const { viewport } = getEnabledElementByIds(viewportId, renderingEngineId);
    const representations = getSegmentationRepresentations(viewportId);
    if (!representations?.length) {
        return;
    }
    const labelmapRepresentations = representations.filter((representation) => representation.type === SegmentationRepresentations.Labelmap);
    const actors = viewport.getActors();
    labelmapRepresentations.forEach((representation) => {
        const { segmentationId } = representation;
        updateLabelmapSegmentationImageReferences(viewportId, segmentationId);
    });
    const labelmapActors = labelmapRepresentations
        .flatMap((representation) => {
        return getLabelmapActorEntries(viewportId, representation.segmentationId);
    })
        .filter((actor) => actor !== undefined);
    if (!labelmapActors.length) {
        return;
    }
    labelmapActors.forEach((actor) => {
        const validActor = labelmapRepresentations.find((representation) => {
            const derivedImageIds = getCurrentLabelmapImageIdsForViewport(viewportId, representation.segmentationId);
            return derivedImageIds?.includes(actor.referencedId);
        });
        if (!validActor) {
            viewport.removeActors([actor.uid]);
        }
    });
    labelmapRepresentations.forEach((representation) => {
        const { segmentationId } = representation;
        const currentImageId = viewport.getCurrentImageId();
        const derivedImageIds = getCurrentLabelmapImageIdsForViewport(viewportId, segmentationId);
        if (!derivedImageIds) {
            return;
        }
        let shouldTriggerSegmentationRender = false;
        const updateSegmentationActor = (derivedImageId) => {
            const derivedImage = cache.getImage(derivedImageId);
            if (!derivedImage) {
                console.warn('No derived image found in the cache for segmentation representation', representation);
                return;
            }
            const segmentationActorInput = actors.find((actor) => actor.referencedId === derivedImageId);
            if (!segmentationActorInput) {
                const { dimensions, spacing, direction } = viewport.getImageDataMetadata(derivedImage);
                const currentImage = cache.getImage(currentImageId) ||
                    {
                        imageId: currentImageId,
                    };
                const { origin: currentOrigin } = viewport.getImageDataMetadata(currentImage);
                const originToUse = currentOrigin;
                const constructor = derivedImage.voxelManager.getConstructor();
                const newPixelData = derivedImage.voxelManager.getScalarData();
                const scalarArray = vtkDataArray.newInstance({
                    name: 'Pixels',
                    numberOfComponents: 1,
                    values: new constructor(newPixelData),
                });
                const imageData = vtkImageData.newInstance();
                imageData.setDimensions(dimensions[0], dimensions[1], 1);
                imageData.setSpacing(spacing);
                imageData.setDirection(direction);
                imageData.setOrigin(originToUse);
                imageData.getPointData().setScalars(scalarArray);
                imageData.modified();
                viewport.addImages([
                    {
                        imageId: derivedImageId,
                        representationUID: `${segmentationId}-${SegmentationRepresentations.Labelmap}-${derivedImage.imageId}`,
                        callback: ({ imageActor }) => {
                            imageActor.getMapper().setInputData(imageData);
                        },
                    },
                ]);
                shouldTriggerSegmentationRender = true;
                return;
            }
            else {
                const segmentationImageData = segmentationActorInput.actor
                    .getMapper()
                    .getInputData();
                if (segmentationImageData.setDerivedImage) {
                    segmentationImageData.setDerivedImage(derivedImage);
                }
                else {
                    utilities.updateVTKImageDataWithCornerstoneImage(segmentationImageData, derivedImage);
                }
            }
        };
        derivedImageIds.forEach(updateSegmentationActor);
        if (shouldTriggerSegmentationRender) {
            triggerSegmentationRender(viewportId);
        }
        viewport.render();
        if (evt.type === Enums.Events.IMAGE_RENDERED) {
            viewport.element.removeEventListener(Enums.Events.IMAGE_RENDERED, _imageChangeEventListener);
        }
    });
}
export default {
    enable,
    disable,
};
