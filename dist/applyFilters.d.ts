/**
 * Apply parametric EQ filters and pregain to a frequency response.
 *
 * @param {{freq: number, db: number}[]} fr       - input frequency response
 * @param {{type: string, fc: number, gain: number, Q: number}[]} filters
 * @param {number} pregain                         - dB shift applied to entire curve
 * @param {number} [fs=44100]                      - sample rate in Hz
 * @returns {{freq: number, db: number}[]}         - corrected frequency response
 */
export function applyFilters(fr: {
    freq: number;
    db: number;
}[], filters: {
    type: string;
    fc: number;
    gain: number;
    Q: number;
}[], pregain: number, fs?: number): {
    freq: number;
    db: number;
}[];
