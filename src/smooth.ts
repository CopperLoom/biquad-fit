/**
 * smooth.ts
 *
 * Fractional-octave smoothing of a frequency response using Savitzky-Golay
 * filtering (polynomial order 2), matching AutoEQ's _smoothen() implementation.
 *
 * AutoEQ uses scipy.signal.savgol_filter with polyorder=2. This is a
 * zero-dependency JS implementation of the same algorithm.
 */

import type { FreqPoint, SmoothOptions } from './types.js';

const DEFAULTS: Required<SmoothOptions> = {
  windowOctaves: 1 / 3,
};

// ─── Savitzky-Golay coefficients ────────────────────────────────────────────

function savgolCoeffs(windowSize: number, polyOrder: number): number[] {
  const m = (windowSize - 1) / 2;
  const nCols = polyOrder + 1;

  // Build Vandermonde matrix V[i][j] = i^j, i in [-m, m]
  const V: number[][] = [];
  for (let i = -m; i <= m; i++) {
    const row: number[] = new Array<number>(nCols);
    row[0] = 1;
    for (let j = 1; j < nCols; j++) row[j] = row[j - 1]! * i;
    V.push(row);
  }

  // Compute V^T V (nCols x nCols)
  const VtV: number[][] = Array.from({ length: nCols }, () => new Array<number>(nCols).fill(0));
  for (let i = 0; i < nCols; i++) {
    for (let j = 0; j < nCols; j++) {
      for (let k = 0; k < windowSize; k++) {
        VtV[i]![j]! += V[k]![i]! * V[k]![j]!;
      }
    }
  }

  // Invert VtV via Gauss-Jordan elimination
  const aug: number[][] = VtV.map((row, i) => {
    const ext: number[] = new Array<number>(nCols).fill(0);
    ext[i] = 1;
    return [...row, ...ext];
  });

  for (let col = 0; col < nCols; col++) {
    // Partial pivot
    let maxRow = col;
    for (let row = col + 1; row < nCols; row++) {
      if (Math.abs(aug[row]![col]!) > Math.abs(aug[maxRow]![col]!)) maxRow = row;
    }
    [aug[col], aug[maxRow]] = [aug[maxRow]!, aug[col]!];

    const pivot = aug[col]![col]!;
    for (let j = col; j < 2 * nCols; j++) aug[col]![j]! /= pivot;

    for (let row = 0; row < nCols; row++) {
      if (row === col) continue;
      const factor = aug[row]![col]!;
      for (let j = col; j < 2 * nCols; j++) {
        aug[row]![j]! -= factor * aug[col]![j]!;
      }
    }
  }

  // Extract inverse
  const inv: number[][] = aug.map(row => row.slice(nCols));

  // Compute (V^T V)^{-1} V^T, first row only (0th derivative)
  const coeffs: number[] = new Array<number>(windowSize);
  for (let k = 0; k < windowSize; k++) {
    let c = 0;
    for (let j = 0; j < nCols; j++) {
      c += inv[0]![j]! * V[k]![j]!;
    }
    coeffs[k] = c;
  }

  return coeffs;
}

// Cache coefficients by window size (polyorder is always 2)
const coeffsCache = new Map<number, number[]>();

function getCachedCoeffs(windowSize: number): number[] {
  if (!coeffsCache.has(windowSize)) {
    coeffsCache.set(windowSize, savgolCoeffs(windowSize, 2));
  }
  return coeffsCache.get(windowSize)!;
}

// ─── Savitzky-Golay filter ──────────────────────────────────────────────────

function savgolFilter(data: number[], windowSize: number): number[] {
  const n = data.length;
  if (windowSize >= n) windowSize = n % 2 === 0 ? n - 1 : n;
  if (windowSize < 3) windowSize = 3;

  const coeffs = getCachedCoeffs(windowSize);
  const m = (windowSize - 1) / 2;
  const result: number[] = new Array<number>(n);

  // Interior points: direct convolution
  for (let i = m; i < n - m; i++) {
    let sum = 0;
    for (let j = 0; j < windowSize; j++) {
      sum += coeffs[j]! * data[i - m + j]!;
    }
    result[i] = sum;
  }

  // Edge points: fit polynomial to the edge window and evaluate
  // This matches scipy's mode='interp' behavior
  for (let i = 0; i < m; i++) {
    result[i] = fitPolyEval(data, 0, windowSize, i);
  }
  for (let i = n - m; i < n; i++) {
    result[i] = fitPolyEval(data, n - windowSize, windowSize, i - (n - windowSize));
  }

  return result;
}

function fitPolyEval(data: number[], start: number, len: number, pos: number): number {
  // Least squares fit: y = a0 + a1*x + a2*x^2
  // where x is centered at the middle of the window
  const mid = (len - 1) / 2;

  // Build normal equations manually (3x3 system for degree 2)
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  let r0 = 0, r1 = 0, r2 = 0;

  for (let j = 0; j < len; j++) {
    const x = j - mid;
    const x2 = x * x;
    s0 += 1;
    s1 += x;
    s2 += x2;
    s3 += x * x2;
    s4 += x2 * x2;
    const y = data[start + j]!;
    r0 += y;
    r1 += x * y;
    r2 += x2 * y;
  }

  // Solve 3x3 system [s0 s1 s2; s1 s2 s3; s2 s3 s4] * [a0; a1; a2] = [r0; r1; r2]
  const A = [
    [s0, s1, s2, r0],
    [s1, s2, s3, r1],
    [s2, s3, s4, r2],
  ];

  // Gaussian elimination
  for (let col = 0; col < 3; col++) {
    let maxRow = col;
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[maxRow][col])) maxRow = row;
    }
    [A[col], A[maxRow]] = [A[maxRow], A[col]];

    const pivot = A[col][col];
    if (Math.abs(pivot) < 1e-15) continue;
    for (let j = col; j <= 3; j++) A[col][j] /= pivot;
    for (let row = 0; row < 3; row++) {
      if (row === col) continue;
      const f = A[row][col];
      for (let j = col; j <= 3; j++) A[row][j] -= f * A[col][j];
    }
  }

  const a0 = A[0]![3]!, a1 = A[1]![3]!, a2 = A[2]![3]!;
  const x = pos - mid;
  return a0 + a1 * x + a2 * x * x;
}

// ─── Window size calculation ────────────────────────────────────────────────

function smoothingWindowSize(freqs: number[], octaves: number): number {
  const k = Math.pow(2, octaves);

  // Average step size
  let stepSum = 0;
  for (let i = 1; i < freqs.length; i++) {
    stepSum += freqs[i]! / freqs[i - 1]!;
  }
  const stepSize = stepSum / (freqs.length - 1);

  // Window size in indices
  let n = Math.round(Math.log(k) / Math.log(stepSize));

  // Ensure odd
  if (n % 2 === 0) n += 1;

  // Minimum 3 (smallest valid Savitzky-Golay window for order 2)
  return Math.max(3, n);
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function smooth(fr: FreqPoint[], options: SmoothOptions = {}): FreqPoint[] {
  const { windowOctaves } = { ...DEFAULTS, ...options };

  const freqs = fr.map(pt => pt.freq);
  const data = fr.map(pt => pt.db);
  const windowSize = smoothingWindowSize(freqs, windowOctaves);
  const smoothed = savgolFilter(data, windowSize);

  return fr.map((pt, i) => ({
    freq: pt.freq,
    db: smoothed[i],
  }));
}
