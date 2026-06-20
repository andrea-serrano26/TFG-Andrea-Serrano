import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import { BaseTool } from './base';
import type { Types } from '@cornerstonejs/core';
import type { EventTypes, PublicToolProps, ToolProps } from '../types';
declare class VolumeCroppingTool extends BaseTool {
    static toolName: any;
    seriesInstanceUID?: string;
    touchDragCallback: (evt: EventTypes.InteractionEventType) => void;
    mouseDragCallback: (evt: EventTypes.InteractionEventType) => void;
    cleanUp: () => void;
    _resizeObservers: Map<any, any>;
    _viewportAddedListener: (evt: any) => void;
    _hasResolutionChanged: boolean;
    originalClippingPlanes: {
        origin: number[];
        normal: number[];
    }[];
    draggingSphereIndex: number | null;
    toolCenter: Types.Point3;
    cornerDragOffset: [number, number, number] | null;
    faceDragOffset: number | null;
    sphereStates: {
        point: Types.Point3;
        axis: string;
        uid: string;
        sphereSource: any;
        sphereActor: any;
        isCorner: boolean;
        color: number[];
    }[];
    edgeLines: {
        [uid: string]: {
            actor: vtkActor;
            source: vtkPolyData;
            key1: string;
            key2: string;
        };
    };
    constructor(toolProps?: PublicToolProps, defaultToolProps?: ToolProps);
    onSetToolActive(): void;
    onSetToolConfiguration: () => void;
    onSetToolEnabled: () => void;
    onSetToolDisabled(): void;
    onCameraModified: (evt: any) => void;
    preMouseDownCallback: (evt: EventTypes.InteractionEventType) => boolean;
    setHandlesVisible(visible: boolean): void;
    getHandlesVisible(): any;
    getClippingPlanesVisible(): any;
    setClippingPlanesVisible(visible: boolean): void;
    _dragCallback(evt: EventTypes.InteractionEventType): void;
    _onMouseMoveSphere: (evt: any) => boolean;
    _onControlToolChange: (evt: any) => void;
    _updateClippingPlanes(viewport: any): void;
    _updateHandlesVisibility(): void;
    _addLine3DBetweenPoints(viewport: any, point1: any, point2: any, color?: [number, number, number], uid?: string): {
        actor: vtkActor;
        source: vtkPolyData;
    };
    _getViewportsInfo: () => any[];
    _addSphere(viewport: any, point: any, axis: any, position: any, cornerKey: any, adaptiveRadius: any): void;
    _calculateAdaptiveSphereRadius(diagonal: any): number;
    _initialize3DViewports: (viewportsInfo: any) => void;
    _getViewportAndWorldCoords: (evt: any) => {
        viewport: import("@cornerstonejs/core").Viewport;
        world: Types.Point3;
    };
    _getViewport: () => import("@cornerstonejs/core").Viewport;
    _handleCornerSphereMovement: (sphereState: any, world: any, viewport: any) => void;
    _handleFaceSphereMovement: (sphereState: any, world: any, viewport: any) => void;
    _calculateNewCornerPosition: (world: any) => any[];
    _parseCornerKey: (uid: any) => {
        isXMin: any;
        isXMax: any;
        isYMin: any;
        isYMax: any;
        isZMin: any;
        isZMax: any;
    };
    _updateSpherePosition: (sphereState: any, newPosition: any) => void;
    _updateRelatedCorners: (draggedSphere: any, newCorner: any, axisFlags: any) => void;
    _shouldUpdateCorner: (cornerKey: any, axisFlags: any) => any;
    _updateCornerCoordinates: (state: any, newCorner: any, cornerKey: any, axisFlags: any) => void;
    _updateAfterCornerMovement: (viewport: any) => void;
    _updateAfterFaceMovement: (viewport: any) => void;
    _triggerToolChangedEvent: (sphereState: any) => void;
    _updateClippingPlanesFromFaceSpheres(viewport: any): void;
    _updateCornerSpheresFromFaces(): void;
    _updateFaceSpheresFromCorners(): void;
    _updateCornerSpheres(): void;
    _onNewVolume: () => void;
    _unsubscribeToViewportNewVolumeSet(viewportsInfo: any): void;
    _subscribeToViewportNewVolumeSet(viewports: any): void;
    _rotateCamera: (viewport: any, centerWorld: any, axis: any, angle: any) => void;
}
export default VolumeCroppingTool;
