# biquad-fit: Development Progress

> Updated after each implementation milestone.
> Test results reflect `npx vitest run` output at time of completion.

---

## Status Summary

| Module | Tests Written | Tests Passing | Implementation | Notes |
|--------|:---:|:---:|:---:|-------|
| `biquadResponse.js` | ✅ | ✅ 19/19 | ✅ | Core evaluator complete |
| `applyFilters.js` | ✅ | ✅ 15/15 | ✅ | |
| `interpolate.js` | ✅ | ✅ 14/14 | ✅ | |
| `compensate.js` | ✅ | ✅ 9/9 | ✅ | |
| `smooth.js` | ✅ | ✅ 9/9 | ✅ | |
| `equalize.js` | ✅ | ✅ 8/8 | ✅ | |
| `optimize.js` | ✅ | ✅ 19/19 unit | ✅ | Joint L-BFGS optimizer, filterSpecs API, shelf init, sharpness penalty |
| Golden file generation | ✅ | — | ✅ | 90 files (5 IEMs × 6 targets × 3 constraints) |
| Integration tests | ✅ | ✅ 274/274 | ✅ | All 90 combinations pass, 0 skipped |
| `visualize.js` | — | — | ✅ | Side-by-side AutoEQ vs biquad-fit Canvas charts |

**Total unit tests: 93/93 passing**

**Integration tests: 274/274 passing** — all 90 IEM × target × constraint combinations within 0.5 dB RMSE of AutoEQ.

---

## Milestone Tracker

| Milestone | Criteria | Status |
|-----------|----------|--------|
| **v0.1** | All unit tests passing, `applyFilters` + `optimize` (greedy) working | ✅ Complete |
| **v0.2** | Golden files generated, integration tests within 0.5 dB RMSE | ⚠️ Complete with 1 known failure |
| **v0.3** | npm package, ES+CJS dual build, TypeScript types, CI | ✅ Complete |
| **v1.0** | Full `equalize()` (slope limiting + gain cap) + joint optimizer (JS equivalent of `fmin_slsqp`), all 274 tests green | ✅ Complete |

---

## Module Detail

### `src/biquadResponse.js` ✅

**Completed:** 2026-02-19

**What it does:** Pure-JS biquad filter evaluator. Given a filter type (PK/LSQ/HSQ), center frequency, gain, Q, and an array of frequencies, returns gain in dB at each frequency. This is the mathematical core that every other module depends on.

**Implementation:**
- `biquadCoeffs(type, fc, gain, Q, fs)` — Audio EQ Cookbook coefficient formulas for PK, LSQ, HSQ; normalized to a0=1
- `evalMagnitude(coeffs, f, fs)` — real-valued squared-magnitude identity using `phi = 4*sin²(w/2)`; matches AutoEq's formula exactly
- `biquadResponse(type, fc, gain, Q, frequencies, fs)` — public export

**Test file:** `tests/unit/biquadResponse.test.js` — **19/19 passed**

| # | Test | Result |
|---|------|--------|
| 1 | PK: 0 dB gain → 0 dB at all frequencies | ✅ |
| 2 | LSQ: 0 dB gain → 0 dB at all frequencies | ✅ |
| 3 | HSQ: 0 dB gain → 0 dB at all frequencies | ✅ |
| 4 | PK +3dB at 1kHz: correct gain at fc (~3.036 dB) | ✅ |
| 5 | PK +3dB at 1kHz: near-zero gain far below fc (~0.072 dB at 100 Hz) | ✅ |
| 6 | PK +3dB at 1kHz: near-zero gain far above fc (~0.021 dB at 10kHz) | ✅ |
| 7 | PK −3dB at 1kHz: correct negative gain at fc (~−3.036 dB) | ✅ |
| 8 | PK −3dB at 1kHz: near-zero gain far below fc | ✅ |
| 9 | LSQ +6dB at 100Hz: near-DC frequencies approach +6 dB | ✅ |
| 10 | LSQ +6dB at 100Hz: high frequencies approach 0 dB | ✅ |
| 11 | HSQ +6dB at 10kHz: near-Nyquist frequencies approach +6 dB | ✅ |
| 12 | HSQ +6dB at 10kHz: low frequencies approach 0 dB | ✅ |
| 13 | PK high-Q (Q=10): gain falls off sharply outside bandwidth | ✅ |
| 14 | PK low-Q (Q=0.5): gain is elevated broadly around fc | ✅ |
| 15 | PK: 20 Hz and 20000 Hz produce finite values | ✅ |
| 16 | LSQ: 20 Hz and 20000 Hz produce finite values | ✅ |
| 17 | HSQ: 20 Hz and 20000 Hz produce finite values | ✅ |
| 18 | Returns array with same length as frequencies input | ✅ |
| 19 | PK: positive and negative gain are symmetric | ✅ |

**Key numerical decisions:**
- `fs` defaults to 44100 Hz (matches AutoEq)
- Expected value at fc=1000 Hz, gain=+3 dB, Q=1: **+3.036 dB** (not exactly 3.0 — bilinear transform frequency warping, verified analytically)
- Magnitude formula uses `phi = 4*sin²(w/2)` identity — avoids complex arithmetic, matches AutoEq

---

### `src/applyFilters.js` ✅

**Completed:** 2026-02-19

**What it does:** Applies a list of biquad filters and a pregain to a frequency response curve. Returns a new FR — does not mutate input.

**Implementation:**
- Sums filter responses in dB (cascade = addition in log domain)
- Adds pregain as a flat dB shift

**Test file:** `tests/unit/applyFilters.test.js` — **15/15 passed**

**Lessons learned:** Test FR grids must include exact frequencies used in assertions, not rely on nearest-point lookups. Expected values derived from `biquadResponse` directly, not hardcoded numbers.

---

### `src/interpolate.js` ✅

**Completed:** 2026-02-19

**What it does:** Resamples an FR (arbitrary spacing) to a log-spaced grid using log-linear interpolation. Default grid matches AutoEq: step=1.01, 20–20000 Hz (~461 points).

**Implementation:**
- Builds log-spaced output grid with multiplicative step
- Binary search for surrounding pair, linear interpolation in log-frequency space
- Clamps to nearest endpoint outside input range

**Test file:** `tests/unit/interpolate.test.js` — **14/14 passed**

---

### `src/compensate.js` ✅

**Completed:** 2026-02-19

**What it does:** Computes error = measured − target. Interpolates both curves to a common log-spaced grid before subtraction.

**Implementation:** Two-line body — interpolates both inputs, subtracts point-wise.

**Test file:** `tests/unit/compensate.test.js` — **9/9 passed**

**Lessons learned:** Same grid issue as applyFilters — test assertions must compare against `interpolate(measured) - interpolate(target)`, not against raw input values at approximate grid points.

---

### `src/smooth.js` ✅

**Completed:** 2026-02-19

**What it does:** Fractional-octave smoothing via rectangular moving-average window in log-frequency space. Assumes input is already on a log-spaced grid (output of `interpolate`).

**Implementation:**
- Window defined in octaves (log2 space)
- For each output point: average all input points within ±halfWindow octaves

**Test file:** `tests/unit/smooth.test.js` — **9/9 passed**

---

### `src/equalize.js` ✅

**Completed:** 2026-02-19

**What it does:** Computes the correction curve as the point-wise negation of the error curve. When added to the measured FR, cancels the error and brings it toward the target.

**Implementation:** Single `map` — negates each db value.

**Test file:** `tests/unit/equalize.test.js` — **8/8 passed**

**Key test:** `compensate → equalize` round-trip identity: `measured + equalize(compensate(measured, target)) ≈ target` at every grid point.

---

### `src/optimize.js` ✅

**Completed:** 2026-02-22 (v1.0 joint optimizer)

**What it does:** Joint parametric EQ optimizer matching AutoEQ's SLSQP approach. Finds optimal filter parameters to minimize RMSE between a corrected FR and a target curve.

**Algorithm:**
1. Resolve filterSpecs (new API) or expand maxFilters+gainRange+qRange (old API)
2. Interpolate to pipeline grid (1.01), center, compute error, equalize
3. Interpolate equalization to optimizer grid (1.02)
4. Sequential initialization: HSQ → LSQ → PK, each against remaining correction
5. Joint L-BFGS optimization over all filter params simultaneously, with STD-based convergence (mirrors AutoEQ's SLSQP behavior)
6. Compute pregain

**Implementation:**
- `resolveSpecs(constraints)` — normalize filterSpecs / old API to uniform format
- `sharpnessPenalty(...)` — sigmoid penalty for overly sharp PK filters (matching AutoEQ)
- `initializeFilters(...)` — sequential HSQ → LSQ → PK init against remaining residual
- `lbfgsOptimize(...)` — L-BFGS quasi-Newton with forward finite-difference gradients, Armijo line search, gradient projection for bounds, STD-based convergence
- `optimize(measured, target, constraints)` — public export

**Test file:** `tests/unit/optimize.test.js` — **19/19 passed**

**Historical note:** v0.1 used greedy coordinate descent (golden section per parameter). This was replaced in v1.0 because coordinate descent gets stuck in local minima for ≥10 filters.

---

## v0.2 — Golden Files + Integration Tests ⚠️

**Completed:** 2026-02-20

**What was done:**
- Populated `tests/fixtures/fr/` with 5 real IEM measurements (blessing3, hexa, andromeda, zero2, origin_s)
- Populated `tests/fixtures/targets/` with 6 target curves (harman_ie_2019, diffuse_field, flat, v_shaped, bass_heavy, bright)
- Wrote and ran `tests/generate_golden.py` — 90 golden files generated (5 × 6 × 3 constraints)
- Wrote `tests/integration/optimize.test.js` — 180 tests covering all 90 combinations

**Test structure:**
- **Structural checks (90 tests, all pass):** filter count ≤ maxFilters, all gains/Q/freq within bounds
- **RMSE checks — restricted only (30 tests, 29 pass):** both biquad-fit and AutoEq use all-PK for this constraint set, making the comparison meaningful; tolerance = 0.5 dB
- **RMSE checks — standard + qudelix_10 (60 tests, skipped in v0.2):** AutoEq uses LSQ+PK+HSQ; biquad-fit v1 was PK-only. All 180 RMSE checks are now active with v1.0 filterSpecs API — all blocked on joint optimizer implementation.

## v0.3 — Package + Build ✅

**Completed:** 2026-02-21

**What was done:**
- Added `src/index.js` — public API entry point, exports all 7 functions
- Dual build via esbuild: `dist/index.js` (ESM) and `dist/index.cjs` (CJS)
- TypeScript declaration files generated from JSDoc via `tsc` → `dist/*.d.ts`
- `package.json` updated: `exports` field, `files` whitelist, `version 0.3.0`, `build` script
- CI: GitHub Actions workflow runs `npm run build` + `npm test` on push/PR to main
- README rewritten for public consumption: installation, quick start, full API reference
- Identity: git config, LICENSE, package.json author all updated to CopperLoom
- `scripts/` moved to `tests/scripts/`; CLAUDE.md and `.envrc` added to `.gitignore`
- Fresh repo created at `github.com/CopperLoom/biquad-fit` — single clean initial commit, no prior history

**CI status:** 1 known failure (`blessing3 × bass_heavy × restricted`) — accepted, resolves at v1.0.

## v1.0 — Full `equalize()` + Joint Optimizer ✅

**Completed:** 2026-02-22

**What was done:**
- Rewrote `equalize.js` — full AutoEq-faithful equalization: dual-direction slope limiting, +6 dB gain cap, two-zone smoothing (1/12 oct below 6 kHz, 2 oct above 8 kHz, sigmoid blend), re-smoothing
- Rewrote `smooth.js` — added two-zone smoothing support (sigmoid crossfade between low/high octave windows)
- Implemented joint optimizer in `optimize.js` — L-BFGS quasi-Newton with forward finite-difference gradients (h = √ε), Armijo line search, gradient projection for bounds, STD-based convergence (window=8, min_std=0.002)
- filterSpecs API: supports mixed filter types (LSQ + PK + HSQ) with per-filter bounds
- All 274 tests pass (93 unit + 181 integration), 0 skipped

**Spec:** `docs/joint-optimizer-spec.md`

### `tests/scripts/visualize.js` ✅

**Completed:** 2026-02-22

**What it does:** Generates a self-contained HTML file with side-by-side Canvas charts comparing AutoEQ (golden reference) vs biquad-fit results. Shows measured FR, target curve, and corrected FR on each panel with RMSE annotations and filter tables.

**Usage:**
```bash
node tests/scripts/visualize.js [iem] [target] [constraint]
node tests/scripts/visualize.js origin_s diffuse_field qudelix_10
node tests/scripts/visualize.js -h
```

## Next: npm publish + v1.1 simplification pass
