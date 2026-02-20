/**
 * equalize.js
 *
 * Computes the correction curve from an error curve.
 * The correction is the point-wise negation of the error:
 *   correction[i].db = -error[i].db
 *
 * Applying this correction to the measured FR cancels the error,
 * bringing the measured response toward the target.
 */

/**
 * Compute the EQ correction curve from a compensated error curve.
 *
 * @param {{freq: number, db: number}[]} error - output of compensate()
 * @returns {{freq: number, db: number}[]}
 */
export function equalize(error) {
  return error.map(pt => ({
    freq: pt.freq,
    db: -pt.db,
  }));
}
