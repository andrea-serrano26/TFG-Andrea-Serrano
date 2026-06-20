import BaseRenderingEngine, { VIEWPORT_MIN_SIZE } from './BaseRenderingEngine';
import WebGLContextPool from './WebGLContextPool';
import { getConfiguration } from '../init';
import Events from '../enums/Events';
import eventTarget from '../eventTarget';
import triggerEvent from '../utilities/triggerEvent';
import ViewportType from '../enums/ViewportType';
import VolumeViewport from './VolumeViewport';
import StackViewport from './StackViewport';
import VolumeViewport3D from './VolumeViewport3D';
import viewportTypeUsesCustomRenderingPipeline from './helpers/viewportTypeUsesCustomRenderingPipeline';
import getOrCreateCanvas from './helpers/getOrCreateCanvas';
class ContextPoolRenderingEngine extends BaseRenderingEngine {
    constructor(id) {
        super(id);
        this._renderFlaggedViewports = () => {
            this._throwIfDestroyed();
            const viewports = this._getViewportsAsArray();
            const viewportsToRender = viewports.filter((vp) => this._needsRender.has(vp.id));
            if (viewportsToRender.length === 0) {
                this._animationFrameSet = false;
                this._animationFrameHandle = null;
                return;
            }
            const eventDetails = viewportsToRender.map((viewport) => {
                const eventDetail = this.renderViewportUsingCustomOrVtkPipeline(viewport);
                viewport.setRendered();
                this._needsRender.delete(viewport.id);
                return eventDetail;
            });
            this._animationFrameSet = false;
            this._animationFrameHandle = null;
            eventDetails.forEach((eventDetail) => {
                if (eventDetail?.element) {
                    triggerEvent(eventDetail.element, Events.IMAGE_RENDERED, eventDetail);
                }
            });
        };
        const { rendering } = getConfiguration();
        const { webGlContextCount } = rendering;
        if (!this.useCPURendering) {
            this.contextPool = new WebGLContextPool(webGlContextCount);
        }
    }
    enableVTKjsDrivenViewport(viewportInputEntry) {
        const viewports = this._getViewportsAsArray();
        const viewportsDrivenByVtkJs = viewports.filter((vp) => viewportTypeUsesCustomRenderingPipeline(vp.type) === false);
        const canvasesDrivenByVtkJs = viewportsDrivenByVtkJs.map((vp) => vp.canvas);
        const canvas = getOrCreateCanvas(viewportInputEntry.element);
        canvasesDrivenByVtkJs.push(canvas);
        const internalViewportEntry = { ...viewportInputEntry, canvas };
        this.addVtkjsDrivenViewport(internalViewportEntry);
    }
    addVtkjsDrivenViewport(viewportInputEntry) {
        const { element, canvas, viewportId, type, defaultOptions } = viewportInputEntry;
        element.tabIndex = -1;
        let contextIndex = 0;
        if (type === ViewportType.STACK) {
            const contexts = this.contextPool.getAllContexts();
            contextIndex = this._viewports.size % contexts.length;
        }
        this.contextPool.assignViewportToContext(viewportId, contextIndex);
        this.contextPool.updateViewportSize(viewportId, canvas.width, canvas.height);
        const contextData = this.contextPool.getContextByIndex(contextIndex);
        const { context: offscreenMultiRenderWindow, container } = contextData;
        const maxSize = this.contextPool.getMaxSizeForContext(contextIndex);
        container.width = maxSize.width;
        container.height = maxSize.height;
        offscreenMultiRenderWindow.resize();
        offscreenMultiRenderWindow.addRenderer({
            viewport: [0, 0, 1, 1],
            id: viewportId,
            background: defaultOptions.background
                ? defaultOptions.background
                : [0, 0, 0],
        });
        const viewportInput = {
            id: viewportId,
            element,
            renderingEngineId: this.id,
            type,
            canvas,
            sx: 0,
            sy: 0,
            sWidth: canvas.width,
            sHeight: canvas.height,
            defaultOptions: defaultOptions || {},
        };
        let viewport;
        if (type === ViewportType.STACK) {
            viewport = new StackViewport(viewportInput);
        }
        else if (type === ViewportType.ORTHOGRAPHIC ||
            type === ViewportType.PERSPECTIVE) {
            viewport = new VolumeViewport(viewportInput);
        }
        else if (type === ViewportType.VOLUME_3D) {
            viewport = new VolumeViewport3D(viewportInput);
        }
        else {
            throw new Error(`Viewport Type ${type} is not supported`);
        }
        this._viewports.set(viewportId, viewport);
        const eventDetail = {
            element,
            viewportId,
            renderingEngineId: this.id,
        };
        if (!viewport.suppressEvents) {
            triggerEvent(eventTarget, Events.ELEMENT_ENABLED, eventDetail);
        }
    }
    setVtkjsDrivenViewports(viewportInputEntries) {
        if (viewportInputEntries.length) {
            const vtkDrivenCanvases = viewportInputEntries.map((vp) => getOrCreateCanvas(vp.element));
            vtkDrivenCanvases.forEach((canvas) => {
                const devicePixelRatio = window.devicePixelRatio || 1;
                const rect = canvas.getBoundingClientRect();
                canvas.width = rect.width * devicePixelRatio;
                canvas.height = rect.height * devicePixelRatio;
            });
            for (let i = 0; i < viewportInputEntries.length; i++) {
                const vtkDrivenViewportInputEntry = viewportInputEntries[i];
                const canvas = vtkDrivenCanvases[i];
                const internalViewportEntry = {
                    ...vtkDrivenViewportInputEntry,
                    canvas,
                };
                this.addVtkjsDrivenViewport(internalViewportEntry);
            }
        }
    }
    _resizeVTKViewports(vtkDrivenViewports, keepCamera = true, immediate = true) {
        const canvasesDrivenByVtkJs = vtkDrivenViewports.map((vp) => {
            return getOrCreateCanvas(vp.element);
        });
        canvasesDrivenByVtkJs.forEach((canvas) => {
            const devicePixelRatio = window.devicePixelRatio || 1;
            canvas.width = canvas.clientWidth * devicePixelRatio;
            canvas.height = canvas.clientHeight * devicePixelRatio;
        });
        if (canvasesDrivenByVtkJs.length) {
            this._resize(vtkDrivenViewports);
        }
        vtkDrivenViewports.forEach((vp) => {
            const prevCamera = vp.getCamera();
            const rotation = vp.getRotation();
            const { flipHorizontal } = prevCamera;
            vp.resetCameraForResize();
            const displayArea = vp.getDisplayArea();
            if (keepCamera) {
                if (displayArea) {
                    if (flipHorizontal) {
                        vp.setCamera({ flipHorizontal });
                    }
                    if (rotation) {
                        vp.setViewPresentation({ rotation });
                    }
                }
                else {
                    vp.setCamera(prevCamera);
                }
            }
        });
        if (immediate) {
            this.render();
        }
    }
    renderViewportUsingCustomOrVtkPipeline(viewport) {
        if (viewportTypeUsesCustomRenderingPipeline(viewport.type)) {
            const eventDetail = viewport.customRenderViewportToCanvas();
            return eventDetail;
        }
        if (this.useCPURendering) {
            throw new Error('GPU not available, and using a viewport with no custom render pipeline.');
        }
        const assignedContextIndex = this.contextPool.getContextIndexForViewport(viewport.id);
        const contextData = this.contextPool.getContextByIndex(assignedContextIndex);
        const { context, container } = contextData;
        const eventDetail = this._renderViewportWithContext(viewport, context, container);
        return eventDetail;
    }
    _renderViewportWithContext(viewport, offscreenMultiRenderWindow, offScreenCanvasContainer) {
        if (viewport.sWidth < VIEWPORT_MIN_SIZE ||
            viewport.sHeight < VIEWPORT_MIN_SIZE) {
            console.warn('Viewport is too small', viewport.sWidth, viewport.sHeight);
            return;
        }
        if (viewportTypeUsesCustomRenderingPipeline(viewport.type)) {
            return viewport.customRenderViewportToCanvas();
        }
        if (this.useCPURendering) {
            throw new Error('GPU not available, and using a viewport with no custom render pipeline.');
        }
        if (!offscreenMultiRenderWindow.getRenderer(viewport.id)) {
            offscreenMultiRenderWindow.addRenderer({
                viewport: [0, 0, 1, 1],
                id: viewport.id,
                background: viewport.defaultOptions?.background || [0, 0, 0],
            });
        }
        const renderWindow = offscreenMultiRenderWindow.getRenderWindow();
        const view = renderWindow.getViews()[0];
        const originalRenderPasses = view.getRenderPasses();
        const viewportRenderPasses = this.getViewportRenderPasses(viewport.id);
        if (viewportRenderPasses) {
            view.setRenderPasses(viewportRenderPasses);
        }
        this._resizeOffScreenCanvasForViewport(viewport, offScreenCanvasContainer, offscreenMultiRenderWindow);
        const renderer = offscreenMultiRenderWindow.getRenderer(viewport.id);
        const contextIndex = this.contextPool.getContextIndexForViewport(viewport.id);
        const maxSize = this.contextPool.getMaxSizeForContext(contextIndex);
        const viewportWidth = viewport.canvas.width;
        const viewportHeight = viewport.canvas.height;
        const xEnd = Math.min(1, viewportWidth / maxSize.width);
        const yEnd = Math.min(1, viewportHeight / maxSize.height);
        renderer.setViewport(0, 0, xEnd, yEnd);
        const allRenderers = offscreenMultiRenderWindow.getRenderers();
        allRenderers.forEach(({ renderer: r, id }) => {
            r.setDraw(id === viewport.id);
        });
        const widgetRenderers = this.getWidgetRenderers();
        widgetRenderers.forEach((viewportId, renderer) => {
            renderer.setDraw(viewportId === viewport.id);
        });
        renderWindow.render();
        allRenderers.forEach(({ renderer: r }) => r.setDraw(false));
        widgetRenderers.forEach((_, renderer) => {
            renderer.setDraw(false);
        });
        if (originalRenderPasses) {
            view.setRenderPasses(originalRenderPasses);
        }
        const openGLRenderWindow = offscreenMultiRenderWindow.getOpenGLRenderWindow();
        const context = openGLRenderWindow.get3DContext();
        const offScreenCanvas = context.canvas;
        const eventDetail = this._copyToOnscreenCanvas(viewport, offScreenCanvas);
        return eventDetail;
    }
    _renderViewportFromVtkCanvasToOnscreenCanvas(viewport, offScreenCanvas) {
        return this._copyToOnscreenCanvas(viewport, offScreenCanvas);
    }
    _resizeOffScreenCanvasForViewport(viewport, offScreenCanvasContainer, offscreenMultiRenderWindow) {
        const contextIndex = this.contextPool.getContextIndexForViewport(viewport.id);
        if (contextIndex === undefined) {
            return;
        }
        const maxSizeChanged = this.contextPool.updateViewportSize(viewport.id, viewport.canvas.width, viewport.canvas.height);
        if (!maxSizeChanged) {
            return;
        }
        const maxSize = this.contextPool.getMaxSizeForContext(contextIndex);
        if (offScreenCanvasContainer.width === maxSize.width &&
            offScreenCanvasContainer.height === maxSize.height) {
            return;
        }
        offScreenCanvasContainer.width = maxSize.width;
        offScreenCanvasContainer.height = maxSize.height;
        offscreenMultiRenderWindow.resize();
    }
    _copyToOnscreenCanvas(viewport, offScreenCanvas) {
        const { element, canvas, id: viewportId, renderingEngineId, suppressEvents, } = viewport;
        const { width: dWidth, height: dHeight } = canvas;
        const onScreenContext = canvas.getContext('2d');
        const contextIndex = this.contextPool.getContextIndexForViewport(viewportId);
        const maxSize = this.contextPool.getMaxSizeForContext(contextIndex);
        const sourceY = maxSize.height - dHeight;
        onScreenContext.drawImage(offScreenCanvas, 0, sourceY, dWidth, dHeight, 0, 0, dWidth, dHeight);
        return {
            element,
            suppressEvents,
            viewportId,
            renderingEngineId,
            viewportStatus: viewport.viewportStatus,
        };
    }
    _resize(viewportsDrivenByVtkJs) {
        const contextsToResize = new Set();
        for (const viewport of viewportsDrivenByVtkJs) {
            viewport.sx = 0;
            viewport.sy = 0;
            viewport.sWidth = viewport.canvas.width;
            viewport.sHeight = viewport.canvas.height;
            const contextIndex = this.contextPool.getContextIndexForViewport(viewport.id);
            const maxSizeChanged = this.contextPool.updateViewportSize(viewport.id, viewport.canvas.width, viewport.canvas.height);
            if (maxSizeChanged) {
                contextsToResize.add(contextIndex);
            }
            const contextData = this.contextPool.getContextByIndex(contextIndex);
            const { context: offscreenMultiRenderWindow } = contextData;
            const renderer = offscreenMultiRenderWindow.getRenderer(viewport.id);
            const maxSize = this.contextPool.getMaxSizeForContext(contextIndex);
            const xEnd = Math.min(1, viewport.canvas.width / maxSize.width);
            const yEnd = Math.min(1, viewport.canvas.height / maxSize.height);
            renderer.setViewport(0, 0, xEnd, yEnd);
        }
        contextsToResize.forEach((contextIndex) => {
            const contextData = this.contextPool.getContextByIndex(contextIndex);
            if (contextData) {
                const { context: offscreenMultiRenderWindow, container } = contextData;
                const maxSize = this.contextPool.getMaxSizeForContext(contextIndex);
                container.width = maxSize.width;
                container.height = maxSize.height;
                offscreenMultiRenderWindow.resize();
            }
        });
    }
    getWidgetRenderers() {
        const allViewports = this._getViewportsAsArray();
        const widgetRenderers = new Map();
        allViewports.forEach((vp) => {
            const widgets = vp.getWidgets ? vp.getWidgets() : [];
            widgets.forEach((widget) => {
                const renderer = widget.getRenderer ? widget.getRenderer() : null;
                if (renderer) {
                    widgetRenderers.set(renderer, vp.id);
                }
            });
        });
        return widgetRenderers;
    }
    getViewportRenderPasses(viewportId) {
        const viewport = this.getViewport(viewportId);
        return viewport?.getRenderPasses ? viewport.getRenderPasses() : null;
    }
    getRenderer(viewportId) {
        const contextIndex = this.contextPool?.getContextIndexForViewport(viewportId);
        const contextData = this.contextPool.getContextByIndex(contextIndex);
        const { context: offscreenMultiRenderWindow } = contextData;
        return offscreenMultiRenderWindow.getRenderer(viewportId);
    }
    disableElement(viewportId) {
        const viewport = this.getViewport(viewportId);
        if (!viewport) {
            return;
        }
        super.disableElement(viewportId);
        if (!viewportTypeUsesCustomRenderingPipeline(viewport.type) &&
            !this.useCPURendering) {
            const contextIndex = this.contextPool.getContextIndexForViewport(viewportId);
            if (contextIndex !== undefined) {
                const contextData = this.contextPool.getContextByIndex(contextIndex);
                if (contextData) {
                    const { context: offscreenMultiRenderWindow } = contextData;
                    offscreenMultiRenderWindow.removeRenderer(viewportId);
                }
            }
            this.contextPool.removeViewport(viewportId);
        }
    }
    destroy() {
        if (this.contextPool) {
            this.contextPool.destroy();
        }
        super.destroy();
    }
    getOffscreenMultiRenderWindow(viewportId) {
        if (this.useCPURendering) {
            throw new Error('Offscreen multi render window is not available when using CPU rendering.');
        }
        const contextIndex = this.contextPool.getContextIndexForViewport(viewportId);
        const contextData = this.contextPool.getContextByIndex(contextIndex);
        return contextData.context;
    }
}
export default ContextPoolRenderingEngine;
