import { getEnabledElement, utilities as csUtils, getEnabledElementByViewportId, utilities, } from '@cornerstonejs/core';
import { addAnnotation, getAllAnnotations, getAnnotations, removeAnnotation, } from '../../stateManagement/annotation/annotationState';
import { isAnnotationLocked } from '../../stateManagement/annotation/annotationLocking';
import { isAnnotationVisible } from '../../stateManagement/annotation/annotationVisibility';
import { drawLine as drawLineSvg, drawHandles as drawHandlesSvg, drawLinkedTextBox as drawLinkedTextBoxSvg, } from '../../drawingSvg';
import { getViewportIdsWithToolToRender } from '../../utilities/viewportFilters';
import { getTextBoxCoordsCanvas } from '../../utilities/drawing';
import { hideElementCursor } from '../../cursors/elementCursor';
import triggerAnnotationRenderForViewportIds from '../../utilities/triggerAnnotationRenderForViewportIds';
import BidirectionalTool from '../annotation/BidirectionalTool';
import { getSegmentIndexColor } from '../../stateManagement/segmentation/config/segmentationColor';
class SegmentBidirectionalTool extends BidirectionalTool {
    static { this.toolName = 'SegmentBidirectional'; }
    constructor(toolProps = {}) {
        super(toolProps);
        this.renderAnnotation = (enabledElement, svgDrawingHelper) => {
            let renderStatus = true;
            const { viewport } = enabledElement;
            const { element } = viewport;
            const viewportId = viewport.id;
            let annotations = getAnnotations(this.getToolName(), element);
            if (!annotations?.length) {
                return renderStatus;
            }
            annotations = this.filterInteractableAnnotationsForElement(element, annotations);
            if (!annotations?.length) {
                return renderStatus;
            }
            const targetId = this.getTargetId(viewport);
            const renderingEngine = viewport.getRenderingEngine();
            const styleSpecifier = {
                toolGroupId: this.toolGroupId,
                toolName: this.getToolName(),
                viewportId: enabledElement.viewport.id,
            };
            for (let i = 0; i < annotations.length; i++) {
                const annotation = annotations[i];
                const { annotationUID, data } = annotation;
                const { points, activeHandleIndex } = data.handles;
                const canvasCoordinates = points.map((p) => viewport.worldToCanvas(p));
                styleSpecifier.annotationUID = annotationUID;
                const { segmentIndex, segmentationId } = annotation.metadata;
                const { lineWidth, lineDash, shadow } = this.getAnnotationStyle({
                    annotation,
                    styleSpecifier,
                });
                const colorArray = getSegmentIndexColor(viewportId, segmentationId, segmentIndex);
                const color = `rgb(${colorArray.slice(0, 3).join(',')})`;
                if (!data.cachedStats[targetId] ||
                    data.cachedStats[targetId].unit == null) {
                    data.cachedStats[targetId] = {
                        length: null,
                        width: null,
                        unit: null,
                    };
                    this._calculateCachedStats(annotation, renderingEngine, enabledElement);
                }
                else if (annotation.invalidated) {
                    this._throttledCalculateCachedStats(annotation, renderingEngine, enabledElement);
                }
                if (!viewport.getRenderingEngine()) {
                    console.warn('Rendering Engine has been destroyed');
                    return renderStatus;
                }
                let activeHandleCanvasCoords;
                if (!isAnnotationVisible(annotationUID)) {
                    continue;
                }
                if (!isAnnotationLocked(annotationUID) &&
                    !this.editData &&
                    activeHandleIndex !== null) {
                    activeHandleCanvasCoords = [canvasCoordinates[activeHandleIndex]];
                }
                if (activeHandleCanvasCoords) {
                    const handleGroupUID = '0';
                    drawHandlesSvg(svgDrawingHelper, annotationUID, handleGroupUID, activeHandleCanvasCoords, {
                        color,
                    });
                }
                const dataId1 = `${annotationUID}-line-1`;
                const dataId2 = `${annotationUID}-line-2`;
                const lineUID = '0';
                drawLineSvg(svgDrawingHelper, annotationUID, lineUID, canvasCoordinates[0], canvasCoordinates[1], {
                    color,
                    lineWidth,
                    lineDash,
                    shadow,
                }, dataId1);
                const secondLineUID = '1';
                drawLineSvg(svgDrawingHelper, annotationUID, secondLineUID, canvasCoordinates[2], canvasCoordinates[3], {
                    color,
                    lineWidth,
                    lineDash,
                    shadow,
                }, dataId2);
                renderStatus = true;
                const options = this.getLinkedTextBoxStyle(styleSpecifier, annotation);
                if (!options.visibility) {
                    data.handles.textBox = {
                        hasMoved: false,
                        worldPosition: [0, 0, 0],
                        worldBoundingBox: {
                            topLeft: [0, 0, 0],
                            topRight: [0, 0, 0],
                            bottomLeft: [0, 0, 0],
                            bottomRight: [0, 0, 0],
                        },
                    };
                    continue;
                }
                options.color = color;
                const textLines = this.configuration.getTextLines(data, targetId);
                if (!textLines || textLines.length === 0) {
                    continue;
                }
                let canvasTextBoxCoords;
                if (!data.handles.textBox.hasMoved) {
                    canvasTextBoxCoords = getTextBoxCoordsCanvas(canvasCoordinates);
                    data.handles.textBox.worldPosition =
                        viewport.canvasToWorld(canvasTextBoxCoords);
                }
                const textBoxPosition = viewport.worldToCanvas(data.handles.textBox.worldPosition);
                const textBoxUID = '1';
                const boundingBox = drawLinkedTextBoxSvg(svgDrawingHelper, annotationUID, textBoxUID, textLines, textBoxPosition, canvasCoordinates, {}, options);
                const { x: left, y: top, width, height } = boundingBox;
                data.handles.textBox.worldBoundingBox = {
                    topLeft: viewport.canvasToWorld([left, top]),
                    topRight: viewport.canvasToWorld([left + width, top]),
                    bottomLeft: viewport.canvasToWorld([left, top + height]),
                    bottomRight: viewport.canvasToWorld([left + width, top + height]),
                };
            }
            return renderStatus;
        };
    }
    addNewAnnotation(evt) {
        const eventDetail = evt.detail;
        const { currentPoints, element } = eventDetail;
        const worldPos = currentPoints.world;
        const enabledElement = getEnabledElement(element);
        const { viewport } = enabledElement;
        this.isDrawing = true;
        const camera = viewport.getCamera();
        const { viewPlaneNormal, viewUp } = camera;
        const referencedImageId = this.getReferencedImageId(viewport, worldPos, viewPlaneNormal, viewUp);
        const FrameOfReferenceUID = viewport.getFrameOfReferenceUID();
        const annotation = {
            highlighted: true,
            invalidated: true,
            metadata: {
                toolName: this.getToolName(),
                viewPlaneNormal: [...viewPlaneNormal],
                viewUp: [...viewUp],
                FrameOfReferenceUID,
                referencedImageId,
                ...viewport.getViewReference({ points: [worldPos] }),
            },
            data: {
                handles: {
                    points: [
                        [...worldPos],
                        [...worldPos],
                        [...worldPos],
                        [...worldPos],
                    ],
                    textBox: {
                        hasMoved: false,
                        worldPosition: [0, 0, 0],
                        worldBoundingBox: {
                            topLeft: [0, 0, 0],
                            topRight: [0, 0, 0],
                            bottomLeft: [0, 0, 0],
                            bottomRight: [0, 0, 0],
                        },
                    },
                    activeHandleIndex: null,
                },
                label: '',
                cachedStats: {},
            },
        };
        addAnnotation(annotation, element);
        const viewportIdsToRender = getViewportIdsWithToolToRender(element, this.getToolName());
        this.editData = {
            annotation,
            viewportIdsToRender,
            handleIndex: 1,
            movingTextBox: false,
            newAnnotation: true,
            hasMoved: false,
        };
        this._activateDraw(element);
        hideElementCursor(element);
        evt.preventDefault();
        triggerAnnotationRenderForViewportIds(viewportIdsToRender);
        return annotation;
    }
    static { this.hydrate = (viewportId, axis, options) => {
        const enabledElement = getEnabledElementByViewportId(viewportId);
        if (!enabledElement) {
            return;
        }
        const { viewport } = enabledElement;
        const existingAnnotations = getAllAnnotations();
        const toolAnnotations = existingAnnotations.filter((annotation) => annotation.metadata.toolName === 'SegmentBidirectional');
        const existingAnnotation = toolAnnotations.find((annotation) => {
            const { metadata } = annotation;
            if (metadata.segmentIndex === options?.segmentIndex &&
                metadata.segmentationId === options?.segmentationId) {
                return true;
            }
            return false;
        });
        if (existingAnnotation) {
            removeAnnotation(existingAnnotation.annotationUID);
        }
        const { FrameOfReferenceUID, referencedImageId, viewPlaneNormal, instance, } = this.hydrateBase(SegmentBidirectionalTool, enabledElement, axis[0], options);
        const [majorAxis, minorAxis] = axis;
        const [major0, major1] = majorAxis;
        const [minor0, minor1] = minorAxis;
        const points = [major0, major1, minor0, minor1];
        const { toolInstance, ...serializableOptions } = options || {};
        const annotation = {
            annotationUID: options?.annotationUID || utilities.uuidv4(),
            data: {
                handles: {
                    points,
                    activeHandleIndex: null,
                    textBox: {
                        hasMoved: false,
                        worldPosition: [0, 0, 0],
                        worldBoundingBox: {
                            topLeft: [0, 0, 0],
                            topRight: [0, 0, 0],
                            bottomLeft: [0, 0, 0],
                            bottomRight: [0, 0, 0],
                        },
                    },
                },
                cachedStats: {},
            },
            highlighted: false,
            autoGenerated: false,
            invalidated: false,
            isLocked: false,
            isVisible: true,
            metadata: {
                segmentIndex: options?.segmentIndex,
                segmentationId: options?.segmentationId,
                toolName: instance.getToolName(),
                viewPlaneNormal,
                FrameOfReferenceUID,
                referencedImageId,
                ...serializableOptions,
            },
        };
        addAnnotation(annotation, viewport.element);
        triggerAnnotationRenderForViewportIds([viewport.id]);
        return annotation;
    }; }
}
export default SegmentBidirectionalTool;
