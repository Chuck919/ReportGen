/** Cross-year exact-dollar corroboration for candidate tie-breaking. */

/**
 * Exact repeats are evidence; ordinary year-over-year changes are neither rewarded
 * nor penalized. Ratio bands previously biased ranking against volatile companies.
 */
export function consistencyScoreForField(
  fieldId: string,
  candidateValue: number,
  priorYearValues?: Record<number, Record<string, number>>,
): number {
  if (!priorYearValues) return 0;
  const candidate = Math.round(candidateValue);
  return Object.values(priorYearValues).some((values) => {
    const prior = values[fieldId];
    return prior !== undefined && Math.round(prior) === candidate;
  })
    ? 1
    : 0;
}
