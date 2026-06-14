/**
 * Form 1120-S "Two Year Comparison" blocks: two money columns + optional variance.
 */

import { TAX_WORKBOOK_ROWS } from "@/lib/tax-workbook";
import { isFormReferenceNumber } from "@/lib/tax-return/money";

const INPUT_IDS = new Set(TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "input").map((r) => r.id));

function parseMoneyToken(raw: string): number | null {
  let s = raw.trim().replace(/[$,]/g, "");
  if (!s || s === "-") return null;
  let sign = 1;
  if (s.startsWith("(") && s.endsWith(")")) {
    sign = -1;
    s = s.slice(1, -1);
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(sign * n) : null;
}

export function stripEinNoise(line: string): string {
  return line
    .replace(/\b\d{1,2}\s*[-–—]\s*\d{7}\b/g, " ")
    .replace(/\b-?\d{7}\b/g, " ");
}

export function classifyComparisonLine(line: string): string | null {
  const t = line.toLowerCase();
  if (/ordinary\s+busin|net\s+income|total\s+inc/i.test(t) && !/cost/.test(t)) return null;
  if (/net\s*rece|gross\s*rece|gross\s*receipt|net\s*sale/.test(t)) {
    if (/8990|section\s+448|3\s+tax\s+years|aggregate\s+average/.test(t)) return null;
    return "sales";
  }
  if (/cost\s*of\s*(gos|good|sales)|c\.?\s*o\.?\s*g/.test(t)) return "cogs";
  if (/compensat\w*.{0,24}off|compensat\w*\s+of\s+(ofc|afc|off)/i.test(t)) return "officer_compensation";
  if (/sar\w*\s+and\s+wa|salari\w*\s+and\s+wag/.test(t)) return "salaries_wages";
  if (/advert|verteng/.test(t) && !/adjusted/i.test(t)) return "advertising";
  if (/(^|[^a-z])rent[^a-z]/.test(t) && !/cur(r)?ent/i.test(t)) return "rent";
  if (/tax(es)?\s+and\s+(lic|es)|totes\s+ond\s+es/.test(t)) return "taxes_licenses";
  if (/interest\s+exp|interest\s*\(/.test(t)) return "interest_expense";
  if (/depreciation/.test(t) && !/accum/i.test(t)) return "depreciation";
  if (/amortization/.test(t) && !/accum/i.test(t)) return "amortization";
  if (/other\s+operat.{0,6}exp|other\s+deduct|ober\s+desucon/.test(t)) return "other_operating_expenses";
  if (/other\s+income/i.test(t) && !/operat/i.test(t)) return "other_income";
  if (/bank|credit\s+card/.test(t)) return "bank_credit_card";
  if (/professional|legal\s+and/.test(t)) return "professional_fees";
  if (/utilities|utilit/.test(t)) return "utilities";
  if (/taxes\s+paid/.test(t) && !/net income|per books|per return|ordinary business/i.test(t)) return "taxes_paid";
  if (/cash/.test(t) && !/flow/.test(t)) return "cash";
  if (/receivable|trade receiv/i.test(t) && !/note|year|overpayment|balance at|beginning|ending/i.test(t)) return "accounts_receivable";
  if (/\binventory\b/.test(t)) return "inventory";
  if (/other\s+current\s+asset/.test(t)) return "other_current_assets";
  if (/gross\s+fixed|buildings\s+and\s+other\s+deprec/.test(t)) return "gross_fixed_assets";
  if (/accumulated\s+depreciation|less\s+acc/i.test(t)) return "accumulated_depreciation";
  if (/gross\s+intang/.test(t)) return "gross_intangible_assets";
  if (/accumulated\s+amort/.test(t)) return "accumulated_amortization";
  if (/other\s+asset/.test(t) && !/current/.test(t)) return "other_assets";
  if (/accounts\s+payable/.test(t)) return "accounts_payable";
  if (/other\s+current\s+liabilit/.test(t)) return "other_current_liabilities";
  if (/retained|unclassified\s+equity/.test(t)) return "unclassified_equity";
  if (/notes\s+minus|senior\s+debt|mortgage.*1\s+year\s+or\s+more/i.test(t)) return "notes_minus_short_term";
  return null;
}

export function pickComparisonColumnIndex(leftYear: number, rightYear: number, targetYear: number): 0 | 1 {
  if (targetYear === leftYear) return 0;
  if (targetYear === rightYear) return 1;
  if (targetYear < Math.min(leftYear, rightYear)) return 0;
  if (targetYear > Math.max(leftYear, rightYear)) return 1;
  return Math.abs(targetYear - leftYear) <= Math.abs(targetYear - rightYear) ? 0 : 1;
}

export function shrinkToYearColumns(nums: number[]): [number, number] | null {
  if (nums.length === 0) return null;
  let v = nums.slice();
  if (v.length >= 3) {
    const a = v[v.length - 3];
    const b = v[v.length - 2];
    const c = v[v.length - 1];
    if (Math.abs(Math.abs(b) - Math.abs(a) - Math.abs(c)) <= Math.max(2, Math.abs(c) * 0.03)) {
      v = v.slice(0, -1);
    }
  }
  if (v.length >= 3) return [v[v.length - 3]!, v[v.length - 2]!];
  if (v.length >= 2) return [v[v.length - 2]!, v[v.length - 1]!];
  if (v.length === 1) return [v[0]!, v[0]!];
  return null;
}

/** Reject OCR noise structurally — not by company-size dollar floors. */
function isStructurallyValid(id: string, value: number, line: string, headerYears?: [number, number]): boolean {
  const v = Math.abs(value);
  if (isFormReferenceNumber(v)) return false;
  if (headerYears && (v === headerYears[0] || v === headerYears[1])) return false;
  if (id === "depreciation" && (value < 0 || /accumulated/i.test(line))) return false;
  if (id === "accounts_receivable" && /balance at|beginning|ending|year/i.test(line)) return false;
  if ((id === "other_income" || id === "taxes_paid" || id === "depreciation") && Math.abs(value) < 100) return false;
  if (id === "taxes_licenses" && Math.abs(value) < 1000) return false;
  return true;
}

export function parseTwoYearComparisonBlock(
  fullText: string,
  targetYear: number,
): {
  values: Record<string, number>;
  confidence: Record<string, number>;
  headerYears?: [number, number];
  columnUsed?: 0 | 1;
  linesMatched: number;
} | null {
  const start = fullText.search(
    /two\s*year\s*comparison|1120[-\s]?s.{0,40}worksheet|worksheet\s+page.{0,20}20\d{2}/i,
  );
  if (start < 0) return null;

  const block = fullText.slice(start, start + 22000);
  const headerM = block.match(/\b(20\d{2})\s*[\&\-–]\s*(20\d{2})\b/);
  let col: 0 | 1 = 1;
  let yL = 0;
  let yR = 0;
  if (headerM) {
    yL = Number(headerM[1]);
    yR = Number(headerM[2]);
    col = pickComparisonColumnIndex(yL, yR, targetYear);
  }

  const values: Record<string, number> = {};
  const confidence: Record<string, number> = {};
  let linesMatched = 0;

  for (const rawLine of block.split(/\r?\n/)) {
    const line = stripEinNoise(rawLine.replace(/\s+/g, " ").trim());
    const id = classifyComparisonLine(line);
    if (!id || !INPUT_IDS.has(id)) continue;

    const matches = Array.from(line.matchAll(/\(?\$?\s*-?\d[\d,]*(?:\.\d{2})?\s*\)?/g));
    const nums: number[] = [];
    for (const m of matches) {
      const v = parseMoneyToken(m[0]);
      if (v !== null) nums.push(v);
    }
    const pair = shrinkToYearColumns(nums);
    if (!pair) continue;

    const picked = col === 0 ? pair[0] : pair[1];
    if (!Number.isFinite(picked)) continue;
    if (!isStructurallyValid(id, picked, line, headerM ? [yL, yR] : undefined)) continue;
    if (values[id] !== undefined) continue;

    values[id] = Math.round(picked);
    confidence[id] = 86;
    linesMatched += 1;
  }

  if (linesMatched < 3) return null;

  return {
    values,
    confidence,
    headerYears: headerM ? [yL, yR] : undefined,
    columnUsed: col,
    linesMatched,
  };
}
