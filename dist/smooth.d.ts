/**
 * Smooth a frequency response using Savitzky-Golay filtering (order 2),
 * matching AutoEQ's smoothen() implementation.
 *
 * @param {{freq: number, db: number}[]} fr - log-spaced input FR
 * @param {{windowOctaves?: number}} [options]
 * @returns {{freq: number, db: number}[]}
 */
export function smooth(fr: {
    freq: number;
    db: number;
}[], options?: {
    windowOctaves?: number;
}): {
    freq: number;
    db: number;
}[];
