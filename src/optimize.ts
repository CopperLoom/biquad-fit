/**
 * optimize.ts — v1.0
 *
 * Joint parametric EQ optimizer. Intended to match AutoEQ's SLSQP approach;
 * implemented as L-BFGS. See README Algorithm & Accuracy for deviation notes.
 *
 * Algorithm:
 *   1. Resolve filterSpecs
 *   2. Interpolate to pipeline grid (1.01), center, compute error, equalize
 *   3. Interpolate equalization to optimizer grid (1.02)
 *   4. Sequential initialization: HSQ → LSQ → PK, each against remaining correction
 *   5. Joint L-BFGS optimization over all filter params simultaneously,
 *      with STD-based convergence stopping (intended to mirror AutoEQ's SLSQP;
 *      diverges due to algorithm differences — see README Algorithm & Accuracy)
 *   6. Compute pregain
 *
 * Spec: docs/joint-optimizer-spec.md
 */

import type { FilterSpec, FilterType, Filter, FreqPoint, Constraints, OptimizeResult } from './types.js';
import { biquadResponse } from './biquadResponse.js';
import { interpolate }    from './interpolate.js';
import { compensate }     from './compensate.js';
import { equalize }       from './equalize.js';

interface ResolvedFilterSpec {
  type:      FilterType;
  gainRange: [number, number];
  qRange:    [number, number];
  fcRange:   [number, number];
}

interface LbfgsEntry { s: number[]; y: number[]; }

interface Bounds { lo: number[]; hi: number[]; }

const DEFAULT_FS      = 44100;
const PIPELINE_GRID   = { step: 1.01, fMin: 20, fMax: 20000 };
const OPTIMIZER_GRID  = { step: 1.02, fMin: 20, fMax: 20000 };
const SHELF_Q_RANGE:   [number, number] = [0.4, 0.7];
const SHELF_FC_RANGE:  [number, number] = [20, 10000];
const DEFAULT_PK_Q_RANGE: [number, number] = [0.18, 6.0];  // AutoEQ defaults: 0.18248 (5-oct max bw), 6.0
const IX_10K_CUTOFF   = 10000;
const LOSS_FREQ_MIN   = 20;     // DEFAULT_PEQ_OPTIMIZER_MIN_F (hardcoded)
const LOSS_FREQ_MAX   = 20000;  // DEFAULT_PEQ_OPTIMIZER_MAX_F (hardcoded)
const MIN_STD         = 0.002;
const STD_WINDOW      = 8;
const MIN_ITER        = 50;     // don't check convergence before this many iterations
const MAX_JOINT_ITER  = 150;    // scipy fmin_slsqp default
const PREAMP_HEADROOM = 0.2;
const LBFGS_MEMORY    = 10;
const FD_H            = Math.sqrt(Number.EPSILON);  // ≈ 1.49e-8, matches scipy

// ─── Resolve filterSpecs from constraints ─────────────────────────────────────

/**
 * Normalize filterSpecs to an array of resolved filter specs with all defaults filled in.
 * gainRange is required on each FilterSpec; qRange defaults by filter type.
 */
function resolveSpecs(filterSpecs: FilterSpec[], defaultFreqRange: [number, number]): ResolvedFilterSpec[] {
  return filterSpecs.map(s => {
    const type    = (s.type ?? 'PK') as FilterType;
    const isShelf = type === 'LSQ' || type === 'HSQ';
    return {
      type,
      gainRange: s.gainRange,
      qRange:    s.qRange    ?? (isShelf ? SHELF_Q_RANGE    : DEFAULT_PK_Q_RANGE),
      fcRange:   s.fcRange   ?? (isShelf ? SHELF_FC_RANGE   : defaultFreqRange),
    };
  });
}

// ─── Sharpness penalty (PK only, matching AutoEQ) ─────────────────────────────

function sharpnessPenalty(type: FilterType, fc: number, gain: number, Q: number, freqs: number[], fs: number): number {
  if (type !== 'PK') return 0;
  const gainLimit = -0.09503189270199464 + 20.575128011847003 / Q;
  if (gainLimit <= 0) return 0;
  const x     = gain / gainLimit - 1;
  const coeff = 1 / (1 + Math.exp(-100 * x));
  const fr    = biquadResponse(type, fc, gain, Q, freqs, fs);
  return fr.reduce((s, v) => s + (v * coeff) ** 2, 0) / fr.length;
}

// ─── Filter initialization ────────────────────────────────────────────────────

function findLocalPeaks(arr: number[]): number[] {
  const peaks: number[] = [];
  let i = 1;
  while (i < arr.length - 1) {
    if (arr[i] > arr[i - 1]) {
      let j = i;
      while (j < arr.length - 1 && arr[j + 1] === arr[j]) j++;
      if (j === arr.length - 1 || arr[j + 1] < arr[j]) {
        peaks.push((i + j) >> 1);
      }
      i = j + 1;
    } else {
      i++;
    }
  }
  return peaks;
}

function initPeaking(freqs: number[], correctionDb: number[], spec: ResolvedFilterSpec): Filter {
  const { gainRange, qRange, fcRange } = spec;

  const minFcIdx = freqs.findIndex(f => f >= fcRange[0]);
  let maxFcIdx = 0;
  for (let i = freqs.length - 1; i >= 0; i--) {
    if (freqs[i] <= fcRange[1]) { maxFcIdx = i; break; }
  }

  const posCorr = correctionDb.map(v => Math.max(v, 0));
  const negCorr = correctionDb.map(v => Math.max(-v, 0));

  let bestIx = minFcIdx, bestSize = -1;

  const evalPeaks = (peaks: number[], arr: number[], offset: number) => {
    for (const ix of peaks) {
      const absIx = ix + offset;
      if (absIx < minFcIdx || absIx > maxFcIdx) continue;
      const height = arr[ix]!;
      if (height <= 0) continue;
      // Interpolated half-height width (matching scipy find_peaks)
      const halfH = height / 2;
      let lo = ix, hi = ix;
      while (lo > 0 && arr[lo - 1]! > halfH) lo--;
      while (hi < arr.length - 1 && arr[hi + 1]! > halfH) hi++;
      // Interpolate left crossing
      let loFrac = lo;
      if (lo > 0 && arr[lo - 1]! <= halfH && arr[lo]! > halfH) {
        loFrac = lo - 1 + (halfH - arr[lo - 1]!) / (arr[lo]! - arr[lo - 1]!);
      }
      // Interpolate right crossing
      let hiFrac = hi;
      if (hi < arr.length - 1 && arr[hi + 1]! <= halfH && arr[hi]! > halfH) {
        hiFrac = hi + (arr[hi]! - halfH) / (arr[hi]! - arr[hi + 1]!);
      }
      const width = hiFrac - loFrac;
      const size = height * width;
      if (size > bestSize) { bestSize = size; bestIx = absIx; }
    }
  };

  const slicedPos = posCorr.slice(minFcIdx, maxFcIdx + 1);
  const slicedNeg = negCorr.slice(minFcIdx, maxFcIdx + 1);
  evalPeaks(findLocalPeaks(slicedPos), slicedPos, minFcIdx);
  evalPeaks(findLocalPeaks(slicedNeg), slicedNeg, minFcIdx);

  if (bestSize < 0) {
    // No peaks found: midpoint fc, Q=sqrt(2), gain=0
    const midIx = (minFcIdx + maxFcIdx) >> 1;
    return {
      type: 'PK' as FilterType,
      fc: freqs[midIx]!,
      gain: 0,
      Q: Math.max(qRange[0], Math.min(qRange[1], Math.SQRT2)),
    };
  }

  const fc   = Math.max(fcRange[0], Math.min(fcRange[1], freqs[bestIx]!));
  const gain = Math.max(gainRange[0], Math.min(gainRange[1], correctionDb[bestIx]!));

  // Estimate Q from peak bandwidth in octaves (interpolated)
  let Q = Math.SQRT2;
  {
    const h = Math.abs(correctionDb[bestIx]!) / 2;
    if (h > 0) {
      let lo = bestIx, hi = bestIx;
      while (lo > 0 && Math.abs(correctionDb[lo - 1]!) > h) lo--;
      while (hi < freqs.length - 1 && Math.abs(correctionDb[hi + 1]!) > h) hi++;
      // Interpolate crossings for fractional positions
      let loFrac = lo, hiFrac = hi;
      if (lo > 0) {
        const a = Math.abs(correctionDb[lo - 1]!), b = Math.abs(correctionDb[lo]!);
        if (a <= h && b > h) loFrac = lo - 1 + (h - a) / (b - a);
      }
      if (hi < freqs.length - 1) {
        const a = Math.abs(correctionDb[hi]!), b = Math.abs(correctionDb[hi + 1]!);
        if (b <= h && a > h) hiFrac = hi + (a - h) / (a - b);
      }
      // Convert sample width to octave bandwidth
      const fStep = Math.log2(freqs[1]! / freqs[0]!);
      const bwOctaves = fStep * (hiFrac - loFrac);
      if (bwOctaves > 0) {
        const bw = Math.pow(2, bwOctaves);
        if (bw > 1) Q = Math.sqrt(bw) / (bw - 1);
      }
    }
  }
  Q = Math.max(qRange[0], Math.min(qRange[1], Q));

  return { type: 'PK' as FilterType, fc, gain, Q };
}

function initLowShelf(freqs: number[], correctionDb: number[], spec: ResolvedFilterSpec, fs: number): Filter {
  const { gainRange, qRange, fcRange } = spec;

  const minIx = Math.max(0, freqs.findIndex(f => f >= Math.max(40, fcRange[0])));
  let maxIx = minIx;
  for (let i = freqs.length - 1; i >= 0; i--) {
    if (freqs[i] < Math.min(10000, fcRange[1])) { maxIx = i; break; }
  }

  let bestIx = minIx, bestAvg = 0;
  for (let i = minIx; i <= maxIx; i++) {
    let sum = 0;
    for (let j = 0; j <= i; j++) sum += correctionDb[j];
    const avg = Math.abs(sum / (i + 1));
    if (avg > bestAvg) { bestAvg = avg; bestIx = i; }
  }

  const fc = Math.max(fcRange[0], Math.min(fcRange[1], freqs[bestIx]!));
  const Q  = Math.max(qRange[0], Math.min(qRange[1], 0.7));

  const shelfFr = biquadResponse('LSQ', fc, 1, Q, freqs, fs);
  const wtSum   = shelfFr.reduce((s, v) => s + Math.abs(v), 0);
  let gain = wtSum > 0
    ? correctionDb.reduce((s, v, i) => s + v * Math.abs(shelfFr[i]!), 0) / wtSum
    : 0;
  gain = Math.max(gainRange[0], Math.min(gainRange[1], gain));

  return { type: 'LSQ' as FilterType, fc, gain, Q };
}

function initHighShelf(freqs: number[], correctionDb: number[], spec: ResolvedFilterSpec, fs: number): Filter {
  const { gainRange, qRange, fcRange } = spec;

  const minIx = Math.max(0, freqs.findIndex(f => f >= Math.max(40, fcRange[0])));
  let maxIx = minIx;
  for (let i = freqs.length - 1; i >= 0; i--) {
    if (freqs[i] < Math.min(10000, fcRange[1])) { maxIx = i; break; }
  }

  let bestIx = minIx, bestAvg = 0;
  for (let i = minIx; i <= maxIx; i++) {
    let sum = 0;
    for (let j = i; j < correctionDb.length; j++) sum += correctionDb[j];
    const avg = Math.abs(sum / (correctionDb.length - i));
    if (avg > bestAvg) { bestAvg = avg; bestIx = i; }
  }

  const fc = Math.max(fcRange[0], Math.min(fcRange[1], freqs[bestIx]!));
  const Q  = Math.max(qRange[0], Math.min(qRange[1], 0.7));

  const shelfFr = biquadResponse('HSQ', fc, 1, Q, freqs, fs);
  const wtSum   = shelfFr.reduce((s, v) => s + Math.abs(v), 0);
  let gain = wtSum > 0
    ? correctionDb.reduce((s, v, i) => s + v * Math.abs(shelfFr[i]!), 0) / wtSum
    : 0;
  gain = Math.max(gainRange[0], Math.min(gainRange[1], gain));

  return { type: 'HSQ' as FilterType, fc, gain, Q };
}

function initFilter(freqs: number[], correctionDb: number[], spec: ResolvedFilterSpec, fs: number): Filter {
  if (spec.type === 'LSQ') return initLowShelf(freqs, correctionDb, spec, fs);
  if (spec.type === 'HSQ') return initHighShelf(freqs, correctionDb, spec, fs);
  return initPeaking(freqs, correctionDb, spec);
}

// ─── Joint loss function ──────────────────────────────────────────────────────

function totalResponse(filters: Filter[], freqs: number[], fs: number): number[] {
  const sum: number[] = new Array<number>(freqs.length).fill(0);
  for (const f of filters) {
    const r = biquadResponse(f.type, f.fc, f.gain, f.Q, freqs, fs);
    for (let i = 0; i < sum.length; i++) sum[i]! += r[i]!;
  }
  return sum;
}

/**
 * Joint loss: sqrt(MSE + sharpness penalties).
 * MSE over [20, 20000] Hz (hardcoded). Above 10 kHz: average-only.
 */
function jointLoss(filters: Filter[], freqs: number[], correctionDb: number[], fs: number): number {
  const fr  = totalResponse(filters, freqs, fs);
  const tgt = correctionDb.slice();

  // Above 10 kHz: replace both with their averages
  let ix10k = freqs.length;
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] >= IX_10K_CUTOFF) { ix10k = i; break; }
  }
  if (ix10k < freqs.length) {
    let tgtSum = 0, frSum = 0, cnt = 0;
    for (let i = ix10k; i < tgt.length; i++) { tgtSum += tgt[i]!; frSum += fr[i]!; cnt++; }
    const tgtAvg = tgtSum / cnt, frAvg = frSum / cnt;
    for (let i = ix10k; i < tgt.length; i++) { tgt[i] = tgtAvg; fr[i] = frAvg; }
  }

  // MSE over [20, 20000] Hz
  let minIx = 0, maxIx = freqs.length - 1;
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] >= LOSS_FREQ_MIN) { minIx = i; break; }
  }
  for (let i = freqs.length - 1; i >= 0; i--) {
    if (freqs[i] <= LOSS_FREQ_MAX) { maxIx = i; break; }
  }

  let mse = 0;
  const n = maxIx - minIx + 1;
  for (let i = minIx; i <= maxIx; i++) {
    const diff = tgt[i]! - fr[i]!;
    mse += diff * diff;
  }
  mse /= n;

  for (const f of filters) {
    mse += sharpnessPenalty(f.type, f.fc, f.gain, f.Q, freqs, fs);
  }

  return Math.sqrt(mse);
}

// ─── Parameter encoding/decoding ──────────────────────────────────────────────

function encodeParams(filters: Filter[]): number[] {
  const x: number[] = [];
  for (const f of filters) {
    x.push(Math.log10(f.fc));
    x.push(f.Q);
    x.push(f.gain);
  }
  return x;
}

function decodeParams(x: number[], specs: ResolvedFilterSpec[]): Filter[] {
  const filters: Filter[] = [];
  let idx = 0;
  for (const s of specs) {
    filters.push({
      type: s.type,
      fc:   Math.pow(10, x[idx]!),
      Q:    x[idx + 1]!,
      gain: x[idx + 2]!,
    });
    idx += 3;
  }
  return filters;
}

function buildBounds(specs: ResolvedFilterSpec[]): Bounds {
  const lo: number[] = [], hi: number[] = [];
  for (const s of specs) {
    lo.push(Math.log10(s.fcRange[0]));  hi.push(Math.log10(s.fcRange[1]));
    lo.push(s.qRange[0]);               hi.push(s.qRange[1]);
    lo.push(s.gainRange[0]);            hi.push(s.gainRange[1]);
  }
  return { lo, hi };
}

function clipToBounds(x: number[], bounds: Bounds): number[] {
  const out: number[] = new Array<number>(x.length);
  for (let i = 0; i < x.length; i++) {
    out[i] = Math.max(bounds.lo[i]!, Math.min(bounds.hi[i]!, x[i]!));
  }
  return out;
}

// ─── L-BFGS optimizer components ──────────────────────────────────────────────

/**
 * Forward finite-difference gradient matching scipy SLSQP.
 * h = sqrt(Number.EPSILON) ≈ 1.49e-8.
 */
function finiteDiffGradient(x: number[], f0: number, lossFn: (x: number[]) => number, bounds: Bounds): number[] {
  const n = x.length;
  const g: number[] = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const xp = x.slice();
    xp[i] = Math.min(x[i] + FD_H, bounds.hi[i]);
    const fp = lossFn(xp);
    const actualH = xp[i] - x[i];
    g[i] = actualH > 0 ? (fp - f0) / actualH : 0;
  }
  return g;
}

/**
 * L-BFGS two-loop recursion.
 * Returns search direction d = -H·g.
 */
function lbfgsTwoLoop(g: number[], history: LbfgsEntry[]): number[] {
  const n = g.length;
  const k = history.length;

  if (k === 0) {
    // Steepest descent
    return g.map(v => -v);
  }

  const q = g.slice();
  const alpha: number[] = new Array<number>(k);
  const rho: number[]   = new Array<number>(k);

  // Precompute rho
  for (let i = 0; i < k; i++) {
    const dot = vecDot(history[i].y, history[i].s);
    rho[i] = dot > 0 ? 1 / dot : 0;
  }

  // First loop: newest → oldest
  for (let i = k - 1; i >= 0; i--) {
    alpha[i] = rho[i] * vecDot(history[i].s, q);
    for (let j = 0; j < n; j++) q[j] -= alpha[i] * history[i].y[j];
  }

  // Scale by initial Hessian estimate
  const last = history[k - 1];
  const ys = vecDot(last.y, last.s);
  const yy = vecDot(last.y, last.y);
  const gamma = yy > 0 ? ys / yy : 1.0;
  const r = q.map(v => gamma * v);

  // Second loop: oldest → newest
  for (let i = 0; i < k; i++) {
    const beta = rho[i] * vecDot(history[i].y, r);
    for (let j = 0; j < n; j++) r[j] += history[i].s[j] * (alpha[i] - beta);
  }

  // Negate for descent direction
  return r.map(v => -v);
}

function vecDot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function vecNorm(a: number[]): number {
  return Math.sqrt(vecDot(a, a));
}

/**
 * Project search direction: zero out components that would push past bounds.
 */
function projectToBounds(d: number[], x: number[], bounds: Bounds): void {
  for (let i = 0; i < d.length; i++) {
    if (x[i]! <= bounds.lo[i]! && d[i]! < 0) d[i] = 0;
    if (x[i]! >= bounds.hi[i]! && d[i]! > 0) d[i] = 0;
  }
}

/**
 * Armijo backtracking line search.
 * Returns x_new (clipped to bounds).
 */
function armijoLineSearch(x: number[], d: number[], g: number[], f0: number, lossFn: (x: number[]) => number, bounds: Bounds): number[] {
  const c1 = 1e-4;
  const rho = 0.5;
  const maxSteps = 20;
  const slope = vecDot(g, d);

  let alpha = 1.0;
  let xTry: number[] = [];
  for (let step = 0; step < maxSteps; step++) {
    xTry = new Array(x.length);
    for (let i = 0; i < x.length; i++) {
      xTry[i] = Math.max(bounds.lo[i], Math.min(bounds.hi[i], x[i] + alpha * d[i]));
    }
    const fTry = lossFn(xTry);
    if (fTry <= f0 + c1 * alpha * slope) return xTry;
    alpha *= rho;
  }

  // Accept even if line search didn't satisfy Armijo (avoid stalling)
  return xTry;
}

/**
 * Population standard deviation (numpy-style, ddof=0).
 */
function populationStd(arr: number[]): number {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i]!;
  const mean = sum / arr.length;
  let ss = 0;
  for (let i = 0; i < arr.length; i++) ss += (arr[i]! - mean) * (arr[i]! - mean);
  return Math.sqrt(ss / arr.length);
}

/**
 * Check convergence: STD of last 8 < 0.002, or STD of last 4 < 0.001.
 */
function converged(lossHistory: number[]): boolean {
  const len = lossHistory.length;
  if (len < MIN_ITER) return false;  // don't converge too early
  if (len > STD_WINDOW) {
    if (populationStd(lossHistory.slice(-STD_WINDOW)) < MIN_STD) return true;
  }
  if (len > 4) {
    if (populationStd(lossHistory.slice(-4)) < MIN_STD / 2) return true;
  }
  return false;
}

// ─── Joint optimizer ──────────────────────────────────────────────────────────

/**
 * L-BFGS bounded optimizer. Intended to match AutoEQ's fmin_slsqp behavior;
 * diverges due to algorithm differences. See README Algorithm & Accuracy.
 *
 * @param {Object[]} initialFilters - [{type, fc, gain, Q}]
 * @param {Object[]} specs - resolved filter specs with bounds
 * @param {number[]} freqs - optimizer grid (step=1.02)
 * @param {number[]} correctionDb - equalization curve on optimizer grid
 * @param {number} fs
 * @returns {Object[]} optimized filters
 */
function jointOptimize(initialFilters: Filter[], specs: ResolvedFilterSpec[], freqs: number[], correctionDb: number[], fs: number): Filter[] {
  let x = encodeParams(initialFilters);
  const bounds = buildBounds(specs);

  const lossFn = (params: number[]) => {
    const filters = decodeParams(params, specs);
    return jointLoss(filters, freqs, correctionDb, fs);
  };

  let loss0 = lossFn(x);
  let g = finiteDiffGradient(x, loss0, lossFn, bounds);
  let bestLoss = loss0;
  let bestX = x.slice();
  const lossHistory: number[] = [];
  const lbfgsHistory: LbfgsEntry[] = [];

  for (let iter = 0; iter < MAX_JOINT_ITER; iter++) {
    // Compute search direction
    const d = lbfgsTwoLoop(g, lbfgsHistory);
    projectToBounds(d, x, bounds);

    if (vecNorm(d) < 1e-10) break;  // Converged at bounded corner

    // Line search
    const xNew = armijoLineSearch(x, d, g, loss0, lossFn, bounds);
    const loss1 = lossFn(xNew);
    const gNew = finiteDiffGradient(xNew, loss1, lossFn, bounds);

    // BFGS history update
    const s: number[] = new Array<number>(x.length);
    const y: number[] = new Array<number>(x.length);
    for (let i = 0; i < x.length; i++) {
      s[i] = xNew[i] - x[i];
      y[i] = gNew[i] - g[i];
    }
    const ys = vecDot(y, s);
    if (ys > 1e-10 * vecNorm(s) * vecNorm(y)) {
      lbfgsHistory.push({ s, y });
      if (lbfgsHistory.length > LBFGS_MEMORY) lbfgsHistory.shift();
    }

    x = xNew;
    g = gNew;
    loss0 = loss1;

    if (loss1 < bestLoss) {
      bestLoss = loss1;
      bestX = x.slice();
    }

    lossHistory.push(loss1);
    if (converged(lossHistory)) break;
  }

  return decodeParams(bestX, specs);
}

// ─── Pregain ──────────────────────────────────────────────────────────────────

function computePregain(filters: Filter[], freqs: number[], fs: number, gainRange: [number, number]): number {
  if (filters.length === 0) return 0;
  const resp     = totalResponse(filters, freqs, fs);
  const maxBoost = Math.max(...resp);
  if (maxBoost <= 0) return 0;
  const pregain = -(maxBoost + PREAMP_HEADROOM);
  return Math.max(gainRange[0], Math.min(gainRange[1], pregain));
}

// ─── Main optimizer ───────────────────────────────────────────────────────────

/**
 * Find optimal PEQ filter parameters to match measured to target.
 *
 * Pipeline (reverse-engineered from AutoEQ):
 *   1. Resolve specs
 *   2. Interpolate to pipeline grid (1.01)
 *   3. Center measured at 1 kHz
 *   4. Compute error = measured - target
 *   5. Equalize: smooth, slope-limit, gain-cap, re-smooth
 *   6. Interpolate equalization to optimizer grid (1.02)
 *   7. Initialize filters (HSQ → LSQ → PK)
 *   8. Joint optimize
 *   9. Compute pregain
 *
 * @param {{freq: number, db: number}[]} measured
 * @param {{freq: number, db: number}[]} target
 * @param {Object} constraints
 * @returns {{ pregain: number, filters: {type: string, fc: number, gain: number, Q: number}[] }}
 */
export function optimize(measured: FreqPoint[], target: FreqPoint[], constraints: Constraints): OptimizeResult {
  const fs = constraints.fs ?? DEFAULT_FS;
  const freqRange: [number, number] = constraints.freqRange ?? [20, 10000];
  const specs = resolveSpecs(constraints.filterSpecs, freqRange);

  // Step 2: interpolate to pipeline grid
  const measInterp   = interpolate(measured, PIPELINE_GRID);
  const targetInterp = interpolate(target, PIPELINE_GRID);

  // Step 3: center measured at 1 kHz
  const ix1k = measInterp.findIndex(pt => pt.freq >= 1000);
  const offset1k = measInterp[ix1k].db;
  const measCentered = measInterp.map(pt => ({ freq: pt.freq, db: pt.db - offset1k }));

  // Step 3b: normalize target at 1 kHz (matching AutoEQ's target.center() inside fr.compensate())
  const targetNormalized = targetInterp.map(pt => ({ freq: pt.freq, db: pt.db - targetInterp[ix1k].db }));

  // Step 4: compute error (compensate on the same grid)
  const error = compensate(measCentered, targetNormalized);

  // Step 5: equalize (slope-limited, gain-capped correction curve)
  const equalizationPipeline = equalize(error);

  // Step 6: interpolate equalization to optimizer grid (1.02)
  const eqOnOptGrid = interpolate(equalizationPipeline, OPTIMIZER_GRID);
  const optFreqs = eqOnOptGrid.map(pt => pt.freq);
  const correctionDb = eqOnOptGrid.map(pt => pt.db);

  // Step 7: initialize filters (HSQ first → LSQ → PK last)
  // Sort by init_order: HSQ=2, LSQ=1, PK=0 (descending)
  const typeOrder: Record<FilterType, number> = { HSQ: 2, LSQ: 1, PK: 0 };
  const initOrder = specs.map((s, i) => ({
    idx: i,
    order: typeOrder[s.type] * 100 +
      (s.fcRange[1] > s.fcRange[0]
        ? 1 / Math.log2(s.fcRange[1] / s.fcRange[0])
        : 0),
  }));
  initOrder.sort((a, b) => b.order - a.order);

  const initialFilters: Filter[] = new Array<Filter>(specs.length);
  const remaining = correctionDb.slice();

  for (const { idx } of initOrder) {
    const filt = initFilter(optFreqs, remaining, specs[idx], fs);
    initialFilters[idx] = filt;
    // Subtract this filter's response from remaining
    const resp = biquadResponse(filt.type, filt.fc, filt.gain, filt.Q, optFreqs, fs);
    for (let i = 0; i < remaining.length; i++) remaining[i] -= resp[i];
  }

  // Step 8: joint optimize
  const optimized = jointOptimize(initialFilters, specs, optFreqs, correctionDb, fs);

  // Step 9: pregain
  const overallGainRange: [number, number] = [
    Math.min(...specs.map(s => s.gainRange[0])),
    Math.max(...specs.map(s => s.gainRange[1])),
  ];
  const pregain = computePregain(optimized, optFreqs, fs, overallGainRange);

  return {
    pregain: Math.round(pregain * 10000) / 10000,
    filters: optimized.map(f => ({
      type: f.type,
      fc:   Math.round(f.fc * 100) / 100,
      gain: Math.round(f.gain * 10000) / 10000,
      Q:    Math.round(f.Q * 10000) / 10000,
    })),
  };
}
