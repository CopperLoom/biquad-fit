/**
 * optimize.ts — v1.0
 *
 * Joint parametric EQ optimizer. Intended to match AutoEQ's SLSQP approach;
 * implemented as L-BFGS. See README Algorithm & Accuracy for deviation notes.
 *
 * Algorithm:
 *   1. Resolve filterSpecs
 *   2. Interpolate to pipeline grid (1.01), center, compute error, equalize
 *   3. Interpolate equalization to optimizer grid (1.02)
 *   4. Sequential initialization: HSQ → LSQ → PK, each against remaining correction
 *   5. Joint L-BFGS optimization over all filter params simultaneously,
 *      with STD-based convergence stopping (intended to mirror AutoEQ's SLSQP;
 *      diverges due to algorithm differences — see README Algorithm & Accuracy)
 *   6. Compute pregain
 *
 * Spec: docs/joint-optimizer-spec.md
 */
import type { FreqPoint, Constraints, OptimizeResult } from './types.js';
/**
 * Find optimal PEQ filter parameters to match measured to target.
 *
 * Pipeline (reverse-engineered from AutoEQ):
 *   1. Resolve specs
 *   2. Interpolate to pipeline grid (1.01)
 *   3. Center measured at 1 kHz
 *   4. Compute error = measured - target
 *   5. Equalize: smooth, slope-limit, gain-cap, re-smooth
 *   6. Interpolate equalization to optimizer grid (1.02)
 *   7. Initialize filters (HSQ → LSQ → PK)
 *   8. Joint optimize
 *   9. Compute pregain
 *
 * @param {{freq: number, db: number}[]} measured
 * @param {{freq: number, db: number}[]} target
 * @param {Object} constraints
 * @returns {{ pregain: number, filters: {type: string, fc: number, gain: number, Q: number}[] }}
 */
export declare function optimize(measured: FreqPoint[], target: FreqPoint[], constraints: Constraints): OptimizeResult;
