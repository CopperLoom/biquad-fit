/**
 * interpolate.ts
 *
 * Resamples a frequency response to a log-spaced grid using log-linear
 * interpolation (linear interpolation in log-frequency space).
 *
 * Default grid matches AutoEq: step=1.01, 20–20000 Hz (~461 points).
 */

import type { FreqPoint, InterpolateOptions } from './types.js';

const DEFAULTS: Required<InterpolateOptions> = {
  step: 1.01,
  fMin: 20,
  fMax: 20000,
};

function buildGrid(fMin: number, fMax: number, step: number): number[] {
  const freqs: number[] = [];
  let f = fMin;
  while (f <= fMax + 1e-9) {
    freqs.push(f);
    f *= step;
  }
  return freqs;
}

export function interpolate(fr: FreqPoint[], options: InterpolateOptions = {}): FreqPoint[] {
  const { step, fMin, fMax } = { ...DEFAULTS, ...options };

  // Work in log-frequency space
  const logFreqs = fr.map(pt => Math.log(pt.freq));
  const dbs      = fr.map(pt => pt.db);

  const grid = buildGrid(fMin, fMax, step);

  return grid.map(freq => {
    const logF = Math.log(freq);

    // Clamp below
    if (logF <= logFreqs[0]) {
      return { freq, db: dbs[0] };
    }
    // Clamp above
    if (logF >= logFreqs[logFreqs.length - 1]) {
      return { freq, db: dbs[dbs.length - 1] };
    }

    // Binary search for the surrounding pair
    let lo = 0;
    let hi = logFreqs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (logFreqs[mid] <= logF) lo = mid;
      else hi = mid;
    }

    // Linear interpolation in log-freq space
    const t  = (logF - logFreqs[lo]) / (logFreqs[hi] - logFreqs[lo]);
    const db = dbs[lo] + t * (dbs[hi] - dbs[lo]);

    return { freq, db };
  });
}
