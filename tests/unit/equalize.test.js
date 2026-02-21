import { describe, test, expect } from 'vitest';
import { equalize } from '../../src/equalize.js';
import { compensate } from '../../src/compensate.js';
import { interpolate } from '../../src/interpolate.js';

// equalize(error) -> {freq, db}[]
//
// v1.0: equalize() now applies the full AutoEQ pipeline:
//   1. Two-zone smooth the error
//   2. Negate (correction = -smoothed_error)
//   3. Find peaks/dips with prominence ≥ 1
//   4. If peaks: slope-limit, gain-cap, re-smooth
//
// For flat/uniform inputs, smoothing is a no-op, so simple tests still hold.

const OPTS = { step: 1.01, fMin: 20, fMax: 20000 };

function makeFR(freqs, dbFn) {
  return freqs.map(freq => ({ freq, db: dbFn(freq) }));
}

describe('equalize', () => {

  // ─── Basic behavior ─────────────────────────────────────────────────────────

  test('zero error → zero correction', () => {
    const error = interpolate(
      makeFR([20, 1000, 20000], () => 0),
      OPTS
    );
    const result = equalize(error);
    result.forEach(pt => expect(pt.db).toBeCloseTo(0, 6));
  });

  test('uniform positive error → negative correction', () => {
    const error = interpolate(
      makeFR([20, 1000, 20000], () => 3),
      OPTS
    );
    const result = equalize(error);
    // Uniform error has no peaks with prominence ≥ 1, so result is just -smoothed(error)
    // Smoothing a uniform signal returns the same signal, so result ≈ -3
    result.forEach(pt => expect(pt.db).toBeCloseTo(-3, 1));
  });

  test('uniform negative error → positive correction', () => {
    const error = interpolate(
      makeFR([20, 1000, 20000], () => -3),
      OPTS
    );
    const result = equalize(error);
    result.forEach(pt => expect(pt.db).toBeCloseTo(3, 1));
  });

  // ─── Smoothing behavior ─────────────────────────────────────────────────────

  test('output is smoothed (not exact negation) for non-uniform input', () => {
    // A sharp spike should be smoothed down
    const fr = interpolate(
      makeFR([20, 1000, 20000], () => 0),
      OPTS
    );
    // Insert a sharp spike at 1 kHz
    const spikeIx = fr.findIndex(pt => pt.freq >= 1000);
    fr[spikeIx] = { freq: fr[spikeIx].freq, db: 20 };

    const result = equalize(fr);
    // The correction at the spike should be reduced by smoothing
    // (not the full -20 dB)
    expect(Math.abs(result[spikeIx].db)).toBeLessThan(20);
  });

  // ─── Gain cap ───────────────────────────────────────────────────────────────

  test('positive correction is capped at +6 dB', () => {
    // Error with a prominent negative dip — correction would try to boost >6 dB.
    // Gain cap applies only when peaks with prominence ≥ 1 exist.
    const error = interpolate(
      makeFR([20, 200, 800, 1000, 1200, 5000, 20000],
        freq => (freq >= 800 && freq <= 1200) ? -15 : 0),
      OPTS
    );
    const result = equalize(error);
    // After slope limiting, gain cap, and re-smoothing,
    // the peak of the correction should be ≤ 6 dB (+ re-smooth tolerance)
    const peak = Math.max(...result.map(pt => pt.db));
    expect(peak).toBeLessThanOrEqual(7.0);
  });

  test('negative correction has no cap (cuts are unlimited)', () => {
    // Large positive error → negative correction, no cap applied
    const error = interpolate(
      makeFR([20, 1000, 20000], () => 15),
      OPTS
    );
    const result = equalize(error);
    // Correction should be approximately -15 (no cap on cuts)
    const mid = result.find(pt => pt.freq >= 1000);
    expect(mid.db).toBeLessThan(-10);
  });

  // ─── Output structure ───────────────────────────────────────────────────────

  test('output has same length as input', () => {
    const error = interpolate(makeFR([20, 1000, 20000], () => 1), OPTS);
    expect(equalize(error)).toHaveLength(error.length);
  });

  test('output preserves frequency values exactly', () => {
    const error = interpolate(makeFR([20, 1000, 20000], () => 1), OPTS);
    const result = equalize(error);
    result.forEach((pt, i) => expect(pt.freq).toBe(error[i].freq));
  });

  test('does not mutate input error', () => {
    const error    = interpolate(makeFR([20, 1000, 20000], () => 3), OPTS);
    const snapshot = error.map(pt => ({ ...pt }));
    equalize(error);
    error.forEach((pt, i) => {
      expect(pt.freq).toBe(snapshot[i].freq);
      expect(pt.db).toBe(snapshot[i].db);
    });
  });

});
