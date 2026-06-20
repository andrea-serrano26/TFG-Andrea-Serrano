import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';
import vtkPoints from '@kitware/vtk.js/Common/Core/Points';
import vtkCellArray from '@kitware/vtk.js/Common/Core/CellArray';
import { mat3, mat4, vec3 } from 'gl-matrix';
import vtkMath from '@kitware/vtk.js/Common/Core/Math';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkSphereSource from '@kitware/vtk.js/Filters/Sources/SphereSource';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkPlane from '@kitware/vtk.js/Common/DataModel/Plane';
import { BaseTool } from './base';
import { getRenderingEngine, getEnabledElementByIds, getEnabledElement, Enums, triggerEvent, eventTarget, } from '@cornerstonejs/core';
import { getToolGroup } from '../store/ToolGroupManager';
import { Events } from '../enums';
const PLANEINDEX = {
    XMIN: 0,
    XMAX: 1,
    YMIN: 2,
    YMAX: 3,
    ZMIN: 4,
    ZMAX: 5,
};
const SPHEREINDEX = {
    XMIN: 0,
    XMAX: 1,
    YMIN: 2,
    YMAX: 3,
    ZMIN: 4,
    ZMAX: 5,
    XMIN_YMIN_ZMIN: 6,
    XMIN_YMIN_ZMAX: 7,
    XMIN_YMAX_ZMIN: 8,
    XMIN_YMAX_ZMAX: 9,
    XMAX_YMIN_ZMIN: 10,
    XMAX_YMIN_ZMAX: 11,
    XMAX_YMAX_ZMIN: 12,
    XMAX_YMAX_ZMAX: 13,
};
class VolumeCroppingTool extends BaseTool {
    constructor(toolProps = {}, defaultToolProps = {
        configuration: {
            showCornerSpheres: true,
            showHandles: true,
            showClippingPlanes: true,
            mobile: {
                enabled: false,
                opacity: 0.8,
            },
            initialCropFactor: 0.08,
            sphereColors: {
                SAGITTAL: [1.0, 1.0, 0.0],
                CORONAL: [0.0, 1.0, 0.0],
                AXIAL: [1.0, 0.0, 0.0],
                CORNERS: [0.0, 0.0, 1.0],
            },
            sphereRadius: 8,
            grabSpherePixelDistance: 20,
            rotateIncrementDegrees: 2,
            rotateSampleDistanceFactor: 2,
        },
    }) {
        super(toolProps, defaultToolProps);
        this._resizeObservers = new Map();
        this._hasResolutionChanged = false;
        this.originalClippingPlanes = [];
        this.draggingSphereIndex = null;
        this.toolCenter = [0, 0, 0];
        this.cornerDragOffset = null;
        this.faceDragOffset = null;
        this.sphereStates = [];
        this.edgeLines = {};
        this.onSetToolConfiguration = () => {
            console.debug('Setting tool settoolconfiguration : volumeCropping');
        };
        this.onSetToolEnabled = () => {
            console.debug('Setting tool enabled: volumeCropping');
        };
        this.onCameraModified = (evt) => {
            const { element } = evt.currentTarget
                ? { element: evt.currentTarget }
                : evt.detail;
            const enabledElement = getEnabledElement(element);
            this._updateClippingPlanes(enabledElement.viewport);
            enabledElement.viewport.render();
        };
        this.preMouseDownCallback = (evt) => {
            const eventDetail = evt.detail;
            const { element } = eventDetail;
            const enabledElement = getEnabledElement(element);
            const { viewport } = enabledElement;
            const actorEntry = viewport.getDefaultActor();
            const actor = actorEntry.actor;
            const mapper = actor.getMapper();
            const mouseCanvas = [
                evt.detail.currentPoints.canvas[0],
                evt.detail.currentPoints.canvas[1],
            ];
            this.draggingSphereIndex = null;
            this.cornerDragOffset = null;
            this.faceDragOffset = null;
            for (let i = 0; i < this.sphereStates.length; ++i) {
                const sphereCanvas = viewport.worldToCanvas(this.sphereStates[i].point);
                const dist = Math.sqrt(Math.pow(mouseCanvas[0] - sphereCanvas[0], 2) +
                    Math.pow(mouseCanvas[1] - sphereCanvas[1], 2));
                if (dist < this.configuration.grabSpherePixelDistance) {
                    this.draggingSphereIndex = i;
                    element.style.cursor = 'grabbing';
                    const sphereState = this.sphereStates[i];
                    const mouseWorld = viewport.canvasToWorld(mouseCanvas);
                    if (sphereState.isCorner) {
                        this.cornerDragOffset = [
                            sphereState.point[0] - mouseWorld[0],
                            sphereState.point[1] - mouseWorld[1],
                            sphereState.point[2] - mouseWorld[2],
                        ];
                        this.faceDragOffset = null;
                    }
                    else {
                        const axisIdx = { x: 0, y: 1, z: 2 }[sphereState.axis];
                        this.faceDragOffset =
                            sphereState.point[axisIdx] - mouseWorld[axisIdx];
                        this.cornerDragOffset = null;
                    }
                    return true;
                }
            }
            const hasSampleDistance = 'getSampleDistance' in mapper || 'getCurrentSampleDistance' in mapper;
            if (!hasSampleDistance) {
                return true;
            }
            const originalSampleDistance = mapper.getSampleDistance();
            if (!this._hasResolutionChanged) {
                const { rotateSampleDistanceFactor } = this.configuration;
                mapper.setSampleDistance(originalSampleDistance * rotateSampleDistanceFactor);
                this._hasResolutionChanged = true;
                if (this.cleanUp !== null) {
                    document.removeEventListener('mouseup', this.cleanUp);
                }
                this.cleanUp = () => {
                    mapper.setSampleDistance(originalSampleDistance);
                    evt.target.style.cursor = '';
                    if (this.draggingSphereIndex !== null) {
                        const sphereState = this.sphereStates[this.draggingSphereIndex];
                        const [viewport3D] = this._getViewportsInfo();
                        const renderingEngine = getRenderingEngine(viewport3D.renderingEngineId);
                        const viewport = renderingEngine.getViewport(viewport3D.viewportId);
                        if (sphereState.isCorner) {
                            this._updateCornerSpheres();
                            this._updateFaceSpheresFromCorners();
                            this._updateClippingPlanesFromFaceSpheres(viewport);
                        }
                    }
                    this.draggingSphereIndex = null;
                    this.cornerDragOffset = null;
                    this.faceDragOffset = null;
                    viewport.render();
                    this._hasResolutionChanged = false;
                };
                document.addEventListener('mouseup', this.cleanUp, { once: true });
            }
            return true;
        };
        this._onMouseMoveSphere = (evt) => {
            if (this.draggingSphereIndex === null) {
                return false;
            }
            const sphereState = this.sphereStates[this.draggingSphereIndex];
            if (!sphereState) {
                return false;
            }
            const { viewport, world } = this._getViewportAndWorldCoords(evt);
            if (!viewport || !world) {
                return false;
            }
            if (sphereState.isCorner) {
                const newCorner = this._calculateNewCornerPosition(world);
                this._updateSpherePosition(sphereState, newCorner);
                const axisFlags = this._parseCornerKey(sphereState.uid);
                this._updateRelatedCorners(sphereState, newCorner, axisFlags);
                this._updateFaceSpheresFromCorners();
                this._updateCornerSpheres();
            }
            else {
                const axisIdx = { x: 0, y: 1, z: 2 }[sphereState.axis];
                let newValue = world[axisIdx];
                if (this.faceDragOffset !== null) {
                    newValue += this.faceDragOffset;
                }
                sphereState.point[axisIdx] = newValue;
                sphereState.sphereSource.setCenter(...sphereState.point);
                sphereState.sphereSource.modified();
                this._updateCornerSpheresFromFaces();
                this._updateFaceSpheresFromCorners();
                this._updateCornerSpheres();
            }
            this._updateClippingPlanesFromFaceSpheres(viewport);
            viewport.render();
            this._triggerToolChangedEvent(sphereState);
            return true;
        };
        this._onControlToolChange = (evt) => {
            const viewport = this._getViewport();
            if (!evt.detail.toolCenter) {
                triggerEvent(eventTarget, Events.VOLUMECROPPING_TOOL_CHANGED, {
                    originalClippingPlanes: this.originalClippingPlanes,
                    viewportId: viewport.id,
                    renderingEngineId: viewport.renderingEngineId,
                    seriesInstanceUID: this.seriesInstanceUID,
                });
            }
            else {
                if (evt.detail.seriesInstanceUID !== this.seriesInstanceUID) {
                    return;
                }
                const isMin = evt.detail.handleType === 'min';
                const toolCenter = isMin
                    ? evt.detail.toolCenterMin
                    : evt.detail.toolCenterMax;
                const normals = isMin
                    ? [
                        [1, 0, 0],
                        [0, 1, 0],
                        [0, 0, 1],
                    ]
                    : [
                        [-1, 0, 0],
                        [0, -1, 0],
                        [0, 0, -1],
                    ];
                const planeIndices = isMin
                    ? [PLANEINDEX.XMIN, PLANEINDEX.YMIN, PLANEINDEX.ZMIN]
                    : [PLANEINDEX.XMAX, PLANEINDEX.YMAX, PLANEINDEX.ZMAX];
                const sphereIndices = isMin
                    ? [SPHEREINDEX.XMIN, SPHEREINDEX.YMIN, SPHEREINDEX.ZMIN]
                    : [SPHEREINDEX.XMAX, SPHEREINDEX.YMAX, SPHEREINDEX.ZMAX];
                const axes = ['x', 'y', 'z'];
                const orientationAxes = [
                    Enums.OrientationAxis.SAGITTAL,
                    Enums.OrientationAxis.CORONAL,
                    Enums.OrientationAxis.AXIAL,
                ];
                for (let i = 0; i < 3; ++i) {
                    const origin = [0, 0, 0];
                    origin[i] = toolCenter[i];
                    const plane = vtkPlane.newInstance({
                        origin,
                        normal: normals[i],
                    });
                    this.originalClippingPlanes[planeIndices[i]].origin = plane.getOrigin();
                    this.sphereStates[sphereIndices[i]].point[i] = plane.getOrigin()[i];
                    this.sphereStates[sphereIndices[i]].sphereSource.setCenter(...this.sphereStates[sphereIndices[i]].point);
                    this.sphereStates[sphereIndices[i]].sphereSource.modified();
                    const otherSphere = this.sphereStates.find((s, idx) => s.axis === axes[i] && idx !== sphereIndices[i]);
                    const newCenter = (otherSphere.point[i] + plane.getOrigin()[i]) / 2;
                    this.sphereStates.forEach((state) => {
                        if (!state.isCorner &&
                            state.axis !== axes[i] &&
                            !evt.detail.viewportOrientation.includes(orientationAxes[i])) {
                            state.point[i] = newCenter;
                            state.sphereSource.setCenter(state.point);
                            state.sphereActor.getProperty().setColor(state.color);
                            state.sphereSource.modified();
                        }
                    });
                    const volumeActor = viewport.getDefaultActor()?.actor;
                    if (volumeActor) {
                        const mapper = volumeActor.getMapper();
                        const clippingPlanes = mapper.getClippingPlanes();
                        if (clippingPlanes) {
                            clippingPlanes[planeIndices[i]].setOrigin(plane.getOrigin());
                        }
                    }
                }
                this._updateCornerSpheres();
                viewport.render();
            }
        };
        this._getViewportsInfo = () => {
            const viewports = getToolGroup(this.toolGroupId).viewportsInfo;
            return viewports;
        };
        this._initialize3DViewports = (viewportsInfo) => {
            if (!viewportsInfo || !viewportsInfo.length || !viewportsInfo[0]) {
                console.warn('VolumeCroppingTool: No viewportsInfo available for initialization of volumecroppingtool.');
                return;
            }
            const viewport = this._getViewport();
            const volumeActors = viewport.getActors();
            if (!volumeActors || volumeActors.length === 0) {
                console.warn('VolumeCroppingTool: No volume actors found in the viewport.');
                return;
            }
            const imageData = volumeActors[0].actor.getMapper().getInputData();
            if (!imageData) {
                console.warn('VolumeCroppingTool: No image data found for volume actor.');
                return;
            }
            this.seriesInstanceUID = imageData.seriesInstanceUID || 'unknown';
            const worldBounds = imageData.getBounds();
            const cropFactor = this.configuration.initialCropFactor || 0.1;
            const xRange = worldBounds[1] - worldBounds[0];
            const yRange = worldBounds[3] - worldBounds[2];
            const zRange = worldBounds[5] - worldBounds[4];
            const xMin = worldBounds[0] + cropFactor * xRange;
            const xMax = worldBounds[1] - cropFactor * xRange;
            const yMin = worldBounds[2] + cropFactor * yRange;
            const yMax = worldBounds[3] - cropFactor * yRange;
            const zMin = worldBounds[4] + cropFactor * zRange;
            const zMax = worldBounds[5] - cropFactor * zRange;
            const planes = [];
            const planeXmin = vtkPlane.newInstance({
                origin: [xMin, 0, 0],
                normal: [1, 0, 0],
            });
            const planeXmax = vtkPlane.newInstance({
                origin: [xMax, 0, 0],
                normal: [-1, 0, 0],
            });
            const planeYmin = vtkPlane.newInstance({
                origin: [0, yMin, 0],
                normal: [0, 1, 0],
            });
            const planeYmax = vtkPlane.newInstance({
                origin: [0, yMax, 0],
                normal: [0, -1, 0],
            });
            const planeZmin = vtkPlane.newInstance({
                origin: [0, 0, zMin],
                normal: [0, 0, 1],
            });
            const planeZmax = vtkPlane.newInstance({
                origin: [0, 0, zMax],
                normal: [0, 0, -1],
            });
            const mapper = viewport
                .getDefaultActor()
                .actor.getMapper();
            planes.push(planeXmin);
            planes.push(planeXmax);
            planes.push(planeYmin);
            planes.push(planeYmax);
            planes.push(planeZmin);
            planes.push(planeZmax);
            const originalPlanes = planes.map((plane) => ({
                origin: [...plane.getOrigin()],
                normal: [...plane.getNormal()],
            }));
            this.originalClippingPlanes = originalPlanes;
            const sphereXminPoint = [xMin, (yMax + yMin) / 2, (zMax + zMin) / 2];
            const sphereXmaxPoint = [xMax, (yMax + yMin) / 2, (zMax + zMin) / 2];
            const sphereYminPoint = [(xMax + xMin) / 2, yMin, (zMax + zMin) / 2];
            const sphereYmaxPoint = [(xMax + xMin) / 2, yMax, (zMax + zMin) / 2];
            const sphereZminPoint = [(xMax + xMin) / 2, (yMax + yMin) / 2, zMin];
            const sphereZmaxPoint = [(xMax + xMin) / 2, (yMax + yMin) / 2, zMax];
            const adaptiveRadius = this._calculateAdaptiveSphereRadius(Math.sqrt(xRange * xRange + yRange * yRange + zRange * zRange));
            this._addSphere(viewport, sphereXminPoint, 'x', 'min', null, adaptiveRadius);
            this._addSphere(viewport, sphereXmaxPoint, 'x', 'max', null, adaptiveRadius);
            this._addSphere(viewport, sphereYminPoint, 'y', 'min', null, adaptiveRadius);
            this._addSphere(viewport, sphereYmaxPoint, 'y', 'max', null, adaptiveRadius);
            this._addSphere(viewport, sphereZminPoint, 'z', 'min', null, adaptiveRadius);
            this._addSphere(viewport, sphereZmaxPoint, 'z', 'max', null, adaptiveRadius);
            const corners = [
                [xMin, yMin, zMin],
                [xMin, yMin, zMax],
                [xMin, yMax, zMin],
                [xMin, yMax, zMax],
                [xMax, yMin, zMin],
                [xMax, yMin, zMax],
                [xMax, yMax, zMin],
                [xMax, yMax, zMax],
            ];
            const cornerKeys = [
                'XMIN_YMIN_ZMIN',
                'XMIN_YMIN_ZMAX',
                'XMIN_YMAX_ZMIN',
                'XMIN_YMAX_ZMAX',
                'XMAX_YMIN_ZMIN',
                'XMAX_YMIN_ZMAX',
                'XMAX_YMAX_ZMIN',
                'XMAX_YMAX_ZMAX',
            ];
            for (let i = 0; i < corners.length; i++) {
                this._addSphere(viewport, corners[i], 'corner', null, cornerKeys[i], adaptiveRadius);
            }
            const edgeCornerPairs = [
                ['XMIN_YMIN_ZMIN', 'XMAX_YMIN_ZMIN'],
                ['XMIN_YMIN_ZMAX', 'XMAX_YMIN_ZMAX'],
                ['XMIN_YMAX_ZMIN', 'XMAX_YMAX_ZMIN'],
                ['XMIN_YMAX_ZMAX', 'XMAX_YMAX_ZMAX'],
                ['XMIN_YMIN_ZMIN', 'XMIN_YMAX_ZMIN'],
                ['XMIN_YMIN_ZMAX', 'XMIN_YMAX_ZMAX'],
                ['XMAX_YMIN_ZMIN', 'XMAX_YMAX_ZMIN'],
                ['XMAX_YMIN_ZMAX', 'XMAX_YMAX_ZMAX'],
                ['XMIN_YMIN_ZMIN', 'XMIN_YMIN_ZMAX'],
                ['XMIN_YMAX_ZMIN', 'XMIN_YMAX_ZMAX'],
                ['XMAX_YMIN_ZMIN', 'XMAX_YMIN_ZMAX'],
                ['XMAX_YMAX_ZMIN', 'XMAX_YMAX_ZMAX'],
            ];
            edgeCornerPairs.forEach(([key1, key2], i) => {
                const state1 = this.sphereStates.find((s) => s.uid === `corner_${key1}`);
                const state2 = this.sphereStates.find((s) => s.uid === `corner_${key2}`);
                if (state1 && state2) {
                    const uid = `edge_${key1}_${key2}`;
                    const { actor, source } = this._addLine3DBetweenPoints(viewport, state1.point, state2.point, [0.7, 0.7, 0.7], uid);
                    this.edgeLines[uid] = { actor, source, key1, key2 };
                }
            });
            mapper.addClippingPlane(planeXmin);
            mapper.addClippingPlane(planeXmax);
            mapper.addClippingPlane(planeYmin);
            mapper.addClippingPlane(planeYmax);
            mapper.addClippingPlane(planeZmin);
            mapper.addClippingPlane(planeZmax);
            eventTarget.addEventListener(Events.VOLUMECROPPINGCONTROL_TOOL_CHANGED, (evt) => {
                this._onControlToolChange(evt);
            });
            viewport.render();
        };
        this._getViewportAndWorldCoords = (evt) => {
            const viewport = this._getViewport();
            const x = evt.detail.currentPoints.canvas[0];
            const y = evt.detail.currentPoints.canvas[1];
            const world = viewport.canvasToWorld([x, y]);
            return { viewport, world };
        };
        this._getViewport = () => {
            const [viewport3D] = this._getViewportsInfo();
            const renderingEngine = getRenderingEngine(viewport3D.renderingEngineId);
            return renderingEngine.getViewport(viewport3D.viewportId);
        };
        this._handleCornerSphereMovement = (sphereState, world, viewport) => {
            const newCorner = this._calculateNewCornerPosition(world);
            this._updateSpherePosition(sphereState, newCorner);
            const axisFlags = this._parseCornerKey(sphereState.uid);
            this._updateRelatedCorners(sphereState, newCorner, axisFlags);
            this._updateAfterCornerMovement(viewport);
        };
        this._handleFaceSphereMovement = (sphereState, world, viewport) => {
            const axisIdx = { x: 0, y: 1, z: 2 }[sphereState.axis];
            let newValue = world[axisIdx];
            if (this.faceDragOffset !== null) {
                newValue += this.faceDragOffset;
            }
            sphereState.point[axisIdx] = newValue;
            sphereState.sphereSource.setCenter(...sphereState.point);
            sphereState.sphereSource.modified();
            this._updateAfterFaceMovement(viewport);
        };
        this._calculateNewCornerPosition = (world) => {
            let newCorner = [world[0], world[1], world[2]];
            if (this.cornerDragOffset) {
                newCorner = [
                    world[0] + this.cornerDragOffset[0],
                    world[1] + this.cornerDragOffset[1],
                    world[2] + this.cornerDragOffset[2],
                ];
            }
            return newCorner;
        };
        this._parseCornerKey = (uid) => {
            const cornerKey = uid.replace('corner_', '');
            return {
                isXMin: cornerKey.includes('XMIN'),
                isXMax: cornerKey.includes('XMAX'),
                isYMin: cornerKey.includes('YMIN'),
                isYMax: cornerKey.includes('YMAX'),
                isZMin: cornerKey.includes('ZMIN'),
                isZMax: cornerKey.includes('ZMAX'),
            };
        };
        this._updateSpherePosition = (sphereState, newPosition) => {
            sphereState.point = newPosition;
            sphereState.sphereSource.setCenter(...newPosition);
            sphereState.sphereSource.modified();
        };
        this._updateRelatedCorners = (draggedSphere, newCorner, axisFlags) => {
            this.sphereStates.forEach((state) => {
                if (!state.isCorner || state === draggedSphere) {
                    return;
                }
                const key = state.uid.replace('corner_', '');
                const shouldUpdate = this._shouldUpdateCorner(key, axisFlags);
                if (shouldUpdate) {
                    this._updateCornerCoordinates(state, newCorner, key, axisFlags);
                }
            });
        };
        this._shouldUpdateCorner = (cornerKey, axisFlags) => {
            return ((axisFlags.isXMin && cornerKey.includes('XMIN')) ||
                (axisFlags.isXMax && cornerKey.includes('XMAX')) ||
                (axisFlags.isYMin && cornerKey.includes('YMIN')) ||
                (axisFlags.isYMax && cornerKey.includes('YMAX')) ||
                (axisFlags.isZMin && cornerKey.includes('ZMIN')) ||
                (axisFlags.isZMax && cornerKey.includes('ZMAX')));
        };
        this._updateCornerCoordinates = (state, newCorner, cornerKey, axisFlags) => {
            if ((axisFlags.isXMin && cornerKey.includes('XMIN')) ||
                (axisFlags.isXMax && cornerKey.includes('XMAX'))) {
                state.point[0] = newCorner[0];
            }
            if ((axisFlags.isYMin && cornerKey.includes('YMIN')) ||
                (axisFlags.isYMax && cornerKey.includes('YMAX'))) {
                state.point[1] = newCorner[1];
            }
            if ((axisFlags.isZMin && cornerKey.includes('ZMIN')) ||
                (axisFlags.isZMax && cornerKey.includes('ZMAX'))) {
                state.point[2] = newCorner[2];
            }
            state.sphereSource.setCenter(...state.point);
            state.sphereSource.modified();
        };
        this._updateAfterCornerMovement = (viewport) => {
            this._updateFaceSpheresFromCorners();
            this._updateCornerSpheres();
            this._updateClippingPlanesFromFaceSpheres(viewport);
        };
        this._updateAfterFaceMovement = (viewport) => {
            this._updateCornerSpheresFromFaces();
            this._updateClippingPlanesFromFaceSpheres(viewport);
        };
        this._triggerToolChangedEvent = (sphereState) => {
            triggerEvent(eventTarget, Events.VOLUMECROPPING_TOOL_CHANGED, {
                toolCenter: sphereState.point,
                axis: sphereState.isCorner ? 'corner' : sphereState.axis,
                draggingSphereIndex: this.draggingSphereIndex,
                seriesInstanceUID: this.seriesInstanceUID,
            });
        };
        this._onNewVolume = () => {
            const viewportsInfo = this._getViewportsInfo();
            this.originalClippingPlanes = [];
            this.sphereStates = [];
            this.edgeLines = {};
            this._initialize3DViewports(viewportsInfo);
        };
        this._rotateCamera = (viewport, centerWorld, axis, angle) => {
            const vtkCamera = viewport.getVtkActiveCamera();
            const viewUp = vtkCamera.getViewUp();
            const focalPoint = vtkCamera.getFocalPoint();
            const position = vtkCamera.getPosition();
            const newPosition = [0, 0, 0];
            const newFocalPoint = [0, 0, 0];
            const newViewUp = [0, 0, 0];
            const transform = mat4.identity(new Float32Array(16));
            mat4.translate(transform, transform, centerWorld);
            mat4.rotate(transform, transform, angle, axis);
            mat4.translate(transform, transform, [
                -centerWorld[0],
                -centerWorld[1],
                -centerWorld[2],
            ]);
            vec3.transformMat4(newPosition, position, transform);
            vec3.transformMat4(newFocalPoint, focalPoint, transform);
            mat4.identity(transform);
            mat4.rotate(transform, transform, angle, axis);
            vec3.transformMat4(newViewUp, viewUp, transform);
            viewport.setCamera({
                position: newPosition,
                viewUp: newViewUp,
                focalPoint: newFocalPoint,
            });
        };
        this.touchDragCallback = this._dragCallback.bind(this);
        this.mouseDragCallback = this._dragCallback.bind(this);
    }
    onSetToolActive() {
        if (this.sphereStates && this.sphereStates.length > 0) {
            if (this.configuration.showHandles) {
                this.setHandlesVisible(false);
                this.setClippingPlanesVisible(false);
            }
            else {
                this.setHandlesVisible(true);
                this.setClippingPlanesVisible(true);
            }
        }
        else {
            const viewportsInfo = this._getViewportsInfo();
            const subscribeToElementResize = () => {
                viewportsInfo.forEach(({ viewportId, renderingEngineId }) => {
                    if (!this._resizeObservers.has(viewportId)) {
                        const { viewport } = getEnabledElementByIds(viewportId, renderingEngineId) || { viewport: null };
                        if (!viewport) {
                            return;
                        }
                        const { element } = viewport;
                        const resizeObserver = new ResizeObserver(() => {
                            const element = getEnabledElementByIds(viewportId, renderingEngineId);
                            if (!element) {
                                return;
                            }
                            const { viewport } = element;
                            const viewPresentation = viewport.getViewPresentation();
                            viewport.resetCamera();
                            viewport.setViewPresentation(viewPresentation);
                            viewport.render();
                        });
                        resizeObserver.observe(element);
                        this._resizeObservers.set(viewportId, resizeObserver);
                    }
                });
            };
            subscribeToElementResize();
            this._viewportAddedListener = (evt) => {
                if (evt.detail.toolGroupId === this.toolGroupId) {
                    subscribeToElementResize();
                }
            };
            eventTarget.addEventListener(Events.TOOLGROUP_VIEWPORT_ADDED, this._viewportAddedListener);
            this._unsubscribeToViewportNewVolumeSet(viewportsInfo);
            this._subscribeToViewportNewVolumeSet(viewportsInfo);
            this._initialize3DViewports(viewportsInfo);
            if (this.sphereStates && this.sphereStates.length > 0) {
                this.setHandlesVisible(true);
            }
            else {
                this.originalClippingPlanes = [];
                this._initialize3DViewports(viewportsInfo);
            }
        }
    }
    onSetToolDisabled() {
        this._resizeObservers.forEach((resizeObserver, viewportId) => {
            resizeObserver.disconnect();
            this._resizeObservers.delete(viewportId);
        });
        if (this._viewportAddedListener) {
            eventTarget.removeEventListener(Events.TOOLGROUP_VIEWPORT_ADDED, this._viewportAddedListener);
            this._viewportAddedListener = null;
        }
        const viewportsInfo = this._getViewportsInfo();
        this._unsubscribeToViewportNewVolumeSet(viewportsInfo);
    }
    setHandlesVisible(visible) {
        this.configuration.showHandles = visible;
        if (visible) {
            this.sphereStates[SPHEREINDEX.XMIN].point[0] =
                this.originalClippingPlanes[PLANEINDEX.XMIN].origin[0];
            this.sphereStates[SPHEREINDEX.XMAX].point[0] =
                this.originalClippingPlanes[PLANEINDEX.XMAX].origin[0];
            this.sphereStates[SPHEREINDEX.YMIN].point[1] =
                this.originalClippingPlanes[PLANEINDEX.YMIN].origin[1];
            this.sphereStates[SPHEREINDEX.YMAX].point[1] =
                this.originalClippingPlanes[PLANEINDEX.YMAX].origin[1];
            this.sphereStates[SPHEREINDEX.ZMIN].point[2] =
                this.originalClippingPlanes[PLANEINDEX.ZMIN].origin[2];
            this.sphereStates[SPHEREINDEX.ZMAX].point[2] =
                this.originalClippingPlanes[PLANEINDEX.ZMAX].origin[2];
            [
                SPHEREINDEX.XMIN,
                SPHEREINDEX.XMAX,
                SPHEREINDEX.YMIN,
                SPHEREINDEX.YMAX,
                SPHEREINDEX.ZMIN,
                SPHEREINDEX.ZMAX,
            ].forEach((idx) => {
                const s = this.sphereStates[idx];
                s.sphereSource.setCenter(...s.point);
                s.sphereSource.modified();
            });
            this._updateCornerSpheres();
        }
        this._updateHandlesVisibility();
        const viewportsInfo = this._getViewportsInfo();
        const [viewport3D] = viewportsInfo;
        const renderingEngine = getRenderingEngine(viewport3D.renderingEngineId);
        const viewport = renderingEngine.getViewport(viewport3D.viewportId);
        viewport.render();
    }
    getHandlesVisible() {
        return this.configuration.showHandles;
    }
    getClippingPlanesVisible() {
        return this.configuration.showClippingPlanes;
    }
    setClippingPlanesVisible(visible) {
        this.configuration.showClippingPlanes = visible;
        const viewport = this._getViewport();
        this._updateClippingPlanes(viewport);
        viewport.render();
    }
    _dragCallback(evt) {
        const { element, currentPoints, lastPoints } = evt.detail;
        if (this.draggingSphereIndex !== null) {
            this._onMouseMoveSphere(evt);
        }
        else {
            const currentPointsCanvas = currentPoints.canvas;
            const lastPointsCanvas = lastPoints.canvas;
            const { rotateIncrementDegrees } = this.configuration;
            const enabledElement = getEnabledElement(element);
            const { viewport } = enabledElement;
            const camera = viewport.getCamera();
            const width = element.clientWidth;
            const height = element.clientHeight;
            const normalizedPosition = [
                currentPointsCanvas[0] / width,
                currentPointsCanvas[1] / height,
            ];
            const normalizedPreviousPosition = [
                lastPointsCanvas[0] / width,
                lastPointsCanvas[1] / height,
            ];
            const center = [width * 0.5, height * 0.5];
            const centerWorld = viewport.canvasToWorld(center);
            const normalizedCenter = [0.5, 0.5];
            const radsq = (1.0 + Math.abs(normalizedCenter[0])) ** 2.0;
            const op = [normalizedPreviousPosition[0], 0, 0];
            const oe = [normalizedPosition[0], 0, 0];
            const opsq = op[0] ** 2;
            const oesq = oe[0] ** 2;
            const lop = opsq > radsq ? 0 : Math.sqrt(radsq - opsq);
            const loe = oesq > radsq ? 0 : Math.sqrt(radsq - oesq);
            const nop = [op[0], 0, lop];
            vtkMath.normalize(nop);
            const noe = [oe[0], 0, loe];
            vtkMath.normalize(noe);
            const dot = vtkMath.dot(nop, noe);
            if (Math.abs(dot) > 0.0001) {
                const angleX = -2 *
                    Math.acos(vtkMath.clampValue(dot, -1.0, 1.0)) *
                    Math.sign(normalizedPosition[0] - normalizedPreviousPosition[0]) *
                    rotateIncrementDegrees;
                const upVec = camera.viewUp;
                const atV = camera.viewPlaneNormal;
                const rightV = [0, 0, 0];
                const forwardV = [0, 0, 0];
                vtkMath.cross(upVec, atV, rightV);
                vtkMath.normalize(rightV);
                vtkMath.cross(atV, rightV, forwardV);
                vtkMath.normalize(forwardV);
                vtkMath.normalize(upVec);
                this._rotateCamera(viewport, centerWorld, forwardV, angleX);
                const angleY = (normalizedPreviousPosition[1] - normalizedPosition[1]) *
                    rotateIncrementDegrees;
                this._rotateCamera(viewport, centerWorld, rightV, angleY);
            }
            viewport.render();
        }
    }
    _updateClippingPlanes(viewport) {
        const actorEntry = viewport.getDefaultActor();
        if (!actorEntry || !actorEntry.actor) {
            if (!viewport._missingActorWarned) {
                console.warn('VolumeCroppingTool._updateClippingPlanes: No default actor found in viewport.');
                viewport._missingActorWarned = true;
            }
            return;
        }
        const actor = actorEntry.actor;
        const mapper = actor.getMapper();
        const matrix = actor.getMatrix();
        if (!this.configuration.showClippingPlanes) {
            mapper.removeAllClippingPlanes();
            return;
        }
        const rot = mat3.create();
        mat3.fromMat4(rot, matrix);
        const normalMatrix = mat3.create();
        mat3.invert(normalMatrix, rot);
        mat3.transpose(normalMatrix, normalMatrix);
        const originalPlanes = this.originalClippingPlanes;
        if (!originalPlanes || !originalPlanes.length) {
            return;
        }
        mapper.removeAllClippingPlanes();
        const transformedOrigins = [];
        const transformedNormals = [];
        for (let i = 0; i < originalPlanes.length; ++i) {
            const plane = originalPlanes[i];
            const oVec = vec3.create();
            vec3.transformMat4(oVec, new Float32Array(plane.origin), matrix);
            const o = [oVec[0], oVec[1], oVec[2]];
            const nVec = vec3.create();
            vec3.transformMat3(nVec, new Float32Array(plane.normal), normalMatrix);
            vec3.normalize(nVec, nVec);
            const n = [nVec[0], nVec[1], nVec[2]];
            transformedOrigins.push(o);
            transformedNormals.push(n);
        }
        for (let i = 0; i < transformedOrigins.length; ++i) {
            const planeInstance = vtkPlane.newInstance({
                origin: transformedOrigins[i],
                normal: transformedNormals[i],
            });
            mapper.addClippingPlane(planeInstance);
        }
    }
    _updateHandlesVisibility() {
        this.sphereStates.forEach((state) => {
            if (state.sphereActor) {
                state.sphereActor.setVisibility(this.configuration.showHandles);
            }
        });
        Object.values(this.edgeLines).forEach(({ actor }) => {
            if (actor) {
                actor.setVisibility(this.configuration.showHandles);
            }
        });
    }
    _addLine3DBetweenPoints(viewport, point1, point2, color = [0.7, 0.7, 0.7], uid = '') {
        if (point1[0] === point2[0] &&
            point1[1] === point2[1] &&
            point1[2] === point2[2]) {
            return { actor: null, source: null };
        }
        const points = vtkPoints.newInstance();
        points.setNumberOfPoints(2);
        points.setPoint(0, point1[0], point1[1], point1[2]);
        points.setPoint(1, point2[0], point2[1], point2[2]);
        const lines = vtkCellArray.newInstance({ values: [2, 0, 1] });
        const polyData = vtkPolyData.newInstance();
        polyData.setPoints(points);
        polyData.setLines(lines);
        const mapper = vtkMapper.newInstance();
        mapper.setInputData(polyData);
        const actor = vtkActor.newInstance();
        actor.setMapper(mapper);
        actor.getProperty().setColor(...color);
        actor.getProperty().setLineWidth(0.5);
        actor.getProperty().setOpacity(1.0);
        actor.getProperty().setInterpolationToFlat();
        actor.getProperty().setAmbient(1.0);
        actor.getProperty().setDiffuse(0.0);
        actor.getProperty().setSpecular(0.0);
        actor.setVisibility(this.configuration.showHandles);
        viewport.addActor({ actor, uid });
        return { actor, source: polyData };
    }
    _addSphere(viewport, point, axis, position, cornerKey = null, adaptiveRadius) {
        const uid = cornerKey ? `corner_${cornerKey}` : `${axis}_${position}`;
        const sphereState = this.sphereStates.find((s) => s.uid === uid);
        if (sphereState) {
            return;
        }
        const sphereSource = vtkSphereSource.newInstance();
        sphereSource.setCenter(point);
        sphereSource.setRadius(adaptiveRadius);
        const sphereMapper = vtkMapper.newInstance();
        sphereMapper.setInputConnection(sphereSource.getOutputPort());
        const sphereActor = vtkActor.newInstance();
        sphereActor.setMapper(sphereMapper);
        let color = [0.0, 1.0, 0.0];
        const sphereColors = this.configuration.sphereColors || {};
        if (cornerKey) {
            color = sphereColors.CORNERS || [0.0, 0.0, 1.0];
        }
        else if (axis === 'z') {
            color = sphereColors.AXIAL || [1.0, 0.0, 0.0];
        }
        else if (axis === 'x') {
            color = sphereColors.SAGITTAL || [1.0, 1.0, 0.0];
        }
        else if (axis === 'y') {
            color = sphereColors.CORONAL || [0.0, 1.0, 0.0];
        }
        const idx = this.sphereStates.findIndex((s) => s.uid === uid);
        if (idx === -1) {
            this.sphereStates.push({
                point: point.slice(),
                axis,
                uid,
                sphereSource,
                sphereActor,
                isCorner: !!cornerKey,
                color,
            });
        }
        else {
            this.sphereStates[idx].point = point.slice();
            this.sphereStates[idx].sphereSource = sphereSource;
        }
        const existingActors = viewport.getActors();
        const existing = existingActors.find((a) => a.uid === uid);
        if (existing) {
            return;
        }
        sphereActor.getProperty().setColor(color);
        sphereActor.setVisibility(this.configuration.showHandles);
        viewport.addActor({ actor: sphereActor, uid: uid });
    }
    _calculateAdaptiveSphereRadius(diagonal) {
        const baseRadius = this.configuration.sphereRadius !== undefined
            ? this.configuration.sphereRadius
            : 8;
        const scaleFactor = this.configuration.sphereRadiusScale || 0.01;
        const adaptiveRadius = diagonal * scaleFactor;
        const minRadius = this.configuration.minSphereRadius || 2;
        const maxRadius = this.configuration.maxSphereRadius || 50;
        return Math.max(minRadius, Math.min(maxRadius, adaptiveRadius));
    }
    _updateClippingPlanesFromFaceSpheres(viewport) {
        const mapper = viewport.getDefaultActor().actor.getMapper();
        this.originalClippingPlanes[0].origin = [
            ...this.sphereStates[SPHEREINDEX.XMIN].point,
        ];
        this.originalClippingPlanes[1].origin = [
            ...this.sphereStates[SPHEREINDEX.XMAX].point,
        ];
        this.originalClippingPlanes[2].origin = [
            ...this.sphereStates[SPHEREINDEX.YMIN].point,
        ];
        this.originalClippingPlanes[3].origin = [
            ...this.sphereStates[SPHEREINDEX.YMAX].point,
        ];
        this.originalClippingPlanes[4].origin = [
            ...this.sphereStates[SPHEREINDEX.ZMIN].point,
        ];
        this.originalClippingPlanes[5].origin = [
            ...this.sphereStates[SPHEREINDEX.ZMAX].point,
        ];
        mapper.removeAllClippingPlanes();
        for (let i = 0; i < 6; ++i) {
            const origin = this.originalClippingPlanes[i].origin;
            const normal = this.originalClippingPlanes[i].normal;
            const plane = vtkPlane.newInstance({
                origin,
                normal,
            });
            mapper.addClippingPlane(plane);
        }
    }
    _updateCornerSpheresFromFaces() {
        const xMin = this.sphereStates[SPHEREINDEX.XMIN].point[0];
        const xMax = this.sphereStates[SPHEREINDEX.XMAX].point[0];
        const yMin = this.sphereStates[SPHEREINDEX.YMIN].point[1];
        const yMax = this.sphereStates[SPHEREINDEX.YMAX].point[1];
        const zMin = this.sphereStates[SPHEREINDEX.ZMIN].point[2];
        const zMax = this.sphereStates[SPHEREINDEX.ZMAX].point[2];
        const corners = [
            { key: 'XMIN_YMIN_ZMIN', pos: [xMin, yMin, zMin] },
            { key: 'XMIN_YMIN_ZMAX', pos: [xMin, yMin, zMax] },
            { key: 'XMIN_YMAX_ZMIN', pos: [xMin, yMax, zMin] },
            { key: 'XMIN_YMAX_ZMAX', pos: [xMin, yMax, zMax] },
            { key: 'XMAX_YMIN_ZMIN', pos: [xMax, yMin, zMin] },
            { key: 'XMAX_YMIN_ZMAX', pos: [xMax, yMin, zMax] },
            { key: 'XMAX_YMAX_ZMIN', pos: [xMax, yMax, zMin] },
            { key: 'XMAX_YMAX_ZMAX', pos: [xMax, yMax, zMax] },
        ];
        for (const corner of corners) {
            const state = this.sphereStates.find((s) => s.uid === `corner_${corner.key}`);
            if (state) {
                state.point[0] = corner.pos[0];
                state.point[1] = corner.pos[1];
                state.point[2] = corner.pos[2];
                state.sphereSource.setCenter(...state.point);
                state.sphereSource.modified();
            }
        }
    }
    _updateFaceSpheresFromCorners() {
        const corners = [
            this.sphereStates[SPHEREINDEX.XMIN_YMIN_ZMIN].point,
            this.sphereStates[SPHEREINDEX.XMIN_YMIN_ZMAX].point,
            this.sphereStates[SPHEREINDEX.XMIN_YMAX_ZMIN].point,
            this.sphereStates[SPHEREINDEX.XMIN_YMAX_ZMAX].point,
            this.sphereStates[SPHEREINDEX.XMAX_YMIN_ZMIN].point,
            this.sphereStates[SPHEREINDEX.XMAX_YMIN_ZMAX].point,
            this.sphereStates[SPHEREINDEX.XMAX_YMAX_ZMIN].point,
            this.sphereStates[SPHEREINDEX.XMAX_YMAX_ZMAX].point,
        ];
        const xs = corners.map((p) => p[0]);
        const ys = corners.map((p) => p[1]);
        const zs = corners.map((p) => p[2]);
        const xMin = Math.min(...xs), xMax = Math.max(...xs);
        const yMin = Math.min(...ys), yMax = Math.max(...ys);
        const zMin = Math.min(...zs), zMax = Math.max(...zs);
        this.sphereStates[SPHEREINDEX.XMIN].point = [
            xMin,
            (yMin + yMax) / 2,
            (zMin + zMax) / 2,
        ];
        this.sphereStates[SPHEREINDEX.XMAX].point = [
            xMax,
            (yMin + yMax) / 2,
            (zMin + zMax) / 2,
        ];
        this.sphereStates[SPHEREINDEX.YMIN].point = [
            (xMin + xMax) / 2,
            yMin,
            (zMin + zMax) / 2,
        ];
        this.sphereStates[SPHEREINDEX.YMAX].point = [
            (xMin + xMax) / 2,
            yMax,
            (zMin + zMax) / 2,
        ];
        this.sphereStates[SPHEREINDEX.ZMIN].point = [
            (xMin + xMax) / 2,
            (yMin + yMax) / 2,
            zMin,
        ];
        this.sphereStates[SPHEREINDEX.ZMAX].point = [
            (xMin + xMax) / 2,
            (yMin + yMax) / 2,
            zMax,
        ];
        [
            SPHEREINDEX.XMIN,
            SPHEREINDEX.XMAX,
            SPHEREINDEX.YMIN,
            SPHEREINDEX.YMAX,
            SPHEREINDEX.ZMIN,
            SPHEREINDEX.ZMAX,
        ].forEach((idx) => {
            const s = this.sphereStates[idx];
            s.sphereSource.setCenter(...s.point);
            s.sphereSource.modified();
        });
    }
    _updateCornerSpheres() {
        const xMin = this.sphereStates[SPHEREINDEX.XMIN].point[0];
        const xMax = this.sphereStates[SPHEREINDEX.XMAX].point[0];
        const yMin = this.sphereStates[SPHEREINDEX.YMIN].point[1];
        const yMax = this.sphereStates[SPHEREINDEX.YMAX].point[1];
        const zMin = this.sphereStates[SPHEREINDEX.ZMIN].point[2];
        const zMax = this.sphereStates[SPHEREINDEX.ZMAX].point[2];
        const corners = [
            { key: 'XMIN_YMIN_ZMIN', pos: [xMin, yMin, zMin] },
            { key: 'XMIN_YMIN_ZMAX', pos: [xMin, yMin, zMax] },
            { key: 'XMIN_YMAX_ZMIN', pos: [xMin, yMax, zMin] },
            { key: 'XMIN_YMAX_ZMAX', pos: [xMin, yMax, zMax] },
            { key: 'XMAX_YMIN_ZMIN', pos: [xMax, yMin, zMin] },
            { key: 'XMAX_YMIN_ZMAX', pos: [xMax, yMin, zMax] },
            { key: 'XMAX_YMAX_ZMIN', pos: [xMax, yMax, zMin] },
            { key: 'XMAX_YMAX_ZMAX', pos: [xMax, yMax, zMax] },
        ];
        for (const corner of corners) {
            const state = this.sphereStates.find((s) => s.uid === `corner_${corner.key}`);
            if (state) {
                state.point[0] = corner.pos[0];
                state.point[1] = corner.pos[1];
                state.point[2] = corner.pos[2];
                state.sphereSource.setCenter(...state.point);
                state.sphereSource.modified();
            }
        }
        Object.values(this.edgeLines).forEach(({ source, key1, key2 }) => {
            const state1 = this.sphereStates.find((s) => s.uid === `corner_${key1}`);
            const state2 = this.sphereStates.find((s) => s.uid === `corner_${key2}`);
            if (state1 && state2) {
                const points = source.getPoints();
                points.setPoint(0, state1.point[0], state1.point[1], state1.point[2]);
                points.setPoint(1, state2.point[0], state2.point[1], state2.point[2]);
                points.modified();
                source.modified();
            }
        });
    }
    _unsubscribeToViewportNewVolumeSet(viewportsInfo) {
        viewportsInfo.forEach(({ viewportId, renderingEngineId }) => {
            const { viewport } = getEnabledElementByIds(viewportId, renderingEngineId);
            const { element } = viewport;
            element.removeEventListener(Enums.Events.VOLUME_VIEWPORT_NEW_VOLUME, this._onNewVolume);
        });
    }
    _subscribeToViewportNewVolumeSet(viewports) {
        viewports.forEach(({ viewportId, renderingEngineId }) => {
            const { viewport } = getEnabledElementByIds(viewportId, renderingEngineId);
            const { element } = viewport;
            element.addEventListener(Enums.Events.VOLUME_VIEWPORT_NEW_VOLUME, this._onNewVolume);
        });
    }
}
VolumeCroppingTool.toolName = 'VolumeCropping';
export default VolumeCroppingTool;
