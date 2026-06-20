export function toFiniteNumber(value) {
    return Number.isFinite(value) ? value : undefined;
}
