export default class CanvasProperties {
    constructor(actor) {
        this.opacity = 0.4;
        this.outlineOpacity = 0.4;
        this.transferFunction = [];
        this.actor = actor;
    }
    setRGBTransferFunction(index, cfun) {
        this.transferFunction[index] = cfun;
    }
    setScalarOpacity(opacity) {
    }
    setInterpolationTypeToNearest() {
    }
    setUseLabelOutline() {
    }
    setLabelOutlineOpacity(opacity) {
        this.outlineOpacity = opacity;
    }
    setLabelOutlineThickness() {
    }
    getColor(index) {
        const cfun = this.transferFunction[0];
        const r = cfun.getRedValue(index);
        const g = cfun.getGreenValue(index);
        const b = cfun.getBlueValue(index);
        return [r, g, b, this.opacity];
    }
}
