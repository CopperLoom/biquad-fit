import { describe, test, expect } from 'vitest';
import { interpolate } from '../../src/interpolate.js';

// interpolate(fr, options) -> {freq, db}[]
//
// fr:      array of {freq, db} points (any spacing, any density)
// options: { step, fMin, fMax }  — all optional, defaults match AutoEq
//
// Returns a new FR resampled to a log-spaced grid.
// Interpolation is log-linear (linear in log-frequency space).

const DEFAULTS = { step: 1.01, fMin: 20, fMax: 20000 };

// Expected point count for a log-spaced grid: floor(log(fMax/fMin) / log(step)) + 1
function expectedLength(fMin, fMax, step) {
  return Math.floor(Math.log(fMax / fMin) / Math.log(step)) + 1;
}

// Build a simple linear FR: db = m * log10(freq) + b
function linearFR(freqs, slope = 0, offset = 0) {
  return freqs.map(freq => ({ freq, db: slope * Math.log10(freq) + offset }));
}

describe('interpolate', () => {

  // ─── 3.3.1 Output length ──────────────────────────────────────────────────

  test('default options: output length matches expected grid size', () => {
    const fr = linearFR([20, 100, 1000, 10000, 20000]);
    const result = interpolate(fr);
    const expected = expectedLength(20, 20000, 1.01);
    expect(result.length).toBeCloseTo(expected, -1); // within 2
  });

  test('custom step=1.02: output length matches expected grid size', () => {
    const fr = linearFR([20, 100, 1000, 10000, 20000]);
    const result = interpolate(fr, { step: 1.02 });
    const expected = expectedLength(20, 20000, 1.02);
    expect(result.length).toBeCloseTo(expected, -1);
  });

  // ─── 3.3.2 Frequencies are log-spaced ────────────────────────────────────

  test('consecutive frequency ratios are constant (log-spaced)', () => {
    const fr = linearFR([20, 1000, 20000]);
    const result = interpolate(fr, DEFAULTS);
    const ratios = [];
    for (let i = 1; i < result.length; i++) {
      ratios.push(result[i].freq / result[i - 1].freq);
    }
    const first = ratios[0];
    ratios.forEach(r => expect(r).toBeCloseTo(first, 6));
  });

  test('frequency ratio equals the step option', () => {
    const step = 1.01;
    const fr = linearFR([20, 1000, 20000]);
    const result = interpolate(fr, { step, fMin: 20, fMax: 20000 });
    for (let i = 1; i < result.length; i++) {
      expect(result[i].freq / result[i - 1].freq).toBeCloseTo(step, 6);
    }
  });

  // ─── 3.3.3 Frequencies are monotonically increasing ──────────────────────

  test('output frequencies are strictly increasing', () => {
    const fr = linearFR([20, 500, 5000, 20000]);
    const result = interpolate(fr);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].freq).toBeGreaterThan(result[i - 1].freq);
    }
  });

  // ─── 3.3.4 Known analytical values preserved ─────────────────────────────
  // Input: flat 0 dB everywhere → output must be 0 dB everywhere

  test('flat input remains flat after interpolation', () => {
    const fr = [20, 100, 500, 1000, 5000, 20000].map(freq => ({ freq, db: 0 }));
    const result = interpolate(fr);
    result.forEach(pt => expect(pt.db).toBeCloseTo(0, 6));
  });

  // Input: constant +3 dB everywhere → output must be +3 dB everywhere
  test('constant non-zero input remains constant after interpolation', () => {
    const fr = [20, 100, 500, 1000, 5000, 20000].map(freq => ({ freq, db: 3 }));
    const result = interpolate(fr);
    result.forEach(pt => expect(pt.db).toBeCloseTo(3, 6));
  });

  // Input: linear ramp in log-freq space → interpolated midpoint is exactly mid-value.
  // fr = 0 dB at 100 Hz, +6 dB at 10000 Hz (linear in log-freq).
  // Geometric mean of 100 and 10000 is 1000 Hz → expected db = 3.0.
  test('log-linear interpolation: midpoint of log-ramp is correct', () => {
    const fr = [
      { freq: 100,   db: 0 },
      { freq: 10000, db: 6 },
    ];
    const result = interpolate(fr, { step: 1.01, fMin: 100, fMax: 10000 });
    // Find the point closest to 1000 Hz (geometric mean of 100 and 10000)
    const mid = result.reduce((best, pt) =>
      Math.abs(Math.log(pt.freq) - Math.log(1000)) <
      Math.abs(Math.log(best.freq) - Math.log(1000)) ? pt : best
    );
    expect(mid.db).toBeCloseTo(3.0, 1);
  });

  // ─── 3.3.5 Sparse input ───────────────────────────────────────────────────

  test('sparse input (3 points) → full output with no NaN or undefined', () => {
    const fr = [
      { freq: 20,    db: 0 },
      { freq: 1000,  db: 3 },
      { freq: 20000, db: 0 },
    ];
    const result = interpolate(fr);
    expect(result.length).toBeGreaterThan(10);
    result.forEach(pt => {
      expect(isNaN(pt.db)).toBe(false);
      expect(pt.db).toBeDefined();
      expect(isFinite(pt.db)).toBe(true);
    });
  });

  // ─── 3.3.6 Dense input (more points than output grid) ────────────────────

  test('dense input: output length matches grid regardless of input density', () => {
    // Build a 2000-point input
    const step = Math.pow(20000 / 20, 1 / 1999);
    const fr = Array.from({ length: 2000 }, (_, i) => ({
      freq: 20 * Math.pow(step, i),
      db: Math.sin(i * 0.1) * 3, // wavy curve
    }));
    const result = interpolate(fr);
    const expected = expectedLength(20, 20000, 1.01);
    expect(result.length).toBeCloseTo(expected, -1);
  });

  test('dense flat input: output is still flat', () => {
    const step = Math.pow(20000 / 20, 1 / 999);
    const fr = Array.from({ length: 1000 }, (_, i) => ({
      freq: 20 * Math.pow(step, i),
      db: 0,
    }));
    const result = interpolate(fr);
    result.forEach(pt => expect(pt.db).toBeCloseTo(0, 6));
  });

  // ─── 3.3.7 Output bounds ─────────────────────────────────────────────────

  test('first output frequency >= fMin', () => {
    const fr = linearFR([20, 1000, 20000]);
    const result = interpolate(fr, DEFAULTS);
    expect(result[0].freq).toBeGreaterThanOrEqual(20);
  });

  test('last output frequency <= fMax', () => {
    const fr = linearFR([20, 1000, 20000]);
    const result = interpolate(fr, DEFAULTS);
    expect(result[result.length - 1].freq).toBeLessThanOrEqual(20000);
  });

  // ─── 3.3.8 Output does not mutate input ──────────────────────────────────

  test('does not mutate input FR', () => {
    const fr = [{ freq: 100, db: 3 }, { freq: 1000, db: 6 }, { freq: 10000, db: 3 }];
    const snapshot = fr.map(pt => ({ ...pt }));
    interpolate(fr);
    fr.forEach((pt, i) => {
      expect(pt.freq).toBe(snapshot[i].freq);
      expect(pt.db).toBe(snapshot[i].db);
    });
  });

});
