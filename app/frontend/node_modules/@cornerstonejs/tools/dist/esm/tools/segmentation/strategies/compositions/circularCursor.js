import { vec3 } from 'gl-matrix';
import StrategyCallbacks from '../../../../enums/StrategyCallbacks';
import { drawCircle as drawCircleSvg } from '../../../../drawingSvg';
export default {
    [StrategyCallbacks.CalculateCursorGeometry]: function (enabledElement, operationData) {
        if (!operationData) {
            return;
        }
        const { configuration, activeStrategy, hoverData } = operationData;
        const { viewport } = enabledElement;
        const camera = viewport.getCamera();
        const { brushSize } = configuration;
        const viewUp = vec3.fromValues(camera.viewUp[0], camera.viewUp[1], camera.viewUp[2]);
        const viewPlaneNormal = vec3.fromValues(camera.viewPlaneNormal[0], camera.viewPlaneNormal[1], camera.viewPlaneNormal[2]);
        const viewRight = vec3.create();
        vec3.cross(viewRight, viewUp, viewPlaneNormal);
        const { canvasToWorld } = viewport;
        const { centerCanvas } = hoverData;
        const centerCursorInWorld = canvasToWorld([
            centerCanvas[0],
            centerCanvas[1],
        ]);
        const bottomCursorInWorld = vec3.create();
        const topCursorInWorld = vec3.create();
        const leftCursorInWorld = vec3.create();
        const rightCursorInWorld = vec3.create();
        for (let i = 0; i <= 2; i++) {
            bottomCursorInWorld[i] = centerCursorInWorld[i] - viewUp[i] * brushSize;
            topCursorInWorld[i] = centerCursorInWorld[i] + viewUp[i] * brushSize;
            leftCursorInWorld[i] = centerCursorInWorld[i] - viewRight[i] * brushSize;
            rightCursorInWorld[i] = centerCursorInWorld[i] + viewRight[i] * brushSize;
        }
        if (!hoverData) {
            return;
        }
        const { brushCursor } = hoverData;
        const { data } = brushCursor;
        if (data.handles === undefined) {
            data.handles = {};
        }
        data.handles.points = [
            bottomCursorInWorld,
            topCursorInWorld,
            leftCursorInWorld,
            rightCursorInWorld,
        ];
        const strategy = configuration.strategies[activeStrategy];
        if (typeof strategy?.computeInnerCircleRadius === 'function') {
            strategy.computeInnerCircleRadius({
                configuration,
                viewport,
            });
        }
        data.invalidated = false;
    },
    [StrategyCallbacks.RenderCursor]: function (enabledElement, operationData, svgDrawingHelper) {
        if (!operationData) {
            return;
        }
        const { configuration, hoverData } = operationData;
        const { viewport } = enabledElement;
        const { brushCursor } = hoverData;
        const toolMetadata = brushCursor.metadata;
        if (!toolMetadata) {
            return;
        }
        const annotationUID = toolMetadata.brushCursorUID;
        const data = brushCursor.data;
        const { points } = data.handles;
        const canvasCoordinates = points.map((p) => viewport.worldToCanvas(p));
        const bottom = canvasCoordinates[0];
        const top = canvasCoordinates[1];
        const center = [
            Math.floor((bottom[0] + top[0]) / 2),
            Math.floor((bottom[1] + top[1]) / 2),
        ];
        const radius = Math.abs(bottom[1] - Math.floor((bottom[1] + top[1]) / 2));
        const color = `rgb(${toolMetadata.segmentColor?.slice(0, 3) || [0, 0, 0]})`;
        if (!viewport.getRenderingEngine()) {
            console.warn('Rendering Engine has been destroyed');
            return;
        }
        const circleUID = '0';
        drawCircleSvg(svgDrawingHelper, annotationUID, circleUID, center, radius, {
            color,
            lineDash: this.centerSegmentIndexInfo.segmentIndex === 0 ? [1, 2] : null,
        });
        const { dynamicRadiusInCanvas } = configuration?.threshold || {
            dynamicRadiusInCanvas: 0,
        };
        if (dynamicRadiusInCanvas) {
            const circleUID1 = '1';
            drawCircleSvg(svgDrawingHelper, annotationUID, circleUID1, center, dynamicRadiusInCanvas, {
                color,
            });
        }
    },
};
