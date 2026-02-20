/**
 * interpolate.js
 *
 * Resamples a frequency response to a log-spaced grid using log-linear
 * interpolation (linear interpolation in log-frequency space).
 *
 * Default grid matches AutoEq: step=1.01, 20–20000 Hz (~461 points).
 */

const DEFAULTS = {
  step: 1.01,
  fMin: 20,
  fMax: 20000,
};

/**
 * Build the log-spaced output frequency grid.
 *
 * @param {number} fMin
 * @param {number} fMax
 * @param {number} step - multiplicative step (e.g. 1.01)
 * @returns {number[]}
 */
function buildGrid(fMin, fMax, step) {
  const freqs = [];
  let f = fMin;
  while (f <= fMax + 1e-9) {
    freqs.push(f);
    f *= step;
  }
  return freqs;
}

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
export function interpolate(fr, options = {}) {
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
