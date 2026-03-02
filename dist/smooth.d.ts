/**
 * smooth.ts
 *
 * Fractional-octave smoothing of a frequency response using Savitzky-Golay
 * filtering (polynomial order 2), matching AutoEQ's _smoothen() implementation.
 *
 * AutoEQ uses scipy.signal.savgol_filter with polyorder=2. This is a
 * zero-dependency JS implementation of the same algorithm.
 */
import type { FreqPoint, SmoothOptions } from './types.js';
export declare function smooth(fr: FreqPoint[], options?: SmoothOptions): FreqPoint[];
