import { getEnabledElement, eventTarget } from '@cornerstonejs/core';
import { vec3, vec2 } from 'gl-matrix';
import { Events, ToolModes, StrategyCallbacks } from '../../enums';
import { fillInsideSphere, thresholdInsideSphere, thresholdInsideSphereIsland, } from './strategies/fillSphere';
import { eraseInsideSphere } from './strategies/eraseSphere';
import { thresholdInsideCircle, fillInsideCircle, } from './strategies/fillCircle';
import { eraseInsideCircle } from './strategies/eraseCircle';
import { resetElementCursor, hideElementCursor, } from '../../cursors/elementCursor';
import triggerAnnotationRenderForViewportUIDs from '../../utilities/triggerAnnotationRenderForViewportIds';
import LabelmapBaseTool from './LabelmapBaseTool';
import { getStrategyData } from './strategies/utils/getStrategyData';
class BrushTool extends LabelmapBaseTool {
    constructor(toolProps = {}, defaultToolProps = {
        supportedInteractionTypes: ['Mouse', 'Touch'],
        configuration: {
            strategies: {
                FILL_INSIDE_CIRCLE: fillInsideCircle,
                ERASE_INSIDE_CIRCLE: eraseInsideCircle,
                FILL_INSIDE_SPHERE: fillInsideSphere,
                ERASE_INSIDE_SPHERE: eraseInsideSphere,
                THRESHOLD_INSIDE_CIRCLE: thresholdInsideCircle,
                THRESHOLD_INSIDE_SPHERE: thresholdInsideSphere,
                THRESHOLD_INSIDE_SPHERE_WITH_ISLAND_REMOVAL: thresholdInsideSphereIsland,
            },
            defaultStrategy: 'FILL_INSIDE_CIRCLE',
            activeStrategy: 'FILL_INSIDE_CIRCLE',
            brushSize: 25,
            useCenterSegmentIndex: false,
            preview: {
                enabled: false,
                previewColors: {
                    0: [255, 255, 255, 128],
                },
                previewTimeMs: 250,
                previewMoveDistance: 8,
                dragMoveDistance: 4,
                dragTimeMs: 500,
            },
            actions: {
                [StrategyCallbacks.AcceptPreview]: {
                    method: StrategyCallbacks.AcceptPreview,
                    bindings: [
                        {
                            key: 'Enter',
                        },
                    ],
                },
                [StrategyCallbacks.RejectPreview]: {
                    method: StrategyCallbacks.RejectPreview,
                    bindings: [
                        {
                            key: 'Escape',
                        },
                    ],
                },
                [StrategyCallbacks.Interpolate]: {
                    method: StrategyCallbacks.Interpolate,
                    bindings: [
                        {
                            key: 'i',
                        },
                    ],
                    configuration: {
                        useBallStructuringElement: true,
                        noUseDistanceTransform: true,
                        noUseExtrapolation: true,
                    },
                },
                interpolateExtrapolation: {
                    method: StrategyCallbacks.Interpolate,
                    bindings: [
                        {
                            key: 'e',
                        },
                    ],
                    configuration: {},
                },
            },
        },
    }) {
        super(toolProps, defaultToolProps);
        this._lastDragInfo = null;
        this.onSetToolPassive = (evt) => {
            this.disableCursor();
        };
        this.onSetToolEnabled = () => {
            this.disableCursor();
        };
        this.onSetToolDisabled = (evt) => {
            this.disableCursor();
        };
        this.preMouseDownCallback = (evt) => {
            const eventData = evt.detail;
            const { element, currentPoints } = eventData;
            const enabledElement = getEnabledElement(element);
            const { viewport } = enabledElement;
            this._editData = this.createEditData(element);
            this._activateDraw(element);
            hideElementCursor(element);
            evt.preventDefault();
            this._previewData.isDrag = false;
            this._previewData.timerStart = Date.now();
            const canvasPoint = vec2.clone(currentPoints.canvas);
            const worldPoint = viewport.canvasToWorld([
                canvasPoint[0],
                canvasPoint[1],
            ]);
            this._lastDragInfo = {
                canvas: canvasPoint,
                world: vec3.clone(worldPoint),
            };
            const hoverData = this._hoverData || this.createHoverData(element);
            triggerAnnotationRenderForViewportUIDs(hoverData.viewportIdsToRender);
            const operationData = this.getOperationData(element);
            if (!operationData) {
                return false;
            }
            this.applyActiveStrategyCallback(enabledElement, operationData, StrategyCallbacks.OnInteractionStart);
            return true;
        };
        this.mouseMoveCallback = (evt) => {
            if (!this.isPrimary) {
                return;
            }
            if (this.mode === ToolModes.Active) {
                this.updateCursor(evt);
                if (!this.configuration.preview.enabled) {
                    return;
                }
                const { previewTimeMs, previewMoveDistance, dragMoveDistance } = this.configuration.preview;
                const { currentPoints, element } = evt.detail;
                const { canvas } = currentPoints;
                const { startPoint, timer, timerStart, isDrag } = this._previewData;
                if (isDrag) {
                    return;
                }
                const delta = vec2.distance(canvas, startPoint);
                const time = Date.now() - timerStart;
                if (delta > previewMoveDistance ||
                    (time > previewTimeMs && delta > dragMoveDistance)) {
                    if (timer) {
                        window.clearTimeout(timer);
                        this._previewData.timer = null;
                    }
                    if (!isDrag) {
                        this.rejectPreview(element);
                    }
                }
                if (!this._previewData.timer) {
                    const timer = window.setTimeout(this.previewCallback, 250);
                    Object.assign(this._previewData, {
                        timerStart: Date.now(),
                        timer,
                        startPoint: canvas,
                        element,
                    });
                }
            }
        };
        this.previewCallback = () => {
            if (this._previewData.isDrag) {
                this._previewData.timer = null;
                return;
            }
            this._previewData.timer = null;
            const operationData = this.getOperationData(this._previewData.element);
            const enabledElement = getEnabledElement(this._previewData.element);
            if (!enabledElement) {
                return;
            }
            const { viewport } = enabledElement;
            const activeStrategy = this.configuration.activeStrategy;
            const strategyData = getStrategyData({
                operationData,
                viewport,
                strategy: activeStrategy,
            });
            if (!operationData) {
                return;
            }
            const memo = this.createMemo(operationData.segmentationId, strategyData.segmentationVoxelManager);
            this._previewData.preview = this.applyActiveStrategyCallback(getEnabledElement(this._previewData.element), {
                ...operationData,
                ...strategyData,
                memo,
            }, StrategyCallbacks.Preview);
        };
        this._dragCallback = (evt) => {
            const eventData = evt.detail;
            const { element, currentPoints } = eventData;
            const enabledElement = getEnabledElement(element);
            const { viewport } = enabledElement;
            this.updateCursor(evt);
            const { viewportIdsToRender } = this._hoverData;
            triggerAnnotationRenderForViewportUIDs(viewportIdsToRender);
            const delta = vec2.distance(currentPoints.canvas, this._previewData.startPoint);
            const { dragTimeMs, dragMoveDistance } = this.configuration.preview;
            if (!this._previewData.isDrag &&
                Date.now() - this._previewData.timerStart < dragTimeMs &&
                delta < dragMoveDistance) {
                return;
            }
            if (this._previewData.timer) {
                window.clearTimeout(this._previewData.timer);
                this._previewData.timer = null;
            }
            if (!this._lastDragInfo) {
                const startCanvas = this._previewData.startPoint;
                const startWorld = viewport.canvasToWorld([
                    startCanvas[0],
                    startCanvas[1],
                ]);
                this._lastDragInfo = {
                    canvas: vec2.clone(startCanvas),
                    world: vec3.clone(startWorld),
                };
            }
            const currentCanvas = currentPoints.canvas;
            const currentWorld = viewport.canvasToWorld([
                currentCanvas[0],
                currentCanvas[1],
            ]);
            this._hoverData = this.createHoverData(element, currentCanvas);
            this._calculateCursor(element, currentCanvas);
            const operationData = this.getOperationData(element);
            if (!operationData) {
                return;
            }
            operationData.strokePointsWorld = [
                vec3.clone(this._lastDragInfo.world),
                vec3.clone(currentWorld),
            ];
            this._previewData.preview = this.applyActiveStrategy(enabledElement, operationData);
            const currentCanvasClone = vec2.clone(currentCanvas);
            this._lastDragInfo = {
                canvas: currentCanvasClone,
                world: vec3.clone(currentWorld),
            };
            this._previewData.element = element;
            this._previewData.timerStart = Date.now() + dragTimeMs;
            this._previewData.isDrag = true;
            this._previewData.startPoint = currentCanvasClone;
        };
        this._endCallback = (evt) => {
            const eventData = evt.detail;
            const { element } = eventData;
            const enabledElement = getEnabledElement(element);
            const operationData = this.getOperationData(element);
            if (!operationData) {
                return;
            }
            if (!this._previewData.preview && !this._previewData.isDrag) {
                this.applyActiveStrategy(enabledElement, operationData);
            }
            this.doneEditMemo();
            this._deactivateDraw(element);
            resetElementCursor(element);
            this.updateCursor(evt);
            this._editData = null;
            this._lastDragInfo = null;
            this.applyActiveStrategyCallback(enabledElement, operationData, StrategyCallbacks.OnInteractionEnd);
            if (!this._previewData.isDrag) {
                this.acceptPreview(element);
            }
        };
        this._activateDraw = (element) => {
            element.addEventListener(Events.MOUSE_UP, this._endCallback);
            element.addEventListener(Events.MOUSE_DRAG, this._dragCallback);
            element.addEventListener(Events.MOUSE_CLICK, this._endCallback);
        };
        this._deactivateDraw = (element) => {
            element.removeEventListener(Events.MOUSE_UP, this._endCallback);
            element.removeEventListener(Events.MOUSE_DRAG, this._dragCallback);
            element.removeEventListener(Events.MOUSE_CLICK, this._endCallback);
        };
    }
    disableCursor() {
        this._hoverData = undefined;
        this.rejectPreview();
    }
    updateCursor(evt) {
        const eventData = evt.detail;
        const { element } = eventData;
        const { currentPoints } = eventData;
        const centerCanvas = currentPoints.canvas;
        this._hoverData = this.createHoverData(element, centerCanvas);
        this._calculateCursor(element, centerCanvas);
        if (!this._hoverData) {
            return;
        }
        BrushTool.activeCursorTool = this;
        triggerAnnotationRenderForViewportUIDs(this._hoverData.viewportIdsToRender);
    }
    _calculateCursor(element, centerCanvas) {
        const enabledElement = getEnabledElement(element);
        this.applyActiveStrategyCallback(enabledElement, this.getOperationData(element), StrategyCallbacks.CalculateCursorGeometry);
    }
    getStatistics(element, segmentIndices) {
        if (!element) {
            return;
        }
        const enabledElement = getEnabledElement(element);
        const stats = this.applyActiveStrategyCallback(enabledElement, this.getOperationData(element), StrategyCallbacks.GetStatistics, segmentIndices);
        return stats;
    }
    rejectPreview(element = this._previewData.element) {
        if (!element) {
            return;
        }
        this.doneEditMemo();
        const enabledElement = getEnabledElement(element);
        if (!enabledElement) {
            return;
        }
        this.applyActiveStrategyCallback(enabledElement, this.getOperationData(element), StrategyCallbacks.RejectPreview);
        this._previewData.preview = null;
        this._previewData.isDrag = false;
    }
    acceptPreview(element = this._previewData.element) {
        if (!element) {
            return;
        }
        super.acceptPreview(element);
    }
    interpolate(element, config) {
        if (!element) {
            return;
        }
        const enabledElement = getEnabledElement(element);
        this._previewData.preview = this.applyActiveStrategyCallback(enabledElement, this.getOperationData(element), StrategyCallbacks.Interpolate, config.configuration);
        this._previewData.isDrag = true;
    }
    invalidateBrushCursor() {
        if (this._hoverData === undefined) {
            return;
        }
        const { data } = this._hoverData.brushCursor;
        const { viewport } = this._hoverData;
        data.invalidated = true;
        const { segmentColor } = this.getActiveSegmentationData(viewport) || {};
        this._hoverData.brushCursor.metadata.segmentColor = segmentColor;
    }
    renderAnnotation(enabledElement, svgDrawingHelper) {
        if (!this._hoverData || BrushTool.activeCursorTool !== this) {
            return;
        }
        const { viewport } = enabledElement;
        const viewportIdsToRender = this._hoverData.viewportIdsToRender;
        if (!viewportIdsToRender.includes(viewport.id)) {
            return;
        }
        const brushCursor = this._hoverData.brushCursor;
        if (brushCursor.data.invalidated === true) {
            const { centerCanvas } = this._hoverData;
            const { element } = viewport;
            this._calculateCursor(element, centerCanvas);
        }
        this.applyActiveStrategyCallback(enabledElement, this.getOperationData(viewport.element), StrategyCallbacks.RenderCursor, svgDrawingHelper);
    }
}
BrushTool.toolName = 'Brush';
export default BrushTool;
