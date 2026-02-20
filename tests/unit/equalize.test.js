import { describe, test, expect } from 'vitest';
import { equalize } from '../../src/equalize.js';
import { compensate } from '../../src/compensate.js';
import { interpolate } from '../../src/interpolate.js';

// equalize(error) -> {freq, db}[]
//
// error:  array of {freq, db} — output of compensate()
//
// Returns the correction curve: negation of the error at each point.
// Applying this correction to the measured FR should yield the target.

const OPTS = { step: 1.01, fMin: 20, fMax: 20000 };

function makeFR(freqs, dbFn) {
  return freqs.map(freq => ({ freq, db: dbFn(freq) }));
}

describe('equalize', () => {

  // ─── 3.6.1 Negation of error ──────────────────────────────────────────────

  test('output is point-wise negation of input error', () => {
    const error = interpolate(
      makeFR([20, 100, 1000, 10000, 20000], freq => Math.log10(freq) - 2),
      OPTS
    );
    const result = equalize(error);
    result.forEach((pt, i) => {
      expect(pt.db).toBeCloseTo(-error[i].db, 10);
    });
  });

  test('zero error → zero correction', () => {
    const error = interpolate(
      makeFR([20, 1000, 20000], () => 0),
      OPTS
    );
    const result = equalize(error);
    result.forEach(pt => expect(pt.db).toBeCloseTo(0, 10));
  });

  test('positive error → negative correction', () => {
    const error = interpolate(
      makeFR([20, 1000, 20000], () => 3),
      OPTS
    );
    const result = equalize(error);
    result.forEach(pt => expect(pt.db).toBeLessThan(0));
  });

  test('negative error → positive correction', () => {
    const error = interpolate(
      makeFR([20, 1000, 20000], () => -3),
      OPTS
    );
    const result = equalize(error);
    result.forEach(pt => expect(pt.db).toBeGreaterThan(0));
  });

  // ─── 3.6.2 Round-trip identity with compensate ────────────────────────────
  // compensate → equalize → add correction to measured ≈ target

  test('compensate → equalize: applying correction to measured yields target', () => {
    const measured = makeFR([20, 100, 500, 1000, 5000, 20000], freq => Math.sin(freq / 1000) * 4);
    const target   = makeFR([20, 100, 500, 1000, 5000, 20000], freq => Math.cos(freq / 2000) * 2);

    const error      = compensate(measured, target, OPTS);
    const correction = equalize(error);

    // Interpolate measured to the same grid
    const measInterp = interpolate(measured, OPTS);

    // Apply correction: measInterp[i].db + correction[i].db should ≈ target at that freq
    const targetInterp = interpolate(target, OPTS);
    correction.forEach((pt, i) => {
      const corrected = measInterp[i].db + pt.db;
      expect(corrected).toBeCloseTo(targetInterp[i].db, 6);
    });
  });

  // ─── 3.6.3 Output structure ───────────────────────────────────────────────

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
