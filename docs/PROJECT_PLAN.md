# biquad-fit: Project Plan

> **Status:** v0.1 complete — all unit tests passing (87/87), greedy optimizer implemented
> **Date:** 2026-02-18 · **Last updated:** 2026-02-19

---

## Part 1: Principles

These are goals and preferences — not hard rules. When a design choice conflicts with one, we flag it explicitly and evaluate the tradeoff before deciding.

### P1 — Scope matches AutoEq, nothing more

This library does what [jaakkopasanen/AutoEq](https://github.com/jaakkopasanen/AutoEq) does. No more. The scope is:

- Load and interpolate frequency response data
- Smooth frequency response curves
- Compensate a measured FR against a target (compute the error)
- Compute an equalization curve from the error
- Optimize parametric EQ filter parameters (freq, gain, Q, type)
- Apply filters to an FR curve mathematically (preview / verify)
- Export results

It does **not** apply EQ to audio signals. It does not provide a UI. It does not fetch data from the internet. It has no persistent state.

### P2 — AutoEq is the oracle

Correctness is defined as: given the same inputs, produce outputs that are within perceptual tolerance of what AutoEq produces. We do not invent our own accuracy standard. Where our output differs meaningfully from AutoEq's, we treat that as a bug.

### P3 — Browser and Node.js, one implementation

The library must work in both environments without separate builds or conditional imports. Pure JS implementation is the baseline. If the Web Audio API's `BiquadFilterNode.getFrequencyResponse()` is detected, use it — but the library does not depend on it. A ~30-line pure JS biquad evaluator handles the Node.js case and is the fallback everywhere.

### P4 — Zero runtime dependencies

`npm install biquad-fit` installs nothing else. No transitive dependencies. Dev dependencies (test runner, bundler) are fine — they don't ship with the library.

### P5 — Match AutoEq's function surface for v1

The v1 API mirrors AutoEq's existing function set. We do not invent new functions or abstractions. Once v1 is stable and published, convenience wrappers or single-function bundles can be layered on top.

### P6 — GitHub-first, npm when it feels ready

Development happens in the public GitHub repository from day one. npm publish happens when the test suite passes and the API feels stable. No artificial deadline.

### P7 — TDD

The test suite is written before or alongside implementation. Tests define correctness. A feature is not done until its tests pass.

---

## Part 2: Scope

### What AutoEq does (and therefore what we do)

The core of AutoEq is the `FrequencyResponse` class. Its operations, translated to our function surface:

| AutoEq method | biquad-fit equivalent | Description |
|---|---|---|
| `FrequencyResponse(name, frequency, raw)` | `createFR(points)` | Wrap FR data |
| `.interpolate()` | `interpolate(fr, options)` | Resample to log-spaced grid |
| `.center()` | `center(fr)` | Normalize mean level |
| `.compensate(target)` | `compensate(fr, target)` | Subtract target, compute error |
| `.smoothen(window_size)` | `smooth(fr, options)` | Smooth the curve |
| `.equalize()` | `equalize(fr)` | Compute correction curve from error |
| `.optimize_parametric_eq(configs, fs)` | `optimize(error, constraints)` | Find optimal PEQ filters |
| *(apply filters to FR)* | `applyFilters(fr, filters, pregain)` | Preview corrected FR |

These are the building blocks. The primary entry point is `optimize()` which orchestrates the full pipeline.

---

## Part 3: TDD Test Suite

### Strategy

AutoEq is the oracle. For every test, we:
1. Run AutoEq (Python) on known inputs → capture output as a golden JSON file
2. Run biquad-fit on the same inputs → compare to golden file

This means our test suite has two parts:
- **Golden file generation** — a Python script that runs AutoEq and writes expected outputs
- **JS tests** — run biquad-fit against the same inputs, assert outputs match within tolerance

### Tolerance

Filter parameters (freq, gain, Q) can differ between two optimizers while producing acoustically identical corrections. Testing individual parameter values is fragile. Instead, the primary accuracy metric is:

> **RMSE of the corrected FR vs target** — must be within 0.5 dB of what AutoEq achieves on the same input.

Secondary assertions (individual filter count, gain range, type) catch gross failures.

### Test Fixtures

Five IEM measurements covering distinct FR shapes, stored as `tests/fixtures/fr/*.json`:

**IEM measurements** (real-world, pulled from squig.link/crinacle), stored as `tests/fixtures/fr/*.json`:

| Fixture | IEM | Why |
|---|---|---|
| `blessing3.json` | Moondrop Blessing 3 | Near-Harman, well-measured, popular reference point |
| `hexa.json` | Truthear Hexa | Flat-ish, good baseline real-world case |
| `andromeda.json` | Campfire Andromeda | Known treble peaks, notoriously tricky to EQ |
| `e3000.json` | Final Audio E3000 | V-shaped, budget classic, real consumer signature |

**Target curves**, stored as `tests/fixtures/targets/*.json`:

Standard (pulled from AutoEq / community sources):

| Target | Source | Why |
|---|---|---|
| `harman_ie_2019.json` | Harman International | Most commonly used IEM target |
| `diffuse_field.json` | ITU-R BS.1116 | Classic reference target |
| `ief_neutral.json` | IEF Neutral | Popular community alternative to Harman |
| `df_neutral.json` | Etymotic DF-Neutral | Diffuse field variant, different high-freq rolloff |

Synthetic tuning preferences (constructed, not measured):

| Target | Shape | Why |
|---|---|---|
| `flat.json` | Flat ±0.1 dB | Neutral reference — optimizer should produce near-zero filters |
| `v_shaped.json` | Bass +4 dB, treble +3 dB, mid -2 dB | Tests correction toward a preference, not a standard |
| `bass_heavy.json` | Bass shelf +6 dB | Tests low-shelf target handling |
| `bright.json` | Treble +4 dB above 5kHz, thin bass | Tests high-shelf target handling |

Wildcard:

| Target | Why |
|---|---|
| `wildcard.json` | TBD — author-supplied target curve |

*Note: `wildcard.json` is a placeholder. Golden file generation skips it until the file is present.*

### Test Matrix

Every IEM measurement × every target × two constraint sets = (4 measurements × 9 targets × 2 constraint sets) = 72 combinations. Wildcard target excluded until supplied.

Constraint sets:
- **Standard:** 5 filters, gain ±12 dB, Q 0.5–10, all filter types
- **Restricted:** 3 filters, gain ±6 dB, Q 1.0–5.0, PK only

### Test Categories

#### Unit Tests — each component in isolation

```
interpolate()
  ✓ output has correct number of points
  ✓ output frequencies are log-spaced
  ✓ output is monotonically increasing in frequency
  ✓ interpolated values match known analytical points
  ✓ handles sparse input (10 points → 1000 points)
  ✓ handles dense input (already 1000 points)

center()
  ✓ mean of output is 0 dB (or reference level)
  ✓ shape is preserved (subtract constant, not modify curve)

compensate(fr, target)
  ✓ output = measured - target at each frequency
  ✓ where measured === target, output is 0 dB
  ✓ correctly handles different frequency grids (interpolates before subtracting)

smooth(fr, options)
  ✓ output has same frequency grid as input
  ✓ peak-to-peak range is reduced
  ✓ flat input remains flat after smoothing
  ✓ 1/3 octave window produces expected result on known input

equalize(fr)
  ✓ output is negation of error (to cancel it)
  ✓ passes through compensate → equalize identity check

applyFilters(fr, filters, pregain)
  ✓ flat FR + no filters = flat FR
  ✓ flat FR + +3 dB PK at 1kHz = +3 dB at 1kHz, flat elsewhere
  ✓ pregain shifts entire curve by correct amount
  ✓ results match known biquad transfer function values (Audio EQ Cookbook)
  ✓ LSQ filter shape is correct
  ✓ HSQ filter shape is correct

biquadResponse() — pure JS evaluator
  ✓ matches BiquadFilterNode.getFrequencyResponse() when available (within 1e-6)
  ✓ PK at 1kHz +3dB: correct gain at 1kHz, ~0dB at 100Hz and 10kHz
  ✓ handles edge frequencies (20Hz, 20kHz)
```

#### Integration Tests — full pipeline vs AutoEq golden files

```
optimize(fr, target, constraints)
  For each fixture × target × constraint combination:
  ✓ returns { pregain, filters } with correct structure
  ✓ filter count ≤ constraints.maxFilters
  ✓ all gains within constraints.gainRange
  ✓ all Q values within constraints.qRange
  ✓ all frequencies within constraints.freqRange
  ✓ RMSE of applyFilters(fr, filters) vs target is within 0.5 dB of AutoEq's RMSE
```

#### Edge Case Tests

```
✓ empty FR input throws descriptive error
✓ FR with only 2 points (minimum valid)
✓ FR with 5000 points (dense measurement)
✓ target with different frequency range than measured
✓ maxFilters = 1 (single filter)
✓ maxFilters = 10 (max for common devices)
✓ gainRange = [0, 0] (no gain allowed — all filters should be zero)
✓ measured === target (no correction needed — filters should be trivial)
✓ extreme error curve (+20 dB deviation) clamped correctly to gainRange
```

#### Regression Tests — golden file exact output

For the five fixtures × harman_ie_2019 target × standard constraints:
```
✓ filter count matches golden file
✓ each filter freq within ±5% of golden
✓ each filter gain within ±0.5 dB of golden
✓ each filter Q within ±0.1 of golden
✓ pregain within ±0.5 dB of golden
✓ corrected FR RMSE within 0.5 dB of golden
```

### Golden File Generation

A Python script at `tests/generate_golden.py`:
- Takes each test fixture FR + target
- Runs it through AutoEq's `FrequencyResponse` pipeline
- Writes `tests/fixtures/golden/{fixture}_{target}_{constraints}.json`

Must be re-run whenever AutoEq updates. Golden files are committed to the repo.

### Ad-hoc Comparison Tool

`tests/scripts/compare.js` runs both AutoEQ and biquad-fit on any FR + target file pair and prints a side-by-side filter table. Useful for exploring novel scenarios beyond the fixed test matrix.

```bash
# From project root (accepts JSON or squiglink CSV)
node tests/scripts/compare.js <fr_file> <target_file> [bands]
node tests/scripts/compare.js fr.csv target.json 10 --gain 12 --q-min 0.5 --q-max 10

# Examples
node tests/scripts/compare.js tests/fixtures/fr/blessing3.json tests/fixtures/targets/harman_ie_2019.json 5
node tests/scripts/compare.js ~/path/to/iem.csv tests/fixtures/targets/flat.json 8 --freq-max 20000
```

Flags: `--bands N`, `--gain G` (±dB), `--q-min Q`, `--q-max Q`, `--freq-min F`, `--freq-max F`

**Input formats:**
- JSON: `[{freq, db}, ...]`
- CSV: two-column with `frequency` and `raw` (or `db`) headers (squiglink format)

**Note on scaling:** raw IEM measurements are in absolute SPL (~85–105 dB). The tool auto-centers the FR at 1kHz before passing to biquad-fit (matching AutoEQ's internal `center()` step). When writing integration tests that call `optimize()` directly on fixture data, apply the same centering first.

**Note on filter types:** both engines currently use all-PK filters. When the v2 DE optimizer adds LSQ/HSQ support, update `buildAutoeqConfig()` in `compare.js` to use mixed types — there is a TODO comment there and a `test.skip` in `tests/unit/optimize.test.js` as reminders.

### Test Runner

**Vitest** — fast, ES module native, no config overhead, works in Node.js.

---

## Part 4: Implementation Order

TDD means tests come first. Implementation order follows test dependencies:

1. `biquadResponse()` — pure JS biquad evaluator (needed by everything)
2. `applyFilters()` — depends on biquadResponse
3. `interpolate()` — independent
4. `center()` — depends on interpolate
5. `compensate()` — depends on interpolate
6. `smooth()` — depends on interpolate
7. `equalize()` — depends on compensate
8. `optimize()` — depends on all of the above
9. Golden file generation script (Python)
10. Integration tests against golden files

---

## Part 5: Milestones

| Milestone | Definition of done |
|---|---|
| **v0.1** | All unit tests passing. `applyFilters` and `optimize` (greedy) working. |
| **v0.2** | Golden files generated. Integration tests passing within 0.5 dB RMSE tolerance. |
| **v0.3** | npm package structure, ES + CJS dual build, TypeScript types, CI on GitHub Actions |
| **v1.0** | Differential evolution optimizer, full test suite green, published to npm |
