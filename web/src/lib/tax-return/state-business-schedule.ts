import type { FieldExtraction } from "./form-anchors";
import { lineMoneyTokens, scheduleLineAmount } from "./money";

/**
 * State / local business P&L schedules (e.g. MO RD-108 Schedule C) mirror federal
 * deduction lines but use their own layout. Match by label text + line prefix, not client.
 */
export function scanStateBusinessScheduleDeductions(text: string): FieldExtraction {
  const out: FieldExtraction = { values: {}, confidence: {}, sources: {} };

  const blockRe =
    /schedule\s+c\s*[-–]\s*profit|profit\s*\(\s*or\s*loss\s*\)\s*from\s+business|form\s+r[dD]-108/gi;
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) starts.push(m.index);
  if (!starts.length) return out;

  const set = (id: string, value: number, source: string, conf = 91) => {
    if (id === "taxes_licenses" && value < 5_000) return;
    const prev = out.confidence[id] ?? 0;
    if (conf < prev) return;
    out.values[id] = Math.round(value);
    out.confidence[id] = conf;
    out.sources[id] = source;
  };

  for (const start of starts) {
    const block = text.slice(start, start + 12_000);
    for (const rawLine of block.split(/\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (!line || !/\d/.test(line)) continue;

      const amt = scheduleLineAmount(line) ?? lineMoneyTokens(line).filter((n) => Math.abs(n) >= 1_000).pop();
      if (amt === undefined || Math.abs(amt) < 1_000) continue;

      if (
        (/(?:^|\s)10\s*[_\.\)]\s*rents?\b|(?:^|\s)10\.\s*rents?\b/i.test(line) || /\b10[_\s]+rents?\b/i.test(line)) &&
        !/real\s+estate\s+income/i.test(line)
      ) {
        set("rent", amt, "State business schedule (line 10 Rents)", 92);
        continue;
      }

      if (
        (/(?:^|\s)(11|12)\s*[_\.\)]\s*taxes|(?:^|\s)(11|12)\.\s*taxes|\btaxes\s*\(\s*federal/i.test(line) ||
          /\b1[12]\b[^\n]{0,30}taxes/i.test(line) ||
          (/taxes/i.test(line) && /stmt\s*2|smt\s*2/i.test(line))) &&
        !/not\s+deduct/i.test(line.slice(0, 80))
      ) {
        const cur = out.values.taxes_licenses;
        if (cur === undefined || Math.abs(amt) > Math.abs(cur)) {
          set("taxes_licenses", amt, "State business schedule (taxes line)", 90);
        }
        continue;
      }

      if (/(?:^|\s)16\s*[_\.\)]\s*advert|(?:^|\s)16\.\s*advert/i.test(line)) {
        set("advertising", amt, "State business schedule (line 16 Advertising)", 92);
        continue;
      }

      if (/(?:^|\s)9\s*[_\.\)]\s*advert|(?:^|\s)9\.\s*advert/i.test(line)) {
        set("advertising", amt, "State business schedule (line 9 Advertising)", 91);
      }
    }
  }

  return out;
}
