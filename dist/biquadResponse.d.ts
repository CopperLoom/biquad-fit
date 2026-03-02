/**
 * biquadResponse.ts
 *
 * Pure-JS biquad filter evaluator. Computes gain in dB at a set of
 * frequencies for a single PK / LSQ / HSQ filter.
 *
 * Coefficient formulas: Audio EQ Cookbook (W3C)
 * Magnitude formula:    phi = 4*sin²(w/2) identity (same as AutoEq)
 */
import type { FilterType } from './types.js';
export declare function biquadResponse(type: FilterType, fc: number, gain: number, Q: number, frequencies: number[], fs?: number): number[];
