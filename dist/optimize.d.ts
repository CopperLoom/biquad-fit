/**
 * Find optimal PEQ filter parameters to match measured to target.
 *
 * Pipeline (matching AutoEQ):
 *   1. Resolve specs
 *   2. Interpolate to pipeline grid (1.01)
 *   3. Center measured at 1 kHz
 *   4. Compute error = measured - target
 *   5. Equalize: smooth, slope-limit, gain-cap, re-smooth
 *   6. Interpolate equalization to optimizer grid (1.02)
 *   7. Initialize filters (HSQ → LSQ → PK)
 *   8. Joint optimize
 *   9. Compute pregain
 *
 * @param {{freq: number, db: number}[]} measured
 * @param {{freq: number, db: number}[]} target
 * @param {Object} [constraints]
 * @returns {{ pregain: number, filters: {type: string, fc: number, gain: number, Q: number}[] }}
 */
export function optimize(measured: {
    freq: number;
    db: number;
}[], target: {
    freq: number;
    db: number;
}[], constraints?: any): {
    pregain: number;
    filters: {
        type: string;
        fc: number;
        gain: number;
        Q: number;
    }[];
};
