import { InstanceVolumetricCalculator } from './VolumetricCalculator';
export default class SegmentStatsCalculator {
    static { this.calculators = new Map(); }
    static { this.indices = []; }
    static { this.mode = 'collective'; }
    static statsInit(options) {
        const { storePointData, indices, mode } = options;
        this.mode = mode;
        this.indices = indices;
        this.calculators.clear();
        if (this.mode === 'individual') {
            indices.forEach((index) => {
                this.calculators.set(index, new InstanceVolumetricCalculator({ storePointData }));
            });
        }
        else {
            this.calculators.set(indices, new InstanceVolumetricCalculator({ storePointData }));
        }
    }
    static statsCallback(data) {
        const { segmentIndex, ...statsData } = data;
        if (!segmentIndex) {
            throw new Error('Segment index is required for stats calculation');
        }
        const calculator = this.mode === 'individual'
            ? this.calculators.get(segmentIndex)
            : this.calculators.get(this.indices);
        if (!calculator) {
            throw new Error(`No calculator found for segment ${segmentIndex}`);
        }
        calculator.statsCallback(statsData);
    }
    static getStatistics(options) {
        if (this.mode === 'individual') {
            const result = {};
            this.calculators.forEach((calculator, segmentIndex) => {
                result[segmentIndex] = calculator.getStatistics(options);
            });
            return result;
        }
        const calculator = this.calculators.get(this.indices);
        return calculator.getStatistics(options);
    }
}
