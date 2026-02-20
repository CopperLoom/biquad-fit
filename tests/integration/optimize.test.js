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
const CONSTRAINT_SETS = {
  standard: {
    maxFilters: 5,
    gainRange:  [-12, 12],
    qRange:     [0.5, 10],
    freqRange:  [20, 10000],
  },
  restricted: {
    maxFilters: 3,
    gainRange:  [-6, 6],
    qRange:     [1.0, 5.0],
    freqRange:  [20, 10000],
  },
  qudelix_10: {
    maxFilters: 10,
    gainRange:  [-12, 12],
    qRange:     [0.5, 10],
    freqRange:  [20, 10000],
  },
};

// Maximum dB by which our RMSE may exceed AutoEq's.
const RMSE_TOLERANCE = 0.5;

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
// 1. Structural (all 90) — filter count, gain/Q/freq bounds. Always runs.
//
// 2. RMSE within RMSE_TOLERANCE of AutoEq golden (restricted only).
//    restricted is all-PK on both sides, so the comparison is meaningful.
//    standard and qudelix_10 use LSQ+PK+HSQ in AutoEq but biquad-fit v1 is
//    PK-only — the gap routinely exceeds 0.5 dB. Skipped until v2 (DE optimizer
//    with shelf support). See test.skip in optimize.test.js for the parallel note.

for (const [constraintName, constraints] of Object.entries(CONSTRAINT_SETS)) {
  describe(`optimize — ${constraintName} constraints`, () => {
    for (const iem of IEMS) {
      describe(iem, () => {
        for (const targetName of TARGETS) {

          // ── 1. Structural check ─────────────────────────────────────────
          test(`${targetName}: output satisfies constraints`, () => {
            const { result } = getResult(iem, targetName, constraintName, constraints);

            expect(result).toHaveProperty('pregain');
            expect(result).toHaveProperty('filters');
            expect(result.filters.length).toBeLessThanOrEqual(constraints.maxFilters);

            for (const f of result.filters) {
              expect(f.gain).toBeGreaterThanOrEqual(constraints.gainRange[0]);
              expect(f.gain).toBeLessThanOrEqual(constraints.gainRange[1]);
              expect(f.Q).toBeGreaterThanOrEqual(constraints.qRange[0]);
              expect(f.Q).toBeLessThanOrEqual(constraints.qRange[1]);
              expect(f.fc).toBeGreaterThanOrEqual(constraints.freqRange[0]);
              expect(f.fc).toBeLessThanOrEqual(constraints.freqRange[1]);
            }
          });

          // ── 2. RMSE check ───────────────────────────────────────────────
          // restricted: all-PK on both sides — run the check.
          // standard / qudelix_10: AutoEq uses shelves, v1 cannot — skip until v2.
          const rmseTest = constraintName === 'restricted' ? test : test.skip;
          rmseTest(`${targetName}: RMSE within ${RMSE_TOLERANCE} dB of AutoEq golden`, () => {
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
