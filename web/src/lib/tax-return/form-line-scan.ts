import { substantialMoneyTokens } from "./money";
import type { FieldExtraction } from "./form-anchors";

/** Last substantial money token on the first line matching `lineRe` (Schedule L / Form rows). */
export function scanLineTail(
  text: string,
  id: string,
  lineRe: RegExp,
  source: string,
  conf = 97,
): { value: number; conf: number; source: string } | null {
  const line = text.split(/\n/).find((row) => lineRe.test(row))?.replace(/\s+/g, " ").trim();
  if (!line) return null;
  const nums = substantialMoneyTokens(line);
  if (!nums.length) return null;
  return { value: Math.round(nums[nums.length - 1]), conf, source };
}

export function applyLineScans(text: string, scans: Array<{ id: string; re: RegExp; source: string; conf?: number }>): FieldExtraction {
  const out: FieldExtraction = { values: {}, confidence: {}, sources: {} };
  for (const scan of scans) {
    const hit = scanLineTail(text, scan.id, scan.re, scan.source, scan.conf);
    if (!hit) continue;
    const prev = out.confidence[scan.id] ?? 0;
    if (hit.conf >= prev) {
      out.values[scan.id] = hit.value;
      out.confidence[scan.id] = hit.conf;
      out.sources[scan.id] = hit.source;
    }
  }
  return out;
}
