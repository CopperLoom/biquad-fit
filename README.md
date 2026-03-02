# biquad-fit

Parametric EQ optimizer for the browser and Node.js.

Computes the optimal set of biquad filter parameters — frequency, gain, and Q — to match a measured frequency response to a target curve. Reimplements the core algorithm from [jaakkopasanen/AutoEq](https://github.com/jaakkopasanen/AutoEq) in pure JavaScript. No dependencies, no Python required.

[![CI](https://github.com/CopperLoom/biquad-fit/actions/workflows/ci.yml/badge.svg)](https://github.com/CopperLoom/biquad-fit/actions/workflows/ci.yml)

---

## Installation

```bash
npm install biquad-fit
```

---

## Quick start

```js
import { optimize } from 'biquad-fit';

// Measured IEM frequency response: array of { freq, db } points
const measured = [
  { freq: 20,    db: 5.2 },
  { freq: 100,   db: 3.1 },
  { freq: 1000,  db: 0.0 },
  { freq: 10000, db: -4.3 },
  { freq: 20000, db: -8.1 },
];

// Target curve (e.g. Harman IE 2019)
const target = [
  { freq: 20,    db: 7.0 },
  { freq: 100,   db: 4.0 },
  { freq: 1000,  db: 0.0 },
  { freq: 10000, db: -3.0 },
  { freq: 20000, db: -6.0 },
];

const { pregain, filters } = optimize(measured, target, {
  filterSpecs: [
    { type: 'PK', gainRange: [-12, 12], qRange: [0.5, 10] },
    { type: 'PK', gainRange: [-12, 12], qRange: [0.5, 10] },
    { type: 'PK', gainRange: [-12, 12], qRange: [0.5, 10] },
    { type: 'PK', gainRange: [-12, 12], qRange: [0.5, 10] },
    { type: 'PK', gainRange: [-12, 12], qRange: [0.5, 10] },
  ],
  freqRange: [20, 10000],
});

console.log(pregain);  // e.g. -1.5  (dB, apply before filters)
console.log(filters);
// [
//   { type: 'PK', fc: 4800, gain: -3.2, Q: 1.4 },
//   { type: 'PK', fc: 120,  gain:  1.8, Q: 0.9 },
//   ...
// ]
```

---

## API

All functions are stateless and pure — they take inputs, return outputs, and do not modify their arguments.

### `optimize(measured, target, constraints?)`

The main entry point. Runs the full pipeline and returns optimal filter parameters.

| Parameter | Type | Description |
|---|---|---|
| `measured` | `{freq, db}[]` | Measured frequency response |
| `target` | `{freq, db}[]` | Target curve |
| `constraints.filterSpecs` | `{type?, gainRange, qRange?, fcRange?}[]` | Per-filter specs. Required. |
| `constraints.freqRange` | `[min, max]` | Default frequency bounds for PK filters in Hz (default: [20, 10000]) |
| `constraints.fs` | `number` | Sample rate in Hz (default: 44100) |

Returns `{ pregain: number, filters: {type, fc, gain, Q}[] }`.

Filter types: `'PK'` (peaking), `'LSQ'` (low shelf), `'HSQ'` (high shelf).

**Mixed filter types:** Pass `LSQ` and `HSQ` specs to include shelving filters:

```js
const { pregain, filters } = optimize(measured, target, {
  filterSpecs: [
    { type: 'LSQ', gainRange: [-12, 12] },
    { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
    { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
    { type: 'HSQ', gainRange: [-12, 12] },
  ],
  freqRange: [20, 10000],
});
```

---

### `applyFilters(fr, filters, pregain, fs?)`

Applies a set of filters and pregain to a frequency response. Useful for previewing the corrected curve.

```js
import { optimize, applyFilters, interpolate } from 'biquad-fit';

const { pregain, filters } = optimize(measured, target);
const corrected = applyFilters(interpolate(measured), filters, pregain);
```

---

### Lower-level functions

These are the individual pipeline steps, exposed for custom use:

| Function | Description |
|---|---|
| `interpolate(fr, options?)` | Resample FR to a log-spaced grid |
| `compensate(measured, target, options?)` | Compute error = measured − target |
| `smooth(fr, options?)` | Fractional-octave smoothing |
| `equalize(error)` | Compute correction curve (negation of error) |
| `biquadResponse(type, fc, gain, Q, frequencies, fs?)` | Evaluate biquad filter gain at given frequencies |

---

## Browser and Node.js

biquad-fit works in both environments from a single implementation. There are no environment-specific code paths or conditional imports.

---

## Status

v1.0 stable. All 274 tests passing (93 unit + 181 integration). The optimizer is a joint L-BFGS quasi-Newton implementation matching AutoEQ's SLSQP algorithm. Full support for mixed filter types (peaking, low shelf, high shelf) and per-filter constraints via the `filterSpecs` API.

---

## License

MIT — see [LICENSE](./LICENSE)
