import type { IStackViewport, IVolumeViewport, IViewport, PublicViewportInput, VtkOffscreenMultiRenderWindow } from '../types';
declare class RenderingEngine {
    hasBeenDestroyed: boolean;
    offscreenMultiRenderWindow: VtkOffscreenMultiRenderWindow;
    private _implementation?;
    constructor(id?: string);
    get id(): string;
    enableElement(viewportInputEntry: PublicViewportInput): void;
    disableElement(viewportId: string): void;
    setViewports(publicViewportInputEntries: PublicViewportInput[]): void;
    resize(immediate?: boolean, keepCamera?: boolean): void;
    getViewport(viewportId: string): IViewport;
    getViewports(): IViewport[];
    getStackViewport(viewportId: string): IStackViewport;
    getStackViewports(): IStackViewport[];
    getVolumeViewports(): IVolumeViewport[];
    getRenderer(viewportId: string): import("@kitware/vtk.js/Rendering/Core/Renderer").vtkRenderer;
    fillCanvasWithBackgroundColor(canvas: HTMLCanvasElement, backgroundColor: [number, number, number]): void;
    render(): void;
    renderViewports(viewportIds: string[]): void;
    renderViewport(viewportId: string): void;
    destroy(): void;
    getOffscreenMultiRenderWindow(viewportId?: string): VtkOffscreenMultiRenderWindow;
}
export default RenderingEngine;
