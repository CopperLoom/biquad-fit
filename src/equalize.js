/**
 * equalize.js — v1.0
 *
 * Computes the equalization (correction) curve from an error curve,
 * faithfully matching AutoEQ's equalize() pipeline:
 *
 *   1. Two-zone smooth the error
 *   2. Negate (correction = -smoothed_error)
 *   3. Find peaks/dips with prominence ≥ 1
 *   4. If peaks exist: slope-limit (dual-direction), gain-cap, re-smooth
 *
 * Spec: docs/joint-optimizer-spec.md §2.2, §12
 */

import { smooth } from './smooth.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

const TREBLE_F_LOWER        = 6000;
const TREBLE_F_UPPER        = 8000;
const NORMAL_SMOOTH_OCTAVES = 1 / 12;
const TREBLE_SMOOTH_OCTAVES = 2.0;
const MAX_SLOPE             = 18.0;   // dB/octave
const MAX_GAIN              = 6.0;    // dB (positive only)
const RE_SMOOTH_OCTAVES     = 1 / 5;

// ─── Two-zone smoothing ────────────────────────────────────────────────────────

/**
 * Smooth using AutoEQ's dual-window approach:
 *   - Below 6 kHz: 1/12 octave
 *   - Above 8 kHz: 2 octave
 *   - 6–8 kHz: sigmoid blend in log-frequency space
 *
 * @param {{freq: number, db: number}[]} fr
 * @param {number} [normalOct=1/12]
 * @param {number} [trebleOct=2.0]
 * @returns {{freq: number, db: number}[]}
 */
function twoZoneSmooth(fr, normalOct = NORMAL_SMOOTH_OCTAVES, trebleOct = TREBLE_SMOOTH_OCTAVES) {
  const normal = smooth(fr, { windowOctaves: normalOct });
  const treble = smooth(fr, { windowOctaves: trebleOct });

  const fCenter   = Math.sqrt(TREBLE_F_UPPER / TREBLE_F_LOWER) * TREBLE_F_LOWER;
  const halfRange = Math.log10(TREBLE_F_UPPER) - Math.log10(fCenter);
  const logFCtr   = Math.log10(fCenter);

  return fr.map((pt, i) => {
    const x       = (Math.log10(pt.freq) - logFCtr) / (halfRange / 4);
    const kTreble = 1 / (1 + Math.exp(-x));
    const kNormal = 1 - kTreble;
    return { freq: pt.freq, db: normal[i].db * kNormal + treble[i].db * kTreble };
  });
}

// ─── Peak finding with prominence ──────────────────────────────────────────────

/**
 * Find peaks in arr with prominence >= minProminence.
 * Returns array of indices.
 *
 * Prominence: how far a peak stands above the higher of its two
 * neighboring valleys (the minimum between this peak and the next
 * higher peak on each side).
 */
function findPeaks(arr, minProminence = 1) {
  // Step 1: find all local maxima, including plateau midpoints.
  // Scipy's find_peaks handles plateaus by finding flat regions that are
  // higher than both sides, then selecting the midpoint.
  const maxima = [];
  let i = 1;
  while (i < arr.length - 1) {
    if (arr[i] > arr[i - 1]) {
      // Rising edge — scan forward past any plateau
      let j = i;
      while (j < arr.length - 1 && arr[j + 1] === arr[j]) j++;
      // j is the end of the plateau (or same as i if no plateau)
      if (j === arr.length - 1 || arr[j + 1] < arr[j]) {
        // Falling edge after plateau — it's a peak. Use midpoint.
        maxima.push((i + j) >> 1);
      }
      i = j + 1;
    } else {
      i++;
    }
  }

  if (maxima.length === 0) return [];

  // Step 2: compute prominence for each maximum
  const peaks = [];
  for (const ix of maxima) {
    const h = arr[ix];

    // Scan left: find the minimum between this peak and the nearest higher peak
    let leftMin = h;
    for (let j = ix - 1; j >= 0; j--) {
      if (arr[j] < leftMin) leftMin = arr[j];
      if (arr[j] > h) break;  // reached a higher peak
    }

    // Scan right: same
    let rightMin = h;
    for (let j = ix + 1; j < arr.length; j++) {
      if (arr[j] < rightMin) rightMin = arr[j];
      if (arr[j] > h) break;
    }

    const prominence = h - Math.max(leftMin, rightMin);
    if (prominence >= minProminence) {
      peaks.push(ix);
    }
  }

  return peaks;
}

// ─── Protection mask ───────────────────────────────────────────────────────────

/**
 * Find zones around dips that sit lower than their neighboring dips.
 * These zones are marked as "limit-free" — the slope limiter won't clip here.
 *
 * Spec: §12.2
 *
 * @param {number[]} y - correction curve values
 * @param {number[]} peakInds - indices of peaks (prominence ≥ 1)
 * @param {number[]} dipInds - indices of dips (prominence ≥ 1)
 * @returns {boolean[]} mask - true = limit-free
 */
function protectionMask(y, peakInds, dipInds) {
  const n = y.length;
  const mask = new Array(n).fill(false);

  // Build extended dip list with sentinel
  let extDipInds, dipLevels;

  if (peakInds.length > 0 && (dipInds.length === 0 || peakInds[peakInds.length - 1] > dipInds[dipInds.length - 1])) {
    // Last significant feature is a peak — add synthetic dip after it
    let lastDipIx = peakInds[peakInds.length - 1];
    let minVal = y[lastDipIx];
    for (let j = lastDipIx; j < n; j++) {
      if (y[j] < minVal) { minVal = y[j]; lastDipIx = j; }
    }
    extDipInds = [...dipInds, lastDipIx];
    dipLevels = extDipInds.map(ix => y[ix]);
  } else {
    extDipInds = [...dipInds, -1]; // sentinel
    dipLevels = extDipInds.map(ix => (ix >= 0 ? y[ix] : 0));
    // Sentinel level = global minimum
    let globalMin = Infinity;
    for (let j = 0; j < n; j++) {
      if (y[j] < globalMin) globalMin = y[j];
    }
    dipLevels[dipLevels.length - 1] = globalMin;
  }

  if (extDipInds.length < 3) return mask;

  // For each interior dip, check if it's lower than neighbors
  for (let i = 1; i < extDipInds.length - 1; i++) {
    const dipIx = extDipInds[i];
    const targetLeft  = dipLevels[i - 1];
    const targetRight = dipLevels[i + 1];

    // Scan left from dip: find where y rises to targetLeft
    let leftIx = dipIx;
    for (let j = dipIx - 1; j >= 0; j--) {
      if (y[j] >= targetLeft) { leftIx = j + 1; break; }
      if (j === 0) leftIx = 0;
    }

    // Scan right from dip: find where y rises to targetRight
    let rightIx = dipIx;
    for (let j = dipIx + 1; j < n; j++) {
      if (y[j] >= targetRight) { rightIx = j - 1; break; }
      if (j === n - 1) rightIx = n - 1;
    }

    for (let j = leftIx; j <= rightIx; j++) {
      mask[j] = true;
    }
  }

  return mask;
}

// ─── RTL start index ───────────────────────────────────────────────────────────

/**
 * Determine where the right-to-left slope-limiting pass begins.
 *
 * Spec: §12.3
 *
 * @param {number[]} y
 * @param {number[]} peakInds
 * @param {number[]} dipInds
 * @returns {number}
 */
function findRtlStart(y, peakInds, dipInds) {
  const n = y.length;

  if (peakInds.length > 0 && (dipInds.length === 0 || peakInds[peakInds.length - 1] > dipInds[dipInds.length - 1])) {
    // Last significant feature is a positive peak
    const lastPeak = peakInds[peakInds.length - 1];
    let threshold;
    if (dipInds.length > 0) {
      threshold = y[dipInds[dipInds.length - 1]];
    } else {
      threshold = Math.max(y[0], y[n - 1]);
    }

    for (let j = lastPeak; j < n; j++) {
      if (y[j] <= threshold) return j;
    }
    return n - 1;
  } else {
    // Last significant feature is a dip
    return dipInds[dipInds.length - 1];
  }
}

// ─── Slope limiter (LTR with region validation) ────────────────────────────────

/**
 * Limit left-to-right slope to max_slope dB/octave.
 * Clipped regions that contain no peaks are discarded (original values restored).
 *
 * Spec: §12.1
 *
 * @param {number[]} freqs
 * @param {number[]} y
 * @param {number} maxSlope
 * @param {number} startIndex
 * @param {number[]} peakInds
 * @param {boolean[]} limitFreeMask
 * @returns {number[]}
 */
function limitedLtrSlope(freqs, y, maxSlope, startIndex, peakInds, limitFreeMask) {
  const n = y.length;
  const limited = new Array(n);
  const clipped = new Array(n).fill(false);
  const regions = []; // list of [start, end) pairs

  for (let i = 0; i < n; i++) {
    if (i <= startIndex) {
      limited[i] = y[i];
      continue;
    }

    const octaves = Math.log2(freqs[i] / freqs[i - 1]);
    const slope = (y[i] - limited[i - 1]) / octaves;

    if (slope > maxSlope && !limitFreeMask[i]) {
      // Clip
      if (!clipped[i - 1]) {
        regions.push([i]); // start new region
      }
      clipped[i] = true;
      limited[i] = limited[i - 1] + maxSlope * octaves;
    } else {
      // No clipping
      limited[i] = y[i];

      if (clipped[i - 1]) {
        // End of clipped region — validate
        const region = regions[regions.length - 1];
        region.push(i + 1); // close [start, end)
        const regionStart = region[0];

        // Check if any peaks fall within this region
        let hasPeak = false;
        for (let p = 0; p < peakInds.length; p++) {
          if (peakInds[p] >= regionStart && peakInds[p] < i) {
            hasPeak = true;
            break;
          }
        }

        if (!hasPeak) {
          // No peaks — discard limitation
          for (let j = regionStart; j < i; j++) {
            limited[j] = y[j];
            clipped[j] = false;
          }
          regions.pop();
        }
      }
    }
  }

  // Close any region that extends to the end
  if (regions.length > 0 && regions[regions.length - 1].length === 1) {
    regions[regions.length - 1].push(n - 1);
  }

  return limited;
}

/**
 * Limit right-to-left slope by flipping, running LTR, and flipping back.
 *
 * @param {number[]} freqs
 * @param {number[]} y
 * @param {number} maxSlope
 * @param {number} rtlStart - index in original (unflipped) array
 * @param {number[]} peakInds
 * @param {boolean[]} limitFreeMask
 * @returns {number[]}
 */
function limitedRtlSlope(freqs, y, maxSlope, rtlStart, peakInds, limitFreeMask) {
  const n = y.length;

  // Flip arrays
  const flippedY = [...y].reverse();
  const flippedFreqs = [...freqs].reverse();
  const flippedMask = [...limitFreeMask].reverse();
  const flippedPeaks = peakInds.map(p => n - p - 1);
  const flippedStart = n - rtlStart - 1;

  const flippedResult = limitedLtrSlope(flippedFreqs, flippedY, maxSlope, flippedStart, flippedPeaks, flippedMask);

  return flippedResult.reverse();
}

// ─── Main equalize function ────────────────────────────────────────────────────

/**
 * Compute the equalization curve from a compensated error curve.
 *
 * Implements the full AutoEQ equalize() pipeline:
 *   1. Two-zone smooth the error
 *   2. Negate to get correction curve
 *   3. Find peaks/dips with prominence ≥ 1
 *   4. If no peaks/dips: return negated smoothed error
 *   5. Otherwise: slope-limit (dual-direction with region validation),
 *      gain-cap (+6 dB), re-smooth (1/5 octave)
 *
 * @param {{freq: number, db: number}[]} error - output of compensate(), on 1.01 grid
 * @returns {{freq: number, db: number}[]}
 */
export function equalize(error) {
  const freqs = error.map(pt => pt.freq);
  const n = freqs.length;

  // Step 1: two-zone smooth
  const smoothed = twoZoneSmooth(error);

  // Step 2: negate (correction = -smoothed_error)
  const y = smoothed.map(pt => -pt.db);

  // Step 3: find peaks and dips with prominence ≥ 1
  const negY = y.map(v => -v);
  const peakInds = findPeaks(y, 1);
  const dipInds  = findPeaks(negY, 1);

  // Step 4: if no significant peaks or dips, return as-is
  if (peakInds.length === 0 && dipInds.length === 0) {
    return y.map((v, i) => ({ freq: freqs[i], db: v }));
  }

  // Step 5: slope limiting
  const limitFreeMask = protectionMask(y, peakInds, dipInds);
  const rtlStart = findRtlStart(y, peakInds, dipInds);

  // All peak and dip indices for region validation
  const allPeakInds = [...peakInds, ...dipInds].sort((a, b) => a - b);

  const ltr = limitedLtrSlope(freqs, y, MAX_SLOPE, 0, allPeakInds, limitFreeMask);
  const rtl = limitedRtlSlope(freqs, y, MAX_SLOPE, rtlStart, allPeakInds, limitFreeMask);

  // Combine: element-wise minimum
  const combined = new Array(n);
  for (let i = 0; i < n; i++) {
    combined[i] = Math.min(ltr[i], rtl[i]);
  }

  // Step 6: clip positive gain to MAX_GAIN (no cap on cuts)
  for (let i = 0; i < n; i++) {
    if (combined[i] > MAX_GAIN) combined[i] = MAX_GAIN;
  }

  // Step 7: re-smooth with 1/5 octave (both zones)
  const toSmooth = combined.map((v, i) => ({ freq: freqs[i], db: v }));
  const reSmoothed = twoZoneSmooth(toSmooth, RE_SMOOTH_OCTAVES, RE_SMOOTH_OCTAVES);

  return reSmoothed;
}
