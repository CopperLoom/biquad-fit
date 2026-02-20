/**
 * applyFilters.js
 *
 * Applies a list of biquad filters and a pregain to a frequency response curve.
 * Returns a new FR array — does not mutate the input.
 */

import { biquadResponse } from './biquadResponse.js';

/**
 * Apply parametric EQ filters and pregain to a frequency response.
 *
 * @param {{freq: number, db: number}[]} fr       - input frequency response
 * @param {{type: string, fc: number, gain: number, Q: number}[]} filters
 * @param {number} pregain                         - dB shift applied to entire curve
 * @param {number} [fs=44100]                      - sample rate in Hz
 * @returns {{freq: number, db: number}[]}         - corrected frequency response
 */
export function applyFilters(fr, filters, pregain, fs = 44100) {
  const frequencies = fr.map(pt => pt.freq);

  // Sum filter responses in dB (cascade = addition in log domain)
  const filterSum = new Array(fr.length).fill(0);
  for (const { type, fc, gain, Q } of filters) {
    const response = biquadResponse(type, fc, gain, Q, frequencies, fs);
    for (let i = 0; i < filterSum.length; i++) {
      filterSum[i] += response[i];
    }
  }

  return fr.map((pt, i) => ({
    freq: pt.freq,
    db: pt.db + filterSum[i] + pregain,
  }));
}
