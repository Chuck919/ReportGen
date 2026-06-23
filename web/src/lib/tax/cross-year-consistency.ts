/** Cross-year consistency scoring for candidate ranking — evidence only, never hard override. */

const YOY_MIN_ABS = 1_000;
const YOY_RATIO_PENALTY = 5;

function yoyRatio(a: number, b: number): number {
  const absA = Math.abs(a);
  const absB = Math.abs(b);
  return Math.max(absA, absB) / Math.max(Math.min(absA, absB), 1);
}

/**
 * Score 0–1: how well candidate matches prior-year values for the same field.
 * Returns 0.5 (neutral) when no history is available.
 */
export function consistencyScoreForField(
  fieldId: string,
  candidateValue: number,
  priorYearValues?: Record<number, Record<string, number>>,
): number {
  if (!priorYearValues) return 0.5;

  const priors: number[] = [];
  for (const values of Object.values(priorYearValues)) {
    const v = values[fieldId];
    if (v !== undefined && Math.abs(v) >= YOY_MIN_ABS) priors.push(v);
  }
  if (!priors.length) return 0.5;

  const medianPrior = priors.sort((a, b) => a - b)[Math.floor(priors.length / 2)]!;
  const ratio = yoyRatio(candidateValue, medianPrior);

  if (ratio <= 1.5) return 1;
  if (ratio <= 2.5) return 0.85;
  if (ratio <= YOY_RATIO_PENALTY) return 0.5;
  if (ratio <= 10) return 0.2;
  return 0;
}

/** Flag when all candidates fail consistency badly — optional rescan trigger. */
export function allCandidatesFailConsistency(
  candidates: Array<{ value: number; consistencyScore: number }>,
  threshold = 0.25,
): boolean {
  if (!candidates.length) return false;
  return candidates.every((c) => c.consistencyScore < threshold);
}
