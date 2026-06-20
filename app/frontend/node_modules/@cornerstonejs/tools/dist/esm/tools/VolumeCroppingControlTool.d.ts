import type vtkPlane from '@kitware/vtk.js/Common/DataModel/Plane';
import { AnnotationTool } from './base';
import type { Types } from '@cornerstonejs/core';
import type { Annotation, Annotations, EventTypes, ToolHandle, PublicToolProps, ToolProps, InteractionTypes, SVGDrawingHelper } from '../types';
type ReferenceLine = [
    viewport: {
        id: string;
        canvas?: HTMLCanvasElement;
        canvasToWorld?: (...args: unknown[]) => Types.Point3;
    },
    startPoint: Types.Point2,
    endPoint: Types.Point2,
    type: 'min' | 'max'
];
interface VolumeCroppingAnnotation extends Annotation {
    data: {
        handles: {
            activeOperation: number | null;
            toolCenter: Types.Point3;
            toolCenterMin: Types.Point3;
            toolCenterMax: Types.Point3;
        };
        activeViewportIds: string[];
        viewportId: string;
        referenceLines: ReferenceLine[];
        clippingPlanes?: vtkPlane[];
        clippingPlaneReferenceLines?: ReferenceLine[];
        orientation?: string;
    };
    isVirtual?: boolean;
    virtualNormal?: Types.Point3;
}
declare class VolumeCroppingControlTool extends AnnotationTool {
    _virtualAnnotations: VolumeCroppingAnnotation[];
    static toolName: any;
    seriesInstanceUID?: string;
    sphereStates: {
        point: Types.Point3;
        axis: string;
        uid: string;
        sphereSource: any;
        sphereActor: any;
    }[];
    draggingSphereIndex: number | null;
    toolCenter: Types.Point3;
    toolCenterMin: Types.Point3;
    toolCenterMax: Types.Point3;
    _getReferenceLineColor?: (viewportId: string) => string;
    _getReferenceLineControllable?: (viewportId: string) => boolean;
    constructor(toolProps?: PublicToolProps, defaultToolProps?: ToolProps);
    _updateToolCentersFromViewport(viewport: any): void;
    initializeViewport: ({ renderingEngineId, viewportId, }: Types.IViewportId) => {
        normal: Types.Point3;
        point: Types.Point3;
    };
    _getViewportsInfo: () => any[];
    onSetToolInactive(): void;
    onSetToolActive(): void;
    onSetToolEnabled(): void;
    onSetToolDisabled(): void;
    resetCroppingSpheres: () => void;
    computeToolCenter: () => void;
    _computeToolCenter: (viewportsInfo: any) => void;
    _getOrientationFromNormal(normal: Types.Point3): string | null;
    _syncWithVolumeCroppingTool(originalClippingPlanes: any): void;
    setToolCenter(toolCenter: Types.Point3, handleType: any): void;
    addNewAnnotation(evt: EventTypes.InteractionEventType): VolumeCroppingAnnotation;
    cancel: () => void;
    isPointNearTool: (element: HTMLDivElement, annotation: VolumeCroppingAnnotation, canvasCoords: Types.Point2, proximity: number) => boolean;
    toolSelectedCallback: (evt: EventTypes.InteractionEventType, annotation: Annotation, interactionType: InteractionTypes) => void;
    handleSelectedCallback(evt: EventTypes.InteractionEventType, annotation: Annotation, handle: ToolHandle, interactionType: InteractionTypes): void;
    onResetCamera: (evt: any) => void;
    mouseMoveCallback: (evt: EventTypes.MouseMoveEventType, filteredToolAnnotations: Annotations) => boolean;
    filterInteractableAnnotationsForElement: (element: any, annotations: any) => any;
    renderAnnotation: (enabledElement: Types.IEnabledElement, svgDrawingHelper: SVGDrawingHelper) => boolean;
    _getAnnotations: (enabledElement: Types.IEnabledElement) => Annotation[];
    _onSphereMoved: (evt: any) => void;
    _onNewVolume: () => void;
    _unsubscribeToViewportNewVolumeSet(viewportsInfo: any): void;
    _subscribeToViewportNewVolumeSet(viewports: any): void;
    _getAnnotationsForViewportsWithDifferentCameras: (enabledElement: any, annotations: any) => any;
    _filterViewportWithSameOrientation: (enabledElement: any, referenceAnnotation: any, annotations: any) => any;
    _activateModify: (element: any) => void;
    _deactivateModify: (element: any) => void;
    _endCallback: (evt: EventTypes.InteractionEventType) => void;
    _dragCallback: (evt: EventTypes.InteractionEventType) => void;
    _applyDeltaShiftToSelectedViewportCameras(renderingEngine: any, viewportsAnnotationsToUpdate: any, delta: any): void;
    _applyDeltaShiftToViewportCamera(renderingEngine: Types.IRenderingEngine, annotation: any, delta: any): void;
    _pointNearTool(element: any, annotation: any, canvasCoords: any, proximity: any): boolean;
}
export default VolumeCroppingControlTool;
