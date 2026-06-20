import { BaseVolumeViewport, cache, utilities as csUtils, getEnabledElementByViewportId, volumeLoader, } from '@cornerstonejs/core';
import { SegmentationRepresentations } from '../../enums';
import vtkColorTransferFunction from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction';
import vtkPiecewiseFunction from '@kitware/vtk.js/Common/DataModel/PiecewiseFunction';
import { triggerSegmentationModified, triggerSegmentationRemoved, triggerSegmentationRepresentationModified, triggerSegmentationRepresentationRemoved, } from './triggerSegmentationEvents';
import { segmentationStyle } from './SegmentationStyle';
import { triggerSegmentationAdded } from './events/triggerSegmentationAdded';
const initialDefaultState = {
    colorLUT: [],
    segmentations: [],
    viewportSegRepresentations: {},
};
export default class SegmentationStateManager {
    constructor(uid) {
        this._stackLabelmapImageIdReferenceMap = new Map();
        this._labelmapImageIdReferenceMap = new Map();
        uid ||= csUtils.uuidv4();
        this.state = Object.freeze(csUtils.deepClone(initialDefaultState));
        this.uid = uid;
    }
    getState() {
        return this.state;
    }
    updateState(updater) {
        const newState = csUtils.deepClone(this.state);
        updater(newState);
        this.state = Object.freeze(newState);
    }
    getColorLUT(lutIndex) {
        return this.state.colorLUT[lutIndex];
    }
    getNextColorLUTIndex() {
        return this.state.colorLUT.length;
    }
    resetState() {
        this._stackLabelmapImageIdReferenceMap.clear();
        this._labelmapImageIdReferenceMap.clear();
        this.state = Object.freeze(csUtils.deepClone(initialDefaultState));
    }
    getSegmentation(segmentationId) {
        return this.state.segmentations.find((segmentation) => segmentation.segmentationId === segmentationId);
    }
    updateSegmentation(segmentationId, payload) {
        this.updateState((draftState) => {
            const segmentation = draftState.segmentations.find((segmentation) => segmentation.segmentationId === segmentationId);
            if (!segmentation) {
                console.warn(`Segmentation with id ${segmentationId} not found. Update aborted.`);
                return;
            }
            Object.assign(segmentation, payload);
        });
        triggerSegmentationModified(segmentationId);
    }
    addSegmentation(segmentation) {
        if (this.getSegmentation(segmentation.segmentationId)) {
            throw new Error(`Segmentation with id ${segmentation.segmentationId} already exists`);
        }
        this.updateState((state) => {
            const newSegmentation = csUtils.deepClone(segmentation);
            if (newSegmentation.representationData.Labelmap &&
                'volumeId' in newSegmentation.representationData.Labelmap &&
                !('imageIds' in newSegmentation.representationData.Labelmap)) {
                const imageIds = this.getLabelmapImageIds(newSegmentation.representationData);
                newSegmentation.representationData
                    .Labelmap.imageIds = imageIds;
            }
            state.segmentations.push(newSegmentation);
        });
        triggerSegmentationAdded(segmentation.segmentationId);
    }
    removeSegmentation(segmentationId) {
        this.updateState((state) => {
            const filteredSegmentations = state.segmentations.filter((segmentation) => segmentation.segmentationId !== segmentationId);
            state.segmentations.splice(0, state.segmentations.length, ...filteredSegmentations);
        });
        triggerSegmentationRemoved(segmentationId);
    }
    addSegmentationRepresentation(viewportId, segmentationId, type, renderingConfig) {
        const enabledElement = getEnabledElementByViewportId(viewportId);
        if (!enabledElement) {
            return;
        }
        const existingRepresentations = this.getSegmentationRepresentations(viewportId, {
            type: type,
            segmentationId,
        });
        if (existingRepresentations.length > 0) {
            console.debug('A segmentation representation of type', type, 'already exists in viewport', viewportId, 'for segmentation', segmentationId);
            return;
        }
        this.updateState((state) => {
            if (!state.viewportSegRepresentations[viewportId]) {
                state.viewportSegRepresentations[viewportId] = [];
                segmentationStyle.setRenderInactiveSegmentations(viewportId, true);
            }
            if (type !== SegmentationRepresentations.Labelmap) {
                this.addDefaultSegmentationRepresentation(state, viewportId, segmentationId, type, renderingConfig);
            }
            else {
                this.addLabelmapRepresentation(state, viewportId, segmentationId, renderingConfig);
            }
        });
        triggerSegmentationRepresentationModified(viewportId, segmentationId, type);
    }
    addDefaultSegmentationRepresentation(state, viewportId, segmentationId, type, renderingConfig) {
        const segmentation = state.segmentations.find((segmentation) => segmentation.segmentationId === segmentationId);
        if (!segmentation) {
            return;
        }
        const segmentReps = {};
        Object.keys(segmentation.segments).forEach((segmentIndex) => {
            segmentReps[Number(segmentIndex)] = {
                visible: true,
            };
        });
        state.viewportSegRepresentations[viewportId].push({
            segmentationId,
            type,
            active: true,
            visible: true,
            colorLUTIndex: renderingConfig?.colorLUTIndex || 0,
            segments: segmentReps,
            config: {
                ...getDefaultRenderingConfig(type),
                ...renderingConfig,
            },
        });
        this._setActiveSegmentation(state, viewportId, segmentationId);
    }
    addLabelmapRepresentation(state, viewportId, segmentationId, renderingConfig = getDefaultRenderingConfig(SegmentationRepresentations.Labelmap)) {
        const enabledElement = getEnabledElementByViewportId(viewportId);
        if (!enabledElement) {
            return;
        }
        const segmentation = this.getSegmentation(segmentationId);
        if (!segmentation) {
            return;
        }
        const { representationData } = segmentation;
        if (!representationData.Labelmap) {
            return this.addDefaultSegmentationRepresentation(state, viewportId, segmentationId, SegmentationRepresentations.Labelmap, renderingConfig);
        }
        this.processLabelmapRepresentationAddition(viewportId, segmentationId);
        this.addDefaultSegmentationRepresentation(state, viewportId, segmentationId, SegmentationRepresentations.Labelmap, renderingConfig);
    }
    async processLabelmapRepresentationAddition(viewportId, segmentationId) {
        const enabledElement = getEnabledElementByViewportId(viewportId);
        if (!enabledElement) {
            return;
        }
        const segmentation = this.getSegmentation(segmentationId);
        if (!segmentation) {
            return;
        }
        const volumeViewport = enabledElement.viewport instanceof BaseVolumeViewport;
        const { representationData } = segmentation;
        const isBaseVolumeSegmentation = 'volumeId' in representationData.Labelmap;
        const viewport = enabledElement.viewport;
        if (!volumeViewport && !isBaseVolumeSegmentation) {
            !this.updateLabelmapSegmentationImageReferences(viewportId, segmentation.segmentationId);
        }
    }
    _updateLabelmapSegmentationReferences(segmentationId, viewport, labelmapImageIds, updateCallback) {
        const referenceImageId = viewport.getCurrentImageId();
        let viewableLabelmapImageIdFound = false;
        for (const labelmapImageId of labelmapImageIds) {
            const viewableImageId = viewport.isReferenceViewable({ referencedImageId: labelmapImageId }, { asOverlay: true });
            if (viewableImageId) {
                viewableLabelmapImageIdFound = true;
                this._stackLabelmapImageIdReferenceMap
                    .get(segmentationId)
                    .set(referenceImageId, labelmapImageId);
                this._updateLabelmapImageIdReferenceMap({
                    segmentationId,
                    referenceImageId,
                    labelmapImageId,
                });
            }
        }
        if (updateCallback) {
            updateCallback(viewport, segmentationId, labelmapImageIds);
        }
        return viewableLabelmapImageIdFound
            ? this._stackLabelmapImageIdReferenceMap
                .get(segmentationId)
                .get(referenceImageId)
            : undefined;
    }
    updateLabelmapSegmentationImageReferences(viewportId, segmentationId) {
        const segmentation = this.getSegmentation(segmentationId);
        if (!segmentation) {
            return;
        }
        if (!this._stackLabelmapImageIdReferenceMap.has(segmentationId)) {
            this._stackLabelmapImageIdReferenceMap.set(segmentationId, new Map());
        }
        const { representationData } = segmentation;
        if (!representationData.Labelmap) {
            return;
        }
        const labelmapImageIds = this.getLabelmapImageIds(representationData);
        const enabledElement = getEnabledElementByViewportId(viewportId);
        const stackViewport = enabledElement.viewport;
        return this._updateLabelmapSegmentationReferences(segmentationId, stackViewport, labelmapImageIds, null);
    }
    _updateAllLabelmapSegmentationImageReferences(viewportId, segmentationId) {
        const segmentation = this.getSegmentation(segmentationId);
        if (!segmentation) {
            return;
        }
        if (!this._stackLabelmapImageIdReferenceMap.has(segmentationId)) {
            this._stackLabelmapImageIdReferenceMap.set(segmentationId, new Map());
        }
        const { representationData } = segmentation;
        if (!representationData.Labelmap) {
            return;
        }
        const labelmapImageIds = this.getLabelmapImageIds(representationData);
        const enabledElement = getEnabledElementByViewportId(viewportId);
        const stackViewport = enabledElement.viewport;
        this._updateLabelmapSegmentationReferences(segmentationId, stackViewport, labelmapImageIds, (stackViewport, segmentationId, labelmapImageIds) => {
            const imageIds = stackViewport.getImageIds();
            imageIds.forEach((referenceImageId, index) => {
                for (const labelmapImageId of labelmapImageIds) {
                    const viewableImageId = stackViewport.isReferenceViewable({ referencedImageId: labelmapImageId, sliceIndex: index }, { asOverlay: true, withNavigation: true });
                    if (viewableImageId) {
                        this._stackLabelmapImageIdReferenceMap
                            .get(segmentationId)
                            .set(referenceImageId, labelmapImageId);
                        this._updateLabelmapImageIdReferenceMap({
                            segmentationId,
                            referenceImageId,
                            labelmapImageId,
                        });
                    }
                }
            });
        });
    }
    getLabelmapImageIds(representationData) {
        const labelmapData = representationData.Labelmap;
        let labelmapImageIds;
        if (labelmapData.imageIds) {
            labelmapImageIds = labelmapData
                .imageIds;
        }
        else if (!labelmapImageIds &&
            labelmapData.volumeId) {
            const volumeId = labelmapData
                .volumeId;
            const volume = cache.getVolume(volumeId);
            labelmapImageIds = volume.imageIds;
        }
        return labelmapImageIds;
    }
    getLabelmapImageIdsForImageId(imageId, segmentationId) {
        const key = this._generateMapKey({
            segmentationId,
            referenceImageId: imageId,
        });
        return this._labelmapImageIdReferenceMap.get(key);
    }
    getCurrentLabelmapImageIdsForViewport(viewportId, segmentationId) {
        const enabledElement = getEnabledElementByViewportId(viewportId);
        if (!enabledElement) {
            return;
        }
        const stackViewport = enabledElement.viewport;
        const referenceImageId = stackViewport.getCurrentImageId();
        return this.getLabelmapImageIdsForImageId(referenceImageId, segmentationId);
    }
    getCurrentLabelmapImageIdForViewport(viewportId, segmentationId) {
        const enabledElement = getEnabledElementByViewportId(viewportId);
        if (!enabledElement) {
            return;
        }
        if (!this._stackLabelmapImageIdReferenceMap.has(segmentationId)) {
            return;
        }
        const stackViewport = enabledElement.viewport;
        const currentImageId = stackViewport.getCurrentImageId();
        const imageIdReferenceMap = this._stackLabelmapImageIdReferenceMap.get(segmentationId);
        return imageIdReferenceMap.get(currentImageId);
    }
    getStackSegmentationImageIdsForViewport(viewportId, segmentationId) {
        const segmentation = this.getSegmentation(segmentationId);
        if (!segmentation) {
            return [];
        }
        this._updateAllLabelmapSegmentationImageReferences(viewportId, segmentationId);
        const { viewport } = getEnabledElementByViewportId(viewportId);
        const imageIds = viewport.getImageIds();
        const associatedReferenceImageAndLabelmapImageIds = this._stackLabelmapImageIdReferenceMap.get(segmentationId);
        return imageIds.map((imageId) => {
            return associatedReferenceImageAndLabelmapImageIds.get(imageId);
        });
    }
    removeSegmentationRepresentationsInternal(viewportId, specifier) {
        const removedRepresentations = [];
        this.updateState((state) => {
            if (!state.viewportSegRepresentations[viewportId]) {
                return;
            }
            const currentRepresentations = state.viewportSegRepresentations[viewportId];
            let activeRepresentationRemoved = false;
            if (!specifier ||
                Object.values(specifier).every((value) => value === undefined)) {
                removedRepresentations.push(...currentRepresentations);
                delete state.viewportSegRepresentations[viewportId];
            }
            else {
                const { segmentationId, type } = specifier;
                state.viewportSegRepresentations[viewportId] =
                    currentRepresentations.filter((representation) => {
                        const shouldRemove = (segmentationId &&
                            type &&
                            representation.segmentationId === segmentationId &&
                            representation.type === type) ||
                            (segmentationId &&
                                !type &&
                                representation.segmentationId === segmentationId) ||
                            (!segmentationId && type && representation.type === type);
                        if (shouldRemove) {
                            removedRepresentations.push(representation);
                            if (representation.active) {
                                activeRepresentationRemoved = true;
                            }
                        }
                        return !shouldRemove;
                    });
                if (state.viewportSegRepresentations[viewportId].length === 0) {
                    delete state.viewportSegRepresentations[viewportId];
                }
                else if (activeRepresentationRemoved) {
                    state.viewportSegRepresentations[viewportId][0].active = true;
                }
            }
        });
        return removedRepresentations;
    }
    removeSegmentationRepresentations(viewportId, specifier) {
        const removedRepresentations = this.removeSegmentationRepresentationsInternal(viewportId, specifier);
        removedRepresentations.forEach((representation) => {
            triggerSegmentationRepresentationRemoved(viewportId, representation.segmentationId, representation.type);
        });
        const remainingRepresentations = this.getSegmentationRepresentations(viewportId);
        if (remainingRepresentations.length > 0 &&
            remainingRepresentations[0].active) {
            triggerSegmentationRepresentationModified(viewportId, remainingRepresentations[0].segmentationId, remainingRepresentations[0].type);
        }
        return removedRepresentations;
    }
    removeSegmentationRepresentation(viewportId, specifier, suppressEvent) {
        const removedRepresentations = this.removeSegmentationRepresentationsInternal(viewportId, specifier);
        if (!suppressEvent) {
            removedRepresentations.forEach(({ segmentationId, type }) => {
                triggerSegmentationRepresentationRemoved(viewportId, segmentationId, type);
            });
        }
        return removedRepresentations;
    }
    _updateLabelmapImageIdReferenceMap({ segmentationId, referenceImageId, labelmapImageId, }) {
        const key = this._generateMapKey({ segmentationId, referenceImageId });
        if (!this._labelmapImageIdReferenceMap.has(key)) {
            this._labelmapImageIdReferenceMap.set(key, [labelmapImageId]);
            return;
        }
        const currentValues = this._labelmapImageIdReferenceMap.get(key);
        const newValues = Array.from(new Set([...currentValues, labelmapImageId]));
        this._labelmapImageIdReferenceMap.set(key, newValues);
    }
    _setActiveSegmentation(state, viewportId, segmentationId) {
        const viewport = state.viewportSegRepresentations[viewportId];
        if (!viewport) {
            return;
        }
        viewport.forEach((value) => {
            value.active = value.segmentationId === segmentationId;
        });
    }
    setActiveSegmentation(viewportId, segmentationId) {
        this.updateState((state) => {
            const viewport = state.viewportSegRepresentations[viewportId];
            if (!viewport) {
                return;
            }
            viewport.forEach((value) => {
                value.active = value.segmentationId === segmentationId;
            });
        });
        triggerSegmentationRepresentationModified(viewportId, segmentationId);
    }
    getActiveSegmentation(viewportId) {
        if (!this.state.viewportSegRepresentations[viewportId]) {
            return;
        }
        const activeSegRep = this.state.viewportSegRepresentations[viewportId].find((segRep) => segRep.active);
        if (!activeSegRep) {
            return;
        }
        return this.getSegmentation(activeSegRep.segmentationId);
    }
    getSegmentationRepresentations(viewportId, specifier = {}) {
        const viewportRepresentations = this.state.viewportSegRepresentations[viewportId];
        if (!viewportRepresentations) {
            return [];
        }
        if (!specifier.type && !specifier.segmentationId) {
            return viewportRepresentations;
        }
        return viewportRepresentations.filter((representation) => {
            const typeMatch = specifier.type
                ? representation.type === specifier.type
                : true;
            const idMatch = specifier.segmentationId
                ? representation.segmentationId === specifier.segmentationId
                : true;
            return typeMatch && idMatch;
        });
    }
    getSegmentationRepresentation(viewportId, specifier) {
        return this.getSegmentationRepresentations(viewportId, specifier)[0];
    }
    getSegmentationRepresentationVisibility(viewportId, specifier) {
        const viewportRepresentation = this.getSegmentationRepresentation(viewportId, specifier);
        return viewportRepresentation?.visible;
    }
    setSegmentationRepresentationVisibility(viewportId, specifier, visible) {
        this.updateState((state) => {
            const viewportRepresentations = this.getSegmentationRepresentations(viewportId, specifier);
            if (!viewportRepresentations) {
                return;
            }
            viewportRepresentations.forEach((representation) => {
                representation.visible = visible;
                Object.entries(representation.segments).forEach(([segmentIndex, segment]) => {
                    segment.visible = visible;
                });
            });
        });
        triggerSegmentationRepresentationModified(viewportId, specifier.segmentationId, specifier.type);
    }
    addColorLUT(colorLUT, lutIndex) {
        this.updateState((state) => {
            if (state.colorLUT[lutIndex]) {
                console.warn('Color LUT table already exists, overwriting');
            }
            state.colorLUT[lutIndex] = csUtils.deepClone(colorLUT);
        });
    }
    removeColorLUT(colorLUTIndex) {
        this.updateState((state) => {
            delete state.colorLUT[colorLUTIndex];
        });
    }
    _getStackIdForImageIds(imageIds) {
        return imageIds
            .map((imageId) => imageId.slice(-Math.round(imageId.length * 0.15)))
            .join('_');
    }
    getAllViewportSegmentationRepresentations() {
        return Object.entries(this.state.viewportSegRepresentations).map(([viewportId, representations]) => ({
            viewportId,
            representations,
        }));
    }
    getSegmentationRepresentationsBySegmentationId(segmentationId) {
        const result = [];
        Object.entries(this.state.viewportSegRepresentations).forEach(([viewportId, viewportReps]) => {
            const filteredReps = viewportReps.filter((representation) => representation.segmentationId === segmentationId);
            if (filteredReps.length > 0) {
                result.push({ viewportId, representations: filteredReps });
            }
        });
        return result;
    }
    _generateMapKey({ segmentationId, referenceImageId }) {
        return `${segmentationId}-${referenceImageId}`;
    }
}
async function internalComputeVolumeLabelmapFromStack({ imageIds, options, }) {
    const segmentationImageIds = imageIds;
    const volumeId = options?.volumeId || csUtils.uuidv4();
    await volumeLoader.createAndCacheVolumeFromImages(volumeId, segmentationImageIds);
    return { volumeId };
}
async function internalConvertStackToVolumeLabelmap({ segmentationId, options, }) {
    const segmentation = defaultSegmentationStateManager.getSegmentation(segmentationId);
    const data = segmentation.representationData
        .Labelmap;
    const { volumeId } = await internalComputeVolumeLabelmapFromStack({
        imageIds: data.imageIds,
        options,
    });
    segmentation.representationData.Labelmap.volumeId = volumeId;
}
function getDefaultRenderingConfig(type) {
    const cfun = vtkColorTransferFunction.newInstance();
    const ofun = vtkPiecewiseFunction.newInstance();
    ofun.addPoint(0, 0);
    if (type === SegmentationRepresentations.Labelmap) {
        return {
            cfun,
            ofun,
        };
    }
    else {
        return {};
    }
}
const defaultSegmentationStateManager = new SegmentationStateManager('DEFAULT');
export { internalConvertStackToVolumeLabelmap, internalComputeVolumeLabelmapFromStack, defaultSegmentationStateManager, };
