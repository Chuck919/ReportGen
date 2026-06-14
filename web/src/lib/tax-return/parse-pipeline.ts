import type { ResolvedFields } from "./merge";
import { applyAuthoritativeExtraction, mergeFieldExtraction } from "./merge";

export type FieldExtraction = {
  values: Record<string, number>;
  confidence: Record<string, number>;
  sources?: Record<string, string>;
};

/**
 * Merge extractions low → high priority. Higher tiers always win on conflict.
 * Generic source priority — not company-specific.
 */
export function assembleExtractions(
  tiers: Array<{ name: string; extraction: FieldExtraction; minConfidence?: number; onlyIds?: Set<string> }>,
): ResolvedFields {
  const resolved: ResolvedFields = { values: {}, confidence: {}, sources: {}, warnings: [] };

  for (const tier of tiers) {
    if (tier.onlyIds) {
      const filtered: FieldExtraction = { values: {}, confidence: {}, sources: {} };
      for (const id of tier.onlyIds) {
        if (tier.extraction.values[id] === undefined) continue;
        filtered.values[id] = tier.extraction.values[id];
        filtered.confidence[id] = tier.extraction.confidence[id] ?? 0;
        if (tier.extraction.sources?.[id]) filtered.sources![id] = tier.extraction.sources[id];
      }
      mergeFieldExtraction(resolved, filtered, tier.minConfidence ?? 0);
    } else if (tier.name === "form-anchors") {
      applyAuthoritativeExtraction(resolved, tier.extraction);
    } else {
      mergeFieldExtraction(resolved, tier.extraction, tier.minConfidence ?? 0);
    }
  }

  return resolved;
}
