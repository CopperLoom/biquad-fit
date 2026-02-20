import { describe, test, expect } from 'vitest';
import { biquadResponse } from '../../src/biquadResponse.js';

// biquadResponse(type, fc, gain, Q, frequencies, sampleRate) -> number[]
// Returns gain in dB at each frequency in the input array.
// type: 'PK' | 'LSQ' | 'HSQ'
// fs defaults to 44100 if not provided.

const FS = 44100;

// Tolerance constants (in dB)
const TIGHT = 0.01;   // analytically derived values
const LOOSE = 0.5;    // boundary approximations (DC, Nyquist)

describe('biquadResponse', () => {

  // ─── 3.1.1 Zero-gain identity ───────────────────────────────────────────────

  test('PK: 0 dB gain → 0 dB at all frequencies', () => {
    const freqs = [20, 100, 500, 1000, 5000, 10000, 20000];
    const gains = biquadResponse('PK', 1000, 0, 1.0, freqs, FS);
    gains.forEach((g, i) => {
      expect(g, `f=${freqs[i]}`).toBeCloseTo(0, 2);
    });
  });

  test('LSQ: 0 dB gain → 0 dB at all frequencies', () => {
    const freqs = [20, 100, 500, 1000, 5000, 10000, 20000];
    const gains = biquadResponse('LSQ', 100, 0, 0.707, freqs, FS);
    gains.forEach((g, i) => {
      expect(g, `f=${freqs[i]}`).toBeCloseTo(0, 2);
    });
  });

  test('HSQ: 0 dB gain → 0 dB at all frequencies', () => {
    const freqs = [20, 100, 500, 1000, 5000, 10000, 20000];
    const gains = biquadResponse('HSQ', 10000, 0, 0.707, freqs, FS);
    gains.forEach((g, i) => {
      expect(g, `f=${freqs[i]}`).toBeCloseTo(0, 2);
    });
  });

  // ─── 3.1.2 Peaking filter at center frequency ───────────────────────────────
  // Pre-computed from Audio EQ Cookbook formulas (see TEST_PLAN.md §2.4, Case A):
  //   PK, fc=1000, gain=+3, Q=1.0, fs=44100
  //   f=100 Hz  → +0.072 dB
  //   f=1000 Hz → +3.036 dB
  //   f=10000 Hz → +0.021 dB

  test('PK +3dB at 1kHz: correct gain at fc', () => {
    const [gain] = biquadResponse('PK', 1000, 3, 1.0, [1000], FS);
    expect(gain).toBeCloseTo(3.036, 1);
  });

  test('PK +3dB at 1kHz: near-zero gain far below fc', () => {
    const [gain] = biquadResponse('PK', 1000, 3, 1.0, [100], FS);
    expect(gain).toBeCloseTo(0.072, 1);
  });

  test('PK +3dB at 1kHz: near-zero gain far above fc', () => {
    const [gain] = biquadResponse('PK', 1000, 3, 1.0, [10000], FS);
    expect(gain).toBeCloseTo(0.021, 1);
  });

  // ─── 3.1.3 Peaking filter negative gain ─────────────────────────────────────

  test('PK −3dB at 1kHz: correct negative gain at fc', () => {
    const [gain] = biquadResponse('PK', 1000, -3, 1.0, [1000], FS);
    expect(gain).toBeCloseTo(-3.036, 1);
  });

  test('PK −3dB at 1kHz: near-zero gain far below fc', () => {
    const [gain] = biquadResponse('PK', 1000, -3, 1.0, [100], FS);
    expect(Math.abs(gain)).toBeLessThan(0.1);
  });

  // ─── 3.1.4 Low shelf DC gain ─────────────────────────────────────────────────
  // Analytically: H(z=1) = A² → gain = dBgain exactly.
  // At very low frequencies, we expect to be within LOOSE of +6 dB.

  test('LSQ +6dB at 100Hz: near-DC frequencies approach +6 dB', () => {
    const freqs = [10, 20, 50];
    const gains = biquadResponse('LSQ', 100, 6, 0.707, freqs, FS);
    gains.forEach((g, i) => {
      expect(g, `f=${freqs[i]}`).toBeCloseTo(6, 0); // within 0.5 dB
    });
  });

  // ─── 3.1.5 Low shelf high-frequency rolloff ──────────────────────────────────

  test('LSQ +6dB at 100Hz: high frequencies approach 0 dB', () => {
    const freqs = [10000, 15000, 20000];
    const gains = biquadResponse('LSQ', 100, 6, 0.707, freqs, FS);
    gains.forEach((g, i) => {
      expect(Math.abs(g), `f=${freqs[i]}`).toBeLessThan(0.1);
    });
  });

  // ─── 3.1.6 High shelf Nyquist gain ───────────────────────────────────────────
  // Analytically: H(z=−1) = A² → gain = dBgain exactly at Nyquist.

  test('HSQ +6dB at 10kHz: near-Nyquist frequencies approach +6 dB', () => {
    const freqs = [18000, 20000];
    const gains = biquadResponse('HSQ', 10000, 6, 0.707, freqs, FS);
    gains.forEach((g, i) => {
      expect(g, `f=${freqs[i]}`).toBeCloseTo(6, 0); // within 0.5 dB
    });
  });

  // ─── 3.1.7 High shelf low-frequency rolloff ──────────────────────────────────

  test('HSQ +6dB at 10kHz: low frequencies approach 0 dB', () => {
    const freqs = [20, 100, 500];
    const gains = biquadResponse('HSQ', 10000, 6, 0.707, freqs, FS);
    gains.forEach((g, i) => {
      expect(Math.abs(g), `f=${freqs[i]}`).toBeLessThan(0.1);
    });
  });

  // ─── 3.1.8 Narrow PK (high Q) ────────────────────────────────────────────────

  test('PK high-Q (Q=10): gain falls off sharply outside bandwidth', () => {
    const [atFc]   = biquadResponse('PK', 1000, 6, 10.0, [1000], FS);
    const [below]  = biquadResponse('PK', 1000, 6, 10.0, [900],  FS);
    const [above]  = biquadResponse('PK', 1000, 6, 10.0, [1100], FS);
    expect(atFc).toBeCloseTo(6, 0);
    expect(below).toBeLessThan(3);
    expect(above).toBeLessThan(3);
  });

  // ─── 3.1.9 Wide PK (low Q) ───────────────────────────────────────────────────

  test('PK low-Q (Q=0.5): gain is elevated broadly around fc', () => {
    const [atFc]   = biquadResponse('PK', 1000, 6, 0.5, [1000], FS);
    const [below]  = biquadResponse('PK', 1000, 6, 0.5, [500],  FS);
    const [above]  = biquadResponse('PK', 1000, 6, 0.5, [2000], FS);
    expect(atFc).toBeCloseTo(6, 0);
    expect(below).toBeGreaterThan(3);
    expect(above).toBeGreaterThan(3);
  });

  // ─── 3.1.10 Edge frequencies produce finite values ───────────────────────────

  test('PK: 20 Hz and 20000 Hz produce finite values', () => {
    const gains = biquadResponse('PK', 1000, 3, 1.0, [20, 20000], FS);
    gains.forEach(g => {
      expect(isFinite(g)).toBe(true);
      expect(isNaN(g)).toBe(false);
    });
  });

  test('LSQ: 20 Hz and 20000 Hz produce finite values', () => {
    const gains = biquadResponse('LSQ', 100, 6, 0.707, [20, 20000], FS);
    gains.forEach(g => {
      expect(isFinite(g)).toBe(true);
      expect(isNaN(g)).toBe(false);
    });
  });

  test('HSQ: 20 Hz and 20000 Hz produce finite values', () => {
    const gains = biquadResponse('HSQ', 10000, 6, 0.707, [20, 20000], FS);
    gains.forEach(g => {
      expect(isFinite(g)).toBe(true);
      expect(isNaN(g)).toBe(false);
    });
  });

  // ─── 3.1.11 Output array length matches input ─────────────────────────────────

  test('returns array with same length as frequencies input', () => {
    const freqs = [100, 200, 500, 1000, 2000, 5000, 10000];
    const gains = biquadResponse('PK', 1000, 3, 1.0, freqs, FS);
    expect(gains).toHaveLength(freqs.length);
  });

  // ─── 3.1.12 Symmetry: +gain and −gain are mirror images ──────────────────────

  test('PK: positive and negative gain are symmetric', () => {
    const freqs = [500, 1000, 2000];
    const pos = biquadResponse('PK', 1000, 6, 1.0, freqs, FS);
    const neg = biquadResponse('PK', 1000, -6, 1.0, freqs, FS);
    pos.forEach((g, i) => {
      expect(g + neg[i]).toBeCloseTo(0, 2);
    });
  });

});
