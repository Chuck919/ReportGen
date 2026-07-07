import type { ResolvedFields } from "./merge";
import { lineMoneyTokens } from "./money";
import { pickComparisonColumnIndex, shrinkToYearColumns } from "@/lib/two-year-comparison-parser";
import { scanComparisonOtherDeductionsTotal, computeComparisonOpexResidual } from "./comparison-opex";
import { extractOtherDeductionsBlockOpex, extractStatementDeductions, blockStmtTotalCorroborated, scanStatement2Total, extractStatementTaxesSplit, isComparisonWorksheetContext } from "./statement-extractors";
import { lineMatchesLabelPattern, repairOcrLabel } from "./ocr-label-repair";
import { knownStmt2AttachmentSum } from "./stmt2-total-inference";
import { closureTolerance } from "./structural-tolerance";
import { scanFormPageRent } from "./form-anchors";
import { detectTaxForm } from "./detect-tax-form";

type RowRule = {
  id: string;
  labelRe: RegExp;
  minAmount: number;
};

const COMPARISON_ROW_RULES: RowRule[] = [
  { id: "officer_compensation", labelRe: /OFFICER|COMPENSATION\s+OF\s+OFFICER/i, minAmount: 1000 },
  {
    id: "salaries_wages",
    labelRe: /SALAR.*WAGE|WAGES?\s+LESS|EMPLOYMENT\s+CREDIT/i,
    minAmount: 5000,
  },
  { id: "utilities", labelRe: /UTILIT|UTILITY|ELECTRIC/i, minAmount: 500 },
  { id: "bank_credit_card", labelRe: /BANK|CREDIT\s+CARD|MERCHANT/i, minAmount: 500 },
  { id: "professional_fees", labelRe: /PROFESSIONAL|LEGAL\s+AND|ACCOUNTING/i, minAmount: 500 },
  { id: "repairs", labelRe: /REPAIR|MAINT/i, minAmount: 500 },
  { id: "insurance", labelRe: /^INSURANCE\b/i, minAmount: 500 },
  { id: "advertising", labelRe: /ADVERT/i, minAmount: 100 },
  { id: "taxes_paid", labelRe: /TAXES\s+PAID|STATE\s+INCOME\s+TAX/i, minAmount: 1000 },
  { id: "rent", labelRe: /\bRENTS?\b/i, minAmount: 10_000 },
  { id: "taxes_licenses", labelRe: /TAXES\s+AND\s+LIC/i, minAmount: 1000 },
  { id: "employee_benefits", labelRe: /EMPLOYEE\s+BENEFIT/i, minAmount: 1000 },
  { id: "other_operating_income", labelRe: /OTHER\s+OPERATING\s+INCOME|OTHER\s+INCOME/i, minAmount: 100 },
  { id: "cogs", labelRe: /COST\s+OF\s+(?:GOODS|SALES)|COGS|\bC\.?\s*O\.?\s*G/i, minAmount: 10_000 },
  { id: "depreciation", labelRe: /DEPRECIATION/i, minAmount: 100 },
];

const STMT2_UTIL =
  /utilities|utility\s+expense|electric/i;

function findComparisonBlock(allText: string): { text: string; start: number } | undefined {
  const start =
    allText.search(
      /t\w{0,3}\s*y\s*ear\s*\w{0,6}\s*omparison|two\s*year\s*comparison|(?:\bg\s*|ross\s+)receipts?\s+or\s+sales|ross\s+receipts?\s+or\s+sales/i,
    ) ?? -1;
  if (start < 0) return undefined;
  return { text: allText.slice(start, start + 80_000), start };
}

function headerYearsInBlock(block: string, allText?: string, blockStart?: number): [number, number] | undefined {
  const windows: string[] = [block.slice(0, 800)];
  if (allText !== undefined && blockStart !== undefined) {
    windows.push(allText.slice(Math.max(0, blockStart - 600), blockStart + 400));
  }
  for (const w of windows) {
    const m =
      w.match(/\b(20\d{2})\s*[\&\-–]\s*(20\d{2})\b/) ??
      w.match(/\b(20\d{2})\s+and\s+(20\d{2})\b/i) ??
      w.match(/\b(20\d{2})\b[^\d]{0,40}\b(20\d{2})\b/);
    if (m) return [Number(m[1]), Number(m[2])];
  }
  return undefined;
}

function pickColumn(nums: number[], targetYear: number, years?: [number, number]): number | undefined {
  const filtered = nums.filter((n) => Math.abs(n) >= 100);
  if (!filtered.length) return undefined;
  const pair = shrinkToYearColumns(filtered);
  if (!pair) return filtered.length >= 2 ? filtered[1] : filtered[0];
  if (!years) return pair[1];
  const col = pickComparisonColumnIndex(years[0], years[1], targetYear);
  return col === 0 ? pair[0] : pair[1];
}

/** Max utilities amount from Stmt 2 detail block (comparison worksheet often omits utilities). */
function scanStmt2UtilitiesMax(allText: string): number | undefined {
  let inStmt2 = false;
  let best: number | undefined;
  const considerLine = (line: string) => {
    if (!STMT2_UTIL.test(line)) return;
    for (const n of lineMoneyTokens(line)) {
      const abs = Math.round(Math.abs(n));
      if (abs < 500 || abs > 500_000) continue;
      if (best === undefined || abs > best) best = abs;
    }
  };
  for (const rawLine of allText.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;
    if (/statement\s*2|stmt\s*2|line\s*(?:19|20)\b.*other\s+deductions|other\s+deduct/i.test(line)) {
      inStmt2 = true;
      best = undefined;
      continue;
    }
    if (/statement\s*[3-9]|stmt\s*[3-9]/i.test(line)) inStmt2 = false;
    if (inStmt2) considerLine(line);
  }
  if (best !== undefined) return best;
  for (const rawLine of allText.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line || !STMT2_UTIL.test(line)) continue;
    if (!/other\s+deduct|federal\s+statements|description\s+amount/i.test(line)) continue;
    considerLine(line);
  }
  return best;
}

/** Max rent amount from Stmt 2 / Federal Statements detail (comparison often double-counts). */
function scanStmt2RentMax(allText: string, formKind?: import("./detect-tax-form").TaxFormKind): number | undefined {
  const formRent = scanFormPageRent(allText, formKind);
  let inStmt2 = false;
  const candidates: number[] = [];
  const considerLine = (line: string) => {
    if (/gross\s+rent|rental\s+real\s+estate|net\s+rental|total\s+inc|gross\s+profit/i.test(line)) return;
    if (!/\brents?\b/i.test(line)) return;
    for (const n of lineMoneyTokens(line)) {
      const abs = Math.round(Math.abs(n));
      if (abs < 10_000 || abs > 5_000_000) continue;
      candidates.push(abs);
    }
  };
  for (const rawLine of allText.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;
    if (/statement\s*2|stmt\s*2|federal\s+statements|line\s*(?:19|20|26)\b.*other\s+deduct/i.test(line)) {
      inStmt2 = true;
      continue;
    }
    if (/statement\s*[3-9]|stmt\s*[3-9]/i.test(line) && !/other\s+deduct/i.test(line)) inStmt2 = false;
    if (inStmt2) considerLine(line);
  }
  if (!candidates.length) {
    for (const rawLine of allText.split(/\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (!line || !/\brents?\b/i.test(line) || /gross\s+rent/i.test(line)) continue;
      if (!/other\s+deduct|federal\s+statements|description\s+amount/i.test(line)) continue;
      considerLine(line);
    }
  }
  if (formRent !== undefined) {
    const near = candidates.find((c) => Math.abs(c - formRent) <= Math.max(5000, formRent * 0.05));
    if (near !== undefined) return near;
    return formRent;
  }
  if (!candidates.length) return undefined;
  candidates.sort((a, b) => a - b);
  return candidates[Math.floor(candidates.length / 2)];
}

/** Refill attachment / P&L lines from labeled two-year comparison rows. */
export function refillFromComparisonLabeledRows(
  allText: string,
  resolved: ResolvedFields,
  targetYear?: number,
): void {
  const blockInfo = findComparisonBlock(allText);
  if (targetYear === undefined) return;
  const block = blockInfo?.text;
  const years = block ? headerYearsInBlock(block, allText, blockInfo?.start) : undefined;

  const stmt2Util = scanStmt2UtilitiesMax(allText);
  if (stmt2Util !== undefined) {
    const cur = resolved.values.utilities;
    if (cur === undefined || Math.abs(cur) < stmt2Util * 0.85) {
      resolved.values.utilities = stmt2Util;
      resolved.confidence.utilities = 93;
      resolved.sources.utilities = "Statement 2 (utilities detail max)";
    }
  }

  const stmt2Rent = scanStmt2RentMax(allText, detectTaxForm(allText).kind);
  const formRent = scanFormPageRent(allText);
  const authoritativeRent = formRent ?? stmt2Rent;
  if (authoritativeRent !== undefined) {
    const cur = resolved.values.rent;
    if (cur === undefined || Math.abs(cur) < authoritativeRent * 0.85 || Math.abs(cur) > authoritativeRent * 1.05) {
      resolved.values.rent = authoritativeRent;
      resolved.confidence.rent = formRent !== undefined ? 96 : 93;
      resolved.sources.rent =
        formRent !== undefined ? "Form page 1 (rents line)" : "Statement 2 (rent detail max)";
    }
  }

  if (!block) return;

  for (const rawLine of block.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line || !/\d/.test(line)) continue;

    for (const rule of COMPARISON_ROW_RULES) {
      const labelLine = repairOcrLabel(line);
      if (!lineMatchesLabelPattern(line, rule.labelRe) && !rule.labelRe.test(labelLine)) continue;
      if (rule.id === "other_operating_income" && /other\s+income/i.test(line) && !/operat/i.test(line)) {
        const lineIdx = allText.indexOf(line);
        const yearWindow = allText.slice(Math.max(0, lineIdx - 4000), lineIdx + line.length + 400);
        if (targetYear !== undefined && !new RegExp(`\\b${targetYear}\\b`).test(yearWindow)) continue;
        const nums = lineMoneyTokens(line).filter((n) => Math.abs(n) >= 100 && Math.abs(n) < 50_000);
        const picked = pickColumn(nums, targetYear, years);
        if (picked !== undefined && picked > 0) {
          resolved.values.other_operating_income = Math.round(picked);
          resolved.confidence.other_operating_income = 88;
          resolved.sources.other_operating_income = "Two-year comparison (OTHER INCOME → other operating income)";
        }
        continue;
      }
      const nums = lineMoneyTokens(line).filter((n) => Math.abs(n) >= rule.minAmount);
      const picked = pickColumn(nums, targetYear, years);
      if (picked === undefined) continue;

      const cur = resolved.values[rule.id];
      const src = resolved.sources[rule.id] ?? "";
      if (
        rule.id === "utilities" &&
        cur !== undefined &&
        /statement\s*2/i.test(src) &&
        Math.abs(cur) >= Math.abs(picked) * 0.95
      ) {
        continue;
      }
      if (
        rule.id === "utilities" &&
        stmt2Util !== undefined &&
        Math.abs(picked) > Math.abs(stmt2Util) * 1.5
      ) {
        continue;
      }
      if (
        rule.id === "rent" &&
        cur !== undefined &&
        /statement\s*2|federal\s+statements|form\s+1120/i.test(src) &&
        Math.abs(picked) > Math.abs(cur) * 1.05
      ) {
        continue;
      }
      const weak = !src || /OCR label|fuzzy|label match|embedded detail|tail scan/i.test(src);
      const bigDiff =
        cur !== undefined &&
        Math.abs(cur - picked) / Math.max(Math.abs(picked), 1) > 0.15;

      const replace =
        cur === undefined ||
        weak ||
        (bigDiff && (rule.id === "utilities" || rule.id === "taxes_licenses" || rule.id === "cogs" || rule.id === "rent")) ||
        (rule.id === "utilities" && cur !== undefined && Math.abs(cur) < Math.abs(picked) * 0.5) ||
        (rule.id === "rent" &&
          cur !== undefined &&
          picked >= 50_000 &&
          Math.abs(cur) < Math.abs(picked) * 0.6 &&
          !/statement\s*2|federal\s+statements/i.test(src)) ||
        (rule.id === "taxes_licenses" &&
          cur !== undefined &&
          picked >= 10_000 &&
          Math.abs(cur) < Math.abs(picked) * 0.75);

      if (!replace) continue;
      resolved.values[rule.id] = Math.round(picked);
      resolved.confidence[rule.id] = 90;
      resolved.sources[rule.id] = `Two-year comparison (${rule.id} row)`;
    }
  }

  const compTaxes = resolved.values.taxes_licenses;
  let paid = resolved.values.taxes_paid;
  if (paid === undefined || paid <= 0) {
    paid = extractStatementTaxesSplit(allText).values.taxes_paid;
  }
  const compBlock = findComparisonBlock(allText);
  if ((paid === undefined || paid <= 0) && compBlock) {
    for (const rawLine of compBlock.text.split(/\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (!/TAXES\s+PAID|STATE\s+INCOME\s+TAX/i.test(line)) continue;
      const nums = lineMoneyTokens(line).filter((n) => Math.abs(n) >= 1000);
      const picked = pickColumn(nums, targetYear, years);
      if (picked !== undefined && picked > 0) {
        paid = Math.round(picked);
        break;
      }
    }
  }
  if (
    compTaxes !== undefined &&
    compTaxes >= 50_000 &&
    paid !== undefined &&
    paid > 0 &&
    paid < compTaxes * 0.6
  ) {
    const split = Math.round(compTaxes - paid);
    if (split >= 10_000) {
      resolved.values.taxes_licenses = split;
      resolved.confidence.taxes_licenses = 91;
      resolved.sources.taxes_licenses = "Two-year comparison (taxes minus taxes paid)";
    }
  }

  const attachmentSum = knownStmt2AttachmentSum(resolved, allText);
  const stmt2Total = scanComparisonOtherDeductionsTotal(allText, targetYear);
  const blockOpex = extractOtherDeductionsBlockOpex(allText);
  const opexResidual = computeComparisonOpexResidual(
    allText,
    targetYear,
    attachmentSum,
    {
      attachmentSum,
      stmt2Total,
    },
    resolved,
    undefined,
  );

  const cur = resolved.values.other_operating_expenses;
  const curSource = resolved.sources.other_operating_expenses ?? "";
  const curIsOfficeDetail = /office\/supplies|telephone\/travel\/bank detail/i.test(curSource);
  const curIsAuthoritativeDetail =
    /summed detail|misc detail closes|office\/supplies|telephone\/travel\/bank detail|total minus util/i.test(
      curSource,
    );

  const blockOfficeDetail =
    blockOpex.opex !== undefined &&
    blockOpex.stmtTotal !== undefined &&
    /office\/supplies|telephone\/travel\/bank detail/i.test(blockOpex.source) &&
    blockStmtTotalCorroborated(blockOpex.stmtTotal, [
      stmt2Total,
      scanStatement2Total(allText),
      scanComparisonOtherDeductionsTotal(allText, targetYear),
    ])
      ? blockOpex
      : undefined;

  if (blockOfficeDetail && !curIsOfficeDetail) {
    const blockExcluded = blockOfficeDetail.stmtTotal! - blockOfficeDetail.opex!;
    const blockCloses =
      Math.abs(blockExcluded + blockOfficeDetail.opex! - blockOfficeDetail.stmtTotal!) <=
      closureTolerance(blockOfficeDetail.stmtTotal!);
    if (
      blockCloses &&
      (cur === undefined ||
        Math.abs(cur - blockOfficeDetail.opex!) / Math.max(blockOfficeDetail.opex!, 1) > 0.12)
    ) {
      resolved.values.other_operating_expenses = blockOfficeDetail.opex!;
      resolved.confidence.other_operating_expenses = blockOfficeDetail.confidence;
      resolved.sources.other_operating_expenses = blockOfficeDetail.source;
    }
  }
  // other_operating_expenses comparison residual left to reconcileOtherOperatingExpenses ranking.
}

const COMPARISON_LEDGER_LABELS: Record<string, string> = {
  officer_compensation: "Officer compensation",
  salaries_wages: "Salaries and wages",
  repairs: "Repairs and maintenance",
  insurance: "Insurance",
  utilities: "Utilities",
  bank_credit_card: "Bank and credit card",
  professional_fees: "Professional fees",
  employee_benefits: "Employee benefit programs",
  advertising: "Advertising",
  taxes_licenses: "Taxes and Licenses",
};

const COMPARISON_LEDGER_IDS = new Set(Object.keys(COMPARISON_LEDGER_LABELS));

/** Comparison-worksheet expense rows for top-8 ledger (repairs, insurance, utilities, etc.). */
export function extractComparisonExpenseLines(
  allText: string,
  targetYear: number,
): Array<{ label: string; amount: number; source: string }> {
  const blockInfo = findComparisonBlock(allText);
  if (!blockInfo) return [];
  const years = headerYearsInBlock(blockInfo.text, allText, blockInfo.start);
  const out: Array<{ label: string; amount: number; source: string }> = [];
  const rawLines = blockInfo.text.split(/\n/);

  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i]!.replace(/\s+/g, " ").trim();
    if (!line) continue;
    if (!/\d/.test(line) && i + 1 < rawLines.length) {
      const next = rawLines[i + 1]!.replace(/\s+/g, " ").trim();
      if (/\d/.test(next) && /salar|wage|officer|repair|insur|advert|rent|tax|utilit|bank|profession|benefit|supply/i.test(`${line} ${next}`)) {
        line = `${line} ${next}`;
        i += 1;
      }
    }
    if (!/\d/.test(line)) continue;
    pushComparisonLine(line, years, targetYear, out);
  }

  // Fallback: comparison rows OCR'd outside the primary block window.
  for (const rawLine of allText.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line || !/\d/.test(line)) continue;
    const lineIdx = allText.indexOf(rawLine);
    const recentContext =
      lineIdx >= 0
        ? allText.slice(Math.max(0, lineIdx - 1200), lineIdx + rawLine.length).replace(/\s+/g, " ")
        : "";
    if (!isComparisonExpenseRowContext(recentContext)) continue;
    pushComparisonLine(line, years, targetYear, out);
  }

  return dedupeComparisonLines(out);
}

function isComparisonExpenseRowContext(ctx: string): boolean {
  return (
    isComparisonWorksheetContext(ctx) ||
    /prior\s+year\s+current\s+year|gross\s+receipts|deductions\s*:/i.test(ctx)
  );
}

function pushComparisonLine(
  line: string,
  years: [number, number] | undefined,
  targetYear: number,
  out: Array<{ label: string; amount: number; source: string }>,
): void {
  for (const rule of COMPARISON_ROW_RULES) {
    if (!COMPARISON_LEDGER_IDS.has(rule.id)) continue;
    const labelLine = repairOcrLabel(line);
    if (!lineMatchesLabelPattern(line, rule.labelRe) && !rule.labelRe.test(labelLine)) continue;
    const nums = lineMoneyTokens(line).filter((n) => Math.abs(n) >= rule.minAmount);
    const picked = pickColumn(nums, targetYear, years);
    if (picked === undefined) continue;
    out.push({
      label: COMPARISON_LEDGER_LABELS[rule.id] ?? rule.id,
      amount: Math.round(Math.abs(picked)),
      source: `Two-year comparison (${rule.id} row)`,
    });
    break;
  }
}

function dedupeComparisonLines(
  lines: Array<{ label: string; amount: number; source: string }>,
): Array<{ label: string; amount: number; source: string }> {
  const byLabel = new Map<string, { label: string; amount: number; source: string }>();
  for (const line of lines) {
    const prev = byLabel.get(line.label);
    if (!prev || line.amount > prev.amount) byLabel.set(line.label, line);
  }
  return [...byLabel.values()];
}
