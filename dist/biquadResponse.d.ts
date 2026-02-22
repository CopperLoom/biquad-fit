/**
 * Compute biquad filter gain in dB at each frequency in the input array.
 *
 * @param {'PK'|'LSQ'|'HSQ'} type
 * @param {number}   fc          - center / shelf frequency in Hz
 * @param {number}   gain        - gain in dB
 * @param {number}   Q           - quality factor
 * @param {number[]} frequencies - array of frequencies in Hz
 * @param {number}   [fs=44100]  - sample rate in Hz
 * @returns {number[]} gain in dB at each frequency
 */
export function biquadResponse(type: "PK" | "LSQ" | "HSQ", fc: number, gain: number, Q: number, frequencies: number[], fs?: number): number[];
