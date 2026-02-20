# biquad-fit: Test Plan

> Sources: [Audio EQ Cookbook (W3C)](https://webaudio.github.io/Audio-EQ-Cookbook/Audio-EQ-Cookbook.txt) · [jaakkopasanen/AutoEq](https://github.com/jaakkopasanen/AutoEq)
> Companion spec: `PROJECT_PLAN.md`

---

## 1. Scope and Goals

Every module has unit tests defined before implementation (TDD). Integration tests compare the full pipeline against AutoEq golden files. Correctness standard: RMSE of the corrected FR vs target must be within **0.5 dB** of what AutoEq produces on the same input.

**Test runner:** Vitest (`npx vitest run`)
**File layout:** one unit test file per source module, integration tests separate:

```
tests/
├── unit/
│   ├── biquadResponse.test.js
│   ├── applyFilters.test.js
│   ├── interpolate.test.js
│   ├── compensate.test.js
│   ├── smooth.test.js
│   ├── equalize.test.js
│   └── optimize.test.js
├── integration/
│   └── pipeline.test.js
├── fixtures/
│   ├── fr/           # IEM measurements
│   ├── targets/      # Target curves
│   └── golden/       # AutoEq reference outputs (generated)
└── generate_golden.py
```

---

## 2. Mathematical Reference

### 2.1 Coefficient Formulas (Audio EQ Cookbook)

All three filter types share these derived quantities:

```
A   = 10^(dBgain / 40)
w0  = 2π × fc / fs
α   = sin(w0) / (2 × Q)
```

**Peaking EQ (PK)**
```
b0 = (1 + α×A) / a0_raw
b1 = (−2×cos(w0)) / a0_raw
b2 = (1 − α×A) / a0_raw
a1 = (−2×cos(w0)) / a0_raw    ← same as b1
a2 = (1 − α/A) / a0_raw
where a0_raw = 1 + α/A
```

**Low Shelf (LSQ)**
```
a0_raw = (A+1) + (A−1)×cos(w0) + 2×√A×α
b0 = A × ((A+1) − (A−1)×cos(w0) + 2×√A×α) / a0_raw
b1 = 2A × ((A−1) − (A+1)×cos(w0))         / a0_raw
b2 = A × ((A+1) − (A−1)×cos(w0) − 2×√A×α) / a0_raw
a1 = −2 × ((A−1) + (A+1)×cos(w0))         / a0_raw
a2 = ((A+1) + (A−1)×cos(w0) − 2×√A×α)     / a0_raw
```

**High Shelf (HSQ)**
```
a0_raw = (A+1) − (A−1)×cos(w0) + 2×√A×α
b0 = A × ((A+1) + (A−1)×cos(w0) + 2×√A×α) / a0_raw
b1 = −2A × ((A−1) + (A+1)×cos(w0))         / a0_raw
b2 = A × ((A+1) + (A−1)×cos(w0) − 2×√A×α) / a0_raw
a1 = 2 × ((A−1) − (A+1)×cos(w0))           / a0_raw
a2 = ((A+1) − (A−1)×cos(w0) − 2×√A×α)      / a0_raw
```

All `a0` values are normalized to 1.0. Coefficients stored and passed as `{b0, b1, b2, a1, a2}`.

### 2.2 Magnitude Formula

Given normalized coefficients, the gain in dB at angular frequency `w = 2π×f/fs`:

```
phi = 4 × sin(w/2)²

num = (b0+b1+b2)² + (b0×b2×phi − b1×(b0+b2) − 4×b0×b2) × phi
den = (1+a1+a2)²  + (a2×phi     − a1×(1+a2)  − 4×a2)    × phi

gain_dB = 10 × log10(num / den)
```

This is the real-valued squared-magnitude identity derived from `|H(e^jw)|²`. It avoids complex arithmetic. This formula must be used identically in `biquadResponse.js` and verified against reference values below.

For a **cascade** of filters, sum the dB values: `total_dB[i] = Σ filter_dB[i]`.

### 2.3 Analytical Boundary Values

These hold exactly (or in the limit) from the transfer function algebra:

| Filter | Condition | Expected gain |
|--------|-----------|---------------|
| Any | `dBgain = 0` | 0 dB at all frequencies |
| PK | `f = fc` (exactly) | ≈ `dBgain` (within bilinear warping) |
| PK | `f ≪ fc` or `f ≫ fc` | ≈ 0 dB |
| LSQ | `f → 0` (DC) | `dBgain` (exactly: `H(z=1) = A²`, so `40×log10(A) = dBgain`) |
| LSQ | `f → fs/2` (Nyquist) | ≈ 0 dB |
| HSQ | `f → fs/2` (Nyquist) | `dBgain` (exactly: `H(z=−1) = A²`, so `40×log10(A) = dBgain`) |
| HSQ | `f → 0` (DC) | ≈ 0 dB |

### 2.4 Pre-Computed Reference Values

The following are derived analytically from the formulas above with `fs = 44100 Hz`. Tests use these as expected values with tolerance ±0.01 dB.

**Case A: PK at fc=1000 Hz, dBgain=+3 dB, Q=1.0**
```
A   = 10^(3/40)   ≈ 1.18850
w0  ≈ 0.142476 rad
α   ≈ 0.070998
a0_raw ≈ 1.059739

Normalized coefficients:
  b0 ≈  1.023254
  b1 ≈ −1.868145
  b2 ≈  0.863989
  a1 ≈ −1.868145   (same as b1)
  a2 ≈  0.887169

Expected gains:
  f = 100 Hz  → ≈ +0.072 dB   (far below fc, near 0)
  f = 1000 Hz → ≈ +3.036 dB   (at fc, bilinear-warped)
  f = 10000 Hz → ≈ +0.021 dB  (far above fc, near 0)
```

**Case B: PK at fc=1000 Hz, dBgain=−3 dB, Q=1.0**
Gain is symmetric: ≈ −3.036 dB at 1000 Hz, ≈ 0 dB at 100/10000 Hz.

**Case C: LSQ at fc=100 Hz, dBgain=+6 dB, Q=0.707**
```
DC gain (f≈0) = +6.0 dB exactly (analytical)
f = 20 Hz    → close to +6 dB (within 0.5 dB)
f = 10000 Hz → close to 0 dB  (within 0.1 dB)
```

**Case D: HSQ at fc=10000 Hz, dBgain=+6 dB, Q=0.707**
```
Nyquist gain (f→22050 Hz) = +6.0 dB exactly (analytical)
f = 20 Hz    → close to 0 dB  (within 0.1 dB)
f = 15000 Hz → close to +6 dB (within 0.5 dB)
```

### 2.5 AutoEq Numerical Constants

These constants appear in AutoEq's optimizer and must be matched in `optimize.js`:

| Constant | Value | Usage |
|----------|-------|-------|
| `fs` | 44100 Hz | Biquad coefficient computation |
| Frequency grid step (standard) | ×1.01 per step | ~461 points, 20–20 kHz |
| Frequency grid step (optimizer) | ×1.02 per step | ~231 points, 20–20 kHz |
| PK Q bounds | [0.18248, 6.0] | Optimizer parameter bounds |
| Shelf Q bounds | [0.4, 0.7] | Optimizer parameter bounds |
| fc bounds | [20, 10000] Hz | All filter types |
| Gain bounds | [−20, +20] dB | All filter types |
| Above-10 kHz treatment | collapse to mean | In optimizer loss computation |
| RMSE stop threshold | std < 0.002 | Main early-exit criterion |

---

## 3. Unit Tests

### 3.1 `biquadResponse.js`

Tests the pure-JS biquad evaluator. Covers coefficient computation and the magnitude formula.

#### 3.1.1 Zero-gain identity

```
Input:  any filter type, dBgain = 0, any fc, any Q
Output: 0.0 dB at every frequency in [20, 20000] Hz
```

*Rationale: When A=1, the peaking filter's b=a (H≡1). Shelf filters also reduce to all-pass.*

```
test('PK 0 dB gain → 0 dB everywhere', ...)
test('LSQ 0 dB gain → 0 dB everywhere', ...)
test('HSQ 0 dB gain → 0 dB everywhere', ...)
```

#### 3.1.2 Peaking filter at center frequency

```
Input:  PK, fc=1000, dBgain=+3, Q=1.0, fs=44100
Expect: gain at f=1000 Hz ≈ +3.036 dB  (±0.01 dB)
        gain at f=100 Hz  ≈ +0.072 dB  (±0.01 dB)
        gain at f=10000 Hz ≈ +0.021 dB (±0.01 dB)
```

```
test('PK +3dB at 1kHz: correct gain at fc, near-zero elsewhere', ...)
```

#### 3.1.3 Peaking filter negative gain

```
Input:  PK, fc=1000, dBgain=−3, Q=1.0, fs=44100
Expect: gain at f=1000 Hz ≈ −3.036 dB (±0.01 dB)
```

```
test('PK −3dB at 1kHz: correct negative gain', ...)
```

#### 3.1.4 Low shelf DC gain

```
Input:  LSQ, fc=100, dBgain=+6, Q=0.707, fs=44100, frequencies=[10, 20, 50]
Expect: all three gains within 0.5 dB of +6.0 dB
        (DC limit is exactly +6 dB by algebra)
```

```
test('LSQ +6dB: near-DC frequencies approach +6 dB', ...)
```

#### 3.1.5 Low shelf high-frequency rolloff

```
Input:  LSQ, fc=100, dBgain=+6, Q=0.707, fs=44100, frequencies=[10000, 15000, 20000]
Expect: all three gains within 0.1 dB of 0.0 dB
```

```
test('LSQ +6dB: high frequencies approach 0 dB', ...)
```

#### 3.1.6 High shelf Nyquist gain

```
Input:  HSQ, fc=10000, dBgain=+6, Q=0.707, fs=44100, frequencies=[18000, 20000, 22000]
Expect: all three gains within 0.5 dB of +6.0 dB
```

```
test('HSQ +6dB: near-Nyquist frequencies approach +6 dB', ...)
```

#### 3.1.7 High shelf low-frequency rolloff

```
Input:  HSQ, fc=10000, dBgain=+6, Q=0.707, fs=44100, frequencies=[20, 100, 500]
Expect: all three gains within 0.1 dB of 0.0 dB
```

```
test('HSQ +6dB: low frequencies approach 0 dB', ...)
```

#### 3.1.8 Narrow PK selectivity

```
Input:  PK, fc=1000, dBgain=+6, Q=10.0, fs=44100
Expect: gain at f=1000 Hz ≈ +6 dB
        gain at f=900 Hz  < +3 dB   (outside half-power bandwidth)
        gain at f=1100 Hz < +3 dB
```

*Rationale: High Q → narrow bandwidth. Checks Q is applied correctly.*

```
test('PK high-Q: gain falls off sharply outside bandwidth', ...)
```

#### 3.1.9 Wide PK spread

```
Input:  PK, fc=1000, dBgain=+6, Q=0.5, fs=44100
Expect: gain at f=1000 Hz ≈ +6 dB
        gain at f=500 Hz   > +3 dB  (within broad bandwidth)
        gain at f=2000 Hz  > +3 dB
```

```
test('PK low-Q: gain is elevated broadly around fc', ...)
```

#### 3.1.10 Edge frequencies do not produce NaN or ±Infinity

```
Input:  any filter type, frequencies=[20, 22050]
Expect: finite number at both extremes
```

```
test('biquadResponse: 20 Hz and 22050 Hz produce finite values', ...)
```

#### 3.1.11 Coefficient structure

```
Input:  any valid (fc, gain, Q, type, fs)
Expect: returned object has keys {b0, b1, b2, a1, a2}
        all values are finite numbers
        a0 is implicitly 1.0 (not returned, normalized)
```

*Tests the internal coefficients helper, if exported.*

---

### 3.2 `applyFilters.js`

Tests applying a list of `{fc, gain, Q, type}` filters (plus pregain) to an FR curve.

#### 3.2.1 No filters, zero pregain → identity

```
Input:  flat FR (0 dB at all frequencies), filters=[], pregain=0
Output: 0 dB at all frequencies
```

```
test('applyFilters: no filters → identity', ...)
```

#### 3.2.2 Pregain shifts entire curve

```
Input:  flat FR (0 dB), filters=[], pregain=−3
Output: −3 dB at all frequencies
```

```
test('applyFilters: pregain shifts all values', ...)
```

#### 3.2.3 Single PK filter shapes correctly

```
Input:  flat FR (0 dB at all freqs), filters=[{fc:1000, gain:+3, Q:1, type:'PK'}], pregain=0
Expect: at f=1000 Hz: ≈ +3.036 dB (from Case A above)
        at f=100 Hz:  ≈ +0.072 dB
        at f=10000 Hz: ≈ +0.021 dB
```

*Directly validates the round-trip from biquadResponse into applyFilters.*

```
test('applyFilters: single PK filter produces correct shape', ...)
```

#### 3.2.4 Filter stacking adds in dB

```
Input:  flat FR, filters=[
          {fc:1000, gain:+3, Q:1, type:'PK'},
          {fc:1000, gain:+3, Q:1, type:'PK'},
        ], pregain=0
Expect: at f=1000 Hz: ≈ 2 × 3.036 = 6.072 dB
```

*Cascaded filters sum in dB.*

```
test('applyFilters: two identical filters double the dB gain', ...)
```

#### 3.2.5 Non-flat input FR

```
Input:  FR with +2 dB at all frequencies, filters=[{fc:1000, gain:+3, Q:1, type:'PK'}], pregain=0
Expect: output = input + filter_response (point-wise)
        at f=1000 Hz: ≈ 2 + 3.036 = 5.036 dB
        at f=100 Hz:  ≈ 2 + 0.072 = 2.072 dB
```

```
test('applyFilters: filters add to non-flat input', ...)
```

#### 3.2.6 LSQ on non-flat input

```
Input:  flat FR, filters=[{fc:100, gain:+6, Q:0.707, type:'LSQ'}], pregain=0
Expect: at f=20 Hz:    ≈ +6 dB (within 0.5 dB)
        at f=10000 Hz: ≈  0 dB (within 0.1 dB)
```

```
test('applyFilters: LSQ filter correct shape on flat input', ...)
```

---

### 3.3 `interpolate.js`

Resamples an FR (arbitrary `{freq, db}` points) to a standard log-spaced grid.

**Standard grid:** `step = 1.01`, range `[20, 20000]` Hz → ~461 points.

#### 3.3.1 Output length

```
Input:  any valid FR, options={step:1.01, fMin:20, fMax:20000}
Expect: output.length ≈ 461  (within ±2)
```

*Exact count = ceil(log(fMax/fMin) / log(step)) + 1.*

```
test('interpolate: output has expected point count', ...)
```

#### 3.3.2 Frequencies are log-spaced

```
Input:  any FR, standard grid options
Expect: for all consecutive output points i, i+1:
        output[i+1].freq / output[i].freq ≈ 1.01 (within ±0.001)
```

```
test('interpolate: output frequencies are log-spaced', ...)
```

#### 3.3.3 Frequencies are monotonically increasing

```
Expect: output[i+1].freq > output[i].freq for all i
```

```
test('interpolate: frequencies are monotonically increasing', ...)
```

#### 3.3.4 Known analytical values preserved

```
Input:  FR = [{freq:100, db:0}, {freq:1000, db:6}, {freq:10000, db:0}]
        (linear ramp in log space between 100→1000→10000 Hz)
Expect: interpolated value at f=316 Hz (≈ geometric mean of 100 and 1000)
        ≈ 3.0 dB (±0.1 dB, assuming log-linear interpolation)
```

```
test('interpolate: interpolated values match log-linear interpolation', ...)
```

#### 3.3.5 Sparse input (extrapolation behavior)

```
Input:  only 5 points covering full range, standard output grid (461 points)
Expect: no NaN or undefined in output
        output values within the input's min/max dB range (no extrapolation runaway)
```

```
test('interpolate: sparse input (5 points) → full output with no NaN', ...)
```

#### 3.3.6 Dense input (downsampling)

```
Input:  5000-point FR, standard output grid (461 points)
Expect: output has ~461 points
        values match input at coincident frequencies (within 0.01 dB)
```

```
test('interpolate: dense input downsamples correctly', ...)
```

---

### 3.4 `compensate.js`

Computes `error = measured − target` at each frequency.

#### 3.4.1 Subtraction correctness

```
Input:  measured=[0, 3, 6] dB at [100, 1000, 10000] Hz (already same grid as target)
        target  =[0, 1, 2] dB at [100, 1000, 10000] Hz
Output: [0, 2, 4] dB at same frequencies
```

```
test('compensate: output = measured − target point-wise', ...)
```

#### 3.4.2 Perfect match → zero error

```
Input:  measured = target (identical frequency and dB arrays)
Output: 0.0 dB at all frequencies
```

```
test('compensate: measured = target → all zeros', ...)
```

#### 3.4.3 Different frequency grids

```
Input:  measured on 100 points, target on 461 points (different grids)
Expect: function interpolates before subtracting — no crash, output is finite
```

```
test('compensate: handles mismatched frequency grids', ...)
```

#### 3.4.4 Negative error (target above measured)

```
Input:  measured < target everywhere
Output: all values negative
```

```
test('compensate: produces negative values when measured < target', ...)
```

---

### 3.5 `smooth.js`

Applies fractional-octave smoothing to an FR curve.

#### 3.5.1 Same frequency grid

```
Input:  any FR on standard grid, any smoothing options
Output: same frequency grid as input (not resampled)
```

```
test('smooth: output has same frequency grid as input', ...)
```

#### 3.5.2 Reduces peak-to-peak range

```
Input:  FR with sharp spike: 0 dB everywhere except one point at +10 dB
Output: peak value < +10 dB (spike is smoothed down)
        total range of output < total range of input
```

```
test('smooth: reduces peak-to-peak variation', ...)
```

#### 3.5.3 Flat input stays flat

```
Input:  constant 0 dB at all frequencies
Output: constant 0 dB at all frequencies (within ±0.001 dB)
```

```
test('smooth: flat input remains flat after smoothing', ...)
```

#### 3.5.4 1/3-octave window — known result

```
Input:  step function: 0 dB below 1000 Hz, +6 dB above 1000 Hz
        options: window = 1/3 octave
Expect: at 1000 Hz: value between 0 and 6 dB (transition zone)
        at 100 Hz: close to 0 dB (within 0.5 dB)
        at 5000 Hz: close to +6 dB (within 0.5 dB)
```

```
test('smooth: 1/3-octave window smooths step function correctly', ...)
```

---

### 3.6 `equalize.js`

Computes the correction curve from the error curve.

#### 3.6.1 Negation of error

```
Input:  error = [−3, 0, +5] dB at [100, 1000, 5000] Hz
Output: [+3, 0, −5] dB at same frequencies
```

```
test('equalize: output is negation of input error', ...)
```

#### 3.6.2 Round-trip identity with compensate

```
Input:  any measured FR, any target FR
Steps:  error = compensate(measured, target)
        eq    = equalize(error)
        result = measured + eq   (point-wise, same grid)
Expect: result ≈ target at all frequencies (within floating-point tolerance)
```

*This checks that compensate → equalize → apply is a perfect correction.*

```
test('equalize: compensate → equalize forms identity pair', ...)
```

---

### 3.7 `optimize.js` (unit-level)

Tests the optimizer's output structure and constraint enforcement, independent of AutoEq golden comparison.

#### 3.7.1 Return structure

```
Input:  any valid FR, any target, standard constraints
Expect: return value is {pregain: number, filters: Array}
        each filter has {fc, gain, Q, type}
        type is one of 'PK', 'LSQ', 'HSQ'
```

```
test('optimize: returns {pregain, filters} with correct shape', ...)
```

#### 3.7.2 Filter count respects maxFilters

```
Input:  constraints.maxFilters = 3
Expect: filters.length <= 3
```

```
test('optimize: filter count does not exceed maxFilters', ...)
```

#### 3.7.3 Gains respect gainRange

```
Input:  constraints.gainRange = [−6, +6]
Expect: all filter gains within [−6, +6] dB
```

```
test('optimize: all filter gains within gainRange', ...)
```

#### 3.7.4 Q values respect qRange

```
Input:  constraints.qRange = [1.0, 5.0]
Expect: all filter Q values within [1.0, 5.0]
```

```
test('optimize: all Q values within qRange', ...)
```

#### 3.7.5 Frequencies respect freqRange

```
Input:  constraints.freqRange = [20, 10000]
Expect: all filter fc values within [20, 10000] Hz
```

```
test('optimize: all fc values within freqRange', ...)
```

#### 3.7.6 Measured = target → trivial result

```
Input:  measured === target (identical data)
Expect: RMSE of applyFilters(measured, result.filters, result.pregain) vs target ≈ 0 dB
        (filters may exist but net correction should be negligible)
```

```
test('optimize: no-error input produces near-trivial correction', ...)
```

---

## 4. Integration Tests

**File:** `tests/integration/pipeline.test.js`

Prerequisite: golden files in `tests/fixtures/golden/` have been generated by `tests/generate_golden.py`.

### 4.1 Golden File Smoke Test

```
For each golden file present:
  ✓ File is valid JSON with keys {pregain, filters, rmse}
  ✓ filters array is non-empty
  ✓ rmse is a positive finite number
```

### 4.2 Full Pipeline vs AutoEq (Primary Accuracy Test)

**Test matrix:** 4 IEM fixtures × 8 targets × 2 constraint sets = 64 combinations.

Targets (excluding wildcard): `harman_ie_2019`, `diffuse_field`, `ief_neutral`, `df_neutral`, `flat`, `v_shaped`, `bass_heavy`, `bright`.

Constraint sets:
- **Standard:** `{maxFilters:5, gainRange:[−12,+12], qRange:[0.5,10], freqRange:[20,10000]}`
- **Restricted:** `{maxFilters:3, gainRange:[−6,+6], qRange:[1,5], freqRange:[20,10000], types:['PK']}`

For each combination:
```
golden = load golden file for (fixture, target, constraintSet)
result = optimize(loadFR(fixture), loadTarget(target), constraintSet)
corrected = applyFilters(fr, result.filters, result.pregain)
rmse = computeRMSE(corrected, target)

✓ rmse <= golden.rmse + 0.5   (within 0.5 dB of AutoEq's result)
✓ result.filters.length <= constraintSet.maxFilters
✓ all gains in result.filters within constraintSet.gainRange
```

```
test.each(testMatrix)('pipeline: %s + %s + %s within 0.5dB of AutoEq', ...)
```

### 4.3 Regression Tests (harman_ie_2019, standard constraints)

For the 4 IEM fixtures × Harman target × standard constraints, do a stricter parameter-level comparison:

```
golden = golden file for (fixture, harman_ie_2019, standard)

✓ result.filters.length === golden.filters.length   (±1 allowed)
✓ result.pregain within ±0.5 dB of golden.pregain
✓ RMSE of corrected FR within 0.5 dB of golden.rmse

For each filter pair (matched by closest fc):
  ✓ fc within ±5% of golden fc
  ✓ gain within ±0.5 dB of golden gain
  ✓ Q within ±0.1 of golden Q
```

*Note: Parameter-level comparisons are secondary — two different sets of parameters can produce the same acoustic correction. A passing RMSE test with failing parameter tests is acceptable.*

```
test.each(iemFixtures)('regression: %s + harman + standard: parameters near golden', ...)
```

---

## 5. Edge Case Tests

**File:** `tests/unit/edgeCases.test.js`

### 5.1 Input validation

```
✓ empty FR array → throws with descriptive message
✓ FR with 1 point → throws (minimum 2 required)
✓ FR with 2 points → does not throw
✓ null/undefined FR → throws
✓ non-numeric dB values → throws
✓ non-increasing frequencies → throws
```

### 5.2 Degenerate frequency ranges

```
✓ target frequency range entirely above measured range → no crash; result is finite
✓ target frequency range entirely below measured range → no crash; result is finite
```

### 5.3 Single filter

```
Input:  constraints.maxFilters = 1
Expect: exactly 1 filter returned
        RMSE is finite and non-negative
```

### 5.4 Maximum filters

```
Input:  constraints.maxFilters = 10
Expect: at most 10 filters returned
        RMSE is finite
```

### 5.5 Zero gain range

```
Input:  constraints.gainRange = [0, 0]
Expect: all filter gains === 0 dB
        pregain === 0 dB
```

### 5.6 Extreme error input

```
Input:  measured is +20 dB at all frequencies relative to target
        constraints.gainRange = [−12, +12]
Expect: optimizer applies maximum correction within limits
        no filter gain exceeds −12 dB
```

### 5.7 Dense measured FR

```
Input:  5000-point FR (very dense measurement)
Expect: pipeline completes without error
        output is finite
```

---

## 6. Test Fixture Format

All FR files (measured and target) use:

```json
{
  "name": "Human-readable name",
  "points": [
    {"freq": 20, "db": 0.0},
    {"freq": 21.8, "db": 0.5},
    ...
  ]
}
```

Golden files use:

```json
{
  "fixture": "blessing3",
  "target": "harman_ie_2019",
  "constraints": "standard",
  "pregain": -2.5,
  "filters": [
    {"fc": 105, "gain": -3.2, "Q": 2.1, "type": "PK"},
    ...
  ],
  "rmse": 0.84
}
```

---

## 7. RMSE Helper

Tests require a `computeRMSE(corrected, target)` helper:

```js
// Both arrays are {freq, db} on the same grid
function computeRMSE(corrected, target) {
  const n = corrected.length;
  const sumSq = corrected.reduce((acc, pt, i) => {
    const diff = pt.db - target[i].db;
    return acc + diff * diff;
  }, 0);
  return Math.sqrt(sumSq / n);
}
```

---

## 8. Implementation Order (TDD)

Write the test file first, then implement to make it pass:

1. `biquadResponse.test.js` → implement `biquadResponse.js`
2. `applyFilters.test.js` → implement `applyFilters.js`
3. `interpolate.test.js` → implement `interpolate.js`
4. `compensate.test.js` → implement `compensate.js`
5. `smooth.test.js` → implement `smooth.js`
6. `equalize.test.js` → implement `equalize.js`
7. `optimize.test.js` (unit) → implement `optimize.js` (greedy v1)
8. Run `generate_golden.py` to create golden files
9. `pipeline.test.js` → integration tests against golden files
