/**
 * Compute the equalization curve from a compensated error curve.
 *
 * Implements the full AutoEQ equalize() pipeline:
 *   1. Two-zone smooth the error
 *   2. Negate to get correction curve
 *   3. Find peaks/dips with prominence ≥ 1
 *   4. If no peaks/dips: return negated smoothed error
 *   5. Otherwise: slope-limit (dual-direction with region validation),
 *      gain-cap (+6 dB), re-smooth (1/5 octave)
 *
 * @param {{freq: number, db: number}[]} error - output of compensate(), on 1.01 grid
 * @returns {{freq: number, db: number}[]}
 */
export function equalize(error: {
    freq: number;
    db: number;
}[]): {
    freq: number;
    db: number;
}[];
