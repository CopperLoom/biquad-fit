import { describe, test, expect } from 'vitest';
import { compensate } from '../../src/compensate.js';
import { interpolate } from '../../src/interpolate.js';

// compensate(measured, target, options) -> {freq, db}[]
//
// measured: array of {freq, db} — the IEM's frequency response
// target:   array of {freq, db} — the target curve
// options:  passed through to interpolate (step, fMin, fMax)
//
// Returns error = measured - target on a common log-spaced grid.

// Shared test frequencies — both measured and target use these
// so we can assert exact values without grid mismatch.
const FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

function makeFR(freqs, dbFn) {
  return freqs.map(freq => ({ freq, db: dbFn(freq) }));
}

describe('compensate', () => {

  // ─── 3.4.1 Subtraction correctness ───────────────────────────────────────

  test('output = measured - target at each grid point', () => {
    const opts     = { step: 1.01, fMin: 20, fMax: 20000 };
    const measured = makeFR(FREQS, freq => Math.log10(freq));
    const target   = makeFR(FREQS, freq => Math.log10(freq) * 0.5);
    const result   = compensate(measured, target, opts);

    // Expected: interpolate each independently, then subtract
    const m = interpolate(measured, opts);
    const t = interpolate(target, opts);
    result.forEach((pt, i) => {
      expect(pt.db).toBeCloseTo(m[i].db - t[i].db, 10);
    });
  });

  // ─── 3.4.2 Perfect match → zero error ────────────────────────────────────

  test('measured === target → all output values are 0 dB', () => {
    const fr = makeFR(FREQS, freq => Math.sin(freq) * 3); // arbitrary shape
    const result = compensate(fr, fr);
    result.forEach(pt => expect(pt.db).toBeCloseTo(0, 6));
  });

  test('flat measured, flat target at same level → all zeros', () => {
    const measured = makeFR(FREQS, () => 5);
    const target   = makeFR(FREQS, () => 5);
    const result   = compensate(measured, target);
    result.forEach(pt => expect(pt.db).toBeCloseTo(0, 6));
  });

  // ─── 3.4.3 Mismatched grids ───────────────────────────────────────────────

  test('mismatched grids: output is finite at all points', () => {
    // Measured: 5 sparse points. Target: 20 dense points.
    const measured = makeFR([20, 200, 1000, 5000, 20000], () => 0);
    const target   = makeFR(
      Array.from({ length: 20 }, (_, i) => 20 * Math.pow(1000, i / 19)),
      () => 3
    );
    const result = compensate(measured, target);
    expect(result.length).toBeGreaterThan(0);
    result.forEach(pt => {
      expect(isFinite(pt.db)).toBe(true);
      expect(isNaN(pt.db)).toBe(false);
    });
  });

  test('mismatched grids: flat measured - flat target = constant error', () => {
    const measured = makeFR([20, 500, 5000, 20000], () => 3);  // +3 dB flat
    const target   = makeFR([20, 100, 1000, 10000, 20000], () => 1); // +1 dB flat
    const result   = compensate(measured, target);
    // error should be +2 dB everywhere
    result.forEach(pt => expect(pt.db).toBeCloseTo(2, 4));
  });

  // ─── 3.4.4 Negative error ────────────────────────────────────────────────

  test('target above measured → all output values are negative', () => {
    const measured = makeFR(FREQS, () => 0);
    const target   = makeFR(FREQS, () => 6);
    const result   = compensate(measured, target);
    result.forEach(pt => expect(pt.db).toBeLessThan(0));
  });

  test('target below measured → all output values are positive', () => {
    const measured = makeFR(FREQS, () => 6);
    const target   = makeFR(FREQS, () => 0);
    const result   = compensate(measured, target);
    result.forEach(pt => expect(pt.db).toBeGreaterThan(0));
  });

  // ─── 3.4.5 Output structure ──────────────────────────────────────────────

  test('output frequencies are log-spaced (ratio is constant)', () => {
    const measured = makeFR(FREQS, () => 0);
    const target   = makeFR(FREQS, () => 0);
    const result   = compensate(measured, target, { step: 1.01 });
    for (let i = 1; i < result.length; i++) {
      expect(result[i].freq / result[i - 1].freq).toBeCloseTo(1.01, 5);
    }
  });

  test('does not mutate measured or target', () => {
    const measured  = makeFR(FREQS, () => 3);
    const target    = makeFR(FREQS, () => 1);
    const mSnapshot = measured.map(pt => ({ ...pt }));
    const tSnapshot = target.map(pt => ({ ...pt }));
    compensate(measured, target);
    measured.forEach((pt, i) => {
      expect(pt.freq).toBe(mSnapshot[i].freq);
      expect(pt.db).toBe(mSnapshot[i].db);
    });
    target.forEach((pt, i) => {
      expect(pt.freq).toBe(tSnapshot[i].freq);
      expect(pt.db).toBe(tSnapshot[i].db);
    });
  });

});
