import { describe, test, expect } from 'vitest';
import { optimize } from '../../src/optimize.js';
import { applyFilters } from '../../src/applyFilters.js';
import { interpolate } from '../../src/interpolate.js';

// optimize(measured, target, constraints) -> { pregain, filters }
//
// measured:    {freq, db}[] — IEM frequency response
// target:      {freq, db}[] — target curve
// constraints: {
//   maxFilters: number,
//   gainRange:  [min, max],   // dB
//   qRange:     [min, max],
//   freqRange:  [min, max],   // Hz
// }
//
// Returns: { pregain: number, filters: [{type, fc, gain, Q}] }

const GRID = { step: 1.01, fMin: 20, fMax: 20000 };

// Build a flat FR on the standard interpolation grid
function flatFR() {
  return interpolate([{ freq: 20, db: 0 }, { freq: 20000, db: 0 }], GRID);
}

// Build a FR with a single Gaussian bump of given height at centerFreq
function bumpFR(centerFreq, heightDb, widthOctaves = 1) {
  return interpolate(
    [{ freq: 20, db: 0 }, { freq: 20000, db: 0 }],
    GRID
  ).map(pt => {
    const octavesAway = Math.abs(Math.log2(pt.freq / centerFreq));
    return { ...pt, db: heightDb * Math.exp(-(octavesAway ** 2) / (2 * widthOctaves ** 2)) };
  });
}

const STANDARD = {
  maxFilters: 5,
  gainRange: [-12, 12],
  qRange: [0.5, 10],
  freqRange: [20, 10000],
};

const RESTRICTED = {
  maxFilters: 3,
  gainRange: [-6, 6],
  qRange: [1, 5],
  freqRange: [20, 10000],
};

// ─── 3.7.1 Return structure ──────────────────────────────────────────────────

describe('optimize: return structure', () => {

  test('returns object with pregain and filters', () => {
    const measured = bumpFR(1000, 6);
    const target   = flatFR();
    const result   = optimize(measured, target, STANDARD);
    expect(result).toHaveProperty('pregain');
    expect(result).toHaveProperty('filters');
    expect(typeof result.pregain).toBe('number');
    expect(Array.isArray(result.filters)).toBe(true);
  });

  test('each filter has type, fc, gain, Q', () => {
    const result = optimize(bumpFR(1000, 6), flatFR(), STANDARD);
    result.filters.forEach(f => {
      expect(f).toHaveProperty('type');
      expect(f).toHaveProperty('fc');
      expect(f).toHaveProperty('gain');
      expect(f).toHaveProperty('Q');
      expect(['PK', 'LSQ', 'HSQ']).toContain(f.type);
      expect(typeof f.fc).toBe('number');
      expect(typeof f.gain).toBe('number');
      expect(typeof f.Q).toBe('number');
    });
  });

  test('pregain is a finite number', () => {
    const result = optimize(bumpFR(1000, 6), flatFR(), STANDARD);
    expect(isFinite(result.pregain)).toBe(true);
  });

});

// ─── 3.7.2 Constraint enforcement ────────────────────────────────────────────

describe('optimize: constraint enforcement', () => {

  test('filter count does not exceed maxFilters', () => {
    const result = optimize(bumpFR(1000, 6), flatFR(), { ...STANDARD, maxFilters: 3 });
    expect(result.filters.length).toBeLessThanOrEqual(3);
  });

  test('filter count does not exceed maxFilters=1', () => {
    const result = optimize(bumpFR(1000, 6), flatFR(), { ...STANDARD, maxFilters: 1 });
    expect(result.filters.length).toBeLessThanOrEqual(1);
  });

  test('all filter gains within gainRange', () => {
    const result = optimize(bumpFR(500, 10), flatFR(), STANDARD);
    result.filters.forEach(f => {
      expect(f.gain).toBeGreaterThanOrEqual(STANDARD.gainRange[0]);
      expect(f.gain).toBeLessThanOrEqual(STANDARD.gainRange[1]);
    });
  });

  test('all filter gains within restricted gainRange', () => {
    const result = optimize(bumpFR(500, 10), flatFR(), RESTRICTED);
    result.filters.forEach(f => {
      expect(f.gain).toBeGreaterThanOrEqual(RESTRICTED.gainRange[0]);
      expect(f.gain).toBeLessThanOrEqual(RESTRICTED.gainRange[1]);
    });
  });

  test('all Q values within qRange', () => {
    const result = optimize(bumpFR(1000, 6), flatFR(), STANDARD);
    result.filters.forEach(f => {
      expect(f.Q).toBeGreaterThanOrEqual(STANDARD.qRange[0]);
      expect(f.Q).toBeLessThanOrEqual(STANDARD.qRange[1]);
    });
  });

  test('all Q values within restricted qRange', () => {
    const result = optimize(bumpFR(1000, 6), flatFR(), RESTRICTED);
    result.filters.forEach(f => {
      expect(f.Q).toBeGreaterThanOrEqual(RESTRICTED.qRange[0]);
      expect(f.Q).toBeLessThanOrEqual(RESTRICTED.qRange[1]);
    });
  });

  test('all fc values within freqRange', () => {
    const result = optimize(bumpFR(1000, 6), flatFR(), STANDARD);
    result.filters.forEach(f => {
      expect(f.fc).toBeGreaterThanOrEqual(STANDARD.freqRange[0]);
      expect(f.fc).toBeLessThanOrEqual(STANDARD.freqRange[1]);
    });
  });

  test('gainRange [0, 0]: all filter gains are 0', () => {
    const result = optimize(bumpFR(1000, 6), flatFR(), { ...STANDARD, gainRange: [0, 0] });
    result.filters.forEach(f => expect(f.gain).toBeCloseTo(0, 6));
  });

});

// ─── 3.7.3 filterSpecs API ───────────────────────────────────────────────────

describe('optimize: filterSpecs API', () => {

  test('accepts filterSpecs array and returns one filter per spec', () => {
    const filterSpecs = [
      { type: 'LSQ', gainRange: [-12, 12] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'HSQ', gainRange: [-12, 12] },
    ];
    const result = optimize(bumpFR(1000, 6), flatFR(), { filterSpecs, freqRange: [20, 10000] });
    expect(result.filters.length).toBe(4);
  });

  test('filterSpecs types are preserved in output', () => {
    const filterSpecs = [
      { type: 'LSQ', gainRange: [-12, 12] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'HSQ', gainRange: [-12, 12] },
    ];
    const result = optimize(bumpFR(1000, 6), flatFR(), { filterSpecs, freqRange: [20, 10000] });
    expect(result.filters[0].type).toBe('LSQ');
    expect(result.filters[1].type).toBe('PK');
    expect(result.filters[2].type).toBe('HSQ');
  });

  test('filterSpecs gainRange is respected per filter', () => {
    const filterSpecs = [
      { type: 'LSQ', gainRange: [-6, 6] },
      { type: 'PK',  gainRange: [-3, 3], qRange: [0.5, 10] },
    ];
    const result = optimize(bumpFR(500, 10), flatFR(), { filterSpecs, freqRange: [20, 10000] });
    expect(result.filters[0].gain).toBeGreaterThanOrEqual(-6);
    expect(result.filters[0].gain).toBeLessThanOrEqual(6);
    expect(result.filters[1].gain).toBeGreaterThanOrEqual(-3);
    expect(result.filters[1].gain).toBeLessThanOrEqual(3);
  });

  test('uses LSQ for strong low-frequency shelf error', () => {
    // Bass-boosted IEM vs flat target: a LOW_SHELF is the natural fit.
    const measured = interpolate([
      { freq: 20,    db: 8 },
      { freq: 200,   db: 4 },
      { freq: 1000,  db: 0 },
      { freq: 20000, db: 0 },
    ], GRID);
    const filterSpecs = [
      { type: 'LSQ', gainRange: [-12, 12] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
    ];
    const result = optimize(measured, flatFR(), { filterSpecs, freqRange: [20, 10000] });
    const hasShelf = result.filters.some(f => f.type === 'LSQ');
    expect(hasShelf).toBe(true);
  });

  test('old API still works (all-PK, backward compat)', () => {
    const result = optimize(bumpFR(1000, 6), flatFR(), STANDARD);
    expect(result.filters.length).toBeGreaterThan(0);
    result.filters.forEach(f => expect(f.type).toBe('PK'));
  });

});

// ─── 3.7.4 Correctness ────────────────────────────────────────────────────────

describe('optimize: correctness', () => {

  test('no-error input: corrected FR RMSE is near 0', () => {
    const fr     = bumpFR(1000, 3); // same for measured and target
    const result = optimize(fr, fr, STANDARD);
    const corrected = applyFilters(
      interpolate(fr, GRID),
      result.filters,
      result.pregain
    );
    const target = interpolate(fr, GRID);
    const mse = corrected.reduce((s, pt, i) => s + (pt.db - target[i].db) ** 2, 0) / corrected.length;
    expect(Math.sqrt(mse)).toBeLessThan(0.5);
  });

  test('single prominent bump: optimizer reduces RMSE vs doing nothing', () => {
    const measured = bumpFR(1000, 8);
    const target   = flatFR();
    const result   = optimize(measured, target, STANDARD);

    const measInterp   = interpolate(measured, GRID);
    const targetInterp = interpolate(target, GRID);
    const corrected    = applyFilters(measInterp, result.filters, result.pregain);

    function rmse(a, b) {
      return Math.sqrt(a.reduce((s, pt, i) => s + (pt.db - b[i].db) ** 2, 0) / a.length);
    }

    const rmseRaw       = rmse(measInterp, targetInterp);
    const rmseCorrected = rmse(corrected, targetInterp);
    expect(rmseCorrected).toBeLessThan(rmseRaw);
  });

  test('shelf + PK filterSpecs: corrected RMSE better than doing nothing', () => {
    const measured = interpolate([
      { freq: 20,    db: 8 },
      { freq: 200,   db: 4 },
      { freq: 1000,  db: 0 },
      { freq: 5000,  db: 3 },
      { freq: 20000, db: 0 },
    ], GRID);
    const target = flatFR();
    const filterSpecs = [
      { type: 'LSQ', gainRange: [-12, 12] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'HSQ', gainRange: [-12, 12] },
    ];
    const result = optimize(measured, target, { filterSpecs, freqRange: [20, 10000] });

    const measInterp   = interpolate(measured, GRID);
    const targetInterp = interpolate(target, GRID);
    const corrected    = applyFilters(measInterp, result.filters, 0);

    function rmse(a, b) {
      return Math.sqrt(a.reduce((s, pt, i) => s + (pt.db - b[i].db) ** 2, 0) / a.length);
    }
    expect(rmse(corrected, targetInterp)).toBeLessThan(rmse(measInterp, targetInterp));
  });

});
