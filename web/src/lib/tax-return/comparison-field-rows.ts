import type { ResolvedFields } from "./merge";
import { lineMoneyTokens } from "./money";
import { pickComparisonColumnIndex, shrinkToYearColumns } from "@/lib/two-year-comparison-parser";
import { scanComparisonOtherDeductionsTotal, computeComparisonOpexResidual } from "./comparison-opex";
import { extractOtherDeductionsBlockOpex, extractStatementDeductions, blockStmtTotalCorroborated, scanStatement2Total } from "./statement-extractors";
import { knownStmt2AttachmentSum } from "./stmt2-total-inference";
import { closureTolerance } from "./structural-tolerance";

type RowRule = {
  id: string;
  labelRe: RegExp;
  minAmount: number;
};

const COMPARISON_ROW_RULES: RowRule[] = [
  { id: "utilities", labelRe: /UTILIT|UTILITY|ELECTRIC/i, minAmount: 500 },
  { id: "bank_credit_card", labelRe: /BANK|CREDIT\s+CARD|MERCHANT/i, minAmount: 500 },
  { id: "professional_fees", labelRe: /PROFESSIONAL|LEGAL\s+AND|ACCOUNTING/i, minAmount: 500 },
  { id: "taxes_licenses", labelRe: /TAXES\s+AND\s+LIC/i, minAmount: 1000 },
  { id: "taxes_paid", labelRe: /TAXES\s+PAID|STATE\s+INCOME\s+TAX/i, minAmount: 1000 },
  { id: "other_operating_income", labelRe: /OTHER\s+OPERATING\s+INCOME|OTHER\s+INCOME/i, minAmount: 100 },
  { id: "cogs", labelRe: /COST\s+OF\s+(?:GOODS|SALES)|COGS|\bC\.?\s*O\.?\s*G/i, minAmount: 10_000 },
  { id: "depreciation", labelRe: /DEPRECIATION/i, minAmount: 100 },
];

const STMT2_UTIL =
  /utilities|utility\s+expense|electric/i;

function findComparisonBlock(allText: string): { text: string; start: number } | undefined {
  const start =
    allText.search(
      /t\w{0,3}\s*y\s*ear\s*\w{0,6}\s*omparison|two\s*year\s*comparison|(?:\bg\s*)?ross\s+receipts?\s+or\s+sales/i,
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

  if (!block) return;

  for (const rawLine of block.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line || !/\d/.test(line)) continue;

    for (const rule of COMPARISON_ROW_RULES) {
      if (!rule.labelRe.test(line)) continue;
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
      const weak = !src || /OCR label|fuzzy|label match|Statement 2|stmt 2|embedded detail|tail scan/i.test(src);
      const bigDiff =
        cur !== undefined &&
        Math.abs(cur - picked) / Math.max(Math.abs(picked), 1) > 0.15;

      const replace =
        cur === undefined ||
        weak ||
        (bigDiff && (rule.id === "utilities" || rule.id === "taxes_licenses" || rule.id === "cogs")) ||
        (rule.id === "utilities" && cur !== undefined && Math.abs(cur) < Math.abs(picked) * 0.5) ||
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
  const paid = resolved.values.taxes_paid;
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
      resolved.values.other_operating_expenses = blockOfficeDetail.opex;
      resolved.confidence.other_operating_expenses = blockOfficeDetail.confidence;
      resolved.sources.other_operating_expenses = blockOfficeDetail.source;
    }
  } else if (opexResidual !== undefined) {
    const stmtOpex = extractStatementDeductions(allText).values.other_operating_expenses;
    const stmtCloses =
      stmt2Total !== undefined &&
      stmtOpex !== undefined &&
      Math.abs(attachmentSum + stmtOpex - stmt2Total) <= closureTolerance(stmt2Total);
    const preferStmt =
      stmtOpex !== undefined &&
      stmtOpex >= 1_000 &&
      stmtCloses &&
      Math.abs(stmtOpex - opexResidual.value) / Math.max(stmtOpex, opexResidual.value) <= 0.15;
    if (preferStmt && !curIsOfficeDetail) {
      resolved.values.other_operating_expenses = stmtOpex;
      resolved.confidence.other_operating_expenses = 90;
      resolved.sources.other_operating_expenses = "Statement 2 (summed detail / residual)";
    } else if (
      !curIsOfficeDetail &&
      !(curIsAuthoritativeDetail && opexResidual !== undefined) &&
      (cur === undefined ||
        Math.abs(cur - opexResidual.value) / Math.max(opexResidual.value, 1) > 0.12)
    ) {
      resolved.values.other_operating_expenses = opexResidual.value;
      resolved.confidence.other_operating_expenses = opexResidual.confidence;
      resolved.sources.other_operating_expenses = "Two-year comparison (OTHER DEDUCTIONS residual)";
    }
  }
}
