import { describe, test, expect } from 'vitest';
import { applyFilters } from '../../src/applyFilters.js';
import { biquadResponse } from '../../src/biquadResponse.js';

// applyFilters(fr, filters, pregain) -> {freq, db}[]
//
// fr:      array of {freq, db} points
// filters: array of {type, fc, gain, Q}
// pregain: number (dB shift applied to entire curve)
//
// Returns a new array of {freq, db} with the same frequency grid.

const FS = 44100;

// Standard test frequencies — includes exact values we assert against
const TEST_FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

// Flat FR at 0 dB using the standard test frequency set
function flatFR(freqs = TEST_FREQS) {
  return freqs.map(freq => ({ freq, db: 0 }));
}

// Exact lookup — freq must exist in the FR array
function atFreq(fr, targetFreq) {
  const pt = fr.find(p => p.freq === targetFreq);
  if (!pt) throw new Error(`Frequency ${targetFreq} not found in FR grid`);
  return pt;
}

describe('applyFilters', () => {

  // ─── 3.2.1 No filters, zero pregain → identity ────────────────────────────

  test('no filters, pregain=0 → output equals input', () => {
    const fr = flatFR();
    const result = applyFilters(fr, [], 0);
    result.forEach((pt, i) => {
      expect(pt.freq).toBe(fr[i].freq);
      expect(pt.db).toBeCloseTo(0, 10);
    });
  });

  test('non-flat input, no filters, pregain=0 → output equals input', () => {
    const fr = flatFR().map((pt, i) => ({ ...pt, db: i * 0.5 }));
    const result = applyFilters(fr, [], 0);
    result.forEach((pt, i) => {
      expect(pt.db).toBeCloseTo(fr[i].db, 10);
    });
  });

  // ─── 3.2.2 Pregain shifts entire curve ────────────────────────────────────

  test('pregain=−3 shifts all values by −3 dB', () => {
    const fr = flatFR();
    const result = applyFilters(fr, [], -3);
    result.forEach(pt => expect(pt.db).toBeCloseTo(-3, 10));
  });

  test('pregain=+6 shifts all values by +6 dB', () => {
    const fr = flatFR();
    const result = applyFilters(fr, [], 6);
    result.forEach(pt => expect(pt.db).toBeCloseTo(6, 10));
  });

  // ─── 3.2.3 Single PK filter matches biquadResponse directly ───────────────
  // Expected values come from biquadResponse (already tested), not hardcoded.

  test('single PK filter: output matches biquadResponse at every point', () => {
    const filter = { type: 'PK', fc: 1000, gain: 3, Q: 1.0 };
    const fr = flatFR();
    const result = applyFilters(fr, [filter], 0);
    const expected = biquadResponse(filter.type, filter.fc, filter.gain, filter.Q, TEST_FREQS, FS);
    result.forEach((pt, i) => {
      expect(pt.db).toBeCloseTo(expected[i], 10);
    });
  });

  test('single LSQ filter: output matches biquadResponse at every point', () => {
    const filter = { type: 'LSQ', fc: 100, gain: 6, Q: 0.707 };
    const fr = flatFR();
    const result = applyFilters(fr, [filter], 0);
    const expected = biquadResponse(filter.type, filter.fc, filter.gain, filter.Q, TEST_FREQS, FS);
    result.forEach((pt, i) => {
      expect(pt.db).toBeCloseTo(expected[i], 10);
    });
  });

  test('single HSQ filter: output matches biquadResponse at every point', () => {
    const filter = { type: 'HSQ', fc: 10000, gain: 6, Q: 0.707 };
    const fr = flatFR();
    const result = applyFilters(fr, [filter], 0);
    const expected = biquadResponse(filter.type, filter.fc, filter.gain, filter.Q, TEST_FREQS, FS);
    result.forEach((pt, i) => {
      expect(pt.db).toBeCloseTo(expected[i], 10);
    });
  });

  // ─── 3.2.4 Filter stacking adds in dB ────────────────────────────────────

  test('two identical PK filters: output = 2× single filter at every point', () => {
    const filter = { type: 'PK', fc: 1000, gain: 3, Q: 1.0 };
    const fr = flatFR();
    const single = applyFilters(fr, [filter], 0);
    const double = applyFilters(fr, [filter, filter], 0);
    single.forEach((pt, i) => {
      expect(double[i].db).toBeCloseTo(2 * pt.db, 10);
    });
  });

  test('two opposing PK filters cancel out', () => {
    const fr = flatFR();
    const result = applyFilters(fr, [
      { type: 'PK', fc: 1000, gain: +6, Q: 1.0 },
      { type: 'PK', fc: 1000, gain: -6, Q: 1.0 },
    ], 0);
    result.forEach(pt => expect(pt.db).toBeCloseTo(0, 10));
  });

  test('mixed filter types sum correctly at every point', () => {
    const pk  = { type: 'PK',  fc: 1000,  gain: 3, Q: 1.0   };
    const lsq = { type: 'LSQ', fc: 100,   gain: 6, Q: 0.707 };
    const fr = flatFR();
    const combined = applyFilters(fr, [pk, lsq], 0);
    const pkResp  = biquadResponse(pk.type,  pk.fc,  pk.gain,  pk.Q,  TEST_FREQS, FS);
    const lsqResp = biquadResponse(lsq.type, lsq.fc, lsq.gain, lsq.Q, TEST_FREQS, FS);
    combined.forEach((pt, i) => {
      expect(pt.db).toBeCloseTo(pkResp[i] + lsqResp[i], 10);
    });
  });

  // ─── 3.2.5 Non-flat input ─────────────────────────────────────────────────

  test('filter adds to non-flat input point-wise', () => {
    const filter = { type: 'PK', fc: 1000, gain: 3, Q: 1.0 };
    const fr = flatFR().map(pt => ({ ...pt, db: 2 })); // +2 dB everywhere
    const result = applyFilters(fr, [filter], 0);
    const filterResp = biquadResponse(filter.type, filter.fc, filter.gain, filter.Q, TEST_FREQS, FS);
    result.forEach((pt, i) => {
      expect(pt.db).toBeCloseTo(2 + filterResp[i], 10);
    });
  });

  // ─── 3.2.6 Pregain + filters combine correctly ────────────────────────────

  test('pregain and filter response combine independently', () => {
    const filter = { type: 'PK', fc: 1000, gain: 3, Q: 1.0 };
    const fr = flatFR();
    const result = applyFilters(fr, [filter], -3);
    const filterResp = biquadResponse(filter.type, filter.fc, filter.gain, filter.Q, TEST_FREQS, FS);
    result.forEach((pt, i) => {
      expect(pt.db).toBeCloseTo(filterResp[i] - 3, 10);
    });
  });

  // ─── 3.2.7 Output structure ───────────────────────────────────────────────

  test('output has same length as input', () => {
    const fr = flatFR();
    expect(applyFilters(fr, [], 0)).toHaveLength(fr.length);
  });

  test('output preserves frequency values exactly', () => {
    const fr = flatFR();
    const result = applyFilters(fr, [{ type: 'PK', fc: 1000, gain: 3, Q: 1 }], 0);
    result.forEach((pt, i) => expect(pt.freq).toBe(fr[i].freq));
  });

  test('output does not mutate input FR', () => {
    const fr = flatFR();
    const snapshot = fr.map(pt => ({ ...pt }));
    applyFilters(fr, [{ type: 'PK', fc: 1000, gain: 3, Q: 1 }], 6);
    fr.forEach((pt, i) => {
      expect(pt.freq).toBe(snapshot[i].freq);
      expect(pt.db).toBe(snapshot[i].db);
    });
  });

});
