import type { Types } from '@cornerstonejs/core';
import { SegmentationRepresentations } from '../../enums';
import type { RenderingConfig, RepresentationsData, Segmentation, SegmentationRepresentation, SegmentationState } from '../../types/SegmentationStateTypes';
export default class SegmentationStateManager {
    private state;
    readonly uid: string;
    private _stackLabelmapImageIdReferenceMap;
    private _labelmapImageIdReferenceMap;
    constructor(uid?: string);
    getState(): Readonly<SegmentationState>;
    private updateState;
    getColorLUT(lutIndex: number): Types.ColorLUT | undefined;
    getNextColorLUTIndex(): number;
    resetState(): void;
    getSegmentation(segmentationId: string): Segmentation | undefined;
    updateSegmentation(segmentationId: string, payload: Partial<Segmentation>): void;
    addSegmentation(segmentation: Segmentation): void;
    removeSegmentation(segmentationId: string): void;
    addSegmentationRepresentation(viewportId: string, segmentationId: string, type: SegmentationRepresentations, renderingConfig: RenderingConfig): void;
    private addDefaultSegmentationRepresentation;
    addLabelmapRepresentation(state: SegmentationState, viewportId: string, segmentationId: string, renderingConfig?: RenderingConfig): void;
    processLabelmapRepresentationAddition(viewportId: string, segmentationId: string): Promise<void>;
    _updateLabelmapSegmentationReferences(segmentationId: any, viewport: any, labelmapImageIds: any, updateCallback: any): string | undefined;
    updateLabelmapSegmentationImageReferences(viewportId: any, segmentationId: any): string;
    _updateAllLabelmapSegmentationImageReferences(viewportId: any, segmentationId: any): void;
    getLabelmapImageIds(representationData: RepresentationsData): any;
    getLabelmapImageIdsForImageId(imageId: string, segmentationId: string): string[];
    getCurrentLabelmapImageIdsForViewport(viewportId: string, segmentationId: string): string[] | undefined;
    getCurrentLabelmapImageIdForViewport(viewportId: string, segmentationId: string): string | undefined;
    getStackSegmentationImageIdsForViewport(viewportId: string, segmentationId: string): string[];
    private removeSegmentationRepresentationsInternal;
    removeSegmentationRepresentations(viewportId: string, specifier?: {
        segmentationId?: string;
        type?: SegmentationRepresentations;
    }): Array<{
        segmentationId: string;
        type: SegmentationRepresentations;
    }>;
    removeSegmentationRepresentation(viewportId: string, specifier: {
        segmentationId: string;
        type: SegmentationRepresentations;
    }, suppressEvent?: boolean): Array<{
        segmentationId: string;
        type: SegmentationRepresentations;
    }>;
    _updateLabelmapImageIdReferenceMap({ segmentationId, referenceImageId, labelmapImageId, }: {
        segmentationId: any;
        referenceImageId: any;
        labelmapImageId: any;
    }): void;
    _setActiveSegmentation(state: SegmentationState, viewportId: string, segmentationId: string): void;
    setActiveSegmentation(viewportId: string, segmentationId: string): void;
    getActiveSegmentation(viewportId: string): Segmentation | undefined;
    getSegmentationRepresentations(viewportId: string, specifier?: {
        segmentationId?: string;
        type?: SegmentationRepresentations;
    }): SegmentationRepresentation[];
    getSegmentationRepresentation(viewportId: string, specifier: {
        segmentationId: string;
        type: SegmentationRepresentations;
    }): SegmentationRepresentation | undefined;
    getSegmentationRepresentationVisibility(viewportId: string, specifier: {
        segmentationId: string;
        type: SegmentationRepresentations;
    }): boolean;
    setSegmentationRepresentationVisibility(viewportId: string, specifier: {
        segmentationId: string;
        type: SegmentationRepresentations;
    }, visible: boolean): void;
    addColorLUT(colorLUT: Types.ColorLUT, lutIndex: number): void;
    removeColorLUT(colorLUTIndex: number): void;
    _getStackIdForImageIds(imageIds: string[]): string;
    getAllViewportSegmentationRepresentations(): Array<{
        viewportId: string;
        representations: SegmentationRepresentation[];
    }>;
    getSegmentationRepresentationsBySegmentationId(segmentationId: string): {
        viewportId: string;
        representations: SegmentationRepresentation[];
    }[];
    private _generateMapKey;
}
declare function internalComputeVolumeLabelmapFromStack({ imageIds, options, }: {
    imageIds: string[];
    options?: {
        volumeId?: string;
    };
}): Promise<{
    volumeId: string;
}>;
declare function internalConvertStackToVolumeLabelmap({ segmentationId, options, }: {
    segmentationId: string;
    options?: {
        viewportId: string;
        volumeId?: string;
        removeOriginal?: boolean;
    };
}): Promise<void>;
declare const defaultSegmentationStateManager: SegmentationStateManager;
export { internalConvertStackToVolumeLabelmap, internalComputeVolumeLabelmapFromStack, defaultSegmentationStateManager, };
