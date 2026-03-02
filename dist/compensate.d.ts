/**
 * compensate.ts
 *
 * Computes the error between a measured frequency response and a target curve:
 *   error[i] = measured[i].db - target[i].db
 *
 * Both curves are interpolated to a common log-spaced grid before subtraction.
 */
import type { FreqPoint, InterpolateOptions } from './types.js';
export declare function compensate(measured: FreqPoint[], target: FreqPoint[], options?: InterpolateOptions): FreqPoint[];
