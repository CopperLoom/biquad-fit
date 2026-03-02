/**
 * biquadResponse.ts
 *
 * Pure-JS biquad filter evaluator. Computes gain in dB at a set of
 * frequencies for a single PK / LSQ / HSQ filter.
 *
 * Coefficient formulas: Audio EQ Cookbook (W3C)
 * Magnitude formula:    phi = 4*sin²(w/2) identity (same as AutoEq)
 */

import type { FilterType } from './types.js';

const DEFAULT_FS = 44100;

interface BiquadCoeffs { b0: number; b1: number; b2: number; a1: number; a2: number; }

function biquadCoeffs(type: FilterType, fc: number, gain: number, Q: number, fs: number): BiquadCoeffs {
  const A  = Math.pow(10, gain / 40);
  const w0 = 2 * Math.PI * fc / fs;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * Q);

  let b0 = 0, b1 = 0, b2 = 0, a0 = 0, a1 = 0, a2 = 0;

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

function evalMagnitude(c: BiquadCoeffs, f: number, fs: number): number {
  const { b0, b1, b2, a1, a2 } = c;
  const w   = 2 * Math.PI * f / fs;
  const phi = 4 * Math.sin(w / 2) ** 2;

  const num = (b0 + b1 + b2) ** 2 + (b0 * b2 * phi - b1 * (b0 + b2) - 4 * b0 * b2) * phi;
  const den = (1  + a1 + a2) ** 2 + (     a2 * phi - a1 * (1  + a2) - 4      * a2) * phi;

  return 10 * Math.log10(num / den);
}

export function biquadResponse(type: FilterType, fc: number, gain: number, Q: number, frequencies: number[], fs = DEFAULT_FS): number[] {
  const c = biquadCoeffs(type, fc, gain, Q, fs);
  return frequencies.map(f => evalMagnitude(c, f, fs));
}
