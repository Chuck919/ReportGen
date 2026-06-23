/** Central percentage tolerances for Stmt attachment closure and formula disagreement. */

/** Closure: sum of known lines + opex ≈ stmt total (default 1%). */
export function closureTolerance(referenceTotal: number): number {
  return Math.max(50, Math.abs(referenceTotal) * 0.01);
}

export function valuesClose(a: number, b: number, referenceTotal?: number): boolean {
  const ref = referenceTotal ?? Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= closureTolerance(ref);
}

/** Formula disagreement: subtractive vs detail-sum diverge beyond this ratio. */
export const FORMULA_DISAGREEMENT_RATIO = 0.02;

export function formulasDisagree(a: number, b: number): boolean {
  const denom = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / denom > FORMULA_DISAGREEMENT_RATIO;
}

/** Display confidence cap for derived / residual / subtractive reads. */
export const SUBTRACTIVE_CONF_CAP = 78;
