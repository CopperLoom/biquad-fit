/**
 * applyFilters.ts
 *
 * Applies a list of biquad filters and a pregain to a frequency response curve.
 * Returns a new FR array — does not mutate the input.
 */

import type { FreqPoint, Filter } from './types.js';
import { biquadResponse } from './biquadResponse.js';

export function applyFilters(fr: FreqPoint[], filters: Filter[], pregain: number, fs = 44100): FreqPoint[] {
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
