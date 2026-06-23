import type { FieldExtraction } from "./form-anchors";
import {
  bracketLineAmount,
  formLineAmount,
  isForm1120Line,
  lineMoneyTokens,
  scheduleLineAmount,
} from "./money";

const CONF = 97;

function setField(
  out: FieldExtraction,
  id: string,
  value: number | undefined,
  source: string,
  conf = CONF,
): void {
  if (value === undefined) return;
  const prev = out.confidence[id] ?? 0;
  if (prev > conf) return;
  out.values[id] = Math.round(value);
  out.confidence[id] = conf;
  out.sources[id] = source;
}

function lineAmt(line: string): number | undefined {
  return scheduleLineAmount(line) ?? bracketLineAmount(line, String(leadingLine(line) ?? ""));
}

function leadingLine(line: string): number | undefined {
  const m = line.match(/^\s*(\d{1,2})(?:[a-z]\b)?/i);
  return m ? Number(m[1]) : undefined;
}

/** Form 1041 page 1 block — estates & trusts income return. */
export function extractForm1041Page1Block(text: string): string {
  const re = /u\.s\.\s*income\s*tax\s*return\s+for\s+estates\s+and\s+trusts|form\s*1041\s*\(\d{4}\)/gi;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    blocks.push(text.slice(Math.max(0, m.index - 2000), m.index + 12000));
  }
  if (blocks.length) {
    return blocks.sort(
      (a, b) =>
        (/\d{1,3},\d{3}/.test(b) ? 1 : 0) - (/\d{1,3},\d{3}/.test(a) ? 1 : 0) || b.length - a.length,
    )[0]!;
  }
  const schedB = text.search(/schedule\s+b\s*\(?\s*form\s*1041/i);
  if (schedB >= 0) return text.slice(Math.max(0, schedB - 8000), schedB + 8000);
  return text;
}

/** Form 1041 page 1 + Schedule B balance sheet (estates & trusts). */
export function extractForm1041Anchors(text: string): FieldExtraction {
  const out: FieldExtraction = { values: {}, confidence: {}, sources: {} };
  const page1 = extractForm1041Page1Block(text);

  for (const rawLine of page1.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;

    if (isForm1120Line(line, 1) && /interest\s+income/i.test(line)) {
      const oi = formLineAmount(line, "1") ?? lineAmt(line);
      if (oi !== undefined && oi < 500_000) setField(out, "other_income", oi, "Form 1041 line 1 interest income", 95);
    }
    if (isForm1120Line(line, 3) && /business\s+income/i.test(line)) {
      setField(out, "sales", lineAmt(line), "Form 1041 line 3 business income");
    }
    if (isForm1120Line(line, 5) && /rents?,?\s*royalt/i.test(line)) {
      const rent = lineAmt(line);
      if (rent !== undefined) setField(out, "rent", rent, "Form 1041 line 5");
    }
    if (isForm1120Line(line, 8) && /total\s+income/i.test(line) && out.values.sales === undefined) {
      setField(out, "sales", lineAmt(line), "Form 1041 line 8 total income");
    }
    if (isForm1120Line(line, 9) && /interest/i.test(line) && !/income/i.test(line)) {
      setField(out, "interest_expense", lineAmt(line), "Form 1041 line 9");
    }
    if (isForm1120Line(line, 10) && /taxes/i.test(line) && !/income/i.test(line)) {
      setField(out, "taxes_paid", lineAmt(line), "Form 1041 line 10");
      setField(out, "taxes_licenses", lineAmt(line), "Form 1041 line 10", 94);
    }
    if (isForm1120Line(line, 11) && /fiduciary/i.test(line)) {
      setField(out, "officer_compensation", lineAmt(line), "Form 1041 line 11");
    }
    if (isForm1120Line(line, 13) && /other\s+deduct/i.test(line)) {
      setField(out, "other_operating_expenses", lineAmt(line), "Form 1041 line 13");
    }
    if (isForm1120Line(line, 22) && /total\s+tax/i.test(line)) {
      setField(out, "taxes_paid", lineAmt(line), "Form 1041 line 22 total tax", 98);
    }
  }

  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;

    if (/^1\s+cash\b/i.test(line) || (isForm1120Line(line, 1) && /schedule\s+b/i.test(text) && /\bcash\b/i.test(line))) {
      setField(out, "cash", lineAmt(line), "Form 1041 Schedule B line 1");
    }
    if (isForm1120Line(line, 2) && /receivable/i.test(line)) {
      setField(out, "accounts_receivable", lineAmt(line), "Form 1041 Schedule B line 2");
    }
    if (isForm1120Line(line, 3) && /inventor/i.test(line)) {
      setField(out, "inventory", lineAmt(line), "Form 1041 Schedule B line 3");
    }
    if (isForm1120Line(line, 5) && /other\s+current\s+asset/i.test(line)) {
      setField(out, "other_current_assets", lineAmt(line), "Form 1041 Schedule B line 5");
    }
    if (/10a\b/i.test(line) && /depreciable|buildings/i.test(line)) {
      const g = lineAmt(line);
      if (g !== undefined && g > 0) setField(out, "gross_fixed_assets", g, "Form 1041 Schedule B line 10a");
    }
    if (/less\s+accumulated\s+depreciation/i.test(line)) {
      setField(out, "accumulated_depreciation", lineAmt(line), "Form 1041 Schedule B line 10b");
    }
    if (isForm1120Line(line, 10) && /accounts\s+payable/i.test(line)) {
      setField(out, "accounts_payable", lineAmt(line), "Form 1041 Schedule B line 10");
    }
    if (isForm1120Line(line, 11) && /other\s+current\s+liabilit/i.test(line)) {
      setField(out, "other_current_liabilities", lineAmt(line), "Form 1041 Schedule B line 11");
    }
    if (isForm1120Line(line, 12) && /loans\s+from/i.test(line)) {
      setField(out, "short_term_debt", lineAmt(line), "Form 1041 Schedule B line 12");
    }
    if (isForm1120Line(line, 13) && /less\s+than\s+1\s+year/i.test(line)) {
      setField(out, "current_portion_ltd", lineAmt(line), "Form 1041 Schedule B line 13");
    }
    if (isForm1120Line(line, 14) && /1\s+year\s+or\s+more/i.test(line)) {
      setField(out, "notes_minus_short_term", lineAmt(line), "Form 1041 Schedule B line 14");
    }
    if (isForm1120Line(line, 16) && /corporate\s+stock/i.test(line)) {
      const amt = lineAmt(line);
      if (amt !== undefined && amt >= 1000) setField(out, "common_stock", amt, "Form 1041 Schedule B line 16");
    }
    if (isForm1120Line(line, 17) && /other\s+asset/i.test(line)) {
      setField(out, "other_assets", lineAmt(line), "Form 1041 Schedule B line 17");
    }
    if (isForm1120Line(line, 18) && /total\s+assets/i.test(line)) {
      // skip total row
    }
    if (isForm1120Line(line, 24) && /retained|equity|corpus/i.test(line)) {
      setField(out, "unclassified_equity", lineAmt(line), "Form 1041 Schedule B line 24");
    }
  }

  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!/gross\s+receipt|gross\s+sales|total\s+income.*business/i.test(line)) continue;
    const nums = lineMoneyTokens(line).filter((n) => Math.abs(n) >= 100_000);
    if (!nums.length) continue;
    const best = Math.max(...nums.map(Math.abs));
    if (out.values.sales === undefined || best > (out.values.sales ?? 0)) {
      setField(out, "sales", best, "Form 1041 attached business schedule", 94);
    }
  }

  return out;
}
