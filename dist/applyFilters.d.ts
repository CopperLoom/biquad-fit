/**
 * applyFilters.ts
 *
 * Applies a list of biquad filters and a pregain to a frequency response curve.
 * Returns a new FR array — does not mutate the input.
 */
import type { FreqPoint, Filter } from './types.js';
export declare function applyFilters(fr: FreqPoint[], filters: Filter[], pregain: number, fs?: number): FreqPoint[];
