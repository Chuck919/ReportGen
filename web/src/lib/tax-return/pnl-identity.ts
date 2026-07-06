/**
 * P&L identity from Form 1120 / 1120-S page 1.
 *
 * Tax returns expose Gross profit (line 3) and Ordinary business income (line 21/22).
 * Workbook formulas:
 *   GP = sales − COGS
 *   overhead = Σ top-8 opex slots
 *   NPBT = GP − DA + OOI − overhead − other_opex − interest + other_income − other_expenses
 *
 * When top-8 is strong, reverse-solve other_opex from form ordinary income.
 */
import type { ResolvedFields } from "./merge";
import {
  formLineAmount,
  isForm1120Line,
  lineMoneyTokens,
  lineTailAmount,
  scheduleLineAmount,
  substantialMoneyTokens,
} from "./money";
import { computeWorkbookFormulas } from "@/lib/tax/workbook-formulas";
import {
  pickComparisonColumnIndex,
  shrinkToYearColumns,
} from "@/lib/two-year-comparison-parser";

const TOP8_IDS = [
  "officer_compensation",
  "salaries_wages",
  "advertising",
  "rent",
  "taxes_licenses",
  "bank_credit_card",
  "professional_fees",
  "utilities",
] as const;

function n(values: Record<string, number | undefined>, id: string): number {
  const v = values[id];
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
}

/** Percentage-based money match (no fixed dollar floors). */
export function pnlAmountsClose(a: number, b: number, pct = 0.005): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= Math.max(1, scale * pct);
}

function parseComparisonHeaderYears(text: string): { yL: number; yR: number } | undefined {
  const headerM = text.match(/\b(20\d{2})\s*[\&\-–]\s*(20\d{2})\b/);
  if (!headerM) return undefined;
  return { yL: Number(headerM[1]), yR: Number(headerM[2]) };
}

/** Year pair from any comparison worksheet header in the full OCR bundle. */
function findDocumentComparisonYears(text: string): { yL: number; yR: number } | undefined {
  const matches = [...text.matchAll(/\b(20\d{2})\s*[\&\-–]\s*(20\d{2})\b/g)];
  if (!matches.length) return undefined;
  const last = matches[matches.length - 1]!;
  return { yL: Number(last[1]), yR: Number(last[2]) };
}

function lineMoneyAmounts(line: string): number[] {
  const tokens: number[] = [];
  for (const m of Array.from(line.matchAll(/\(?\$?\s*-?\d[\d,]*(?:\.\d{2})?\s*\)?/g))) {
    const raw = m[0].replace(/[$,]/g, "").trim();
    let s = raw;
    let sign = 1;
    if (s.startsWith("(") && s.endsWith(")")) {
      sign = -1;
      s = s.slice(1, -1);
    }
    const n = Number(s);
    if (Number.isFinite(n)) tokens.push(Math.round(sign * n));
  }
  return tokens;
}

function isComparisonContext(text: string, line: string): boolean {
  const idx = text.indexOf(line);
  const window = text.slice(Math.max(0, idx - 600), idx + line.length + 200);
  return /two\s*year\s*comparison|comparison\s+worksheet/i.test(window);
}

function pickComparisonYearAmount(
  line: string,
  text: string,
  targetYear: number,
): number | undefined {
  const nums = lineMoneyAmounts(line).filter((n) => n < 2020 || n > 2035);
  const pair = shrinkToYearColumns(nums);
  if (!pair) return undefined;
  const localWindow = text.slice(
    Math.max(0, text.indexOf(line) - 600),
    text.indexOf(line) + line.length + 200,
  );
  const years =
    parseComparisonHeaderYears(localWindow) ?? findDocumentComparisonYears(text);
  if (!years) return Math.round(Math.abs(pair[1]!));
  const col = pickComparisonColumnIndex(years.yL, years.yR, targetYear);
  return Math.round(Math.abs(col === 0 ? pair[0]! : pair[1]!));
}

function pickEndColumnAmount(line: string, text?: string, targetYear?: number): number | undefined {
  if (text && targetYear !== undefined) {
    const nums = lineMoneyAmounts(line).filter((n) => n < 2020 || n > 2035);
    if (nums.length >= 2) {
      const fromCols = pickComparisonYearAmount(line, text, targetYear);
      if (fromCols !== undefined) return fromCols;
    }
    if (isComparisonContext(text, line)) {
      const pair = shrinkToYearColumns(nums);
      if (pair) return Math.round(Math.abs(pair[1]!));
    }
  }

  const bracket = line.match(/\[\s*(?:3|21|22)\s*\][^\d\-]*([\d,.\s]+)/i);
  if (bracket?.[1]) {
    const tokens = lineMoneyTokens(bracket[1]);
    if (tokens.length) return Math.round(Math.abs(tokens[tokens.length - 1]!));
  }
  const pipeParts = line.split("|");
  if (pipeParts.length >= 2) {
    const endTokens = lineMoneyTokens(pipeParts[pipeParts.length - 1]!);
    if (endTokens.length) return Math.round(Math.abs(endTokens[endTokens.length - 1]!));
  }
  const tagged =
    formLineAmount(line, "3") ??
    formLineAmount(line, "21") ??
    formLineAmount(line, "22") ??
    scheduleLineAmount(line) ??
    lineTailAmount(line);
  if (tagged !== undefined) return Math.round(Math.abs(tagged));
  const tokens = substantialMoneyTokens(line);
  if (tokens.length) return Math.round(Math.abs(tokens[tokens.length - 1]!));
  const all = lineMoneyTokens(line);
  if (all.length) return Math.round(Math.abs(all[all.length - 1]!));
  return undefined;
}

/** Form 1120-S line 3 / 1120 line 3 — Gross profit. */
export function scanFormGrossProfit(text: string, targetYear?: number): number | undefined {
  const hits: number[] = [];
  for (const raw of text.split(/\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!/gross\s+profit/i.test(line)) continue;
    if (/percentage|gross\s+profit\s*%/i.test(line)) continue;
    if (/two\s*year\s*comparison|comparison\s+worksheet/i.test(line)) continue;
    const hasLine3 = isForm1120Line(line, 3) || /\[\s*3\s*\]/.test(line) || /^\s*3\b/.test(line);
    if (!hasLine3 && !/gross\s+profit\s+subtract/i.test(line)) continue;
    const amt = pickEndColumnAmount(line, text, targetYear);
    if (amt === undefined || amt <= 0) continue;
    // Gross profit is a material P&L total — reject tiny OCR crumbs via sales-relative check later.
    hits.push(amt);
  }
  if (!hits.length) return undefined;
  // Prefer the most common end-year amount (mode), else median-ish last.
  const counts = new Map<number, number>();
  for (const h of hits) counts.set(h, (counts.get(h) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0];
}

type OrdinaryIncomeHit = { amount: number; weight: number };

function scoreOrdinaryIncomeLine(line: string): number {
  let w = 1;
  if (/ordinary\s+business\s+income/i.test(line)) w += 4;
  else if (/^ordinary\s+income/i.test(line)) w -= 2;
  if (/total\s+deductions/i.test(line)) w += 2;
  if (/schedule\s+k/i.test(line) && !/ordinary\s+business\s+income/i.test(line)) w -= 3;
  if (/section\s+199a/i.test(line)) w += 1;
  if (/reconcil|schedule\s+m/i.test(line)) w -= 2;
  if (/\b1\s+ordinary\s+business/i.test(line)) w -= 1;
  return w;
}

/** Form 1120-S line 22 / 1120 line 30 — Ordinary business income (loss). */
export function scanFormOrdinaryBusinessIncome(text: string, targetYear?: number): number | undefined {
  const weighted: OrdinaryIncomeHit[] = [];
  for (const raw of text.split(/\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!/ordinary\s+(?:business\s+)?income/i.test(line)) continue;
    if (/net\s+rental|per\s+books|from\s+page\s+1/i.test(line) && !/subtract\s+line/i.test(line)) {
      continue;
    }
    if (/two\s*year\s*comparison|comparison\s+worksheet/i.test(line)) continue;
    const hasLine =
      isForm1120Line(line, 22) ||
      isForm1120Line(line, 21) ||
      isForm1120Line(line, 30) ||
      /\[\s*(?:21|22|30)\s*\]/.test(line) ||
      /subtract\s+line\s*21/i.test(line);
    if (!hasLine && !/^ordinary\s+(?:business\s+)?income/i.test(line)) continue;
    const amt = pickEndColumnAmount(line, text, targetYear);
    if (amt === undefined || amt <= 0) continue;
    if (!/business/i.test(line) && amt < 10_000) continue;
    const w = scoreOrdinaryIncomeLine(line);
    if (w <= 0) continue;
    weighted.push({ amount: amt, weight: w });
  }
  if (!weighted.length) return undefined;
  const totals = new Map<number, number>();
  for (const h of weighted) totals.set(h.amount, (totals.get(h.amount) ?? 0) + h.weight);
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const top = ranked[0]![0];
  const runner = ranked[1]?.[0];
  if (runner !== undefined && top < runner * 0.2) return runner;
  return top;
}

export function countFilledTop8(values: Record<string, number | undefined>): number {
  return TOP8_IDS.filter((id) => values[id] !== undefined).length;
}

/**
 * other_opex = GP − DA + OOI − overhead − interest + other_income − other_expenses − ordinary_income
 * Ordinary income is Form page-1 ordinary business income (maps to workbook NPBT when taxes/extras are 0).
 * Uses the same inputs workbook formulas use so NPBT/NI match the form.
 */
export function deriveOtherOpexFromOrdinaryIncome(
  values: Record<string, number | undefined>,
  ordinaryIncome: number,
  _sources?: Record<string, string | undefined>,
): number | undefined {
  if (values.sales === undefined || values.cogs === undefined) return undefined;
  if (countFilledTop8(values) < 4) return undefined;

  const gp = Math.round(n(values, "sales") - n(values, "cogs"));
  const da = Math.round(n(values, "depreciation") + n(values, "amortization"));
  const overhead = TOP8_IDS.reduce((s, id) => s + n(values, id), 0);
  const ooi = n(values, "other_operating_income");
  const interest = n(values, "interest_expense");
  const otherIncome = n(values, "other_income");
  const otherExpenses = n(values, "other_expenses");
  // Same dollar amount sometimes lands in both income buckets — count once.
  let incomeAdd = ooi + otherIncome;
  if (ooi > 0 && otherIncome > 0 && pnlAmountsClose(ooi, otherIncome)) {
    incomeAdd = otherIncome;
  }

  const opex = Math.round(gp - da + incomeAdd - overhead - interest - otherExpenses - ordinaryIncome);
  if (!Number.isFinite(opex)) return undefined;
  // Other opex can be zero; negative usually means inputs disagree — reject.
  if (opex < 0) return undefined;
  const sales = values.sales;
  if (sales !== undefined && sales > 0 && opex > sales) return undefined;
  return opex;
}

/** Implied NPBT with a candidate other_opex (same formula engine as the workbook). */
export function impliedNetProfitBeforeTaxes(
  values: Record<string, number | undefined>,
  otherOpex: number,
  _sources?: Record<string, string | undefined>,
): number | undefined {
  if (values.sales === undefined || values.cogs === undefined) return undefined;
  if (countFilledTop8(values) < 4) return undefined;
  const trial = { ...values, other_operating_expenses: otherOpex };
  const formulas = computeWorkbookFormulas(trial);
  return formulas.net_profit_before_taxes;
}

export function candidateClosesOrdinaryIncome(
  values: Record<string, number | undefined>,
  otherOpex: number,
  ordinaryIncome: number,
  sources?: Record<string, string | undefined>,
): boolean {
  const npbt = impliedNetProfitBeforeTaxes(values, otherOpex, sources);
  if (npbt === undefined) return false;
  return pnlAmountsClose(npbt, ordinaryIncome);
}

/**
 * Prefer reverse-math other_opex when top-8 is strong and form ordinary income is present.
 * Returns true if the field was set/replaced.
 */
export function applyOrdinaryIncomeReverseOpex(
  resolved: ResolvedFields,
  allText: string,
  targetYear?: number,
): { ordinaryIncome?: number; grossProfit?: number; applied: boolean } {
  const ordinaryIncome = scanFormOrdinaryBusinessIncome(allText, targetYear);
  const grossProfit = scanFormGrossProfit(allText, targetYear);
  const sources = resolved.sources;
  const derived =
    ordinaryIncome !== undefined
      ? deriveOtherOpexFromOrdinaryIncome(resolved.values, ordinaryIncome, sources)
      : undefined;

  if (derived === undefined || ordinaryIncome === undefined) {
    return { ordinaryIncome, grossProfit, applied: false };
  }

  const cur = resolved.values.other_operating_expenses;
  if (cur !== undefined && pnlAmountsClose(cur, derived)) {
    return { ordinaryIncome, grossProfit, applied: false };
  }

  const sales = resolved.values.sales ?? 0;
  if (
    cur !== undefined &&
    cur > 0 &&
    derived > cur * 1.25 &&
    !pnlAmountsClose(cur, derived) &&
    (sales === 0 || derived > sales * 0.12 || cur < sales * 0.02)
  ) {
    return { ordinaryIncome, grossProfit, applied: false };
  }

  // Only override when reverse math closes identity and top-8 coverage is solid.
  if (countFilledTop8(resolved.values) < 6) {
    return { ordinaryIncome, grossProfit, applied: false };
  }
  if (!candidateClosesOrdinaryIncome(resolved.values, derived, ordinaryIncome, sources)) {
    return { ordinaryIncome, grossProfit, applied: false };
  }

  if (
    cur !== undefined &&
    cur > 0 &&
    /statement|stmt\s*2|summed detail|attachment/i.test(sources?.other_operating_expenses ?? "") &&
    derived > cur * 1.5 &&
    !pnlAmountsClose(cur, derived)
  ) {
    return { ordinaryIncome, grossProfit, applied: false };
  }

  resolved.values.other_operating_expenses = derived;
  resolved.confidence.other_operating_expenses = 96;
  resolved.sources.other_operating_expenses =
    "P&L reverse math (Form ordinary income − top-8 − known lines)";
  resolved.warnings.push(
    `Other opex ${derived} from Form ordinary income ${ordinaryIncome} (top-8 reverse math)`,
  );
  return { ordinaryIncome, grossProfit, applied: true };
}

/** Flag workbook inputs when computed formulas disagree with Form page-1 anchors. */
export function flagPnlIdentityMismatches(
  resolved: ResolvedFields,
  allText: string,
  targetYear?: number,
): void {
  const ordinaryIncome = scanFormOrdinaryBusinessIncome(allText, targetYear);
  const formGp = scanFormGrossProfit(allText, targetYear);
  const formulas = computeWorkbookFormulas(resolved.values);

  if (
    formGp !== undefined &&
    formulas.gross_profit !== undefined &&
    !pnlAmountsClose(formGp, formulas.gross_profit)
  ) {
    const msg = `Gross profit mismatch: form ${formGp.toLocaleString()} vs sales−COGS ${formulas.gross_profit.toLocaleString()}`;
    for (const id of ["sales", "cogs"] as const) {
      if (resolved.values[id] !== undefined) {
        resolved.warnings.push(msg);
      }
    }
  }

  if (ordinaryIncome === undefined) return;

  const npbt = formulas.net_profit_before_taxes;
  const ni = formulas.net_income;
  if (npbt !== undefined && !pnlAmountsClose(npbt, ordinaryIncome)) {
    const gap = npbt - ordinaryIncome;
    const msg = `P&L does not close to Form ordinary income (workbook NPBT ${npbt.toLocaleString()} vs form ${ordinaryIncome.toLocaleString()}, gap ${gap.toLocaleString()})`;
    resolved.warnings.push(msg);
    if (resolved.values.other_operating_expenses !== undefined) {
      resolved.warnings.push(`other_operating_expenses may be wrong (gap ${gap.toLocaleString()})`);
    }
  } else if (ni !== undefined && !pnlAmountsClose(ni, ordinaryIncome)) {
    // When taxes/extras are zero, net income should also match ordinary income.
    const taxes = resolved.values.taxes_paid ?? 0;
    const extras =
      (resolved.values.extraordinary_gain ?? 0) -
      (resolved.values.extraordinary_loss ?? 0) +
      (resolved.values.adjusted_owner_compensation ?? 0);
    if (taxes === 0 && extras === 0) {
      resolved.warnings.push(
        `Net income ${ni.toLocaleString()} ≠ Form ordinary income ${ordinaryIncome.toLocaleString()}`,
      );
    }
  }
}
