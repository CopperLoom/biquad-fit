/**
 * Compute error = measured - target on a common log-spaced grid.
 *
 * @param {{freq: number, db: number}[]} measured - IEM frequency response
 * @param {{freq: number, db: number}[]} target   - target curve
 * @param {{step?: number, fMin?: number, fMax?: number}} [options]
 * @returns {{freq: number, db: number}[]}
 */
export function compensate(measured: {
    freq: number;
    db: number;
}[], target: {
    freq: number;
    db: number;
}[], options?: {
    step?: number;
    fMin?: number;
    fMax?: number;
}): {
    freq: number;
    db: number;
}[];
