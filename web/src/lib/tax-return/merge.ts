import { TAX_WORKBOOK_ROWS } from "@/lib/tax-workbook";

const INPUT_ROW_IDS = new Set(
  TAX_WORKBOOK_ROWS.filter((row) => row.excelBehavior === "input").map((row) => row.id),
);

export type ResolvedFields = {
  values: Record<string, number>;
  confidence: Record<string, number>;
  sources: Record<string, string>;
  warnings: string[];
};

export function mergeFieldExtraction(
  resolved: ResolvedFields,
  incoming: { values: Record<string, number>; confidence: Record<string, number>; sources?: Record<string, string> },
  minConfidence = 0,
  skipIds?: Set<string>,
): Set<string> {
  const filled = new Set<string>();
  for (const [id, value] of Object.entries(incoming.values)) {
    if (!INPUT_ROW_IDS.has(id)) continue;
    if (skipIds?.has(id)) continue;
    const conf = incoming.confidence[id] ?? 0;
    if (conf < minConfidence) continue;
    const prev = resolved.confidence[id] ?? 0;
    if (conf >= prev) {
      resolved.values[id] = value;
      resolved.confidence[id] = conf;
      if (incoming.sources?.[id]) resolved.sources[id] = incoming.sources[id];
      filled.add(id);
    }
  }
  return filled;
}

/** Form / statement anchors always override fuzzy OCR hits. */
export function applyAuthoritativeExtraction(
  resolved: ResolvedFields,
  incoming: { values: Record<string, number>; confidence: Record<string, number>; sources?: Record<string, string> },
): void {
  for (const [id, value] of Object.entries(incoming.values)) {
    if (!INPUT_ROW_IDS.has(id)) continue;
    resolved.values[id] = value;
    resolved.confidence[id] = incoming.confidence[id] ?? 98;
    if (incoming.sources?.[id]) resolved.sources[id] = incoming.sources[id];
  }
}

export function pruneNoMatchWarnings(resolved: ResolvedFields, filled: Set<string>): void {
  resolved.warnings = resolved.warnings.filter((w) => {
    if (!w.startsWith("No OCR/text match")) return true;
    const row = TAX_WORKBOOK_ROWS.find((r) => w.includes(r.label));
    return !row || !filled.has(row.id);
  });
}
