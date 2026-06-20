import type Point2 from './Point2';
import type Point3 from './Point3';
import type ViewportInputOptions from './ViewportInputOptions';
import type ViewportType from '../enums/ViewportType';
import type DisplayArea from './displayArea';
import type { BoundsLPS } from './BoundsLPS';
import type Viewport from '../RenderingEngine/Viewport';
export type ViewReferenceSpecifier = {
    sliceIndex?: number;
    rangeEndSliceIndex?: number;
    frameNumber?: number;
    forFrameOfReference?: boolean;
    points?: Point3[];
    volumeId?: string;
};
export interface ReferenceCompatibleOptions {
    withNavigation?: boolean;
    asVolume?: boolean;
    withOrientation?: boolean;
    imageURI?: string;
    asNearbyProjection?: boolean;
    asOverlay?: boolean;
}
export type ReferencedImageRange = ViewReference & {
    referencedImageId: string;
};
export type PlaneRestriction = {
    FrameOfReferenceUID: string;
    point: Point3;
    inPlaneVector1?: Point3;
    inPlaneVector2?: Point3;
};
export interface ViewReference {
    FrameOfReferenceUID?: string;
    planeRestriction?: PlaneRestriction;
    referencedImageId?: string;
    referencedImageURI?: string;
    multiSliceReference?: ReferencedImageRange;
    cameraFocalPoint?: Point3;
    viewPlaneNormal?: Point3;
    viewUp?: Point3;
    sliceIndex?: number;
    volumeId?: string;
    bounds?: BoundsLPS;
}
export interface ViewPresentation {
    slabThickness?: number;
    rotation?: number;
    displayArea?: DisplayArea;
    zoom?: number;
    pan?: Point2;
    flipHorizontal?: boolean;
    flipVertical?: boolean;
}
export interface ViewPresentationSelector {
    slabThickness?: number;
    rotation?: boolean;
    displayArea?: boolean;
    zoom?: boolean;
    pan?: boolean;
    flipHorizontal?: boolean;
    flipVertical?: boolean;
    windowLevel?: boolean;
    paletteLut?: boolean;
}
export type DataSetOptions = {
    groupId?: string;
    viewSelector?: ViewPresentationSelector;
    viewReference?: ViewReferenceSpecifier;
};
type IViewport = Viewport;
interface PublicViewportInput {
    element: HTMLDivElement;
    viewportId: string;
    type: ViewportType;
    defaultOptions?: ViewportInputOptions;
}
interface NormalizedViewportInput {
    element: HTMLDivElement;
    viewportId: string;
    type: ViewportType;
    defaultOptions: ViewportInputOptions;
}
interface InternalViewportInput {
    element: HTMLDivElement;
    canvas: HTMLCanvasElement;
    viewportId: string;
    type: ViewportType;
    defaultOptions: ViewportInputOptions;
}
interface ViewportInput {
    id: string;
    renderingEngineId: string;
    type: ViewportType;
    element: HTMLDivElement;
    sx: number;
    sy: number;
    sWidth: number;
    sHeight: number;
    defaultOptions: ViewportInputOptions;
    canvas: HTMLCanvasElement;
}
export type { IViewport, ViewportInput, PublicViewportInput, InternalViewportInput, NormalizedViewportInput, };
