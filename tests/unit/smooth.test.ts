import { describe, test, expect } from 'vitest';
import { smooth } from '../../src/smooth.js';
import { interpolate } from '../../src/interpolate.js';

// smooth(fr, options) -> {freq, db}[]
//
// fr:      array of {freq, db} on a log-spaced grid (from interpolate)
// options: { windowOctaves } — smoothing window width in octaves
//
// Returns a new FR with the same frequency grid, values smoothed.

// Build a log-spaced FR with a given dB function
function makeFR(dbFn, opts = { step: 1.01, fMin: 20, fMax: 20000 }) {
  const raw = [
    { freq: 20,    db: dbFn(20)    },
    { freq: 1000,  db: dbFn(1000)  },
    { freq: 20000, db: dbFn(20000) },
  ];
  return interpolate(raw, opts);
}

describe('smooth', () => {

  // ─── 3.5.1 Same frequency grid ───────────────────────────────────────────

  test('output has same frequency grid as input', () => {
    const fr = makeFR(() => 0);
    const result = smooth(fr, { windowOctaves: 1 / 3 });
    expect(result).toHaveLength(fr.length);
    result.forEach((pt, i) => {
      expect(pt.freq).toBeCloseTo(fr[i].freq, 6);
    });
  });

  // ─── 3.5.2 Flat input stays flat ─────────────────────────────────────────

  test('flat input remains flat after smoothing', () => {
    const fr = makeFR(() => 0);
    const result = smooth(fr, { windowOctaves: 1 / 3 });
    result.forEach(pt => expect(pt.db).toBeCloseTo(0, 6));
  });

  test('flat non-zero input remains constant after smoothing', () => {
    const fr = makeFR(() => 3);
    const result = smooth(fr, { windowOctaves: 1 / 3 });
    result.forEach(pt => expect(pt.db).toBeCloseTo(3, 6));
  });

  // ─── 3.5.3 Reduces peak-to-peak range ────────────────────────────────────

  test('sharp spike is reduced by smoothing', () => {
    // Build FR with a single +10 dB spike at 1 kHz, 0 dB elsewhere
    const fr = makeFR(() => 0);
    const spikeIdx = fr.findIndex(pt => Math.abs(pt.freq - 1000) / 1000 < 0.01);
    const spiked = fr.map((pt, i) => ({ ...pt, db: i === spikeIdx ? 10 : 0 }));

    const result = smooth(spiked, { windowOctaves: 1 / 3 });
    const peakDb = Math.max(...result.map(pt => pt.db));
    expect(peakDb).toBeLessThan(10);
    expect(peakDb).toBeGreaterThan(0); // not fully erased
  });

  test('smoothing reduces overall peak-to-peak range', () => {
    // Alternating +3 / -3 dB pattern — smoothing should reduce variance
    const fr = makeFR(() => 0);
    const noisy = fr.map((pt, i) => ({ ...pt, db: i % 2 === 0 ? 3 : -3 }));

    const result = smooth(noisy, { windowOctaves: 1 / 3 });
    const inputRange  = 6; // 3 - (-3)
    const outputRange = Math.max(...result.map(p => p.db)) - Math.min(...result.map(p => p.db));
    expect(outputRange).toBeLessThan(inputRange);
  });

  // ─── 3.5.4 Step function — 1/3-octave window ─────────────────────────────
  // Input: 0 dB below 1000 Hz, +6 dB above 1000 Hz.
  // After smoothing, the transition zone should be blurred while
  // far-away regions should be close to their original values.

  test('1/3-octave window: regions far from transition preserve their value', () => {
    const fr = makeFR(() => 0);
    const step = fr.map(pt => ({ ...pt, db: pt.freq >= 1000 ? 6 : 0 }));
    const result = smooth(step, { windowOctaves: 1 / 3 });

    // Well below transition (100 Hz is > 3 octaves below 1000 Hz)
    const lowPt = result.find(pt => Math.abs(pt.freq - 100) / 100 < 0.01);
    expect(lowPt.db).toBeCloseTo(0, 0);

    // Well above transition (10000 Hz is ~3.3 octaves above 1000 Hz)
    const highPt = result.find(pt => Math.abs(pt.freq - 10000) / 10000 < 0.01);
    expect(highPt.db).toBeCloseTo(6, 0);
  });

  test('1/3-octave window: transition zone is between 0 and 6 dB', () => {
    const fr = makeFR(() => 0);
    const step = fr.map(pt => ({ ...pt, db: pt.freq >= 1000 ? 6 : 0 }));
    const result = smooth(step, { windowOctaves: 1 / 3 });

    // Near 1000 Hz the value should be between the two extremes
    const atTransition = result.find(pt => Math.abs(pt.freq - 1000) / 1000 < 0.01);
    expect(atTransition.db).toBeGreaterThan(0);
    expect(atTransition.db).toBeLessThan(6);
  });

  // ─── 3.5.5 Wider window smooths more aggressively ─────────────────────────

  test('wider window produces a flatter output than narrow window', () => {
    const fr = makeFR(() => 0);
    const noisy = fr.map((pt, i) => ({ ...pt, db: Math.sin(i * 0.3) * 3 }));

    const narrow = smooth(noisy, { windowOctaves: 1 / 12 });
    const wide   = smooth(noisy, { windowOctaves: 1 });

    const rangeNarrow = Math.max(...narrow.map(p => p.db)) - Math.min(...narrow.map(p => p.db));
    const rangeWide   = Math.max(...wide.map(p => p.db))   - Math.min(...wide.map(p => p.db));
    expect(rangeWide).toBeLessThan(rangeNarrow);
  });

  // ─── 3.5.6 Output does not mutate input ──────────────────────────────────

  test('does not mutate input FR', () => {
    const fr = makeFR(() => 3);
    const snapshot = fr.map(pt => ({ ...pt }));
    smooth(fr, { windowOctaves: 1 / 3 });
    fr.forEach((pt, i) => {
      expect(pt.freq).toBe(snapshot[i].freq);
      expect(pt.db).toBe(snapshot[i].db);
    });
  });

});
