import type CanvasActor from '.';
export default class CanvasProperties {
    private actor;
    private opacity;
    private outlineOpacity;
    private transferFunction;
    constructor(actor: CanvasActor);
    setRGBTransferFunction(index: any, cfun: any): void;
    setScalarOpacity(opacity: number): void;
    setInterpolationTypeToNearest(): void;
    setUseLabelOutline(): void;
    setLabelOutlineOpacity(opacity: any): void;
    setLabelOutlineThickness(): void;
    getColor(index: number): any[];
}
