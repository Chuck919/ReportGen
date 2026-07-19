import type { OpexCandidate } from "@/lib/tax-return/opex-candidate-ranking";
import type { ConfidenceFlag } from "./confidence-flags";
import type { FieldAlternative } from "./field-confidence";

export type CandidateUncertaintyInput = {
  value: number;
  candidates: Array<{
    value: number;
    source: string;
    totalScore: number;
    closureScore?: number;
    evidenceScore?: number;
    consistencyScore?: number;
    valid?: boolean;
  }>;
};

export type CandidateUncertaintyResult = {
  flags: ConfidenceFlag[];
  alternatives: FieldAlternative[];
  /** True when runner-up is competitive and materially different. */
  hasConflict: boolean;
  topScore?: number;
  runnerUpScore?: number;
};

/**
 * Detect when multiple extraction candidates have the same paste-deciding evidence
 * but different values. This is structural uncertainty: no score-gap, percentage,
 * or dollar-size thresholds.
 * Generic — no client-specific branches.
 */
export function analyzeCandidateUncertainty(
  input: CandidateUncertaintyInput,
): CandidateUncertaintyResult {
  const flags: ConfidenceFlag[] = [];
  const alternatives: FieldAlternative[] = [];

  const pool = input.candidates
    .filter((c) => c.valid !== false && c.value > 0)
    .sort((a, b) => b.totalScore - a.totalScore);

  if (pool.length < 2) {
    return { flags, alternatives, hasConflict: false };
  }

  const winner = pool[0]!;
  const runnerUp = pool.find((c) => c.value !== winner.value) ?? pool[1]!;

  for (const c of pool.slice(0, 5)) {
    if (c.value === input.value) continue;
    alternatives.push({
      value: c.value,
      score: c.totalScore,
      source: c.source,
      closureScore: c.closureScore,
      evidenceScore: c.evidenceScore,
      consistencyScore: c.consistencyScore,
    });
  }

  const hasConflict =
    winner.value !== runnerUp.value &&
    (winner.closureScore ?? 0) === (runnerUp.closureScore ?? 0) &&
    (winner.evidenceScore ?? 0) === (runnerUp.evidenceScore ?? 0);

  if (hasConflict) {
    flags.push("candidate_conflict");
  }

  return {
    flags,
    alternatives: alternatives.sort((a, b) => b.score - a.score),
    hasConflict,
    topScore: winner.totalScore,
    runnerUpScore: runnerUp.totalScore,
  };
}

export function opexCandidateUncertainty(
  chosenValue: number,
  candidates: OpexCandidate[],
): CandidateUncertaintyResult {
  return analyzeCandidateUncertainty({
    value: chosenValue,
    candidates: candidates.map((c) => ({
      value: c.value,
      source: c.source,
      totalScore: c.totalScore,
      closureScore: c.closureScore,
      evidenceScore: c.evidenceScore,
      consistencyScore: c.consistencyScore,
      valid: c.valid,
    })),
  });
}
