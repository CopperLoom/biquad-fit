/**
 * interpolate.ts
 *
 * Resamples a frequency response to a log-spaced grid using log-linear
 * interpolation (linear interpolation in log-frequency space).
 *
 * Default grid matches AutoEq: step=1.01, 20–20000 Hz (~461 points).
 */
import type { FreqPoint, InterpolateOptions } from './types.js';
export declare function interpolate(fr: FreqPoint[], options?: InterpolateOptions): FreqPoint[];
