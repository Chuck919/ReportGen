import {
  bracketLineAmount,
  formLineAmount,
  isForm1120Line,
  isFormReferenceNumber,
  isHistoricalGrossReceiptsLine,
  lineMoneyTokens,
  lineMaxAmount,
  lineTailAmount,
  scheduleLineAmount,
  substantialMoneyTokens,
} from "./money";
import { applyLineScans } from "./form-line-scan";
import { extractScheduleLFields } from "./schedule-l";

export type FieldExtraction = {
  values: Record<string, number>;
  confidence: Record<string, number>;
  sources: Record<string, string>;
};

const ANCHOR_CONF = 98;

function setField(
  out: FieldExtraction,
  id: string,
  value: number | undefined,
  source: string,
  conf = ANCHOR_CONF,
): void {
  if (value === undefined || isFormReferenceNumber(Math.abs(value))) return;
  const prev = out.confidence[id] ?? 0;
  if (prev > conf) return;
  out.values[id] = Math.round(value);
  out.confidence[id] = conf;
  out.sources[id] = source;
}

function isCogsLine(line: string): boolean {
  return /cost\s*of\s*goods|c\.?o\.?g|costof\s*goods|goods\s*soid/i.test(line);
}

function salesFromLine(line: string): number | undefined {
  return bracketLineAmount(line, "1c") ?? lineMaxAmount(line) ?? consensusFromLine(line);
}

function consensusFromLine(line: string): number | undefined {
  const nums = lineMoneyTokens(line);
  if (!nums.length) return undefined;
  const counts = new Map<number, number>();
  for (const n of nums) counts.set(n, (counts.get(n) ?? 0) + 1);
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || Math.abs(b[0]) - Math.abs(a[0]))[0]?.[0];
}

function mergeExtractions(base: FieldExtraction, incoming: FieldExtraction): void {
  for (const [id, value] of Object.entries(incoming.values)) {
    const conf = incoming.confidence[id] ?? 0;
    const prev = base.confidence[id] ?? 0;
    if (conf >= prev) {
      base.values[id] = value;
      base.confidence[id] = conf;
      if (incoming.sources[id]) base.sources[id] = incoming.sources[id];
    }
  }
}

/**
 * Form 1120-S page 1 + Schedule L anchors from labeled line numbers in OCR text.
 * No company-size dollar thresholds — only line label / form structure.
 */
export function extractForm1120Anchors(text: string): FieldExtraction {
  const out: FieldExtraction = { values: {}, confidence: {}, sources: {} };
  const inventoryCandidates: number[] = [];

  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line || isHistoricalGrossReceiptsLine(line)) continue;
    if (/form 1120/i.test(line) && !/schedule\s*l|stmt\s*\d|statement\s*\d/i.test(line)) continue;

    if (/\[1c\b|\[1c[\]| ]|gross receipts or sales|\b1a\b.*gross|\bgoss\s+(rece|csr|receipts)/i.test(line)) {
      setField(out, "sales", salesFromLine(line), "Form 1120-S line 1c");
    }
    if ((isForm1120Line(line, 2) || /\[\s*2\s*\]/i.test(line)) && isCogsLine(line) && !/gross profit/i.test(line)) {
      const cogs = formLineAmount(line, "2");
      if (cogs !== undefined) setField(out, "cogs", cogs, "Form 1120-S line 2");
    }
    if (isForm1120Line(line, 7) && /compensation of officers/i.test(line)) {
      setField(out, "officer_compensation", scheduleLineAmount(line) ?? lineTailAmount(line), "Form 1120-S line 7");
    }
    if (isForm1120Line(line, 8) && /salaries and wages/i.test(line)) {
      setField(out, "salaries_wages", scheduleLineAmount(line) ?? lineTailAmount(line), "Form 1120-S line 8");
    }
    if (isForm1120Line(line, 11) && /\brents?\b/i.test(line)) {
      setField(out, "rent", scheduleLineAmount(line) ?? lineTailAmount(line), "Form 1120-S line 11");
    }
    if (isForm1120Line(line, 12) && /taxes and lic/i.test(line)) {
      setField(out, "taxes_licenses", scheduleLineAmount(line) ?? lineTailAmount(line), "Form 1120-S line 12");
    }
    if (isForm1120Line(line, 13) && /interest/i.test(line) && !/investment|tax-exempt|business interest/i.test(line)) {
      setField(out, "interest_expense", scheduleLineAmount(line) ?? lineTailAmount(line), "Form 1120-S line 13");
    }
    if (isForm1120Line(line, 14) && /depreciation/i.test(line) && !/accum|schedule\s*l|post-1986/i.test(line)) {
      const dep = scheduleLineAmount(line);
      if (dep !== undefined && (Math.abs(dep) > 99 || substantialMoneyTokens(line).length)) {
        setField(out, "depreciation", dep, "Form 1120-S line 14");
      } else if (!substantialMoneyTokens(line).length) setField(out, "depreciation", 0, "Form 1120-S line 14", 96);
    }
    if (/(\b16\b|\[16\b)/i.test(line) && /advertis/i.test(line)) {
      setField(out, "advertising", scheduleLineAmount(line) ?? lineTailAmount(line), "Form 1120-S line 16");
    }
    if (/^1\s+cash\b/i.test(line)) {
      setField(out, "cash", scheduleLineAmount(line) ?? lineTailAmount(line), "Schedule L line 1");
    }
    if (
      /inventor/i.test(line) &&
      /\b3\b/i.test(line) &&
      !/beginning|end of year|lifo|closing|form\s*1125/i.test(line)
    ) {
      const amt = scheduleLineAmount(line) ?? lineTailAmount(line);
      if (amt !== undefined) inventoryCandidates.push(Math.round(amt));
    }
    if (
      (/^\s*6\b/i.test(line) || /other\s+curren/i.test(line)) &&
      /curren\w*\s+ass|ment\s+asel|ronases|curent\s+ass|asses|romm|stmt\s*4/i.test(line) &&
      !/\b14\b.*other\s+ass/i.test(line)
    ) {
      setField(out, "other_current_assets", scheduleLineAmount(line), "Schedule L line 6");
    }
    if (
      /\b14\b/i.test(line) &&
      !/current\s+asset/i.test(line) &&
      /other\s+ass|ot\w*\s+ass|ofer\s+ass|ter\s+ass|stmt\s*4/i.test(line)
    ) {
      setField(out, "other_assets", scheduleLineAmount(line), "Schedule L line 14");
    }
  }

  if (inventoryCandidates.length) {
    const counts = new Map<number, number>();
    for (const v of inventoryCandidates) counts.set(v, (counts.get(v) ?? 0) + 1);
    const [value] = Array.from(counts.entries()).sort(
      (a, b) => b[1] - a[1] || Math.abs(b[0]) - Math.abs(a[0]),
    )[0]!;
    setField(out, "inventory", value, "Schedule L line 3");
  }

  mergeExtractions(out, extractScheduleLFields(text));

  mergeExtractions(
    out,
    applyLineScans(text, [
      { id: "taxes_licenses", re: /taxes\s+and\s+licen/i, source: "Form 1120-S line 12 (tail scan)", conf: 99 },
      { id: "cogs", re: /cost\s*of\s*goods|costof\s*goods|goods\s*soid/i, source: "Form 1120-S line 2 (tail scan)", conf: 98 },
      { id: "other_current_liabilities", re: /other\s+curren\w*\s+liabilit|curent\s+labi/i, source: "Schedule L line 18 (tail scan)", conf: 98 },
      {
        id: "notes_minus_short_term",
        re: /1\s*year\s*or\s*more|1yearormore|yearormore|fyearormo|payable.{0,16}in\s*1\s*year/i,
        source: "Schedule L line 20 (tail scan)",
        conf: 97,
      },
      { id: "unclassified_equity", re: /24\s+retained|retained\s+e\w*rnings/i, source: "Schedule L line 24 (tail scan)", conf: 97 },
      { id: "gross_fixed_assets", re: /10a\s+buildings|other depreciable assets/i, source: "Schedule L line 10a (tail scan)", conf: 98 },
      { id: "accumulated_depreciation", re: /less accumulated depreciation/i, source: "Schedule L line 10b (tail scan)", conf: 98 },
    ]),
  );

  const otherIncomeHit = scanFormLine5OtherIncome(extractFormPage1Block(text));
  if (otherIncomeHit !== undefined) {
    setField(out, "other_income", otherIncomeHit, "Form 1120-S line 5", 97);
  }

  const formPage1 = extractFormPage1Block(text);
  for (const rawLine of formPage1.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if ((isForm1120Line(line, 2) || /\[\s*2\s*\]/i.test(line)) && isCogsLine(line) && !/gross profit/i.test(line)) {
      const cogs = formLineAmount(line, "2");
      if (cogs !== undefined) {
        setField(out, "cogs", cogs, "Form 1120-S line 2 (page 1 block)", 99);
        break;
      }
    }
  }

  const form4562 = text.match(/form\s*4562[\s\S]{0,8000}/i)?.[0];
  if (form4562 && out.values.gross_intangible_assets === undefined) {
    for (const rawLine of form4562.split(/\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (!/intangible|goodwill|organizational|start-?up/i.test(line)) continue;
      const amt = scheduleLineAmount(line) ?? lineTailAmount(line);
      if (amt !== undefined) {
        setField(out, "gross_intangible_assets", amt, "Form 4562 amortization schedule", 96);
        break;
      }
    }
  }

  for (const stmtMatch of text.matchAll(/(?:statement|stmt|tatement)\s*[\d§][\s\S]{0,1500}/gi)) {
    const stmtBlock = stmtMatch[0];
    const header = stmtBlock.slice(0, 320);
    const totalLine = stmtBlock.split(/\n/).find((row) => /^total\b/i.test(row.replace(/\s+/g, " ").trim()));
    if (!totalLine) continue;
    const nums = lineMoneyTokens(totalLine);
    const endTotal = nums.length >= 2 ? nums[nums.length - 1] : scheduleLineAmount(totalLine);
    if (endTotal === undefined) continue;
    if (/line\s*6|other\s+current\s+ass/i.test(header)) {
      setField(out, "other_current_assets", endTotal, "Statement total (Line 6)", 99);
    } else if (/line\s*14|other\s+ass/i.test(header) && !/current\s+asset/i.test(header)) {
      setField(out, "other_assets", endTotal, "Statement total (Line 14)", 99);
    } else if (/line\s*18|other\s+curren|current\s+liabilit/i.test(header)) {
      setField(out, "other_current_liabilities", endTotal, "Statement total (Line 18)", 99);
    }
  }

  return out;
}

/** Real Form 1120-S page 1 — skip Two Year Comparison worksheets that also mention 1120-S. */
export function extractFormPage1Block(text: string): string {
  const anchors = [
    /u\.s\.\s*income\s*tax\s*return\s+for\s+an\s+s\s+corporation/i,
    /income\s*tax\s*return\s+for\s+an\s+s\s+corporation/i,
    /caution:\s*include\s+only\s+trade\s+or\s+business\s+income/i,
  ];
  for (const re of anchors) {
    const idx = text.search(re);
    if (idx >= 0) return text.slice(idx, idx + 14000);
  }
  const idx = text.search(/\b5\s+other\s+income/i);
  if (idx >= 0) return text.slice(Math.max(0, idx - 6000), idx + 800);
  const fallback = text.match(/form\s*1120-?s[\s\S]{0,14000}/i)?.[0];
  return fallback && !/two\s*year\s*comparison/i.test(fallback) ? fallback : text;
}

function scanFormLine5OtherIncome(block: string): number | undefined {
  for (const rawLine of block.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!isForm1120Line(line, 5) || !/other\s+income/i.test(line)) continue;
    if (/statement\s*[2-9]|stmt\s*[2-9]|discount|description/i.test(line)) continue;
    if (/attach|see\s+stmt|federal\s+statem/i.test(line)) {
      const stmtAmt = formLineAmount(line, "5") ?? scheduleLineAmount(line) ?? lineTailAmount(line);
      if (stmtAmt !== undefined) return stmtAmt;
      return undefined;
    }
    const amt = formLineAmount(line, "5") ?? scheduleLineAmount(line) ?? lineTailAmount(line);
    if (amt !== undefined) return amt;
    if (!substantialMoneyTokens(line).length) return 0;
  }
  return undefined;
}
