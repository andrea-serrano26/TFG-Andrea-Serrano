import { vec2, vec3 } from 'gl-matrix';
import vtkMath from '@kitware/vtk.js/Common/Core/Math';
import { AnnotationTool } from './base';
import { getRenderingEngine, getEnabledElementByIds, getEnabledElement, utilities as csUtils, Enums, CONSTANTS, triggerEvent, eventTarget, } from '@cornerstonejs/core';
import { getToolGroup, getToolGroupForViewport, } from '../store/ToolGroupManager';
import { addAnnotation, getAnnotations, removeAnnotation, } from '../stateManagement/annotation/annotationState';
import { drawCircle as drawCircleSvg, drawLine as drawLineSvg, } from '../drawingSvg';
import { state } from '../store/state';
import { Events } from '../enums';
import { getViewportIdsWithToolToRender } from '../utilities/viewportFilters';
import { resetElementCursor, hideElementCursor, } from '../cursors/elementCursor';
import liangBarksyClip from '../utilities/math/vec2/liangBarksyClip';
import * as lineSegment from '../utilities/math/line';
import { isAnnotationLocked } from '../stateManagement/annotation/annotationLocking';
import triggerAnnotationRenderForViewportIds from '../utilities/triggerAnnotationRenderForViewportIds';
const { RENDERING_DEFAULTS } = CONSTANTS;
function defaultReferenceLineColor() {
    return 'rgb(0, 200, 0)';
}
function defaultReferenceLineControllable() {
    return true;
}
const OPERATION = {
    DRAG: 1,
    ROTATE: 2,
    SLAB: 3,
};
class VolumeCroppingControlTool extends AnnotationTool {
    constructor(toolProps = {}, defaultToolProps = {
        supportedInteractionTypes: ['Mouse'],
        configuration: {
            viewportIndicators: false,
            viewportIndicatorsConfig: {
                radius: 5,
                x: null,
                y: null,
            },
            extendReferenceLines: true,
            initialCropFactor: 0.2,
            mobile: {
                enabled: false,
                opacity: 0.8,
            },
            lineColors: {
                AXIAL: [1.0, 0.0, 0.0],
                CORONAL: [0.0, 1.0, 0.0],
                SAGITTAL: [1.0, 1.0, 0.0],
                UNKNOWN: [0.0, 0.0, 1.0],
            },
            lineWidth: 1.5,
            lineWidthActive: 2.5,
        },
    }) {
        super(toolProps, defaultToolProps);
        this._virtualAnnotations = [];
        this.sphereStates = [];
        this.draggingSphereIndex = null;
        this.toolCenter = [0, 0, 0];
        this.toolCenterMin = [0, 0, 0];
        this.toolCenterMax = [0, 0, 0];
        this.initializeViewport = ({ renderingEngineId, viewportId, }) => {
            if (!renderingEngineId || !viewportId) {
                console.warn('VolumeCroppingControlTool: Missing renderingEngineId or viewportId');
                return;
            }
            const enabledElement = getEnabledElementByIds(viewportId, renderingEngineId);
            if (!enabledElement) {
                return;
            }
            const { viewport } = enabledElement;
            this._updateToolCentersFromViewport(viewport);
            const { element } = viewport;
            const { position, focalPoint, viewPlaneNormal } = viewport.getCamera();
            let annotations = this._getAnnotations(enabledElement);
            annotations = this.filterInteractableAnnotationsForElement(element, annotations);
            if (annotations?.length) {
                removeAnnotation(annotations[0].annotationUID);
            }
            const orientation = this._getOrientationFromNormal(viewport.getCamera().viewPlaneNormal);
            const annotation = {
                highlighted: false,
                metadata: {
                    cameraPosition: [...position],
                    cameraFocalPoint: [...focalPoint],
                    toolName: this.getToolName(),
                },
                data: {
                    handles: {
                        toolCenter: this.toolCenter,
                        toolCenterMin: this.toolCenterMin,
                        toolCenterMax: this.toolCenterMax,
                    },
                    activeOperation: null,
                    activeViewportIds: [],
                    viewportId,
                    referenceLines: [],
                    orientation,
                },
            };
            addAnnotation(annotation, element);
            return {
                normal: viewPlaneNormal,
                point: viewport.canvasToWorld([100, 100]),
            };
        };
        this._getViewportsInfo = () => {
            const viewports = getToolGroup(this.toolGroupId).viewportsInfo;
            return viewports;
        };
        this.resetCroppingSpheres = () => {
            const viewportsInfo = this._getViewportsInfo();
            for (const viewportInfo of viewportsInfo) {
                const { viewportId, renderingEngineId } = viewportInfo;
                const enabledElement = getEnabledElementByIds(viewportId, renderingEngineId);
                const viewport = enabledElement.viewport;
                const resetPan = true;
                const resetZoom = true;
                const resetToCenter = true;
                const resetRotation = true;
                const suppressEvents = true;
                viewport.resetCamera({
                    resetPan,
                    resetZoom,
                    resetToCenter,
                    resetRotation,
                    suppressEvents,
                });
                viewport.resetSlabThickness();
                const { element } = viewport;
                let annotations = this._getAnnotations(enabledElement);
                annotations = this.filterInteractableAnnotationsForElement(element, annotations);
                if (annotations.length) {
                    removeAnnotation(annotations[0].annotationUID);
                }
                viewport.render();
            }
            this._computeToolCenter(viewportsInfo);
        };
        this.computeToolCenter = () => {
            const viewportsInfo = this._getViewportsInfo();
        };
        this._computeToolCenter = (viewportsInfo) => {
            if (!viewportsInfo || !viewportsInfo[0]) {
                console.warn('  _computeToolCenter : No valid viewportsInfo for computeToolCenter.');
                return;
            }
            const orientationIds = ['AXIAL', 'CORONAL', 'SAGITTAL'];
            const presentOrientations = viewportsInfo
                .map((vp) => {
                if (vp.renderingEngineId) {
                    const renderingEngine = getRenderingEngine(vp.renderingEngineId);
                    const viewport = renderingEngine.getViewport(vp.viewportId);
                    if (viewport && viewport.getCamera) {
                        const orientation = this._getOrientationFromNormal(viewport.getCamera().viewPlaneNormal);
                        if (orientation) {
                            return orientation;
                        }
                    }
                }
                return null;
            })
                .filter(Boolean);
            const missingOrientation = orientationIds.find((id) => !presentOrientations.includes(id));
            const presentNormals = [];
            const presentCenters = [];
            const presentViewportInfos = viewportsInfo.filter((vp) => {
                let orientation = null;
                if (vp.renderingEngineId) {
                    const renderingEngine = getRenderingEngine(vp.renderingEngineId);
                    const viewport = renderingEngine.getViewport(vp.viewportId);
                    if (viewport && viewport.getCamera) {
                        orientation = this._getOrientationFromNormal(viewport.getCamera().viewPlaneNormal);
                    }
                }
                return orientation && orientationIds.includes(orientation);
            });
            presentViewportInfos.forEach((vpInfo) => {
                const { normal, point } = this.initializeViewport(vpInfo);
                presentNormals.push(normal);
                presentCenters.push(point);
            });
            if (presentViewportInfos.length === 2 && missingOrientation) {
                const virtualNormal = [0, 0, 0];
                vec3.cross(virtualNormal, presentNormals[0], presentNormals[1]);
                vec3.normalize(virtualNormal, virtualNormal);
                const virtualCenter = [
                    (presentCenters[0][0] + presentCenters[1][0]) / 2,
                    (presentCenters[0][1] + presentCenters[1][1]) / 2,
                    (presentCenters[0][2] + presentCenters[1][2]) / 2,
                ];
                const orientation = null;
                const virtualAnnotation = {
                    highlighted: false,
                    metadata: {
                        cameraPosition: [...virtualCenter],
                        cameraFocalPoint: [...virtualCenter],
                        toolName: this.getToolName(),
                    },
                    data: {
                        handles: {
                            activeOperation: null,
                            toolCenter: this.toolCenter,
                            toolCenterMin: this.toolCenterMin,
                            toolCenterMax: this.toolCenterMax,
                        },
                        activeViewportIds: [],
                        viewportId: missingOrientation,
                        referenceLines: [],
                        orientation,
                    },
                    isVirtual: true,
                    virtualNormal,
                };
                this._virtualAnnotations = [virtualAnnotation];
            }
            else if (presentViewportInfos.length === 1) {
                let presentOrientation = null;
                const vpInfo = presentViewportInfos[0];
                if (vpInfo.renderingEngineId) {
                    const renderingEngine = getRenderingEngine(vpInfo.renderingEngineId);
                    const viewport = renderingEngine.getViewport(vpInfo.viewportId);
                    if (viewport && viewport.getCamera) {
                        presentOrientation = this._getOrientationFromNormal(viewport.getCamera().viewPlaneNormal);
                    }
                }
                const presentCenter = presentCenters[0];
                const canonicalNormals = {
                    AXIAL: [0, 0, 1],
                    CORONAL: [0, 1, 0],
                    SAGITTAL: [1, 0, 0],
                };
                const missingIds = orientationIds.filter((id) => id !== presentOrientation);
                const virtualAnnotations = missingIds.map((orientation) => {
                    const normal = canonicalNormals[orientation];
                    const virtualAnnotation = {
                        highlighted: false,
                        metadata: {
                            cameraPosition: [...presentCenter],
                            cameraFocalPoint: [...presentCenter],
                            toolName: this.getToolName(),
                        },
                        data: {
                            handles: {
                                activeOperation: null,
                                toolCenter: this.toolCenter,
                                toolCenterMin: this.toolCenterMin,
                                toolCenterMax: this.toolCenterMax,
                            },
                            activeViewportIds: [],
                            viewportId: orientation,
                            referenceLines: [],
                            orientation,
                        },
                        isVirtual: true,
                        virtualNormal: normal,
                    };
                    return virtualAnnotation;
                });
                this._virtualAnnotations = virtualAnnotations;
            }
            if (viewportsInfo && viewportsInfo.length) {
                triggerAnnotationRenderForViewportIds(viewportsInfo.map(({ viewportId }) => viewportId));
            }
        };
        this.cancel = () => {
            console.log('Not implemented yet');
        };
        this.isPointNearTool = (element, annotation, canvasCoords, proximity) => {
            if (this._pointNearTool(element, annotation, canvasCoords, 6)) {
                return true;
            }
            return false;
        };
        this.toolSelectedCallback = (evt, annotation, interactionType) => {
            const eventDetail = evt.detail;
            const { element } = eventDetail;
            annotation.highlighted = true;
            this._activateModify(element);
            hideElementCursor(element);
            evt.preventDefault();
        };
        this.onResetCamera = (evt) => {
            this.resetCroppingSpheres();
        };
        this.mouseMoveCallback = (evt, filteredToolAnnotations) => {
            if (!filteredToolAnnotations) {
                return;
            }
            const { element, currentPoints } = evt.detail;
            const canvasCoords = currentPoints.canvas;
            let imageNeedsUpdate = false;
            for (let i = 0; i < filteredToolAnnotations.length; i++) {
                const annotation = filteredToolAnnotations[i];
                if (isAnnotationLocked(annotation.annotationUID)) {
                    continue;
                }
                const { data, highlighted } = annotation;
                if (!data.handles) {
                    continue;
                }
                const previousActiveOperation = data.handles.activeOperation;
                const previousActiveViewportIds = data.activeViewportIds && data.activeViewportIds.length > 0
                    ? [...data.activeViewportIds]
                    : [];
                data.activeViewportIds = [];
                let near = false;
                near = this._pointNearTool(element, annotation, canvasCoords, 6);
                const nearToolAndNotMarkedActive = near && !highlighted;
                const notNearToolAndMarkedActive = !near && highlighted;
                if (nearToolAndNotMarkedActive || notNearToolAndMarkedActive) {
                    annotation.highlighted = !highlighted;
                    imageNeedsUpdate = true;
                }
            }
            return imageNeedsUpdate;
        };
        this.filterInteractableAnnotationsForElement = (element, annotations) => {
            if (!annotations || !annotations.length) {
                return [];
            }
            const enabledElement = getEnabledElement(element);
            let orientation = null;
            if (enabledElement.viewport && enabledElement.viewport.getCamera) {
                orientation = this._getOrientationFromNormal(enabledElement.viewport.getCamera().viewPlaneNormal);
            }
            const filtered = annotations.filter((annotation) => {
                if (annotation.isVirtual) {
                    return true;
                }
                if (annotation.data.orientation &&
                    orientation &&
                    annotation.data.orientation === orientation) {
                    return true;
                }
                return false;
            });
            return filtered;
        };
        this.renderAnnotation = (enabledElement, svgDrawingHelper) => {
            function lineIntersection2D(p1, p2, q1, q2) {
                const s1_x = p2[0] - p1[0];
                const s1_y = p2[1] - p1[1];
                const s2_x = q2[0] - q1[0];
                const s2_y = q2[1] - q1[1];
                const denom = -s2_x * s1_y + s1_x * s2_y;
                if (Math.abs(denom) < 1e-8) {
                    return null;
                }
                const s = (-s1_y * (p1[0] - q1[0]) + s1_x * (p1[1] - q1[1])) / denom;
                const t = (s2_x * (p1[1] - q1[1]) - s2_y * (p1[0] - q1[0])) / denom;
                if (s >= 0 && s <= 1 && t >= 0 && t <= 1) {
                    return [p1[0] + t * s1_x, p1[1] + t * s1_y];
                }
                return null;
            }
            const viewportsInfo = this._getViewportsInfo();
            if (!viewportsInfo || viewportsInfo.length === 0) {
                return false;
            }
            let renderStatus = false;
            const { viewport, renderingEngine } = enabledElement;
            const { element } = viewport;
            let annotations = this._getAnnotations(enabledElement);
            if (this._virtualAnnotations && this._virtualAnnotations.length) {
                annotations = annotations.concat(this._virtualAnnotations);
            }
            const camera = viewport.getCamera();
            const filteredToolAnnotations = this.filterInteractableAnnotationsForElement(element, annotations);
            const viewportAnnotation = filteredToolAnnotations[0];
            if (!viewportAnnotation || !viewportAnnotation.data) {
                return renderStatus;
            }
            const annotationUID = viewportAnnotation.annotationUID;
            const { clientWidth, clientHeight } = viewport.canvas;
            const canvasDiagonalLength = Math.sqrt(clientWidth * clientWidth + clientHeight * clientHeight);
            const data = viewportAnnotation.data;
            const otherViewportAnnotations = annotations;
            const volumeCroppingCenterCanvasMin = viewport.worldToCanvas(this.toolCenterMin);
            const volumeCroppingCenterCanvasMax = viewport.worldToCanvas(this.toolCenterMax);
            const referenceLines = [];
            const canvasBox = [0, 0, clientWidth, clientHeight];
            otherViewportAnnotations.forEach((annotation) => {
                const data = annotation.data;
                const isVirtual = 'isVirtual' in annotation &&
                    annotation.isVirtual === true;
                data.handles.toolCenter = this.toolCenter;
                let otherViewport, otherCamera, clientWidth, clientHeight, otherCanvasDiagonalLength, otherCanvasCenter, otherViewportCenterWorld;
                if (isVirtual) {
                    const realViewports = viewportsInfo.filter((vp) => vp.viewportId !== data.viewportId);
                    if (realViewports.length === 2) {
                        const vp1 = renderingEngine.getViewport(realViewports[0].viewportId);
                        const vp2 = renderingEngine.getViewport(realViewports[1].viewportId);
                        const normal1 = vp1.getCamera().viewPlaneNormal;
                        const normal2 = vp2.getCamera().viewPlaneNormal;
                        const virtualNormal = vec3.create();
                        vec3.cross(virtualNormal, normal1, normal2);
                        vec3.normalize(virtualNormal, virtualNormal);
                        otherCamera = {
                            viewPlaneNormal: virtualNormal,
                            position: data.handles.toolCenter,
                            focalPoint: data.handles.toolCenter,
                            viewUp: [0, 1, 0],
                        };
                        clientWidth = viewport.canvas.clientWidth;
                        clientHeight = viewport.canvas.clientHeight;
                        otherCanvasDiagonalLength = Math.sqrt(clientWidth * clientWidth + clientHeight * clientHeight);
                        otherCanvasCenter = [clientWidth * 0.5, clientHeight * 0.5];
                        otherViewportCenterWorld = data.handles.toolCenter;
                        otherViewport = {
                            id: data.viewportId,
                            canvas: viewport.canvas,
                            canvasToWorld: () => data.handles.toolCenter,
                        };
                    }
                    else {
                        const virtualNormal = annotation
                            .virtualNormal ?? [0, 0, 1];
                        otherCamera = {
                            viewPlaneNormal: virtualNormal,
                            position: data.handles.toolCenter,
                            focalPoint: data.handles.toolCenter,
                            viewUp: [0, 1, 0],
                        };
                        clientWidth = viewport.canvas.clientWidth;
                        clientHeight = viewport.canvas.clientHeight;
                        otherCanvasDiagonalLength = Math.sqrt(clientWidth * clientWidth + clientHeight * clientHeight);
                        otherCanvasCenter = [clientWidth * 0.5, clientHeight * 0.5];
                        otherViewportCenterWorld = data.handles.toolCenter;
                        otherViewport = {
                            id: data.viewportId,
                            canvas: viewport.canvas,
                            canvasToWorld: () => data.handles.toolCenter,
                        };
                    }
                }
                else {
                    otherViewport = renderingEngine.getViewport(data.viewportId);
                    otherCamera = otherViewport.getCamera();
                    clientWidth = otherViewport.canvas.clientWidth;
                    clientHeight = otherViewport.canvas.clientHeight;
                    otherCanvasDiagonalLength = Math.sqrt(clientWidth * clientWidth + clientHeight * clientHeight);
                    otherCanvasCenter = [clientWidth * 0.5, clientHeight * 0.5];
                    otherViewportCenterWorld =
                        otherViewport.canvasToWorld(otherCanvasCenter);
                }
                const otherViewportControllable = this._getReferenceLineControllable(otherViewport.id);
                const direction = [0, 0, 0];
                vtkMath.cross(camera.viewPlaneNormal, otherCamera.viewPlaneNormal, direction);
                vtkMath.normalize(direction);
                vtkMath.multiplyScalar(direction, otherCanvasDiagonalLength);
                const pointWorld0 = [0, 0, 0];
                vtkMath.add(otherViewportCenterWorld, direction, pointWorld0);
                const pointWorld1 = [0, 0, 0];
                vtkMath.subtract(otherViewportCenterWorld, direction, pointWorld1);
                const pointCanvas0 = viewport.worldToCanvas(pointWorld0);
                const otherViewportCenterCanvas = viewport.worldToCanvas([
                    otherViewportCenterWorld[0] ?? 0,
                    otherViewportCenterWorld[1] ?? 0,
                    otherViewportCenterWorld[2] ?? 0,
                ]);
                const canvasUnitVectorFromCenter = vec2.create();
                vec2.subtract(canvasUnitVectorFromCenter, pointCanvas0, otherViewportCenterCanvas);
                vec2.normalize(canvasUnitVectorFromCenter, canvasUnitVectorFromCenter);
                const canvasVectorFromCenterLong = vec2.create();
                vec2.scale(canvasVectorFromCenterLong, canvasUnitVectorFromCenter, canvasDiagonalLength * 100);
                const refLinesCenterMin = otherViewportControllable
                    ? vec2.clone(volumeCroppingCenterCanvasMin)
                    : vec2.clone(otherViewportCenterCanvas);
                const refLinePointMinOne = vec2.create();
                const refLinePointMinTwo = vec2.create();
                vec2.add(refLinePointMinOne, refLinesCenterMin, canvasVectorFromCenterLong);
                vec2.subtract(refLinePointMinTwo, refLinesCenterMin, canvasVectorFromCenterLong);
                liangBarksyClip(refLinePointMinOne, refLinePointMinTwo, canvasBox);
                referenceLines.push([
                    otherViewport,
                    refLinePointMinOne,
                    refLinePointMinTwo,
                    'min',
                ]);
                const refLinesCenterMax = otherViewportControllable
                    ? vec2.clone(volumeCroppingCenterCanvasMax)
                    : vec2.clone(otherViewportCenterCanvas);
                const refLinePointMaxOne = vec2.create();
                const refLinePointMaxTwo = vec2.create();
                vec2.add(refLinePointMaxOne, refLinesCenterMax, canvasVectorFromCenterLong);
                vec2.subtract(refLinePointMaxTwo, refLinesCenterMax, canvasVectorFromCenterLong);
                liangBarksyClip(refLinePointMaxOne, refLinePointMaxTwo, canvasBox);
                referenceLines.push([
                    otherViewport,
                    refLinePointMaxOne,
                    refLinePointMaxTwo,
                    'max',
                ]);
            });
            data.referenceLines = referenceLines;
            const viewportColor = this._getReferenceLineColor(viewport.id);
            const color = viewportColor !== undefined ? viewportColor : 'rgb(200, 200, 200)';
            referenceLines.forEach((line, lineIndex) => {
                const intersections = [];
                for (let j = 0; j < referenceLines.length; ++j) {
                    if (j === lineIndex) {
                        continue;
                    }
                    const otherLine = referenceLines[j];
                    const intersection = lineIntersection2D(line[1], line[2], otherLine[1], otherLine[2]);
                    if (intersection) {
                        intersections.push({
                            with: otherLine[3],
                            point: intersection,
                        });
                    }
                }
                const otherViewport = line[0];
                let orientation = null;
                if (otherViewport && otherViewport.id) {
                    const annotationForViewport = annotations.find((a) => a.data.viewportId === otherViewport.id);
                    if (annotationForViewport && annotationForViewport.data.orientation) {
                        orientation = String(annotationForViewport.data.orientation).toUpperCase();
                    }
                    else {
                        const idUpper = otherViewport.id.toUpperCase();
                        if (idUpper.includes('AXIAL')) {
                            orientation = 'AXIAL';
                        }
                        else if (idUpper.includes('CORONAL')) {
                            orientation = 'CORONAL';
                        }
                        else if (idUpper.includes('SAGITTAL')) {
                            orientation = 'SAGITTAL';
                        }
                    }
                }
                const lineColors = this.configuration.lineColors || {};
                const colorArr = lineColors[orientation] ||
                    lineColors.unknown || [1.0, 0.0, 0.0];
                const color = Array.isArray(colorArr)
                    ? `rgb(${colorArr.map((v) => Math.round(v * 255)).join(',')})`
                    : colorArr;
                const viewportControllable = this._getReferenceLineControllable(otherViewport.id);
                const selectedViewportId = data.activeViewportIds.find((id) => id === otherViewport.id);
                let lineWidth = this.configuration.lineWidth ?? 1.5;
                const lineActive = data.handles.activeOperation !== null &&
                    data.handles.activeOperation === OPERATION.DRAG &&
                    selectedViewportId;
                if (lineActive) {
                    lineWidth = this.configuration.activeLineWidth ?? 2.5;
                }
                const lineUID = `${lineIndex}`;
                if (viewportControllable) {
                    if (intersections.length === 2) {
                        drawLineSvg(svgDrawingHelper, annotationUID, lineUID, intersections[0].point, intersections[1].point, {
                            color,
                            lineWidth,
                        });
                    }
                    if (this.configuration.extendReferenceLines &&
                        intersections.length === 2) {
                        if (this.configuration.extendReferenceLines &&
                            intersections.length === 2) {
                            const sortedIntersections = intersections
                                .map((intersection) => ({
                                ...intersection,
                                distance: vec2.distance(line[1], intersection.point),
                            }))
                                .sort((a, b) => a.distance - b.distance);
                            drawLineSvg(svgDrawingHelper, annotationUID, lineUID + '_dashed_before', line[1], sortedIntersections[0].point, { color, lineWidth, lineDash: [4, 4] });
                            drawLineSvg(svgDrawingHelper, annotationUID, lineUID + '_dashed_after', sortedIntersections[1].point, line[2], { color, lineWidth, lineDash: [4, 4] });
                        }
                    }
                }
            });
            renderStatus = true;
            if (this.configuration.viewportIndicators) {
                const { viewportIndicatorsConfig } = this.configuration;
                const xOffset = viewportIndicatorsConfig?.xOffset || 0.95;
                const yOffset = viewportIndicatorsConfig?.yOffset || 0.05;
                const referenceColorCoordinates = [
                    clientWidth * xOffset,
                    clientHeight * yOffset,
                ];
                const circleRadius = viewportIndicatorsConfig?.circleRadius || canvasDiagonalLength * 0.01;
                const circleUID = '0';
                drawCircleSvg(svgDrawingHelper, annotationUID, circleUID, referenceColorCoordinates, circleRadius, { color, fill: color });
            }
            return renderStatus;
        };
        this._getAnnotations = (enabledElement) => {
            const { viewport } = enabledElement;
            const annotations = getAnnotations(this.getToolName(), viewport.element) || [];
            const viewportIds = this._getViewportsInfo().map(({ viewportId }) => viewportId);
            const toolGroupAnnotations = annotations.filter((annotation) => {
                const { data } = annotation;
                return viewportIds.includes(data.viewportId);
            });
            return toolGroupAnnotations;
        };
        this._onSphereMoved = (evt) => {
            if (evt.detail.originalClippingPlanes) {
                this._syncWithVolumeCroppingTool(evt.detail.originalClippingPlanes);
            }
            else {
                if (evt.detail.seriesInstanceUID !== this.seriesInstanceUID) {
                    return;
                }
                const { draggingSphereIndex, toolCenter } = evt.detail;
                const newMin = [...this.toolCenterMin];
                const newMax = [...this.toolCenterMax];
                if (draggingSphereIndex >= 0 && draggingSphereIndex <= 5) {
                    const axis = Math.floor(draggingSphereIndex / 2);
                    const isMin = draggingSphereIndex % 2 === 0;
                    (isMin ? newMin : newMax)[axis] = toolCenter[axis];
                    this.setToolCenter(newMin, 'min');
                    this.setToolCenter(newMax, 'max');
                    return;
                }
                if (draggingSphereIndex >= 6 && draggingSphereIndex <= 13) {
                    const idx = draggingSphereIndex;
                    if (idx < 10) {
                        newMin[0] = toolCenter[0];
                    }
                    else {
                        newMax[0] = toolCenter[0];
                    }
                    if ([6, 7, 10, 11].includes(idx)) {
                        newMin[1] = toolCenter[1];
                    }
                    else {
                        newMax[1] = toolCenter[1];
                    }
                    if (idx % 2 === 0) {
                        newMin[2] = toolCenter[2];
                    }
                    else {
                        newMax[2] = toolCenter[2];
                    }
                    this.setToolCenter(newMin, 'min');
                    this.setToolCenter(newMax, 'max');
                }
            }
        };
        this._onNewVolume = () => {
            const viewportsInfo = this._getViewportsInfo();
            if (viewportsInfo && viewportsInfo.length > 0) {
                const { viewportId, renderingEngineId } = viewportsInfo[0];
                const renderingEngine = getRenderingEngine(renderingEngineId);
                const viewport = renderingEngine.getViewport(viewportId);
                const volumeActors = viewport.getActors();
                if (volumeActors.length > 0) {
                    const imageData = volumeActors[0].actor.getMapper().getInputData();
                    if (imageData) {
                        this.seriesInstanceUID = imageData.seriesInstanceUID;
                        this._updateToolCentersFromViewport(viewport);
                        const annotations = getAnnotations(this.getToolName(), viewportId) || [];
                        annotations.forEach((annotation) => {
                            if (annotation.data && annotation.data.handles) {
                                annotation.data.handles.toolCenter = [...this.toolCenter];
                            }
                        });
                    }
                }
            }
            this._computeToolCenter(viewportsInfo);
            triggerEvent(eventTarget, Events.VOLUMECROPPINGCONTROL_TOOL_CHANGED, {
                toolGroupId: this.toolGroupId,
                viewportsInfo: viewportsInfo,
                seriesInstanceUID: this.seriesInstanceUID,
            });
        };
        this._getAnnotationsForViewportsWithDifferentCameras = (enabledElement, annotations) => {
            const { viewportId, renderingEngine, viewport } = enabledElement;
            const otherViewportAnnotations = annotations.filter((annotation) => annotation.data.viewportId !== viewportId);
            if (!otherViewportAnnotations || !otherViewportAnnotations.length) {
                return [];
            }
            const camera = viewport.getCamera();
            const { viewPlaneNormal, position } = camera;
            const viewportsWithDifferentCameras = otherViewportAnnotations.filter((annotation) => {
                const { viewportId } = annotation.data;
                const targetViewport = renderingEngine.getViewport(viewportId);
                const cameraOfTarget = targetViewport.getCamera();
                return !(csUtils.isEqual(cameraOfTarget.viewPlaneNormal, viewPlaneNormal, 1e-2) && csUtils.isEqual(cameraOfTarget.position, position, 1));
            });
            return viewportsWithDifferentCameras;
        };
        this._filterViewportWithSameOrientation = (enabledElement, referenceAnnotation, annotations) => {
            const { renderingEngine } = enabledElement;
            const { data } = referenceAnnotation;
            const viewport = renderingEngine.getViewport(data.viewportId);
            const linkedViewportAnnotations = annotations.filter((annotation) => {
                const { data } = annotation;
                const otherViewport = renderingEngine.getViewport(data.viewportId);
                const otherViewportControllable = this._getReferenceLineControllable(otherViewport.id);
                return otherViewportControllable === true;
            });
            if (!linkedViewportAnnotations || !linkedViewportAnnotations.length) {
                return [];
            }
            const camera = viewport.getCamera();
            const viewPlaneNormal = camera.viewPlaneNormal;
            vtkMath.normalize(viewPlaneNormal);
            const otherViewportsAnnotationsWithSameCameraDirection = linkedViewportAnnotations.filter((annotation) => {
                const { viewportId } = annotation.data;
                const otherViewport = renderingEngine.getViewport(viewportId);
                const otherCamera = otherViewport.getCamera();
                const otherViewPlaneNormal = otherCamera.viewPlaneNormal;
                vtkMath.normalize(otherViewPlaneNormal);
                return (csUtils.isEqual(viewPlaneNormal, otherViewPlaneNormal, 1e-2) &&
                    csUtils.isEqual(camera.viewUp, otherCamera.viewUp, 1e-2));
            });
            return otherViewportsAnnotationsWithSameCameraDirection;
        };
        this._activateModify = (element) => {
            state.isInteractingWithTool = !this.configuration.mobile?.enabled;
            element.addEventListener(Events.MOUSE_UP, this._endCallback);
            element.addEventListener(Events.MOUSE_DRAG, this._dragCallback);
            element.addEventListener(Events.MOUSE_CLICK, this._endCallback);
            element.addEventListener(Events.TOUCH_END, this._endCallback);
            element.addEventListener(Events.TOUCH_DRAG, this._dragCallback);
            element.addEventListener(Events.TOUCH_TAP, this._endCallback);
        };
        this._deactivateModify = (element) => {
            state.isInteractingWithTool = false;
            element.removeEventListener(Events.MOUSE_UP, this._endCallback);
            element.removeEventListener(Events.MOUSE_DRAG, this._dragCallback);
            element.removeEventListener(Events.MOUSE_CLICK, this._endCallback);
            element.removeEventListener(Events.TOUCH_END, this._endCallback);
            element.removeEventListener(Events.TOUCH_DRAG, this._dragCallback);
            element.removeEventListener(Events.TOUCH_TAP, this._endCallback);
        };
        this._endCallback = (evt) => {
            const eventDetail = evt.detail;
            const { element } = eventDetail;
            this.editData.annotation.data.handles.activeOperation = null;
            this.editData.annotation.data.activeViewportIds = [];
            this._deactivateModify(element);
            resetElementCursor(element);
            this.editData = null;
            const requireSameOrientation = false;
            const viewportIdsToRender = getViewportIdsWithToolToRender(element, this.getToolName(), requireSameOrientation);
            triggerAnnotationRenderForViewportIds(viewportIdsToRender);
        };
        this._dragCallback = (evt) => {
            const eventDetail = evt.detail;
            const delta = eventDetail.deltaPoints.world;
            if (Math.abs(delta[0]) < 1e-3 &&
                Math.abs(delta[1]) < 1e-3 &&
                Math.abs(delta[2]) < 1e-3) {
                return;
            }
            const { element } = eventDetail;
            const enabledElement = getEnabledElement(element);
            const { viewport } = enabledElement;
            if (viewport.type === Enums.ViewportType.VOLUME_3D) {
                return;
            }
            const annotations = this._getAnnotations(enabledElement);
            const filteredToolAnnotations = this.filterInteractableAnnotationsForElement(element, annotations);
            const viewportAnnotation = filteredToolAnnotations[0];
            if (!viewportAnnotation) {
                return;
            }
            const { handles } = viewportAnnotation.data;
            if (handles.activeOperation === OPERATION.DRAG) {
                if (handles.activeType === 'min') {
                    this.toolCenterMin[0] += delta[0];
                    this.toolCenterMin[1] += delta[1];
                    this.toolCenterMin[2] += delta[2];
                }
                else if (handles.activeType === 'max') {
                    this.toolCenterMax[0] += delta[0];
                    this.toolCenterMax[1] += delta[1];
                    this.toolCenterMax[2] += delta[2];
                }
                else {
                    this.toolCenter[0] += delta[0];
                    this.toolCenter[1] += delta[1];
                    this.toolCenter[2] += delta[2];
                }
                const viewportsInfo = this._getViewportsInfo();
                triggerAnnotationRenderForViewportIds(viewportsInfo.map(({ viewportId }) => viewportId));
                triggerEvent(eventTarget, Events.VOLUMECROPPINGCONTROL_TOOL_CHANGED, {
                    toolGroupId: this.toolGroupId,
                    toolCenter: this.toolCenter,
                    toolCenterMin: this.toolCenterMin,
                    toolCenterMax: this.toolCenterMax,
                    handleType: handles.activeType,
                    viewportOrientation: [],
                    seriesInstanceUID: this.seriesInstanceUID,
                });
            }
        };
        this._getReferenceLineColor =
            toolProps.configuration?.getReferenceLineColor ||
                defaultReferenceLineColor;
        this._getReferenceLineControllable =
            toolProps.configuration?.getReferenceLineControllable ||
                defaultReferenceLineControllable;
        const viewportsInfo = getToolGroup(this.toolGroupId)?.viewportsInfo;
        eventTarget.addEventListener(Events.VOLUMECROPPING_TOOL_CHANGED, this._onSphereMoved);
        if (viewportsInfo && viewportsInfo.length > 0) {
            const { viewportId, renderingEngineId } = viewportsInfo[0];
            const enabledElement = getEnabledElementByIds(viewportId, renderingEngineId);
            const renderingEngine = getRenderingEngine(renderingEngineId);
            const viewport = renderingEngine.getViewport(viewportId);
            const volumeActors = viewport.getActors();
            if (!volumeActors || !volumeActors.length) {
                console.warn(`VolumeCroppingControlTool: No volume actors found in viewport ${viewportId}.`);
                return;
            }
            const imageData = volumeActors[0].actor.getMapper().getInputData();
            if (imageData) {
                const dimensions = imageData.getDimensions();
                const spacing = imageData.getSpacing();
                const origin = imageData.getOrigin();
                this.seriesInstanceUID = imageData.seriesInstanceUID || 'unknown';
                const cropFactor = this.configuration.initialCropFactor ?? 0.2;
                this.toolCenter = [
                    origin[0] + cropFactor * (dimensions[0] - 1) * spacing[0],
                    origin[1] + cropFactor * (dimensions[1] - 1) * spacing[1],
                    origin[2] + cropFactor * (dimensions[2] - 1) * spacing[2],
                ];
                const maxCropFactor = 1 - cropFactor;
                this.toolCenterMin = [
                    origin[0] + cropFactor * (dimensions[0] - 1) * spacing[0],
                    origin[1] + cropFactor * (dimensions[1] - 1) * spacing[1],
                    origin[2] + cropFactor * (dimensions[2] - 1) * spacing[2],
                ];
                this.toolCenterMax = [
                    origin[0] + maxCropFactor * (dimensions[0] - 1) * spacing[0],
                    origin[1] + maxCropFactor * (dimensions[1] - 1) * spacing[1],
                    origin[2] + maxCropFactor * (dimensions[2] - 1) * spacing[2],
                ];
            }
        }
    }
    _updateToolCentersFromViewport(viewport) {
        const volumeActors = viewport.getActors();
        if (!volumeActors || !volumeActors.length) {
            return;
        }
        const imageData = volumeActors[0].actor.getMapper().getInputData();
        if (!imageData) {
            return;
        }
        this.seriesInstanceUID = imageData.seriesInstanceUID || 'unknown';
        const dimensions = imageData.getDimensions();
        const spacing = imageData.getSpacing();
        const origin = imageData.getOrigin();
        const cropFactor = this.configuration.initialCropFactor ?? 0.2;
        const cropStart = cropFactor / 2;
        const cropEnd = 1 - cropFactor / 2;
        this.toolCenter = [
            origin[0] +
                ((cropStart + cropEnd) / 2) * (dimensions[0] - 1) * spacing[0],
            origin[1] +
                ((cropStart + cropEnd) / 2) * (dimensions[1] - 1) * spacing[1],
            origin[2] +
                ((cropStart + cropEnd) / 2) * (dimensions[2] - 1) * spacing[2],
        ];
        this.toolCenterMin = [
            origin[0] + cropStart * (dimensions[0] - 1) * spacing[0],
            origin[1] + cropStart * (dimensions[1] - 1) * spacing[1],
            origin[2] + cropStart * (dimensions[2] - 1) * spacing[2],
        ];
        this.toolCenterMax = [
            origin[0] + cropEnd * (dimensions[0] - 1) * spacing[0],
            origin[1] + cropEnd * (dimensions[1] - 1) * spacing[1],
            origin[2] + cropEnd * (dimensions[2] - 1) * spacing[2],
        ];
    }
    onSetToolInactive() {
        console.debug(`VolumeCroppingControlTool: onSetToolInactive called for tool ${this.getToolName()}`);
    }
    onSetToolActive() {
        const viewportsInfo = this._getViewportsInfo();
        let anyAnnotationExists = false;
        for (const vpInfo of viewportsInfo) {
            const enabledElement = getEnabledElementByIds(vpInfo.viewportId, vpInfo.renderingEngineId);
            const annotations = this._getAnnotations(enabledElement);
            if (annotations && annotations.length > 0) {
                anyAnnotationExists = true;
                break;
            }
        }
        if (!anyAnnotationExists) {
            this._unsubscribeToViewportNewVolumeSet(viewportsInfo);
            this._subscribeToViewportNewVolumeSet(viewportsInfo);
            this._computeToolCenter(viewportsInfo);
            triggerEvent(eventTarget, Events.VOLUMECROPPINGCONTROL_TOOL_CHANGED, {
                toolGroupId: this.toolGroupId,
                viewportsInfo: viewportsInfo,
                seriesInstanceUID: this.seriesInstanceUID,
            });
        }
        else {
            for (const vpInfo of viewportsInfo) {
                const enabledElement = getEnabledElementByIds(vpInfo.viewportId, vpInfo.renderingEngineId);
                if (!enabledElement) {
                    continue;
                }
                const annotations = this._getAnnotations(enabledElement);
                if (annotations && annotations.length > 0) {
                    annotations.forEach((annotation) => {
                        removeAnnotation(annotation.annotationUID);
                    });
                }
                enabledElement.viewport.render();
            }
        }
    }
    onSetToolEnabled() {
        console.debug(`VolumeCroppingControlTool: onSetToolEnabled called for tool ${this.getToolName()}`);
        const viewportsInfo = this._getViewportsInfo();
    }
    onSetToolDisabled() {
        console.debug(`VolumeCroppingControlTool: onSetToolDisabled called for tool ${this.getToolName()}`);
        const viewportsInfo = this._getViewportsInfo();
        this._unsubscribeToViewportNewVolumeSet(viewportsInfo);
        viewportsInfo.forEach(({ renderingEngineId, viewportId }) => {
            const enabledElement = getEnabledElementByIds(viewportId, renderingEngineId);
            if (!enabledElement) {
                return;
            }
            const annotations = this._getAnnotations(enabledElement);
            if (annotations?.length) {
                annotations.forEach((annotation) => {
                    removeAnnotation(annotation.annotationUID);
                });
            }
        });
    }
    _getOrientationFromNormal(normal) {
        if (!normal) {
            return null;
        }
        const canonical = {
            AXIAL: [0, 0, 1],
            CORONAL: [0, 1, 0],
            SAGITTAL: [1, 0, 0],
        };
        const tol = 1e-2;
        for (const [key, value] of Object.entries(canonical)) {
            if (Math.abs(normal[0] - value[0]) < tol &&
                Math.abs(normal[1] - value[1]) < tol &&
                Math.abs(normal[2] - value[2]) < tol) {
                return key;
            }
            if (Math.abs(normal[0] + value[0]) < tol &&
                Math.abs(normal[1] + value[1]) < tol &&
                Math.abs(normal[2] + value[2]) < tol) {
                return key;
            }
        }
        return null;
    }
    _syncWithVolumeCroppingTool(originalClippingPlanes) {
        const planes = originalClippingPlanes;
        if (planes.length >= 6) {
            this.toolCenterMin = [
                planes[0].origin[0],
                planes[2].origin[1],
                planes[4].origin[2],
            ];
            this.toolCenterMax = [
                planes[1].origin[0],
                planes[3].origin[1],
                planes[5].origin[2],
            ];
            this.toolCenter = [
                (this.toolCenterMin[0] + this.toolCenterMax[0]) / 2,
                (this.toolCenterMin[1] + this.toolCenterMax[1]) / 2,
                (this.toolCenterMin[2] + this.toolCenterMax[2]) / 2,
            ];
            const viewportsInfo = this._getViewportsInfo();
            viewportsInfo.forEach(({ viewportId, renderingEngineId }) => {
                const enabledElement = getEnabledElementByIds(viewportId, renderingEngineId);
                if (enabledElement) {
                    const annotations = this._getAnnotations(enabledElement);
                    annotations.forEach((annotation) => {
                        if (annotation.data &&
                            annotation.data.handles &&
                            annotation.data.orientation) {
                            const orientation = annotation.data.orientation;
                            if (orientation === 'AXIAL') {
                                annotation.data.handles.toolCenterMin = [
                                    planes[0].origin[0],
                                    planes[2].origin[1],
                                    annotation.data.handles.toolCenterMin[2],
                                ];
                                annotation.data.handles.toolCenterMax = [
                                    planes[1].origin[0],
                                    planes[3].origin[1],
                                    annotation.data.handles.toolCenterMax[2],
                                ];
                            }
                            else if (orientation === 'CORONAL') {
                                annotation.data.handles.toolCenterMin = [
                                    planes[0].origin[0],
                                    annotation.data.handles.toolCenterMin[1],
                                    planes[4].origin[2],
                                ];
                                annotation.data.handles.toolCenterMax = [
                                    planes[1].origin[0],
                                    annotation.data.handles.toolCenterMax[1],
                                    planes[5].origin[2],
                                ];
                            }
                            else if (orientation === 'SAGITTAL') {
                                annotation.data.handles.toolCenterMin = [
                                    annotation.data.handles.toolCenterMin[0],
                                    planes[2].origin[1],
                                    planes[4].origin[2],
                                ];
                                annotation.data.handles.toolCenterMax = [
                                    annotation.data.handles.toolCenterMax[0],
                                    planes[3].origin[1],
                                    planes[5].origin[2],
                                ];
                            }
                            annotation.data.handles.toolCenter = [
                                (annotation.data.handles.toolCenterMin[0] +
                                    annotation.data.handles.toolCenterMax[0]) /
                                    2,
                                (annotation.data.handles.toolCenterMin[1] +
                                    annotation.data.handles.toolCenterMax[1]) /
                                    2,
                                (annotation.data.handles.toolCenterMin[2] +
                                    annotation.data.handles.toolCenterMax[2]) /
                                    2,
                            ];
                        }
                    });
                }
            });
            if (this._virtualAnnotations && this._virtualAnnotations.length > 0) {
                this._virtualAnnotations.forEach((annotation) => {
                    if (annotation.data &&
                        annotation.data.handles &&
                        annotation.data.orientation) {
                        const orientation = annotation.data.orientation.toUpperCase();
                        if (orientation === 'AXIAL') {
                            annotation.data.handles.toolCenterMin = [
                                planes[0].origin[0],
                                planes[2].origin[1],
                                annotation.data.handles.toolCenterMin[2],
                            ];
                            annotation.data.handles.toolCenterMax = [
                                planes[1].origin[0],
                                planes[3].origin[1],
                                annotation.data.handles.toolCenterMax[2],
                            ];
                        }
                        else if (orientation === 'CORONAL') {
                            annotation.data.handles.toolCenterMin = [
                                planes[0].origin[0],
                                annotation.data.handles.toolCenterMin[1],
                                planes[4].origin[2],
                            ];
                            annotation.data.handles.toolCenterMax = [
                                planes[1].origin[0],
                                annotation.data.handles.toolCenterMax[1],
                                planes[5].origin[2],
                            ];
                        }
                        else if (orientation === 'SAGITTAL') {
                            annotation.data.handles.toolCenterMin = [
                                annotation.data.handles.toolCenterMin[0],
                                planes[2].origin[1],
                                planes[4].origin[2],
                            ];
                            annotation.data.handles.toolCenterMax = [
                                annotation.data.handles.toolCenterMax[0],
                                planes[3].origin[1],
                                planes[5].origin[2],
                            ];
                        }
                        annotation.data.handles.toolCenter = [
                            (annotation.data.handles.toolCenterMin[0] +
                                annotation.data.handles.toolCenterMax[0]) /
                                2,
                            (annotation.data.handles.toolCenterMin[1] +
                                annotation.data.handles.toolCenterMax[1]) /
                                2,
                            (annotation.data.handles.toolCenterMin[2] +
                                annotation.data.handles.toolCenterMax[2]) /
                                2,
                        ];
                    }
                });
            }
            triggerAnnotationRenderForViewportIds(viewportsInfo.map(({ viewportId }) => viewportId));
        }
    }
    setToolCenter(toolCenter, handleType) {
        if (handleType === 'min') {
            this.toolCenterMin = [...toolCenter];
        }
        else if (handleType === 'max') {
            this.toolCenterMax = [...toolCenter];
        }
        const viewportsInfo = this._getViewportsInfo();
        triggerAnnotationRenderForViewportIds(viewportsInfo.map(({ viewportId }) => viewportId));
    }
    addNewAnnotation(evt) {
        const eventDetail = evt.detail;
        const { element } = eventDetail;
        const enabledElement = getEnabledElement(element);
        const { viewport } = enabledElement;
        const annotations = this._getAnnotations(enabledElement);
        const filteredAnnotations = this.filterInteractableAnnotationsForElement(viewport.element, annotations);
        if (!filteredAnnotations ||
            filteredAnnotations.length === 0 ||
            !filteredAnnotations[0]) {
            return null;
        }
        const { data } = filteredAnnotations[0];
        const viewportIdArray = [];
        const referenceLines = data.referenceLines || [];
        for (let i = 0; i < referenceLines.length; ++i) {
            const otherViewport = referenceLines[i][0];
            const viewportControllable = this._getReferenceLineControllable(otherViewport.id);
            if (!viewportControllable) {
                continue;
            }
            viewportIdArray.push(otherViewport.id);
            i++;
        }
        data.activeViewportIds = [...viewportIdArray];
        data.handles.activeOperation = OPERATION.DRAG;
        evt.preventDefault();
        hideElementCursor(element);
        this._activateModify(element);
        return filteredAnnotations[0];
    }
    handleSelectedCallback(evt, annotation, handle, interactionType) {
        this.toolSelectedCallback(evt, annotation, interactionType);
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
    _applyDeltaShiftToSelectedViewportCameras(renderingEngine, viewportsAnnotationsToUpdate, delta) {
        viewportsAnnotationsToUpdate.forEach((annotation) => {
            this._applyDeltaShiftToViewportCamera(renderingEngine, annotation, delta);
        });
    }
    _applyDeltaShiftToViewportCamera(renderingEngine, annotation, delta) {
        const { data } = annotation;
        const viewport = renderingEngine.getViewport(data.viewportId);
        const camera = viewport.getCamera();
        const normal = camera.viewPlaneNormal;
        const dotProd = vtkMath.dot(delta, normal);
        const projectedDelta = [...normal];
        vtkMath.multiplyScalar(projectedDelta, dotProd);
        if (Math.abs(projectedDelta[0]) > 1e-3 ||
            Math.abs(projectedDelta[1]) > 1e-3 ||
            Math.abs(projectedDelta[2]) > 1e-3) {
            const newFocalPoint = [0, 0, 0];
            const newPosition = [0, 0, 0];
            vtkMath.add(camera.focalPoint, projectedDelta, newFocalPoint);
            vtkMath.add(camera.position, projectedDelta, newPosition);
            viewport.setCamera({
                focalPoint: newFocalPoint,
                position: newPosition,
            });
            viewport.render();
        }
    }
    _pointNearTool(element, annotation, canvasCoords, proximity) {
        const { data } = annotation;
        const referenceLines = data.referenceLines;
        const viewportIdArray = [];
        if (referenceLines) {
            for (let i = 0; i < referenceLines.length; ++i) {
                const otherViewport = referenceLines[i][0];
                const start1 = referenceLines[i][1];
                const end1 = referenceLines[i][2];
                const type = referenceLines[i][3];
                const distance1 = lineSegment.distanceToPoint(start1, end1, [
                    canvasCoords[0],
                    canvasCoords[1],
                ]);
                if (distance1 <= proximity) {
                    viewportIdArray.push(otherViewport.id);
                    data.handles.activeOperation = 1;
                    data.handles.activeType = type;
                }
            }
        }
        data.activeViewportIds = [...viewportIdArray];
        this.editData = {
            annotation,
        };
        return data.handles.activeOperation === 1 ? true : false;
    }
}
VolumeCroppingControlTool.toolName = 'VolumeCroppingControl';
export default VolumeCroppingControlTool;
