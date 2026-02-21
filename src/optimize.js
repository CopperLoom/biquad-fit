/**
 * optimize.js — v1.0
 *
 * Joint parametric EQ optimizer matching AutoEQ's SLSQP approach.
 *
 * Algorithm:
 *   1. Resolve filterSpecs (new API) or expand maxFilters+gainRange+qRange (old API)
 *   2. Sequential initialization: HSQ → LSQ → PK, each against remaining correction
 *   3. Joint coordinate-descent over all filter params simultaneously,
 *      with STD-based convergence stopping (mirrors AutoEQ's SLSQP behavior)
 *   4. Compute pregain
 *
 * New API:
 *   optimize(measured, target, {
 *     filterSpecs: [{ type, gainRange, qRange?, fcRange? }, ...],
 *     freqRange: [20, 10000],
 *     fs: 44100,
 *   })
 *
 * Old API (all-PK, backward compatible):
 *   optimize(measured, target, {
 *     maxFilters, gainRange, qRange, freqRange, fs,
 *   })
 *
 * Returns { pregain, filters } where filters is [{type, fc, gain, Q}].
 */

import { biquadResponse } from './biquadResponse.js';
import { compensate }     from './compensate.js';
import { smooth }         from './smooth.js';

const DEFAULT_FS      = 44100;
const GRID_OPTS       = { step: 1.02, fMin: 20, fMax: 20000 };
const SHELF_Q_RANGE   = [0.4, 0.7];
const SHELF_FC_RANGE  = [20, 10000];
const IX_10K_CUTOFF   = 10000;
const LOSS_FREQ_MAX   = 20000;  // AutoEQ DEFAULT_PEQ_OPTIMIZER_MAX_F
const MIN_STD         = 0.002;
const STD_WINDOW      = 8;
const MAX_JOINT_ITER  = 150;  // scipy fmin_slsqp default
const PREAMP_HEADROOM = 0.2;

// Treble smoothing transition zone (matches AutoEQ defaults)
const TREBLE_F_LOWER        = 6000;
const TREBLE_F_UPPER        = 8000;
const NORMAL_SMOOTH_OCTAVES = 1 / 12;
const TREBLE_SMOOTH_OCTAVES = 2.0;

// ─── Golden section search (1D minimizer) ─────────────────────────────────────

const PHI = (Math.sqrt(5) - 1) / 2;

function goldenSearch(f, lo, hi, logScale = false, tol = 1e-4, maxIter = 80) {
  let a = logScale ? Math.log(lo) : lo;
  let b = logScale ? Math.log(hi) : hi;
  let c = b - PHI * (b - a);
  let d = a + PHI * (b - a);

  const ev = x => f(logScale ? Math.exp(x) : x);

  for (let i = 0; i < maxIter; i++) {
    if (Math.abs(b - a) < tol) break;
    if (ev(c) < ev(d)) { b = d; } else { a = c; }
    c = b - PHI * (b - a);
    d = a + PHI * (b - a);
  }

  const x = (a + b) / 2;
  return logScale ? Math.exp(x) : x;
}

// ─── Two-zone smoothing (matching AutoEQ's smoothen()) ────────────────────────

/**
 * Smooth a log-spaced FR using AutoEQ's dual-window approach:
 *   - Below 6 kHz:    1/12 octave window
 *   - Above 8 kHz:    2 octave window
 *   - 6–8 kHz:        sigmoid blend between the two in log-frequency space
 *
 * AutoEQ uses Savitzky-Golay; we use our existing moving-average smooth().
 * The window sizes match, so treble smoothing behavior is equivalent.
 */
function twoZoneSmooth(fr) {
  const normal = smooth(fr, { windowOctaves: NORMAL_SMOOTH_OCTAVES });
  const treble = smooth(fr, { windowOctaves: TREBLE_SMOOTH_OCTAVES });

  // Sigmoid centre = geometric mean of transition band in log-frequency space
  const fCenter   = Math.sqrt(TREBLE_F_UPPER / TREBLE_F_LOWER) * TREBLE_F_LOWER;
  const halfRange = Math.log10(TREBLE_F_UPPER) - Math.log10(fCenter);
  const logFCtr   = Math.log10(fCenter);

  return fr.map((pt, i) => {
    const x       = (Math.log10(pt.freq) - logFCtr) / (halfRange / 4);
    const kTreble = 1 / (1 + Math.exp(-x));   // 0 below, 1 above transition
    const kNormal = 1 - kTreble;
    return { freq: pt.freq, db: normal[i].db * kNormal + treble[i].db * kTreble };
  });
}

// ─── Resolve filterSpecs from constraints ─────────────────────────────────────

/**
 * Normalize constraints to an array of filter specs with all defaults filled in.
 * Accepts either the new filterSpecs API or the old maxFilters+gainRange+qRange API.
 */
function resolveSpecs(constraints, defaultFreqRange) {
  const {
    filterSpecs,
    maxFilters = 5,
    gainRange  = [-12, 12],
    qRange     = [0.18, 6.0],  // AutoEQ defaults: 0.18248 (5-oct max bw), 6.0
  } = constraints;

  const raw = filterSpecs
    ? filterSpecs
    : Array.from({ length: maxFilters }, () => ({ type: 'PK', gainRange, qRange }));

  return raw.map(s => {
    const type    = s.type || 'PK';
    const isShelf = type === 'LSQ' || type === 'HSQ';
    return {
      type,
      gainRange: s.gainRange ?? gainRange,
      qRange:    s.qRange    ?? (isShelf ? SHELF_Q_RANGE : qRange),
      fcRange:   s.fcRange   ?? (isShelf ? SHELF_FC_RANGE : defaultFreqRange),
    };
  });
}

// ─── Sharpness penalty (PK only, matching AutoEQ) ─────────────────────────────

/**
 * Penalizes PK filters with slopes steeper than ~18 dB/octave.
 * Uses a sigmoid that jumps from 0 to 1 around the limit gain for a given Q.
 */
function sharpnessPenalty(type, fc, gain, Q, freqs, fs) {
  if (type !== 'PK') return 0;
  const gainLimit = -0.09503189270199464 + 20.575128011847003 / Q;
  if (gainLimit <= 0) return 0;
  const x     = gain / gainLimit - 1;
  const coeff = 1 / (1 + Math.exp(-100 * x));
  const fr    = biquadResponse(type, fc, gain, Q, freqs, fs);
  return fr.reduce((s, v) => s + (v * coeff) ** 2, 0) / fr.length;
}

// ─── Filter initialization ────────────────────────────────────────────────────

/**
 * Find indices of local maxima in arr.
 */
function findLocalPeaks(arr) {
  const peaks = [];
  for (let i = 1; i < arr.length - 1; i++) {
    if (arr[i] > arr[i - 1] && arr[i] > arr[i + 1]) peaks.push(i);
  }
  return peaks;
}

/**
 * Initialize a Peaking filter.
 * correctionDb: what we want the filters to provide (positive = boost, negative = cut).
 * Finds the biggest peak by height × width, sets fc/gain/Q accordingly.
 */
function initPeaking(freqs, correctionDb, spec) {
  const { gainRange, qRange, fcRange } = spec;

  const minFcIdx = freqs.findIndex(f => f >= fcRange[0]);
  let maxFcIdx = 0;
  for (let i = freqs.length - 1; i >= 0; i--) {
    if (freqs[i] <= fcRange[1]) { maxFcIdx = i; break; }
  }

  const posCorr = correctionDb.map(v => Math.max(v, 0));
  const negCorr = correctionDb.map(v => Math.max(-v, 0));

  let bestIx = minFcIdx, bestSize = -1;

  const evalPeaks = (peaks, arr, offset) => {
    for (const ix of peaks) {
      const absIx = ix + offset;
      if (absIx < minFcIdx || absIx > maxFcIdx) continue;
      const height = arr[ix];
      if (height <= 0) continue;
      let lo = ix, hi = ix;
      while (lo > 0          && arr[lo - 1] > height / 2) lo--;
      while (hi < arr.length - 1 && arr[hi + 1] > height / 2) hi++;
      const size = height * (hi - lo + 1);
      if (size > bestSize) { bestSize = size; bestIx = absIx; }
    }
  };

  const slicedPos = posCorr.slice(minFcIdx, maxFcIdx + 1);
  const slicedNeg = negCorr.slice(minFcIdx, maxFcIdx + 1);
  evalPeaks(findLocalPeaks(slicedPos), slicedPos, minFcIdx);
  evalPeaks(findLocalPeaks(slicedNeg), slicedNeg, minFcIdx);

  if (bestSize < 0) {
    // Fallback: largest absolute correction point
    let maxAbs = 0;
    for (let i = minFcIdx; i <= maxFcIdx; i++) {
      if (Math.abs(correctionDb[i]) > maxAbs) {
        maxAbs = Math.abs(correctionDb[i]);
        bestIx = i;
      }
    }
  }

  const fc   = Math.max(fcRange[0], Math.min(fcRange[1], freqs[bestIx]));
  const gain = Math.max(gainRange[0], Math.min(gainRange[1], correctionDb[bestIx]));

  // Estimate Q from peak width in octaves
  let Q = 1.4;
  {
    const h = Math.abs(correctionDb[bestIx]) / 2;
    let lo = bestIx, hi = bestIx;
    while (lo > 0              && Math.abs(correctionDb[lo - 1]) > h) lo--;
    while (hi < freqs.length - 1 && Math.abs(correctionDb[hi + 1]) > h) hi++;
    if (hi > lo && freqs[lo] > 0) {
      const bw = Math.pow(2, Math.log2(freqs[hi] / freqs[lo]));
      if (bw > 1) Q = Math.sqrt(bw) / (bw - 1);
    }
  }
  Q = Math.max(qRange[0], Math.min(qRange[1], Q));

  return { type: 'PK', fc, gain, Q };
}

/**
 * Initialize a LowShelf filter.
 * Finds the frequency where the cumulative average of correctionDb is greatest,
 * then sets gain as the weighted average (shelf FR as weights).
 */
function initLowShelf(freqs, correctionDb, spec, fs) {
  const { gainRange, qRange, fcRange } = spec;

  const minIx = Math.max(0, freqs.findIndex(f => f >= Math.max(40, fcRange[0])));
  let maxIx = minIx;
  for (let i = freqs.length - 1; i >= 0; i--) {
    if (freqs[i] < Math.min(10000, fcRange[1])) { maxIx = i; break; }
  }

  let bestIx = minIx, bestAvg = 0;
  for (let i = minIx; i <= maxIx; i++) {
    const avg = Math.abs(correctionDb.slice(0, i + 1).reduce((s, v) => s + v, 0) / (i + 1));
    if (avg > bestAvg) { bestAvg = avg; bestIx = i; }
  }

  const fc = Math.max(fcRange[0], Math.min(fcRange[1], freqs[bestIx]));
  const Q  = Math.max(qRange[0], Math.min(qRange[1], 0.7));

  // Weighted average: weight by abs(shelf FR at gain=1)
  const shelfFr = biquadResponse('LSQ', fc, 1, Q, freqs, fs);
  const wtSum   = shelfFr.reduce((s, v) => s + Math.abs(v), 0);
  let gain = wtSum > 0
    ? correctionDb.reduce((s, v, i) => s + v * Math.abs(shelfFr[i]), 0) / wtSum
    : 0;
  gain = Math.max(gainRange[0], Math.min(gainRange[1], gain));

  return { type: 'LSQ', fc, gain, Q };
}

/**
 * Initialize a HighShelf filter.
 * Finds the frequency where the average of correctionDb after it is greatest,
 * then sets gain as the weighted average (shelf FR as weights).
 */
function initHighShelf(freqs, correctionDb, spec, fs) {
  const { gainRange, qRange, fcRange } = spec;

  const minIx = Math.max(0, freqs.findIndex(f => f >= Math.max(40, fcRange[0])));
  let maxIx = minIx;
  for (let i = freqs.length - 1; i >= 0; i--) {
    if (freqs[i] < Math.min(10000, fcRange[1])) { maxIx = i; break; }
  }

  let bestIx = minIx, bestAvg = 0;
  for (let i = minIx; i <= maxIx; i++) {
    const slice = correctionDb.slice(i);
    const avg = Math.abs(slice.reduce((s, v) => s + v, 0) / slice.length);
    if (avg > bestAvg) { bestAvg = avg; bestIx = i; }
  }

  const fc = Math.max(fcRange[0], Math.min(fcRange[1], freqs[bestIx]));
  const Q  = Math.max(qRange[0], Math.min(qRange[1], 0.7));

  const shelfFr = biquadResponse('HSQ', fc, 1, Q, freqs, fs);
  const wtSum   = shelfFr.reduce((s, v) => s + Math.abs(v), 0);
  let gain = wtSum > 0
    ? correctionDb.reduce((s, v, i) => s + v * Math.abs(shelfFr[i]), 0) / wtSum
    : 0;
  gain = Math.max(gainRange[0], Math.min(gainRange[1], gain));

  return { type: 'HSQ', fc, gain, Q };
}

function initFilter(freqs, correctionDb, spec, fs) {
  if (spec.type === 'LSQ') return initLowShelf(freqs, correctionDb, spec, fs);
  if (spec.type === 'HSQ') return initHighShelf(freqs, correctionDb, spec, fs);
  return initPeaking(freqs, correctionDb, spec);
}

// ─── Joint loss function ──────────────────────────────────────────────────────

/**
 * Sum filter responses across all filters.
 */
function totalResponse(filters, freqs, fs) {
  const sum = new Array(freqs.length).fill(0);
  for (const f of filters) {
    const r = biquadResponse(f.type, f.fc, f.gain, f.Q, freqs, fs);
    for (let i = 0; i < sum.length; i++) sum[i] += r[i];
  }
  return sum;
}

/**
 * Compute joint loss: sqrt(MSE(correctionDb - totalResponse, in freqRange) + sharpness penalties).
 * Above 10 kHz, both curves are replaced by their averages (total energy only).
 * Matches AutoEQ's _optimizer_loss.
 */
function jointLoss(filters, freqs, correctionDb, fs) {
  const fr  = totalResponse(filters, freqs, fs);
  const tgt = correctionDb.slice();

  // Above 10 kHz: replace both with their averages
  let ix10k = freqs.length;
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] >= IX_10K_CUTOFF) { ix10k = i; break; }
  }
  if (ix10k < freqs.length) {
    const tgtAbove = tgt.slice(ix10k);
    const frAbove  = fr.slice(ix10k);
    const tgtAvg   = tgtAbove.reduce((s, v) => s + v, 0) / tgtAbove.length;
    const frAvg    = frAbove.reduce((s, v) => s + v, 0)  / frAbove.length;
    for (let i = ix10k; i < tgt.length; i++) { tgt[i] = tgtAvg; fr[i] = frAvg; }
  }

  // MSE over [20, 20000] Hz — always hardcoded, matching AutoEQ's
  // DEFAULT_PEQ_OPTIMIZER_MIN_F = 20 and DEFAULT_PEQ_OPTIMIZER_MAX_F = 20000.
  // freqRange controls filter fc placement only, never the loss range.
  let minIx = 0, maxIx = freqs.length - 1;
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] >= 20) { minIx = i; break; }
  }
  for (let i = freqs.length - 1; i >= 0; i--) {
    if (freqs[i] <= LOSS_FREQ_MAX) { maxIx = i; break; }
  }

  let mse = 0;
  const n = maxIx - minIx + 1;
  for (let i = minIx; i <= maxIx; i++) {
    const diff = tgt[i] - fr[i];
    mse += diff * diff;
  }
  mse /= n;

  // Sharpness penalties
  for (const f of filters) {
    mse += sharpnessPenalty(f.type, f.fc, f.gain, f.Q, freqs, fs);
  }

  return Math.sqrt(mse);
}

// ─── Joint optimizer ──────────────────────────────────────────────────────────
//
// TODO: implement a faithful equivalent of scipy.optimize.fmin_slsqp.
//
// Before implementing:
//   1. Read peq.py — specifically _optimizer_loss() and the fmin_slsqp call
//   2. Read scipy fmin_slsqp docs for parameter semantics (bounds, fprime, iter)
//   3. Write a technical spec and get sign-off before writing any code
//
// Known-bad approach: coordinate descent (one param at a time) — gets stuck in
// local minima for ≥10 filters. Do not reimplement this.
//
// The correct approach must update all parameters simultaneously using gradient
// information, matching SLSQP's behavior.
//
// Inputs:  initialFilters, specs, freqs, correctionDb, freqRange, fs
// Returns: filters[] (same shape as initialFilters, optimized)

// ─── Pregain ──────────────────────────────────────────────────────────────────

function computePregain(filters, freqs, fs, gainRange) {
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
 * @param {{freq: number, db: number}[]} measured
 * @param {{freq: number, db: number}[]} target
 * @param {{
 *   filterSpecs?: {type: string, gainRange: number[], qRange?: number[], fcRange?: number[]}[],
 *   maxFilters?:  number,
 *   gainRange?:   [number, number],
 *   qRange?:      [number, number],
 *   freqRange?:   [number, number],
 *   fs?:          number,
 * }} [constraints]
 * @returns {{ pregain: number, filters: {type: string, fc: number, gain: number, Q: number}[] }}
 */
export function optimize(_measured, _target, _constraints = {}) {
  // TODO: implement once jointOptimize is specced and signed off.
  // See the TODO block above jointOptimize for the required approach.
  throw new Error('optimize() not implemented — joint optimizer pending design');
}
