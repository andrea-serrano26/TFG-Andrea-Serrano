export type BaseLabelmapStyle = {
    renderOutline?: boolean;
    outlineWidth?: number;
    activeSegmentOutlineWidthDelta?: number;
    renderFill?: boolean;
    fillAlpha?: number;
    outlineOpacity?: number;
};
export type InactiveLabelmapStyle = {
    renderOutlineInactive?: boolean;
    outlineWidthInactive?: number;
    renderFillInactive?: boolean;
    fillAlphaInactive?: number;
    outlineOpacityInactive?: number;
};
export type LabelmapStyle = BaseLabelmapStyle & InactiveLabelmapStyle;
export type LabelmapSegmentationDataVolume = {
    volumeId: string;
    referencedVolumeId?: string;
};
export type LabelmapSegmentationDataStack = {
    imageIds: string[];
};
export type LabelmapSegmentationData = LabelmapSegmentationDataVolume | LabelmapSegmentationDataStack | {
    volumeId?: string;
    referencedVolumeId?: string;
    referencedImageIds?: string[];
    imageIds?: string[];
};
