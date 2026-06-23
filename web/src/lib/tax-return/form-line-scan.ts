import { substantialMoneyTokens } from "./money";
import type { FieldExtraction } from "./form-anchors";

/** Last substantial money token on the best line matching `lineRe` (prefers largest tail amount). */
export function scanLineTail(
  text: string,
  id: string,
  lineRe: RegExp,
  source: string,
  conf = 97,
): { value: number; conf: number; source: string } | null {
  const hits: Array<{ value: number; conf: number; source: string }> = [];
  for (const row of text.split(/\n/)) {
    if (!lineRe.test(row)) continue;
    const line = row.replace(/\s+/g, " ").trim();
    const nums = substantialMoneyTokens(line);
    const tail = nums.length ? nums[nums.length - 1] : undefined;
    if (tail === undefined) continue;
    hits.push({ value: Math.round(tail), conf, source });
  }
  if (!hits.length) return null;
  return hits.sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0]!;
}

export function applyLineScans(text: string, scans: Array<{ id: string; re: RegExp; source: string; conf?: number }>): FieldExtraction {
  const out: FieldExtraction = { values: {}, confidence: {}, sources: {} };
  for (const scan of scans) {
    const hits: Array<{ value: number; conf: number; source: string }> = [];
    for (const row of text.split(/\n/)) {
      if (!scan.re.test(row)) continue;
      const line = row.replace(/\s+/g, " ").trim();
      const nums = substantialMoneyTokens(line);
      const tail = nums.length ? nums[nums.length - 1] : undefined;
      if (tail === undefined) continue;
      if (scan.id === "cogs") {
        const yearCols = nums.filter((n) => Math.abs(n) >= 500_000);
        if (!yearCols.length) continue;
        const pair = yearCols.length >= 2 ? yearCols.slice(-2) : yearCols;
        if (pair.length >= 2 && Math.abs(pair[0]! - pair[1]!) < 2) continue;
        hits.push({ value: Math.round(Math.max(...yearCols)), conf: scan.conf ?? 97, source: scan.source });
        continue;
      }
      hits.push({ value: Math.round(tail), conf: scan.conf ?? 97, source: scan.source });
    }
    if (!hits.length) continue;
    const hit = hits.sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0]!;
    const prev = out.confidence[scan.id] ?? 0;
    if (hit.conf >= prev) {
      out.values[scan.id] = hit.value;
      out.confidence[scan.id] = hit.conf;
      out.sources[scan.id] = hit.source;
    }
  }
  return out;
}
