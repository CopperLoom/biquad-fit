/**
 * compensate.js
 *
 * Computes the error between a measured frequency response and a target curve:
 *   error[i] = measured[i].db - target[i].db
 *
 * Both curves are interpolated to a common log-spaced grid before subtraction.
 */

import { interpolate } from './interpolate.js';

/**
 * Compute error = measured - target on a common log-spaced grid.
 *
 * @param {{freq: number, db: number}[]} measured - IEM frequency response
 * @param {{freq: number, db: number}[]} target   - target curve
 * @param {{step?: number, fMin?: number, fMax?: number}} [options]
 * @returns {{freq: number, db: number}[]}
 */
export function compensate(measured, target, options = {}) {
  const m = interpolate(measured, options);
  const t = interpolate(target, options);

  return m.map((pt, i) => ({
    freq: pt.freq,
    db: pt.db - t[i].db,
  }));
}
