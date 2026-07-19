import { substantialMoneyTokens } from "./money";
import type { FieldExtraction } from "./form-anchors";

export function applyLineScans(text: string, scans: Array<{ id: string; re: RegExp; source: string; conf?: number }>): FieldExtraction {
  const out: FieldExtraction = { values: {}, confidence: {}, sources: {} };
  for (const scan of scans) {
    const hits: Array<{ value: number; conf: number; source: string }> = [];
    for (const row of text.split(/\n/)) {
      if (!scan.re.test(row)) continue;
      const line = row.replace(/\s+/g, " ").trim();
      // Statement caption headers ("Statement N - Form 1120-S, Page N, Schedule L,
      // Line NN - <name>") carry only reference numbers, never an amount cell.
      if (/schedule\s+l\W{0,15}line\s*\d{1,2}\b\s*[-–—]?\s*[a-z]/i.test(line)) continue;
      const nums = substantialMoneyTokens(line);
      const tail = nums.length ? nums[nums.length - 1] : undefined;
      if (tail === undefined) continue;
      if (scan.id === "cogs") {
        // Multi-column comparison bleed: require two distinct year columns, not a $500k floor.
        if (nums.length < 2) continue;
        const pair = nums.slice(-2);
        if (Math.round(pair[0]!) === Math.round(pair[1]!)) continue;
        hits.push({ value: Math.round(Math.max(...pair)), conf: scan.conf ?? 97, source: scan.source });
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
