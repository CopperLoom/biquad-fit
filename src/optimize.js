/**
 * optimize.js
 *
 * Greedy parametric EQ optimizer (v1).
 *
 * Algorithm:
 *   For each filter slot:
 *     1. Find the frequency of maximum absolute error in the residual
 *     2. Initialize a PK filter at that frequency
 *     3. Optimize (fc, gain, Q) via coordinate descent + golden section search
 *     4. Subtract the optimized filter's response from the residual
 *
 * Returns { pregain, filters } where pregain is a global dB offset and
 * filters is an array of { type, fc, gain, Q }.
 *
 * The differential evolution optimizer (v2) will replace this for v1.0.
 */

import { biquadResponse } from './biquadResponse.js';
import { compensate } from './compensate.js';

const GRID_OPTS = { step: 1.02, fMin: 20, fMax: 20000 };

// ─── Golden section search (1D minimizer) ────────────────────────────────────

const PHI = (Math.sqrt(5) - 1) / 2;

/**
 * Find the minimum of f over [lo, hi].
 * logScale=true searches in log space (for frequency optimization).
 */
function goldenSearch(f, lo, hi, logScale = false, tol = 1e-4, maxIter = 80) {
  let a = logScale ? Math.log(lo) : lo;
  let b = logScale ? Math.log(hi) : hi;
  let c = b - PHI * (b - a);
  let d = a + PHI * (b - a);

  const eval_ = x => f(logScale ? Math.exp(x) : x);

  for (let i = 0; i < maxIter; i++) {
    if (Math.abs(b - a) < tol) break;
    if (eval_(c) < eval_(d)) {
      b = d;
    } else {
      a = c;
    }
    c = b - PHI * (b - a);
    d = a + PHI * (b - a);
  }

  const x = (a + b) / 2;
  return logScale ? Math.exp(x) : x;
}

// ─── RMSE between a filter's response and the residual target ────────────────

function filterRMSE(type, fc, gain, Q, freqs, targetDb, fs) {
  const response = biquadResponse(type, fc, gain, Q, freqs, fs);
  const ss = response.reduce((s, r, i) => {
    const diff = targetDb[i] - r;
    return s + diff * diff;
  }, 0);
  return Math.sqrt(ss / freqs.length);
}

// ─── Single-filter optimizer ─────────────────────────────────────────────────

/**
 * Optimize a single biquad filter against a residual error curve.
 * Uses coordinate descent: cycles over fc, gain, Q with golden section.
 */
function optimizeSingleFilter(freqs, residualDb, init, constraints, fs) {
  const { gainRange, qRange, freqRange } = constraints;
  let { type, fc, gain, Q } = init;

  // Clamp initial values to bounds
  fc   = Math.max(freqRange[0], Math.min(freqRange[1], fc));
  gain = Math.max(gainRange[0], Math.min(gainRange[1], gain));
  Q    = Math.max(qRange[0],    Math.min(qRange[1],    Q));

  const rmse = (fc_, gain_, Q_) => filterRMSE(type, fc_, gain_, Q_, freqs, residualDb, fs);

  for (let iter = 0; iter < 6; iter++) {
    const prevRmse = rmse(fc, gain, Q);

    fc   = goldenSearch(f => rmse(f, gain, Q),  freqRange[0], freqRange[1], true);
    gain = goldenSearch(g => rmse(fc, g, Q),    gainRange[0], gainRange[1]);
    Q    = goldenSearch(q => rmse(fc, gain, q), qRange[0],    qRange[1]);

    if (Math.abs(prevRmse - rmse(fc, gain, Q)) < 1e-6) break;
  }

  return { type, fc, gain, Q };
}

// ─── Pregain ─────────────────────────────────────────────────────────────────

/**
 * Compute pregain: the negative of the maximum positive sum of all filter
 * responses across the optimization grid. Prevents the corrected signal
 * from boosting above the original level. Clamped to gainRange.
 */
function computePregain(filters, freqs, fs, gainRange) {
  if (filters.length === 0) return 0;

  const sumDb = freqs.map((f, i) =>
    filters.reduce((s, filt) => {
      const r = biquadResponse(filt.type, filt.fc, filt.gain, filt.Q, [f], fs);
      return s + r[0];
    }, 0)
  );

  const maxBoost = Math.max(...sumDb);
  const pregain  = maxBoost > 0 ? -maxBoost : 0;
  return Math.max(gainRange[0], Math.min(gainRange[1], pregain));
}

// ─── Main optimizer ───────────────────────────────────────────────────────────

/**
 * Find optimal PEQ filter parameters to match measured to target.
 *
 * @param {{freq: number, db: number}[]} measured
 * @param {{freq: number, db: number}[]} target
 * @param {{
 *   maxFilters?: number,
 *   gainRange?:  [number, number],
 *   qRange?:     [number, number],
 *   freqRange?:  [number, number],
 *   fs?:         number,
 * }} [constraints]
 * @returns {{ pregain: number, filters: {type: string, fc: number, gain: number, Q: number}[] }}
 */
export function optimize(measured, target, constraints = {}) {
  const {
    maxFilters = 5,
    gainRange  = [-12, 12],
    qRange     = [0.5, 10],
    freqRange  = [20, 10000],
    fs         = 44100,
  } = constraints;

  // Handle zero-gain constraint immediately
  if (gainRange[0] === 0 && gainRange[1] === 0) {
    return { pregain: 0, filters: Array.from({ length: maxFilters }, () =>
      ({ type: 'PK', fc: 1000, gain: 0, Q: 1 })) };
  }

  // Build residual on the optimization grid
  let residual = compensate(measured, target, GRID_OPTS);
  const freqs  = residual.map(pt => pt.freq);

  const filters = [];

  for (let slot = 0; slot < maxFilters; slot++) {
    // Find frequency with largest absolute error within freqRange
    let maxAbsDb = 0;
    let peakIdx  = 0;
    for (let j = 0; j < residual.length; j++) {
      const f = residual[j].freq;
      if (f >= freqRange[0] && f <= freqRange[1] && Math.abs(residual[j].db) > maxAbsDb) {
        maxAbsDb = Math.abs(residual[j].db);
        peakIdx  = j;
      }
    }

    if (maxAbsDb < 0.01) break; // Residual is negligible

    const initFc   = residual[peakIdx].freq;
    // Correction is the negation of the residual: if error is +8 dB, we need -8 dB filter
    const initGain = Math.max(gainRange[0], Math.min(gainRange[1], -residual[peakIdx].db));
    const initQ    = 1.4;

    // Target for the filter is -residual: we want filter_response ≈ -residual
    const correctionTarget = residual.map(pt => -pt.db);
    const filter = optimizeSingleFilter(
      freqs,
      correctionTarget,
      { type: 'PK', fc: initFc, gain: initGain, Q: initQ },
      { gainRange, qRange, freqRange },
      fs
    );

    filters.push(filter);

    // Update residual: new_residual = old_residual + correction_response
    // (applying the correction reduces the error toward zero)
    const response = biquadResponse(filter.type, filter.fc, filter.gain, filter.Q, freqs, fs);
    residual = residual.map((pt, i) => ({ ...pt, db: pt.db + response[i] }));
  }

  const pregain = computePregain(filters, freqs, fs, gainRange);

  return { pregain, filters };
}
