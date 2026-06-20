import { utilities } from '@cornerstonejs/core';
import { defaultSegmentationStateManager } from './SegmentationStateManager';
import { getNextColorLUTIndex } from './getNextColorLUTIndex';
import CORNERSTONE_COLOR_LUT from '../../constants/COLOR_LUT';
export function addColorLUT(colorLUT, index) {
    const segmentationStateManager = defaultSegmentationStateManager;
    const indexToUse = index ?? getNextColorLUTIndex();
    let colorLUTToUse = [...colorLUT];
    if (!utilities.isEqual(colorLUTToUse[0], [0, 0, 0, 0])) {
        console.warn('addColorLUT: [0, 0, 0, 0] color is not provided for the background color (segmentIndex =0), automatically adding it');
        colorLUTToUse = [[0, 0, 0, 0], ...colorLUTToUse];
    }
    colorLUTToUse = colorLUTToUse.map((color) => {
        if (color.length === 3) {
            return [color[0], color[1], color[2], 255];
        }
        return color;
    });
    if (colorLUTToUse.length < 255) {
        const missingColorLUTs = CORNERSTONE_COLOR_LUT.slice(colorLUTToUse.length);
        colorLUTToUse = [...colorLUTToUse, ...missingColorLUTs];
    }
    segmentationStateManager.addColorLUT(colorLUTToUse, indexToUse);
    return indexToUse;
}
