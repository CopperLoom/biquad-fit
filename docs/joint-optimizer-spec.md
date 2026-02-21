# Joint Optimizer Technical Specification

**Status:** Reviewed and corrected — ready for implementation
**Date:** 2026-02-21
**Reviewed:** 2026-02-21 (audit against AutoEQ source; 6 corrections applied)
**Source read:** `.venv/lib/python3.9/site-packages/autoeq/peq.py` (full file),
               `.venv/lib/python3.9/site-packages/autoeq/frequency_response.py` (relevant sections),
               `tests/generate_golden.py` (pipeline reference)

---

## 0. Priority

**AutoEQ's implementation is the correctness oracle.** This spec documents what AutoEQ does. The JS implementation must match it as closely as a zero-dependency library permits. If a test conflicts with AutoEQ's behavior, the test is wrong.

---

## 1. The Full AutoEQ Pipeline

From `generate_golden.py`, the exact sequence AutoEQ runs before returning filters:

```python
fr.interpolate()            # 1. resample to log grid, step=1.01
fr.center()                 # 2. normalize at 1 kHz
fr.compensate(target)       # 3. fr.error = fr.raw - fr.target
fr.smoothen()               # 4. fr.error_smoothed (for display only — not used by optimizer)
fr.equalize()               # 5. fr.equalization = slope-limited, gain-capped inverse of smoothed error
                            #    THIS is what the optimizer targets
peqs = fr.optimize_parametric_eq(config, fs=44100)
```

**Critical:** the optimizer's target is `fr.equalization` — the output of `equalize()`. It is **not** simply `-(smoothed error)`. `equalize()` applies two-zone smoothing, slope limiting, gain capping, and a final re-smoothing. Details in Section 3.

---

## 2. Frequency-Range-Dependent Behavior

There are four distinct places where frequency range drives different treatment:

### 2.1 Smoothing: three zones

`frequency_response.py` `_smoothen()` (called by both `smoothen()` and internally by `equalize()`):

| Zone | Window | Formula |
|------|--------|---------|
| < 6 kHz | 1/12 octave Savitzky-Golay (polynomial order 2) | normal |
| 6–8 kHz | sigmoid blend between normal and treble | `k_treble = log_f_sigmoid(f, 6000, 8000)` |
| > 8 kHz | 2 octave Savitzky-Golay (polynomial order 2) | treble |

Window sizes in samples: `n = round(log(2^octaves) / log(avg_step_size))`, rounded up to odd.

`log_f_sigmoid(f, f_lower, f_upper)`:
```
f_center = sqrt(f_upper / f_lower) * f_lower   (geometric mean)
half_range = log10(f_upper) - log10(f_center)
k_treble = expit((log10(f) - log10(f_center)) / (half_range / 4))
k_normal = 1 - k_treble
```

This is already implemented in `twoZoneSmooth()` in `optimize.js`. The key difference: AutoEQ uses Savitzky-Golay (polynomial smoothing); we use a moving average. Both produce equivalent results at these window sizes.

### 2.2 Equalization curve: slope limiting and gain capping

`equalize()` (called with defaults: `max_gain=6.0`, `max_slope=18.0`, `treble_gain_k=1.0`):

1. Smooth `self.error` with the three-zone Savitzky-Golay above → `y_smooth`
2. Negate: `y = -y_smooth` (correction curve)
3. If no peaks or dips with prominence ≥ 1 dB: `equalization = y` (no limiting needed)
4. Otherwise:
   a. Compute protection mask (Section 12.2) and find RTL start index (Section 12.3)
   b. Slope-limit `y` left-to-right with region validation (Section 12.1)
   c. Slope-limit `y` right-to-left starting from RTL start index (Section 12.1)
   d. Combine with element-wise `min(ltr, rtl)` (take the more conservative limit)
   e. Apply `treble_gain_k=1.0` (no change at default)
   f. Clip positive gain to `max_gain=6.0` dB: `equalization = min(combined, 6.0)`
   g. Re-smooth with 1/5 octave window (both zones): `equalization = smoothen(combined, 1/5, 1/5)`
5. `self.equalization` = the result above

**Key effects:**
- **Slope limit** prevents the optimizer from chasing steep measurement artifacts (e.g., >18 dB/octave transitions cannot be fully corrected)
- **+6 dB gain cap** means the optimizer cannot boost more than 6 dB at any frequency
- **No cap on cuts** — the optimizer can cut as deeply as needed (down to `max_gain` on the cut side, but cuts are not clipped)
- At default `treble_gain_k=1.0`, treble is treated identically to midrange

### 2.3 Optimizer frequency grid: step=1.02

`_optimize_peq_filters()` re-interpolates the equalization curve to a **coarser** grid before optimization:

```python
fr.interpolate(f_step=DEFAULT_BIQUAD_OPTIMIZATION_F_STEP)  # 1.02
```

This is a different grid from the pipeline grid (step=1.01). The optimizer computes filter responses and the loss function on the 1.02 grid. Our JS optimizer must use the same step=1.02 grid internally.

### 2.4 Loss function: below vs. above 10 kHz

Inside `_optimizer_loss()`, before computing MSE:

```python
target[ix_10k:] = mean(target[ix_10k:])   # average target above 10 kHz
fr[ix_10k:]     = mean(fr[ix_10k:])       # average filter cascade above 10 kHz
```

Then MSE is computed over `[ix_min_f, ix_max_f]` = `[20 Hz, 20000 Hz]`.

**Effect:** above 10 kHz, only the total average energy matters to the loss. Point-to-point spectral accuracy above 10 kHz is not penalized. This is why shelf filters (which have smooth rolloffs) work well here even though the measured response may be rough above 10 kHz.

**Loss range is always 20–20,000 Hz** regardless of any user-supplied `freqRange`. Both `min_f = 20` Hz (`DEFAULT_PEQ_OPTIMIZER_MIN_F`) and `max_f = 20000` Hz (`DEFAULT_PEQ_OPTIMIZER_MAX_F`) are hardcoded in AutoEQ. The `freqRange` constraint controls filter center-frequency placement only — it does not affect the loss range.

### 2.5 Filter placement range: 20–10,000 Hz

AutoEQ defaults:
- PK: `fc ∈ [20, 10000]` Hz
- LSQ: `fc ∈ [20, 10000]` Hz
- HSQ: `fc ∈ [20, 10000]` Hz

No filter center frequency is ever placed above 10 kHz. Filters still affect above-10kHz response (biquad rolloff), but their centers are constrained below.

---

## 3. What the Optimizer Receives

When `PEQ.optimize()` is called:

- `self.f`: log-spaced grid, step=1.02, from ~20 to ~20000 Hz
- `self.target`: the `equalization` curve sampled on this grid — slope-limited, gain-capped, re-smoothed inverse error (Section 2.2)
- `self.filters`: filter objects initialized sequentially against remaining target (Section 5)

The optimizer's job: find filter parameters that make `sum(filter FRs)` ≈ `self.target`, within the loss function defined in Section 4.

---

## 4. Parameter Vector Encoding

For each filter (in `self.filters` order), append to the flat parameter vector `x`:

| Parameter | Encoding | Bounds |
|-----------|----------|--------|
| `fc` | `log10(fc)` | `[log10(min_fc), log10(max_fc)]` |
| `Q` | linear | `[min_q, max_q]` |
| `gain` | linear | `[min_gain, max_gain]` |

Decoding: `fc = 10**x[i]`, `Q = x[i+1]`, `gain = x[i+2]`.

The `fc` log-encoding ensures equal optimizer step sizes across all octaves.

---

## 5. Loss Function

`_optimizer_loss()` — already correctly implemented as `jointLoss()` in `optimize.js`:

1. `fr[i]` = sum of all filter FRs at each frequency
2. Above 10 kHz: replace `target[ix_10k:]` and `fr[ix_10k:]` with their respective averages
3. `MSE = mean((target[ix_min:ix_max] - fr[ix_min:ix_max])²)`
   where `ix_min` = index of 20 Hz (hardcoded), `ix_max` = index of 20000 Hz (hardcoded)
4. Add `sharpness_penalty(filt)` for each filter (PK only; shelves return 0)
5. Return `sqrt(MSE + penalties)` — RMSE

**Note:** `band_penalty` is a defined property on each filter class but is **not** used in `_optimizer_loss`. Do not add it.

**Note:** `ix_min` must always correspond to 20 Hz, not to `freqRange[0]`. The loss range is independent of filter placement constraints.

---

## 6. Initialization Order

Filters are initialized sequentially. Each filter is initialized against the **remaining target** after subtracting the already-initialized filters' responses.

Sort order: descending by `init_order` value = `(type_ix × 100) + (1/log2(max_fc/min_fc) if fc is free)`:

| Type | optimize_fc | optimize_q | type_ix | init order |
|------|-------------|------------|---------|------------|
| PK | True | True | 0 | last |
| LSQ | True | True | 1 | second |
| HSQ | True | True | 2 | first |

Since all our parameters are optimizable: **HSQ first → LSQ → PK last**. Within same type, narrower fc range initialized first.

**The loop:**
```
remaining = target.copy()
for filt in [HSQ..., LSQ..., PK...]:
    filt.init(remaining)               // sets fc, Q, gain
    remaining -= biquadResponse(filt)  // subtract this filter's effect
flatten all filter params → x0
```

---

## 7. Filter Initialization

Already correctly implemented in `optimize.js`. Documented for completeness.

**Peaking** — find biggest peak by `height × width`:
- Detect positive and negative peaks using `find_peaks` with `prominence=0, height=0, width=0`
- For each peak within `[min_fc, max_fc]`, compute `size = width × height`
- Pick peak with max size
- If no peaks: `fc = f[midpoint]`, `Q = sqrt(2)`, `gain = 0`
- `fc = f[peak_ix]`, clamp to `[min_fc, max_fc]`
- `Q` from peak half-height bandwidth in octaves → `Q = sqrt(2^bw) / (2^bw - 1)`, clamp to `[min_q, max_q]`
- `gain = height × sign(target[peak_ix])`, clamp to `[min_gain, max_gain]`

**Width computation:** scipy's `find_peaks` computes peak widths using interpolated half-height positions (linear interpolation between samples to find exact crossing points). Our JS `findLocalPeaks` should match this: instead of counting whole samples above half-height, interpolate to find the fractional sample positions where the curve crosses the half-height threshold, then compute width from those interpolated positions.

**LowShelf** — find fc where `|mean(target[:ix+1])|` is maximized:
- Search `[max(40, min_fc), min(10000, max_fc)]`
- `Q = clip(0.7, min_q, max_q)`
- `gain` = weighted average of target using `|shelf_fr at gain=1|` as weights

**HighShelf** — find fc where `|mean(target[ix:])|` is maximized:
- Search `[max(40, min_fc), min(10000, max_fc)]`
- `Q = clip(0.7, min_q, max_q)`
- `gain` = weighted average of target using `|shelf_fr at gain=1|` as weights

---

## 8. The Optimizer Algorithm: JS Equivalent of `fmin_slsqp`

### What AutoEQ uses

AutoEQ calls `scipy.optimize.fmin_slsqp` — a Sequential Least Squares Programming solver — without supplying `fprime`, so scipy computes gradients internally via forward finite differences with step `eps ≈ 1.49e-8`. SLSQP approximates the Hessian using BFGS updates and at each iteration solves a quadratic subproblem to find a search direction that satisfies the bounds. Defaults: `acc=1e-6`, `iter=150`.

Our JS implementation must replicate this behavior: gradient-based quasi-Newton updates using finite-difference gradients, bounds enforced natively, convergence controlled by the STD-based callback. We implement this from scratch with zero dependencies using the same mathematical structure — finite-difference gradient, BFGS Hessian approximation, bounded line search.

**Ruled-out approaches:**
- **Coordinate descent** (one parameter at a time): confirmed to produce local-minima failures for ≥10 filters
- **Differential Evolution (DE)**: a global stochastic search — not what AutoEQ uses and not the right oracle to match
- Any approach that does not update all parameters simultaneously using gradient information

### 8.1 Finite-Difference Gradient

Forward differences matching scipy SLSQP's default behavior:

```
h = 1.4901161193847656e-8    // sqrt(Number.EPSILON), same as scipy
g[i] = (loss(x + h·eᵢ) - loss(x)) / h
```

Points probed outside bounds are clipped before evaluation. Cost per gradient: `n+1` loss evaluations (1 base + n perturbations).

### 8.2 L-BFGS Two-Loop Recursion

Given history `{(s₀,y₀), ..., (s_{k-1},y_{k-1})}`, length ≤ m=10:

```
q = g.copy()
α[i] = 0  for all i

// First loop: newest → oldest
for i = k-1 downto 0:
    ρᵢ = 1 / dot(yᵢ, sᵢ)
    αᵢ = ρᵢ · dot(sᵢ, q)
    q -= αᵢ · yᵢ

// Scale initial Hessian estimate
γ = (k > 0) ? dot(s_{k-1}, y_{k-1}) / dot(y_{k-1}, y_{k-1}) : 1.0
r = γ · q

// Second loop: oldest → newest
for i = 0 to k-1:
    ρᵢ = 1 / dot(yᵢ, sᵢ)
    βᵢ = ρᵢ · dot(yᵢ, r)
    r += sᵢ · (αᵢ - βᵢ)

direction d = -r
```

Skip any (s,y) pair where `dot(y,s) ≤ 0` (curvature not satisfied).

### 8.3 Gradient Projection for Active Bounds

```
for each parameter i:
    if x[i] ≤ lo[i] and d[i] < 0:  d[i] = 0   // at lower bound
    if x[i] ≥ hi[i] and d[i] > 0:  d[i] = 0   // at upper bound
```

If `‖d‖ < 1e-10` after projection: converged at a bounded corner — stop.

### 8.4 Armijo Backtracking Line Search

```
α = 1.0, c₁ = 1e-4, ρ = 0.5, max_steps = 20
f₀ = loss(x)
slope = dot(g, d)   // negative for a descent direction

for _ in range(max_steps):
    x_try = clip(x + α·d, bounds)
    f_try = loss(x_try)
    if f_try ≤ f₀ + c₁·α·slope: break
    α *= ρ

// accept x_try even if line search failed (avoid stalling)
```

### 8.5 BFGS History Update

```
s = x_new - x
y = g_new - g
if dot(y, s) > 1e-10 · ‖s‖ · ‖y‖:   // curvature check
    history.push({s, y})
    if history.length > m:  history.shift()  // drop oldest
```

---

## 9. Convergence — Exact Match to AutoEQ

From `_callback()`. The callback is called after each SLSQP iteration (not after each function evaluation).

```
n = 8
loss_history = []   // grows each iteration

after each iteration, push current loss to loss_history, then:

std_n  = population_stddev(loss_history[-8:])   // last 8 values
std_n2 = population_stddev(loss_history[-4:])   // last 4 values

stop if: len(loss_history) > 8  AND  std_n  < 0.002   (MIN_STD)
stop if: len(loss_history) > 4  AND  std_n2 < 0.001   (MIN_STD / 2)
```

`population_stddev(arr) = sqrt(mean((x - mean(x))²))` — use numpy/population, not sample.

Also stop at `iter = 150` (scipy fmin_slsqp default). No time limit, no target_loss, no min_change_rate — all default to `None` in AutoEQ.

**Best-params restoration:** track `bestLoss` and `bestX` throughout. On any stop, decode `bestX` (not the current `x`) into filters. From `PEQ.optimize()`:
```python
self._parse_optimizer_params(self.history.params[np.argmin(self.history.loss)])
```

---

## 10. Full Algorithm

```
function jointOptimize(initialFilters, specs, equalizationCurve, freqs1_02, fs):
    // freqs1_02: log-spaced grid at step=1.02, 20–20000 Hz
    // equalizationCurve: sampled on freqs1_02

    x      = encodeParams(initialFilters)      // fc as log10
    bounds = buildBounds(specs)                // in encoded space
    loss0  = evalLoss(x)
    g      = finiteDiffGradient(x, loss0, loss, bounds)
    bestLoss = loss0, bestX = x.slice()
    lossHistory = [], lbfgsHistory = []

    for iter = 0 to 149:
        d = lbfgsTwoLoop(g, lbfgsHistory)
        projectToBounds(d, x, bounds)
        if norm(d) < 1e-10: break

        x_new = armijoLineSearch(x, d, g, loss0, loss, bounds)
        loss1 = evalLoss(x_new)
        g_new = finiteDiffGradient(x_new, loss1, loss, bounds)

        s = x_new - x,  y = g_new - g
        if dot(y, s) > 1e-10 · norm(s) · norm(y):
            lbfgsHistory.push({s, y})
            if lbfgsHistory.length > 10: lbfgsHistory.shift()

        x = x_new,  g = g_new,  loss0 = loss1
        if loss1 < bestLoss: bestLoss = loss1; bestX = x.slice()

        lossHistory.push(loss1)
        if converged(lossHistory): break

    return decodeParams(bestX, specs)
```

---

## 11. Integration into `optimize()`

```
function optimize(measured, target, constraints):
    1. Resolve specs (filterSpecs or maxFilters+gainRange+qRange)
    2. Interpolate measured and target to log grid, step=1.01 (pipeline grid)
    3. fr.center() — subtract value at 1 kHz from measured
    4. fr.error = measured.db - target.db (element-wise, on 1.01 grid)
    5. equalization = equalize(fr.error, freqs_1_01)
       [slope-limited, gain-capped inverse of smoothed error — Section 2.2]
    6. Interpolate equalization to step=1.02 grid (optimizer grid)
    7. Initialize filters in HSQ→LSQ→PK order against equalization on 1.02 grid
    8. jointOptimize(initialFilters, specs, equalization_1_02, freqs_1_02, fs)
    9. pregain = computePregain(optimizedFilters, freqs_1_02, fs, gainRange)
    10. return { pregain, filters }
```

---

## 12. Approach: Full `equalize()` with Post-Hoc Optimization

**Chosen approach: implement full `equalize()` faithfully, then try simplifications.**

Phase 1 — Faithful implementation: replicate the full `equalize()` pipeline (slope limiting, gain cap, re-smoothing). This ensures the optimizer targets the same curve AutoEQ targets.

Phase 2 (v1.1) — Try simplifications after all tests pass: attempt progressively simpler versions of the equalize step (e.g. remove slope limiting, use smoothed-inverse directly) and check whether RMSE stays within the 0.5 dB tolerance on all 90 golden-file combinations. If a simpler form passes all tests, prefer it. If not, keep the faithful form. This is empirical — don't guess in advance. The three sub-algorithms below (slope limiter region validation, protection mask, RTL start) are candidates for simplification.

### 12.1 Full `equalize()` Implementation

Inputs: `error[i]` (measured - target, on the 1.01 grid), `freqs`

Steps:
1. Smooth `error` with two-zone Savitzky-Golay → `smoothed`
2. Negate: `y = -smoothed`  (correction curve)
3. Find peaks in `y` with prominence ≥ 1 (positive and negative)
4. If no peaks or dips: `equalization = y`, done
5. Compute protection mask (Section 12.2)
6. Find `rtl_start` (Section 12.3)

**Dual-direction slope limiting — why both directions:**

A single LTR pass limits how steeply the correction curve can *rise* going left-to-right, but doesn't constrain how steeply it *falls*. A single RTL pass (reversed data) limits the same in the other direction. Taking `min(ltr, rtl)` enforces the slope cap on both sides of every peak — no edge of a peak can be steeper than 18 dB/octave in either direction.

```
ltr = limitedLTR(freqs, y, max_slope=18, start=0, peak_inds, limit_free_mask)
rtl = limitedRTL(freqs, y, max_slope=18, start=rtl_start, peak_inds, limit_free_mask)
combined[i] = min(ltr[i], rtl[i])   // element-wise
```

**Slope-limit algorithm (LTR) with region validation:**

```
// Inputs: freqs, y, max_slope, start_index, peak_inds, limit_free_mask
limited = []
clipped = []
regions = []     // list of [start, end) pairs

for i = 0 to n-1:
    if i <= start_index:
        limited[i] = y[i]
        clipped[i] = false
        continue

    slope = (y[i] - limited[i-1]) / log2(freqs[i] / freqs[i-1])   // dB/octave

    if slope > max_slope AND NOT limit_free_mask[i]:
        // Clip: slope exceeds limit
        if NOT clipped[i-1]:
            regions.push([i])           // start new clipped region
        clipped[i] = true
        octaves = log2(freqs[i] / freqs[i-1])
        limited[i] = limited[i-1] + max_slope * octaves

    else:
        // No clipping needed
        limited[i] = y[i]

        if clipped[i-1]:
            // End of a clipped region — validate it
            regions[-1].push(i + 1)     // close the region [start, end)
            region_start = regions[-1][0]

            // Check if any peak_inds fall within [region_start, i)
            has_peak = peak_inds.some(p => p >= region_start && p < i)
            if NOT has_peak:
                // No peaks in this region — discard the limitation
                for j = region_start to i-1:
                    limited[j] = y[j]
                    clipped[j] = false
                regions.pop()

        clipped[i] = false

// Close any region that extends to the end
if regions.length > 0 AND regions[-1].length == 1:
    regions[-1].push(n - 1)

return limited
```

**RTL:** Flip `y`, `limit_free_mask`, and `peak_inds` (remap indices: `new_ix = n - old_ix - 1`), compute `start_index = n - rtl_start - 1`, run LTR on flipped data, then flip result back.

**Note:** `concha_interference` and `max_slope_decay` parameters exist in AutoEQ but default to `False` and `0.0` respectively. Our golden files do not use them. They can be omitted from the JS implementation.

7. Clip positive gain: `combined = min(combined, 6.0)` (no clipping on cuts)
8. Re-smooth `combined` with 1/5 octave window (both zones use 1/5) → `equalization`

### 12.2 Protection Mask

From `frequency_response.py` `protection_mask()`. Finds zones around dips that sit lower than their neighboring dips and marks them as "limit-free" (the slope limiter won't clip within these zones).

```
function protectionMask(y, peak_inds, dip_inds):
    mask = array of false, length n

    // Ensure dip_inds has a sentinel at the end
    if peak_inds.length > 0 AND (dip_inds.length == 0 OR peak_inds[-1] > dip_inds[-1]):
        // Last significant feature is a peak — add a synthetic dip after it
        last_dip_ix = argmin(y[peak_inds[-1]:]) + peak_inds[-1]
        dip_inds = concat(dip_inds, [last_dip_ix])
        dip_levels = y[dip_inds]   // includes the synthetic dip
    else:
        dip_inds = concat(dip_inds, [-1])   // sentinel
        dip_levels = y[dip_inds]
        dip_levels[-1] = min(y)             // sentinel level = global minimum

    if dip_inds.length < 3:
        return mask   // need at least 3 dips to have a "middle" one

    // For each interior dip, check if it's lower than its neighbors
    for i = 1 to dip_inds.length - 2:
        dip_ix = dip_inds[i]
        target_left  = dip_levels[i - 1]
        target_right = dip_levels[i + 1]

        // Find where curve rises to meet left neighbor's level (scanning leftward)
        left_ix  = last index j < dip_ix where y[j] >= target_left, then j + 1
        // Find where curve rises to meet right neighbor's level (scanning rightward)
        right_ix = first index j > dip_ix where y[j] >= target_right, then j - 1

        mask[left_ix .. right_ix] = true

    return mask
```

### 12.3 RTL Start Index

From `frequency_response.py` `find_rtl_start()`. Determines where the right-to-left slope-limiting pass begins.

```
function findRtlStart(y, peak_inds, dip_inds):
    if peak_inds.length > 0 AND (dip_inds.length == 0 OR peak_inds[-1] > dip_inds[-1]):
        // Last significant feature is a positive peak
        if dip_inds.length > 0:
            // Find where curve descends to the last dip's level, right of the last peak
            crossings = indices j >= peak_inds[-1] where y[j] <= y[dip_inds[-1]]
        else:
            // No dips — find where curve descends to max(y[0], y[-1])
            crossings = indices j >= peak_inds[-1] where y[j] <= max(y[0], y[-1])

        if crossings.length > 0:
            rtl_start = crossings[0] + peak_inds[-1]
        else:
            rtl_start = len(y) - 1
    else:
        // Last significant feature is a dip — start there
        rtl_start = dip_inds[-1]

    return rtl_start
```

---

## 13. New Code Required

| Function | Notes |
|----------|-------|
| `equalize(error, freqs)` | Full pipeline: smooth, negate, slope limit with region validation, protection mask, RTL start, gain cap, re-smooth |
| `protectionMask(y, peakInds, dipInds)` | Section 12.2 |
| `findRtlStart(y, peakInds, dipInds)` | Section 12.3 |
| `limitedLtrSlope(freqs, y, maxSlope, startIx, peakInds, limitFreeMask)` | Section 12.1 with region validation |
| `encodeParams(filters)` | fc→log10, Q and gain linear |
| `buildBounds(specs)` | per-element [lo, hi] in encoded space |
| `decodeParams(x, specs)` | flat array → filter objects |
| `finiteDiffGradient(x, f0, lossFn, bounds)` | forward differences, h = √ε |
| `lbfgsTwoLoop(g, history)` | search direction |
| `projectToBounds(d, x, bounds)` | zeros blocked dims in-place |
| `armijoLineSearch(x, d, g, f0, lossFn, bounds)` | returns x_new |
| `converged(lossHistory)` | STD check matching AutoEQ |
| `jointOptimize(...)` | main loop |
| Wire `optimize()` | calls equalize → init → jointOptimize |

---

## 14. Numerical Parameters

| Parameter | Value | Source |
|-----------|-------|--------|
| Pipeline grid step | `1.01` | `DEFAULT_STEP` |
| Optimizer grid step | `1.02` | `DEFAULT_BIQUAD_OPTIMIZATION_F_STEP` |
| Gradient `h` | `√ε ≈ 1.49e-8` | `sqrt(Number.EPSILON)`, matches scipy SLSQP |
| Gradient scheme | forward differences | matches scipy SLSQP (not central) |
| L-BFGS memory `m` | `10` | standard |
| Max optimizer iterations | `150` | scipy fmin_slsqp default `iter` |
| Armijo `c₁` | `1e-4` | standard |
| Armijo backtrack `ρ` | `0.5` | standard |
| Max line search steps | `20` | practical |
| Curvature guard | `dot(y,s) > 1e-10·‖s‖·‖y‖` | numerical hygiene |
| Convergence window | `n = 8` | `_callback` in peq.py |
| `MIN_STD` | `0.002` | `DEFAULT_PEQ_OPTIMIZER_MIN_STD` |
| Slope limit | `18.0` dB/octave | `DEFAULT_MAX_SLOPE` |
| Max positive gain | `6.0` dB | `DEFAULT_MAX_GAIN` |
| Preamp headroom | `0.2` dB | `PREAMP_HEADROOM` |
| Loss `min_f` | `20` Hz (hardcoded) | `DEFAULT_PEQ_OPTIMIZER_MIN_F` |
| Loss `max_f` | `20000` Hz (hardcoded) | `DEFAULT_PEQ_OPTIMIZER_MAX_F` |

---

## 15. Resolved Decisions

1. **`equalize()` scope:** `equalize.js` is updated to implement the full AutoEQ-faithful version (dual-direction slope limiting with region validation, protection mask, RTL start, +6 dB gain cap, re-smoothing). This is a breaking change to the public API — the simpler previous implementation is replaced. `optimize()` calls the updated `equalize.js` internally.

2. **Loss function range:** `jointLoss()` always computes MSE from 20 Hz to 20,000 Hz. `freqRange` is used only for filter center-frequency bounds, never for the loss range.

3. **Finite-difference scheme:** Forward differences with `h = sqrt(Number.EPSILON) ≈ 1.49e-8`, matching scipy SLSQP exactly. Cost: n+1 evaluations per gradient.

4. **Max iterations:** 150, matching scipy default.

5. **Old-API PK Q default:** `[0.18, 6.0]`, matching AutoEQ's internal defaults.

6. **Peak width computation:** Match scipy's `find_peaks` interpolated half-height width, not simple sample counting.

7. **Slope limiter simplification (v1.1 candidate):** The full slope limiter includes region validation (discard clipped regions with no peaks), protection mask, and smart RTL start. These are implemented faithfully in Phase 1. In v1.1, test whether simpler versions (e.g., no region validation, no protection mask) still pass all 90 RMSE tests. If so, prefer the simpler form.

**No open questions. Spec is complete — ready for implementation.**
