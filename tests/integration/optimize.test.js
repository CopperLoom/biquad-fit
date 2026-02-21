import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { optimize }     from '../../src/optimize.js';
import { applyFilters } from '../../src/applyFilters.js';
import { interpolate }  from '../../src/interpolate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES  = join(__dirname, '../fixtures');

function loadJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Center the FR at 1kHz, matching AutoEq's fr.center() step.
// Raw IEM measurements are absolute SPL (~85–105 dB); both engines
// must operate on the same scale for the comparison to be valid.
function centerAt1k(points) {
  const interp = interpolate(points);
  const ref    = interp.find(p => p.freq >= 1000);
  const offset = ref ? ref.db : 0;
  return points.map(p => ({ ...p, db: p.db - offset }));
}

// RMSE of the corrected FR vs target with no pregain (shape comparison only).
// Matches the convention in generate_golden.py and compare.js.
function computeRMSE(frCentered, target, filters) {
  const frInterp  = interpolate(frCentered);
  const tgtInterp = interpolate(target);
  const corrected = applyFilters(frInterp, filters, 0);
  return Math.sqrt(
    corrected.reduce((s, pt, i) => s + (pt.db - tgtInterp[i].db) ** 2, 0) / corrected.length
  );
}

// ─── Test matrix ─────────────────────────────────────────────────────────────

const IEMS    = ['blessing3', 'hexa', 'andromeda', 'zero2', 'origin_s'];
const TARGETS = ['harman_ie_2019', 'diffuse_field', 'flat', 'v_shaped', 'bass_heavy', 'bright'];

// Constraint sets match generate_golden.py exactly.
//
// standard / qudelix_10: use filterSpecs with LSQ + PK + HSQ, matching the
//   golden files which were generated with AutoEQ's mixed-type configs.
//
// restricted: all-PK (same as golden files).
const CONSTRAINT_SETS = {
  standard: {
    filterSpecs: [
      { type: 'LSQ', gainRange: [-12, 12] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'HSQ', gainRange: [-12, 12] },
    ],
    freqRange: [20, 10000],
    gainRange: [-12, 12],
  },
  restricted: {
    maxFilters: 3,
    gainRange:  [-6, 6],
    qRange:     [1.0, 5.0],
    freqRange:  [20, 10000],
  },
  qudelix_10: {
    filterSpecs: [
      { type: 'LSQ', gainRange: [-12, 12] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'HSQ', gainRange: [-12, 12] },
    ],
    freqRange: [20, 10000],
    gainRange: [-12, 12],
  },
};

// Maximum dB by which our RMSE may exceed AutoEq's.
const RMSE_TOLERANCE = 0.5;

// Per-constraint metadata for structural checks.
// resolvedSpecs: the expanded filterSpecs array with per-filter bounds.
// gainRange / qRange / freqRange: fallback bounds for constraints without filterSpecs.
function getResolvedSpecs(constraintName, constraints) {
  if (constraints.filterSpecs) {
    return constraints.filterSpecs.map(s => ({
      type:      s.type,
      gainRange: s.gainRange,
      qRange:    s.qRange  ?? (s.type === 'PK' ? [0.5, 10] : [0.4, 0.7]),
      freqRange: s.fcRange ?? constraints.freqRange,
    }));
  }
  // Old API: all-PK
  return Array.from({ length: constraints.maxFilters }, () => ({
    type:      'PK',
    gainRange: constraints.gainRange,
    qRange:    constraints.qRange,
    freqRange: constraints.freqRange,
  }));
}

// Cache optimize() results so each combination is computed only once.
const resultCache = {};
function getResult(iem, targetName, constraintName, constraints) {
  const key = `${iem}_${targetName}_${constraintName}`;
  if (!resultCache[key]) {
    const fr         = loadJSON(join(FIXTURES, 'fr',      `${iem}.json`));
    const target     = loadJSON(join(FIXTURES, 'targets', `${targetName}.json`));
    const frCentered = centerAt1k(fr);
    resultCache[key] = { result: optimize(frCentered, target, constraints), frCentered, target };
  }
  return resultCache[key];
}

// ─── Tests ───────────────────────────────────────────────────────────────────
//
// Two checks per combination:
//
// 1. Structural (all 90) — filter count, per-filter gain/Q/freq bounds.
//
// 2. RMSE within RMSE_TOLERANCE of AutoEq golden (all 90 in v1.0).
//    All constraint sets now use matching filter types (LSQ+PK+HSQ or all-PK),
//    so the comparison is valid across the full matrix.

for (const [constraintName, constraints] of Object.entries(CONSTRAINT_SETS)) {
  describe(`optimize — ${constraintName} constraints`, () => {
    const resolvedSpecs = getResolvedSpecs(constraintName, constraints);

    for (const iem of IEMS) {
      describe(iem, () => {
        for (const targetName of TARGETS) {

          // ── 1. Structural check ─────────────────────────────────────────
          test(`${targetName}: output satisfies constraints`, () => {
            const { result } = getResult(iem, targetName, constraintName, constraints);

            expect(result).toHaveProperty('pregain');
            expect(result).toHaveProperty('filters');
            expect(result.filters.length).toBe(resolvedSpecs.length);

            for (let i = 0; i < result.filters.length; i++) {
              const f    = result.filters[i];
              const spec = resolvedSpecs[i];
              expect(f.type).toBe(spec.type);
              expect(f.gain).toBeGreaterThanOrEqual(spec.gainRange[0]);
              expect(f.gain).toBeLessThanOrEqual(spec.gainRange[1]);
              expect(f.Q).toBeGreaterThanOrEqual(spec.qRange[0]);
              expect(f.Q).toBeLessThanOrEqual(spec.qRange[1]);
              expect(f.fc).toBeGreaterThanOrEqual(spec.freqRange[0]);
              expect(f.fc).toBeLessThanOrEqual(spec.freqRange[1]);
            }
          });

          // ── 2. RMSE check ───────────────────────────────────────────────
          test(`${targetName}: RMSE within ${RMSE_TOLERANCE} dB of AutoEq golden`, () => {
            const { result, frCentered, target } = getResult(iem, targetName, constraintName, constraints);
            const golden  = loadJSON(join(FIXTURES, 'golden', `${iem}_${targetName}_${constraintName}.json`));
            const ourRMSE = computeRMSE(frCentered, target, result.filters);
            expect(ourRMSE).toBeLessThanOrEqual(golden.rmse + RMSE_TOLERANCE);
          });

        }
      });
    }
  });
}
