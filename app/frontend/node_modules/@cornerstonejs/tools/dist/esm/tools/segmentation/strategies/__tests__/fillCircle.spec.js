import { createPointInEllipse } from '../fillCircle';
describe('createPointInEllipse', () => {
    const corners = [
        [-1, 1, 0],
        [1, -1, 0],
        [-1, -1, 0],
        [1, 1, 0],
    ];
    it('detects points inside the base circle', () => {
        const predicate = createPointInEllipse(corners);
        expect(predicate([0, 0, 0])).toBe(true);
        expect(predicate([0.5, 0.5, 0])).toBe(true);
        expect(predicate([1.2, 0, 0])).toBe(false);
    });
    it('covers interpolated stroke segments', () => {
        const predicate = createPointInEllipse(corners, {
            strokePointsWorld: [
                [-2, 0, 0],
                [2, 0, 0],
            ],
            radius: 1,
        });
        expect(predicate([0, 0, 0])).toBe(true);
        expect(predicate([1.5, 0, 0])).toBe(true);
        expect(predicate([3.2, 0, 0])).toBe(false);
    });
});
