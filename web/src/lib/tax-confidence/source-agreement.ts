/**
 * Re-exports source agreement primitives used by the confidence layer.
 * Canonical implementation lives in @/lib/tax/source-agreement.
 */
export {
  buildSourceSnapshots,
  classifySourceFamily,
  countAgreeingFamilies,
  getAlternateReads,
  hasSourceDisagreement,
  pickBestSnapshot,
  resolveValuesFromSnapshots,
  sourceDisagreementDetail,
  valuesExactlyEqual,
  withinTolerance,
  type SourceFamily,
  type SourceSnapshot,
} from "@/lib/tax/source-agreement";

import type { SourceSnapshot } from "@/lib/tax/source-agreement";
import { hasSourceDisagreement, valuesExactlyEqual } from "@/lib/tax/source-agreement";
import type { ConfidenceFlag } from "./confidence-flags";

/** Detect cross-family disagreement for confidence flagging. */
export function crossSourceConflictFlags(
  snapshots: SourceSnapshot[],
  chosen: number,
): ConfidenceFlag[] {
  if (!hasSourceDisagreement(snapshots)) return [];
  const alternates = snapshots.filter((s) => !valuesExactlyEqual(s.value, chosen));
  const families = new Set(alternates.map((s) => s.family));
  if (families.size >= 2) return ["source_disagreement"];
  if (alternates.length >= 1) return ["source_disagreement"];
  return [];
}
