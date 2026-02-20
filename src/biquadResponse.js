/**
 * biquadResponse.js
 *
 * Pure-JS biquad filter evaluator. Computes gain in dB at a set of
 * frequencies for a single PK / LSQ / HSQ filter.
 *
 * Coefficient formulas: Audio EQ Cookbook (W3C)
 * Magnitude formula:    phi = 4*sin²(w/2) identity (same as AutoEq)
 */

const DEFAULT_FS = 44100;

/**
 * Compute normalized biquad coefficients {b0, b1, b2, a1, a2}
 * for the given filter type. a0 is always 1.0 (normalized out).
 *
 * @param {'PK'|'LSQ'|'HSQ'} type
 * @param {number} fc   - center / shelf frequency in Hz
 * @param {number} gain - gain in dB
 * @param {number} Q    - quality factor
 * @param {number} fs   - sample rate in Hz
 * @returns {{b0: number, b1: number, b2: number, a1: number, a2: number}}
 */
function biquadCoeffs(type, fc, gain, Q, fs) {
  const A  = Math.pow(10, gain / 40);
  const w0 = 2 * Math.PI * fc / fs;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * Q);

  let b0, b1, b2, a0, a1, a2;

  if (type === 'PK') {
    a0 =  1 + alpha / A;
    b0 = (1 + alpha * A) / a0;
    b1 = (-2 * cosW0)    / a0;
    b2 = (1 - alpha * A) / a0;
    a1 = (-2 * cosW0)    / a0;
    a2 = (1 - alpha / A) / a0;

  } else if (type === 'LSQ') {
    const sqrtA = Math.sqrt(A);
    a0 =  (A + 1) + (A - 1) * cosW0 + 2 * sqrtA * alpha;
    b0 =  A * ((A + 1) - (A - 1) * cosW0 + 2 * sqrtA * alpha) / a0;
    b1 =  2 * A * ((A - 1) - (A + 1) * cosW0)                 / a0;
    b2 =  A * ((A + 1) - (A - 1) * cosW0 - 2 * sqrtA * alpha) / a0;
    a1 = -2 * ((A - 1) + (A + 1) * cosW0)                     / a0;
    a2 =  ((A + 1) + (A - 1) * cosW0 - 2 * sqrtA * alpha)     / a0;

  } else if (type === 'HSQ') {
    const sqrtA = Math.sqrt(A);
    a0 =  (A + 1) - (A - 1) * cosW0 + 2 * sqrtA * alpha;
    b0 =  A * ((A + 1) + (A - 1) * cosW0 + 2 * sqrtA * alpha) / a0;
    b1 = -2 * A * ((A - 1) + (A + 1) * cosW0)                 / a0;
    b2 =  A * ((A + 1) + (A - 1) * cosW0 - 2 * sqrtA * alpha) / a0;
    a1 =  2 * ((A - 1) - (A + 1) * cosW0)                     / a0;
    a2 =  ((A + 1) - (A - 1) * cosW0 - 2 * sqrtA * alpha)     / a0;

  } else {
    throw new Error(`Unknown filter type: ${type}. Expected 'PK', 'LSQ', or 'HSQ'.`);
  }

  return { b0, b1, b2, a1, a2 };
}

/**
 * Evaluate a biquad filter's gain in dB at a single frequency.
 *
 * Uses the real-valued squared-magnitude identity:
 *   phi = 4 * sin²(w/2)
 *   |H|² = num / den
 *   where num and den are quadratics in phi.
 *
 * This avoids complex arithmetic and matches AutoEq's implementation exactly.
 *
 * @param {{b0,b1,b2,a1,a2}} c - normalized coefficients (a0 = 1)
 * @param {number} f  - frequency in Hz
 * @param {number} fs - sample rate in Hz
 * @returns {number} gain in dB
 */
function evalMagnitude(c, f, fs) {
  const { b0, b1, b2, a1, a2 } = c;
  const w   = 2 * Math.PI * f / fs;
  const phi = 4 * Math.sin(w / 2) ** 2;

  const num = (b0 + b1 + b2) ** 2 + (b0 * b2 * phi - b1 * (b0 + b2) - 4 * b0 * b2) * phi;
  const den = (1  + a1 + a2) ** 2 + (     a2 * phi - a1 * (1  + a2) - 4      * a2) * phi;

  return 10 * Math.log10(num / den);
}

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
export function biquadResponse(type, fc, gain, Q, frequencies, fs = DEFAULT_FS) {
  const c = biquadCoeffs(type, fc, gain, Q, fs);
  return frequencies.map(f => evalMagnitude(c, f, fs));
}
