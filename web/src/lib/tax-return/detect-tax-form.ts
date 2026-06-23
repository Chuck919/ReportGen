/** Primary federal return form detected from embedded + OCR text. */
export type TaxFormKind = "1120-s" | "1120" | "1065" | "1041" | "unknown";

export type TaxFormAnalysis = {
  kind: TaxFormKind;
  confidence: number;
  signals: string[];
  formsMentioned: string[];
};

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) || []).length;
}

/** Detect dominant return form — structure-based, no client-specific rules. */
export function detectTaxForm(text: string): TaxFormAnalysis {
  const t = text.toLowerCase();
  const signals: string[] = [];
  const formsMentioned = [
    ...new Set((text.match(/form\s+10\d{2}[-\w]*/gi) || []).map((f) => f.replace(/\s+/g, " "))),
  ].slice(0, 12);

  let s1120s =
    countMatches(t, /form\s+1120-?s\b/g) +
    countMatches(t, /1120-?s\s*\(\d{4}\)/g) +
    (/\bschedule\s+k-?1\b/i.test(t) && /shareholder/i.test(t) ? 2 : 0);
  if (/s\s+corporation/i.test(t)) s1120s += countMatches(t, /form\s+1120/i);
  let s1120 =
    countMatches(t, /form\s+1120\b(?!-)/g) +
    countMatches(t, /u\.s\.\s+corporation\s+income\s+tax\s+return/g) +
    (/\bgross receipts or sales\b/i.test(t) && /\bcompensation of officers\b/i.test(t) ? 2 : 0) +
    (/form\s+1120\s+return\s+summary/i.test(t) ? 4 : 0);
  let s1065 =
    countMatches(t, /form\s+1065\b/g) +
    countMatches(t, /u\.s\.\s+return of partnership income/g) +
    (/\bschedule\s+k-?1\b/i.test(t) && /partner/i.test(t) ? 3 : 0);
  let s1041 =
    countMatches(t, /form\s+1041\b/g) +
    countMatches(t, /u\.s\.\s+income\s+tax\s+return\s+for\s+estates\s+and\s+trusts/g) +
    (/\bfiduciary\b/i.test(t) && /\bschedule\s+b\b/i.test(t) ? 3 : 0);

  if (/form\s+1065\b/i.test(t) && !/form\s+1120-?s\b/i.test(t) && !/s\s+corporation/i.test(t)) {
    s1065 += 5;
    s1120s = Math.max(0, s1120s - 4);
  }
  if (countMatches(t, /form\s+1065\b/g) >= 2 && countMatches(t, /form\s+1120-?s\b/g) === 0) {
    s1065 += 6;
    s1120s = Math.max(0, s1120s - 5);
  }
  if (/u\.s\.\s+return\s+of\s+partnership\s+income/i.test(t)) {
    s1065 += 8;
    s1120s = Math.max(0, s1120s - 4);
  }
  if (/form\s+7004/i.test(t) && !/income\s+tax\s+return\s+for\s+estates\s+and\s+trusts/i.test(t)) {
    const ext1041 = countMatches(t, /form\s+1041\b/g);
    if (ext1041 > 0 && !/form\s+1041\s*\(\d{4}\)/i.test(t)) {
      s1041 = Math.max(0, s1041 - ext1041);
    }
  }
  if (/form\s+1041\s*\(\d{4}\)|income\s+tax\s+return\s+for\s+estates\s+and\s+trusts/i.test(t)) {
    s1041 += 8;
    s1120s = Math.max(0, s1120s - 3);
  }
  if (/form\s+1041\b/i.test(t) && /estates?\s+and\s+trusts|fiduciary\s+return|schedule\s+b\b/i.test(t)) {
    s1041 += 6;
    s1120 = Math.max(0, s1120 - 3);
    s1120s = Math.max(0, s1120s - 4);
  }
  if (/\bschedule\s+b\b/i.test(t) && /form\s+1041\b/i.test(t) && countMatches(t, /form\s+1120-?s\b/g) === 0) {
    s1041 += 5;
    s1120s = Math.max(0, s1120s - 5);
  }
  if (s1041 > 0 && s1120 > s1041 && !/\bschedule\s+b\b/i.test(t)) {
    s1041 = Math.max(0, s1041 - 3);
  }

  const ranked: Array<{ kind: TaxFormKind; score: number }> = [
    { kind: "1120-s", score: s1120s },
    { kind: "1120", score: s1120 - (s1120s > 0 ? 3 : 0) },
    { kind: "1065", score: s1065 },
    { kind: "1041", score: s1041 },
  ].sort((a, b) => b.score - a.score);

  const top = ranked[0]!;
  const second = ranked[1]?.score ?? 0;

  if (top.score < 2) {
    return { kind: "unknown", confidence: 0, signals: ["no strong form signal"], formsMentioned };
  }

  if (top.kind === "1120-s") signals.push("1120-S / Schedule K-1");
  if (top.kind === "1120") signals.push("1120 corporation return");
  if (top.kind === "1065") signals.push("1065 partnership return");
  if (top.kind === "1041") signals.push("1041 estate/trust return");

  const confidence = Math.min(99, 50 + top.score * 8 + (top.score - second) * 5);
  return { kind: top.score - second >= 1 ? top.kind : "unknown", confidence, signals, formsMentioned };
}
