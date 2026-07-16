/**
 * Form 1120-S "Two Year Comparison" blocks: two money columns + optional variance.
 */

import { TAX_WORKBOOK_ROWS } from "@/lib/tax-workbook";
import { isFormReferenceNumber } from "@/lib/tax-return/money";

const INPUT_IDS = new Set(TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "input").map((r) => r.id));
/** Extra SG&A categories present on comparison worksheets but not fixed workbook slots. */
const COMPARISON_VALUE_IDS = new Set([
  ...INPUT_IDS,
  "employee_benefits",
  "gasoline",
  "insurance",
  "supplies",
  "repairs",
  "travel",
]);

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

/** OCR often drops the leading letter (e.g. `ROSS RECEIPTS`, `OST OF GOODS`). */
function isGrossReceiptsLabel(line: string): boolean {
  if (/8990|section\s+448|3\s+tax\s+years|aggregate\s+average/i.test(line)) return false;
  return /(?:\bg\s*)?ross\s+rece|gross\s*rece|gross\s*receipt|net\s*sale/i.test(line);
}

export function classifyComparisonLine(line: string): string | null {
  const t = line.toLowerCase();
  if (/\b20\b/i.test(line) && /other\s+deduct/i.test(line) && /attach|stmt\s*2|see\s+stmt|\[20\]/i.test(line)) {
    return null;
  }
  if (/ordinary\s+busin|net\s+income|total\s+inc/i.test(t) && !/cost/.test(t)) return null;
  if (isGrossReceiptsLabel(line) || (/return.*allow/i.test(t) && /\d{1,3},\d{3}/.test(line))) {
    return "sales";
  }
  if (/cost\s*of\s*(gos|good|sales)|c\.?\s*o\.?\s*g|(?:\bc\s*)?ost\s+of\s*(gos|good|sales)/i.test(t)) return "cogs";
  if (/compensat\w*.{0,24}off|ompensat\w*.{0,24}off|compensat\w*\s+of\s+(ofc|afc|off)/i.test(t)) return "officer_compensation";
  if (/sar\w*\s+and\s+wa|salari\w*\s+and\s+wag/.test(t)) return "salaries_wages";
  if (/advert|verteng/.test(t) && !/adjusted/i.test(t)) return "advertising";
  if (/\brents?\b/i.test(t) && !/gross\s+rent|cur(r)?ent|parent\s+corp/i.test(t)) return "rent";
  if (/tax(es)?\s+and\s+(lic|es)|totes\s+ond\s+es|\baxes\s+and\s+lic/i.test(t)) return "taxes_licenses";
  if (/interest\s+exp|interest\s*\(/.test(t) && !/interest\s+income/i.test(t)) return "interest_expense";
  if (/depreciation/.test(t) && !/accum/i.test(t)) return "depreciation";
  if (/amortization/.test(t) && !/accum/i.test(t)) return "amortization";
  // Form line 20 "OTHER DEDUCTIONS" = Stmt 2 attachment total — not workbook opex residual.
  if (/other\s+operat.{0,6}exp|ober\s+desucon|ther\s+operat|0ther\s+operat/i.test(t)) {
    return "other_operating_expenses";
  }
  if (/\bother\b/i.test(t) && /\bexp/i.test(t) && !/other\s+income|operat.{0,6}income|other\s+deduct/i.test(t)) {
    return "other_operating_expenses";
  }
  if (/other\s+income/i.test(t) && !/operat/i.test(t)) {
    if (/subtraction|subtract|sch\.?\s*k|schedule\s*k|from federal/i.test(t)) return null;
    return "other_income";
  }
  if (/bank|credit\s+card/.test(t)) return "bank_credit_card";
  if (/professional|legal\s+and/.test(t)) return "professional_fees";
  if (/utilities|utilit/.test(t)) return "utilities";
  if (/employee\s+benefit/i.test(t)) return "employee_benefits";
  if (/gasoline|\bfuel\b/i.test(t) && !/biofuel|heating/i.test(t)) return "gasoline";
  if (/taxes\s+paid/.test(t) && !/net income|per books|per return|ordinary business/i.test(t)) return "taxes_paid";
  if (/\bcash\b/.test(t) && !/charit|contribut|flow|over\/short|chartable|method/i.test(t)) return "cash";
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
    const a = v[v.length - 3]!;
    const b = v[v.length - 2]!;
    const c = v[v.length - 1]!;
    // Drop trailing YoY change column when present (e.g. 3525, 857, -2668).
    const looksLikeChange =
      Math.abs(Math.abs(a - b) - Math.abs(c)) <= Math.max(2, Math.abs(c) * 0.03);
    // Legacy: middle equals sum of neighbors (OCR sometimes emits total mid-row).
    const looksLikeSum =
      Math.abs(Math.abs(b) - Math.abs(a) - Math.abs(c)) <= Math.max(2, Math.abs(c) * 0.03);
    // Trailing rollup total (year1 + year2 = total) — keep the two year columns.
    const looksLikeTrailingTotal =
      Math.abs(Math.abs(c) - Math.abs(a) - Math.abs(b)) <= Math.max(2, Math.abs(c) * 0.03);
    if (looksLikeChange || looksLikeSum || looksLikeTrailingTotal) {
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
  if ((id === "depreciation" || id === "amortization") && value >= 2020 && value <= 2030) return false;
  if ((id === "depreciation" || id === "amortization") && (value === 1986 || value === 1987)) return false;
  if (id === "accounts_receivable" && /balance at|beginning|ending|year/i.test(line)) return false;
  if ((id === "other_income" || id === "taxes_paid" || id === "depreciation" || id === "amortization") && Math.abs(value) < 100) return false;
  // Form 8990 / IRC §163(j) instruction crumbs — context only, no bare dollar floors.
  if (
    id === "interest_expense" &&
    /million|form\s*8990|see instructions|163\s*\(\s*j\s*\)|section\s*163|business\s+interest\s+(?:expense\s+)?limitation|irc\s*§?\s*163/i.test(
      line,
    )
  ) {
    return false;
  }
  if (
    id === "interest_expense" &&
    Math.abs(value) === 163 &&
    /(?:^|[^\d])163(?:[^\d]|$)|limitation|form\s*8990/i.test(line)
  ) {
    return false;
  }
  if (id === "other_operating_expenses" && Math.abs(value) > 5_000_000) return false;
  if (id === "other_income" && /subtraction|subtract|sch\.?\s*k|schedule\s*k|from federal/i.test(line)) return false;
  if (id === "notes_minus_short_term" && Math.abs(value) < 100) return false;
  // COGS/rent: no size floor — year/line-number/negative checks above are enough.
  if (
    (id === "rent" || id === "taxes_licenses" || id === "cogs" || id === "sales") &&
    value < 0
  ) {
    return false;
  }
  return true;
}

const PENDING_COMPARISON_LABELS = new Set([
  "rent",
  "advertising",
  "taxes_licenses",
  "utilities",
  "cogs",
  "depreciation",
  "bank_credit_card",
  "professional_fees",
  "interest_expense",
]);

export function parseTwoYearComparisonBlock(
  fullText: string,
  targetYear: number,
  opts?: { assumeHeaderYears?: [number, number] },
): {
  values: Record<string, number>;
  confidence: Record<string, number>;
  headerYears?: [number, number];
  columnUsed?: 0 | 1;
  linesMatched: number;
} | null {
  const startRe =
    /t\w{0,3}\s*y\s*ear\s*\w{0,6}\s*omparison|two\s*year\s*comparison|s\.?\s*,?\s*corp\w*[\s\S]{0,80}comparison|1120[-\s]?s.{0,40}worksheet|worksheet\s+page.{0,20}20\d{2}/gi;
  const starts: number[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = startRe.exec(fullText)) !== null) starts.push(sm.index);
  const grossIdx = fullText.search(/(?:\bg\s*)?ross\s+receipts?\s+or\s+sales/i);
  if (grossIdx >= 0) starts.push(Math.max(0, grossIdx - 300));
  if (!starts.length) return null;

  let best: ReturnType<typeof parseTwoYearComparisonAt> = null;
  for (const start of starts) {
    const parsed = parseTwoYearComparisonAt(fullText, targetYear, start, opts?.assumeHeaderYears);
    if (!parsed) continue;
    if (!best || parsed.linesMatched > best.linesMatched) best = parsed;
  }
  return best;
}

function parseTwoYearComparisonAt(
  fullText: string,
  targetYear: number,
  start: number,
  assumeHeaderYears?: [number, number],
): {
  values: Record<string, number>;
  confidence: Record<string, number>;
  headerYears?: [number, number];
  columnUsed?: 0 | 1;
  linesMatched: number;
} | null {
  const block = fullText.slice(start, start + 22000);
  const headerM =
    block.match(/\b(20\d{2})\s*[\&\-–]\s*(20\d{2})\b/) ??
    block.match(/\b(20\d{2})\s+and\s+(20\d{2})\b/);
  let col: 0 | 1 = 1;
  let yL = 0;
  let yR = 0;
  if (headerM) {
    yL = Number(headerM[1]);
    yR = Number(headerM[2]);
    col = pickComparisonColumnIndex(yL, yR, targetYear);
  } else if (assumeHeaderYears) {
    yL = assumeHeaderYears[0];
    yR = assumeHeaderYears[1];
    col = pickComparisonColumnIndex(yL, yR, targetYear);
  }

  const values: Record<string, number> = {};
  const confidence: Record<string, number> = {};
  let linesMatched = 0;

  let pendingSales = false;
  let pendingLabelId: string | null = null;
  let prevLine = "";
  const blockLines = block.split(/\r?\n/);

  const moneyFromLine = (line: string, id: string): number[] => {
    const matches = Array.from(line.matchAll(/\(?\$?\s*-?\d[\d,]*(?:\.\d{2})?\s*\)?/g));
    let nums: number[] = [];
    for (const m of matches) {
      const v = parseMoneyToken(m[0]);
      if (v !== null) nums.push(v);
    }
    if (id === "other_operating_expenses") {
      nums = nums.filter((n) => Math.abs(n) >= 1000);
    }
    return nums;
  };

  for (let li = 0; li < blockLines.length; li++) {
    const rawLine = blockLines[li]!;
    const line = stripEinNoise(rawLine.replace(/\s+/g, " ").trim());
    if (!line) continue;

    if (isGrossReceiptsLabel(line) && !/\d{1,3},\d{3}/.test(line)) {
      pendingSales = true;
      pendingLabelId = null;
      prevLine = line;
      continue;
    }

    let id = classifyComparisonLine(line);
    if (!id && pendingSales && /\d{1,3},\d{3}/.test(line)) {
      id = "sales";
      pendingSales = false;
    } else if (id) {
      pendingSales = false;
    }

    if (id && !moneyFromLine(line, id).length && !/\d{1,3},\d{3}/.test(line)) {
      pendingLabelId = PENDING_COMPARISON_LABELS.has(id) ? id : null;
      prevLine = line;
      continue;
    }

    if (!id && pendingLabelId && /\d{1,3},\d{3}/.test(line)) {
      if (
        /total\s+inc|net\s+inc|gross\s+profit|total\s+deduct|taxable\s+inc|ordinary\s+busin/i.test(
          line,
        )
      ) {
        pendingLabelId = null;
      } else {
        id = pendingLabelId;
        pendingLabelId = null;
      }
    }
    const context = `${prevLine} ${line}`;
    if (
      id === "other_income" &&
      /subtraction|subtract|sch\.?\s*k|schedule\s*k-1|k_1\s*totals|shareholder/i.test(context)
    ) {
      prevLine = line;
      continue;
    }
    if (id === "other_income" && /schedule\s*k-1\s+line|k-1\s+line\/item/i.test(context)) {
      prevLine = line;
      continue;
    }
    if (id === "interest_expense" && (!/interest/i.test(line) || /interest\s+income/i.test(line))) {
      prevLine = line;
      continue;
    }
    if (id === "cogs") {
      const pair = shrinkToYearColumns(
        Array.from(line.matchAll(/\(?\$?\s*-?\d[\d,]*(?:\.\d{2})?\s*\)?/g))
          .map((m) => parseMoneyToken(m[0]))
          .filter((n): n is number => n !== null),
      );
      if (pair && Math.abs(pair[0] - pair[1]) < 2 && Math.abs(pair[0]) < 500_000) {
        prevLine = line;
        continue;
      }
    }
    if (!id || !COMPARISON_VALUE_IDS.has(id)) {
      prevLine = line;
      continue;
    }

    const nums = moneyFromLine(line, id);
    // Payroll needs a real two-column worksheet row — skip single-token form-page bleed.
    if ((id === "salaries_wages" || id === "officer_compensation") && nums.length < 2) {
      prevLine = line;
      continue;
    }
    const pair = shrinkToYearColumns(nums);
    if (!pair) {
      prevLine = line;
      continue;
    }

    let picked = col === 0 ? pair[0] : pair[1];
    if (
      picked < 0 &&
      (id === "rent" || id === "taxes_licenses" || id === "cogs" || id === "sales")
    ) {
      const positive = nums.filter((n) => n > 1000);
      if (!positive.length) {
        prevLine = line;
        continue;
      }
      picked = col === 0 ? positive[0]! : positive[positive.length - 1]!;
    }
    if (
      id === "taxes_licenses" &&
      nums.some((n) => Math.abs(n) >= 50_000) &&
      Math.abs(picked) < 10_000
    ) {
      prevLine = line;
      continue;
    }
    if (!Number.isFinite(picked)) {
      prevLine = line;
      continue;
    }
    if (!isStructurallyValid(id, picked, line, headerM || assumeHeaderYears ? [yL, yR] : undefined)) {
      prevLine = line;
      continue;
    }
    if (values[id] !== undefined) {
      const prev = values[id]!;
      if (
        (id === "taxes_licenses" || id === "rent") &&
        Math.abs(prev) < 10_000 &&
        Math.abs(picked) >= 10_000
      ) {
        // Replace garbled first match with a stronger later row
      } else if (
        (id === "salaries_wages" || id === "officer_compensation") &&
        nums.length >= 2 &&
        Math.abs(prev) >= 2 * Math.min(Math.abs(pair[0]), Math.abs(pair[1]))
      ) {
        // Replace single-column form rollup with worksheet year columns
      } else {
        prevLine = line;
        continue;
      }
    }

    values[id] = Math.round(picked);
    confidence[id] = 86;
    linesMatched += 1;
    prevLine = line;
  }

  if (linesMatched < 3) return null;

  return {
    values,
    confidence,
    headerYears: headerM || assumeHeaderYears ? [yL, yR] : undefined,
    columnUsed: col,
    linesMatched,
  };
}
