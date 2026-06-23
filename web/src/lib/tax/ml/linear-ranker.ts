import weightsJson from "./opex-ranker-weights.json";
import { OPEX_FEATURE_NAMES, opexCandidateFeatures } from "./feature-vector";
import type { OpexCandidate } from "@/lib/tax-return/opex-candidate-ranking";

export type RankerWeights = {
  version: number;
  features: string[];
  weights: number[];
  bias: number;
  trainedAt?: string | null;
  notes?: string;
};

const DEFAULT_WEIGHTS: RankerWeights = weightsJson as RankerWeights;

let activeWeights: RankerWeights = DEFAULT_WEIGHTS;

export function setOpexRankerWeights(weights: RankerWeights): void {
  activeWeights = weights;
}

export function getOpexRankerWeights(): RankerWeights {
  return activeWeights;
}

export function dotFeatures(features: number[], weights: number[], bias: number): number {
  let sum = bias;
  const n = Math.min(features.length, weights.length);
  for (let i = 0; i < n; i++) sum += features[i]! * weights[i]!;
  return sum;
}

/** Learned linear score for an OPEX candidate (higher = more likely correct). */
export function scoreOpexCandidateMl(
  candidate: OpexCandidate,
  ctx?: { sales?: number; stmt2Total?: number },
): number {
  const w = activeWeights;
  if (!w.weights.length) {
    return candidate.closureScore * 50 + candidate.evidenceScore * 30 + candidate.consistencyScore * 20;
  }
  const features = opexCandidateFeatures(candidate, ctx);
  return dotFeatures(features, w.weights, w.bias ?? 0);
}

/** Blend hand-tuned formula with learned weights (keeps behavior stable when ML is uncertain). */
export function scoreOpexCandidateBlended(
  candidate: OpexCandidate,
  ctx?: { sales?: number; stmt2Total?: number },
): number {
  const hand =
    candidate.closureScore * 50 + candidate.evidenceScore * 30 + candidate.consistencyScore * 20;
  const ml = scoreOpexCandidateMl(candidate, ctx);
  return hand * 0.35 + ml * 0.65;
}

export function featureNamesForTraining(): readonly string[] {
  return OPEX_FEATURE_NAMES;
}
