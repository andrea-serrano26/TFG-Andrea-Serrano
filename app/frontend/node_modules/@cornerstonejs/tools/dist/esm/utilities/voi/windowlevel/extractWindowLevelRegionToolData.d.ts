import type { Types } from '@cornerstonejs/core';
declare function extractWindowLevelRegionToolData(viewport: Types.IVolumeViewport | Types.IStackViewport): {
    scalarData: Types.PixelDataTypedArray;
    minPixelValue: number;
    maxPixelValue: number;
    width: number;
    height: number;
    rows: number;
    columns: number;
};
export { extractWindowLevelRegionToolData };
