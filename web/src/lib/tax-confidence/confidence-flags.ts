/** Machine-readable confidence warning codes surfaced on extracted fields. */
export type ConfidenceFlag =
  | "candidate_conflict"
  | "source_disagreement"
  | "formula_inconsistency"
  | "ocr_incomplete"
  | "stmt2_missing_lines"
  | "comparison_missing"
  | "low_numeric_density"
  | "page_truncation"
  | "missing_key_schedule"
  | "low_trust_source"
  | "subtractive_formula";

const FLAG_MESSAGES: Record<ConfidenceFlag, string> = {
  candidate_conflict: "Top candidates disagree — verify before using",
  source_disagreement: "Independent sources read different values",
  formula_inconsistency: "Statement total does not close with exclusions + OPEX",
  ocr_incomplete: "OCR may be missing key attachment pages",
  stmt2_missing_lines: "Statement 2 detail lines not fully captured",
  comparison_missing: "Two-year comparison worksheet not found in OCR",
  low_numeric_density: "Low numeric density in OCR text — possible truncation",
  page_truncation: "OCR page count suggests incomplete document scan",
  missing_key_schedule: "Schedule L or key schedule not detected",
  low_trust_source: "Single low-trust source — verify manually",
  subtractive_formula: "Subtractive formula — verify against detail lines",
};

export function confidenceFlagMessage(flag: ConfidenceFlag): string {
  return FLAG_MESSAGES[flag];
}

export function flagCodeInText(text: string): ConfidenceFlag | undefined {
  const lower = text.toLowerCase();
  if (/candidate.?conflict|top candidates disagree/i.test(text)) return "candidate_conflict";
  if (/other reads|sources disagree|source_disagreement/i.test(lower)) return "source_disagreement";
  if (/formula.?inconsistency|formula-disagreement|does not close/i.test(lower)) return "formula_inconsistency";
  if (/ocr_incomplete|ocr may be missing/i.test(lower)) return "ocr_incomplete";
  if (/stmt2.?missing|detail.?incomplete/i.test(lower)) return "stmt2_missing_lines";
  if (/comparison.?missing|worksheet not found/i.test(lower)) return "comparison_missing";
  if (/low.?numeric.?density/i.test(lower)) return "low_numeric_density";
  if (/page.?truncation|incomplete document scan/i.test(lower)) return "page_truncation";
  if (/schedule.?l.?not|missing.?key.?schedule/i.test(lower)) return "missing_key_schedule";
  if (/low.?trust|verify manually/i.test(lower)) return "low_trust_source";
  if (/subtractive/i.test(lower)) return "subtractive_formula";
  return undefined;
}

/** Merge human-readable flags with standardized codes (deduped). */
export function mergeConfidenceFlags(
  existing: string[] | undefined,
  codes: ConfidenceFlag[],
): string[] {
  const out = [...(existing ?? [])];
  const seen = new Set(out.map((f) => f.toLowerCase()));

  for (const code of codes) {
    const msg = confidenceFlagMessage(code);
    if (!seen.has(code) && !seen.has(msg.toLowerCase())) {
      out.push(code);
      seen.add(code);
    }
  }
  return out;
}

/** Confidence penalty per flag — applied to display confidence (not parser score). */
export const FLAG_CONFIDENCE_CAP: Partial<Record<ConfidenceFlag, number>> = {
  candidate_conflict: 48,
  source_disagreement: 55,
  formula_inconsistency: 42,
  ocr_incomplete: 58,
  stmt2_missing_lines: 62,
  comparison_missing: 65,
  low_numeric_density: 60,
  page_truncation: 55,
  missing_key_schedule: 68,
  subtractive_formula: 72,
};

export function capConfidenceForFlags(
  baseConfidence: number,
  flags: ConfidenceFlag[],
): number {
  let capped = baseConfidence;
  for (const flag of flags) {
    const cap = FLAG_CONFIDENCE_CAP[flag];
    if (cap !== undefined) capped = Math.min(capped, cap);
  }
  return capped;
}
