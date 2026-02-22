/**
 * Resample a frequency response to a log-spaced grid.
 *
 * Interpolation is log-linear: dB values are interpolated linearly
 * as a function of log(freq). This matches AutoEq's behavior and
 * reflects how human hearing perceives frequency.
 *
 * Points outside the input range are clamped to the nearest endpoint.
 *
 * @param {{freq: number, db: number}[]} fr - input frequency response
 * @param {{step?: number, fMin?: number, fMax?: number}} [options]
 * @returns {{freq: number, db: number}[]}
 */
export function interpolate(fr: {
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
