/**
 * smooth.js
 *
 * Fractional-octave smoothing of a frequency response.
 *
 * Assumes the input is already on a log-spaced grid (output of interpolate).
 * Applies a rectangular moving-average window of width `windowOctaves`
 * centered on each point, in log-frequency space.
 *
 * This matches AutoEq's approach: a window defined in octaves applied
 * uniformly across the log-spaced grid.
 */

const DEFAULTS = {
  windowOctaves: 1 / 3,
};

/**
 * Smooth a frequency response using a fractional-octave moving average.
 *
 * @param {{freq: number, db: number}[]} fr - log-spaced input FR
 * @param {{windowOctaves?: number}} [options]
 * @returns {{freq: number, db: number}[]}
 */
export function smooth(fr, options = {}) {
  const { windowOctaves } = { ...DEFAULTS, ...options };

  const logFreqs = fr.map(pt => Math.log2(pt.freq));
  const halfWindow = windowOctaves / 2;

  return fr.map((pt, i) => {
    const logF = logFreqs[i];
    const lo   = logF - halfWindow;
    const hi   = logF + halfWindow;

    // Collect all points within the window
    let sum = 0;
    let count = 0;
    for (let j = 0; j < fr.length; j++) {
      if (logFreqs[j] >= lo && logFreqs[j] <= hi) {
        sum += fr[j].db;
        count++;
      }
    }

    return {
      freq: pt.freq,
      db: sum / count,
    };
  });
}
