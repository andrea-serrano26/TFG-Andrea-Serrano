import type { OrientationAxis } from '../enums';
import type OrientationVectors from './OrientationVectors';
import type DisplayArea from './displayArea';
import type RGB from './RGB';
interface ViewportInputOptions {
    background?: RGB;
    orientation?: OrientationAxis | OrientationVectors;
    displayArea?: DisplayArea;
    suppressEvents?: boolean;
    parallelProjection?: boolean;
}
export type { ViewportInputOptions as default };
