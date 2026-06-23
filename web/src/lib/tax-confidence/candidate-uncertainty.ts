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
  /** Score gap below which top-two are considered "close". Default 8. */
  scoreGapThreshold?: number;
  /** Relative value gap to flag disagreement. Default 0.08 (8%). */
  valueGapRatio?: number;
};

export type CandidateUncertaintyResult = {
  flags: ConfidenceFlag[];
  alternatives: FieldAlternative[];
  /** True when runner-up is competitive and materially different. */
  hasConflict: boolean;
  topScore?: number;
  runnerUpScore?: number;
};

function valueGapRatio(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1);
}

/**
 * Detect when multiple extraction candidates compete with close scores but different values.
 * Generic — no client-specific branches.
 */
export function analyzeCandidateUncertainty(
  input: CandidateUncertaintyInput,
): CandidateUncertaintyResult {
  const scoreGap = input.scoreGapThreshold ?? 8;
  const gapRatio = input.valueGapRatio ?? 0.08;
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

  const scoreDelta = winner.totalScore - runnerUp.totalScore;
  const valueDelta = valueGapRatio(winner.value, runnerUp.value);

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
    scoreDelta <= scoreGap &&
    valueDelta >= gapRatio &&
    Math.abs(winner.value - runnerUp.value) >= Math.max(500, winner.value * 0.03);

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
    scoreGapThreshold: 8,
    valueGapRatio: 0.08,
  });
}
