import type RGB from './RGB';
interface ColormapRegistration {
    ColorSpace: string;
    Name: string;
    name?: string;
    RGBPoints: RGB[] | number[];
}
interface OpacityMapping {
    value: number;
    opacity: number;
}
interface ColormapPublic {
    name?: string;
    opacity?: OpacityMapping[] | number;
    threshold?: number;
}
export type { ColormapRegistration, ColormapPublic, OpacityMapping };
