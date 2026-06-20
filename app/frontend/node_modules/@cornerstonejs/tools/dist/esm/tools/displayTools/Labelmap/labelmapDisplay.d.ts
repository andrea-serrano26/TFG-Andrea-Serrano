import type { Types } from '@cornerstonejs/core';
import type { LabelmapRepresentation } from '../../../types/SegmentationStateTypes';
export declare const MAX_NUMBER_COLORS = 255;
declare function removeRepresentation(viewportId: string, segmentationId: string, renderImmediate?: boolean): void;
declare function render(viewport: Types.IStackViewport | Types.IVolumeViewport, representation: LabelmapRepresentation): Promise<void>;
declare function getUpdateFunction(viewport: Types.IVolumeViewport | Types.IStackViewport): (segmentationId: string) => Promise<void> | null;
declare const _default: {
    getUpdateFunction: typeof getUpdateFunction;
    render: typeof render;
    removeRepresentation: typeof removeRepresentation;
};
export default _default;
export { render, removeRepresentation };
