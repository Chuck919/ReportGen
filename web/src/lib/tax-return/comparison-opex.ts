import { keepableWorksheetMoneyTokens, lineMoneyTokens } from "./money";
import {
  pickComparisonColumnIndex,
  shrinkToYearColumns,
} from "@/lib/two-year-comparison-parser";
import type { parseTwoYearComparisonBlock } from "@/lib/two-year-comparison-parser";
import { scanStmt2MiscLineAmounts, scanDocumentWideStmt2Exclusions } from "./statement-extractors";
import { scanFormLine20OtherDeductionsTotal, scanFormLineOtherDeductionsTotalBest } from "./form-anchors";
import type { TaxFormKind } from "./detect-tax-form";
import { detectTaxForm } from "./detect-tax-form";
import { exactClosureTolerance } from "./structural-tolerance";

const COMP_CTX =
  /(?:\bg\s*)?ross\s+receipts?\s+or\s+sales|two\s*year\s*comparison|t\w{0,3}\s*y\s*ear\s*\w{0,6}\s*omparison/i;

const OPEX_LINE =
  /OTHER\s+OPERATING\s+EXP|other\s+operating\s+exp|0ther\s+operat|ther\s+operat/i;

const OTHER_DEDUCTIONS_LINE = /OTHER\s+DEDUCT|other\s+deduct|ober\s+desucon/i;

function isOpexComparisonLine(line: string): boolean {
  const t = line.toLowerCase();
  if (/other\s+income|operat.{0,6}income|other\s+deduct/i.test(t)) return false;
  return OPEX_LINE.test(line) || (/\bother\b/i.test(t) && /\bexp/i.test(t) && !/income|deduct/i.test(t));
}

function isOtherDeductionsComparisonLine(line: string): boolean {
  return OTHER_DEDUCTIONS_LINE.test(line) && !/operat/i.test(line);
}

export type ComparisonOpexHints = {
  attachmentSum?: number;
  stmt2Total?: number;
};

function headerYearsNearLine(allText: string, line: string): [number, number] | undefined {
  const idx = allText.indexOf(line);
  const window = allText.slice(Math.max(0, idx - 800), idx + line.length + 200);
  const m = window.match(/\b(20\d{2})\b[^\d]{0,40}\b(20\d{2})\b/);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2])];
}

/** Value that completes attachmentSum + opex = Stmt 2 TOTAL (prior-year column trap). */
export function closesTruncatedStmt2Total(
  opex: number,
  attachmentSum: number,
  stmt2Total: number,
): boolean {
  return (
    Math.abs(Math.round(attachmentSum + opex) - Math.round(stmt2Total)) <=
    exactClosureTolerance(stmt2Total)
  );
}

/** Comparison picked attachment total instead of residual opex. */
export function looksLikeStmt2CombinedTotal(value: number, attachmentSum: number): boolean {
  if (attachmentSum < 1) return false;
  return (
    Math.abs(Math.round(Math.abs(value)) - Math.round(attachmentSum)) <=
    exactClosureTolerance(attachmentSum)
  );
}

export function rejectComparisonOpexValue(
  value: number,
  hints?: ComparisonOpexHints,
): boolean {
  if (
    hints?.stmt2Total !== undefined &&
    Math.abs(Math.round(value) - Math.round(hints.stmt2Total)) <=
      exactClosureTolerance(hints.stmt2Total)
  ) {
    return true;
  }
  if (
    hints?.stmt2Total !== undefined &&
    hints.attachmentSum !== undefined &&
    closesTruncatedStmt2Total(value, hints.attachmentSum, hints.stmt2Total)
  ) {
    return false;
  }
  // Reject footer echo: value is the stmt total itself (or ≥ total).
  if (hints?.stmt2Total !== undefined && value >= hints.stmt2Total) {
    return true;
  }
  if (hints?.attachmentSum !== undefined && looksLikeStmt2CombinedTotal(value, hints.attachmentSum)) {
    return true;
  }
  return false;
}

function pickYearColumn(
  nums: number[],
  targetYear: number,
  allText: string,
  line: string,
  hints?: ComparisonOpexHints,
): number | undefined {
  const filtered = nums.filter((n) => {
    const abs = Math.abs(n);
    if (abs < 1) return false;
    if (abs >= 1990 && abs <= 2035) return false;
    return true;
  });
  if (!filtered.length) return undefined;
  const pair = shrinkToYearColumns(filtered);
  if (!pair) return filtered.length >= 2 ? filtered[1] : filtered[0];
  const years = headerYearsNearLine(allText, line);
  const col = years ? pickComparisonColumnIndex(years[0], years[1], targetYear) : 1;
  let picked = col === 0 ? pair[0] : pair[1];
  const alt = col === 0 ? pair[1] : pair[0];

  const pickedBad = rejectComparisonOpexValue(picked, hints);
  const altBad = rejectComparisonOpexValue(alt, hints);
  if (pickedBad && !altBad) return alt;
  if (!pickedBad && altBad) return picked;
  if (
    hints?.attachmentSum !== undefined &&
    hints.stmt2Total !== undefined &&
    closesTruncatedStmt2Total(picked, hints.attachmentSum, hints.stmt2Total) &&
    !closesTruncatedStmt2Total(alt, hints.attachmentSum, hints.stmt2Total)
  ) {
    picked = alt;
  }
  if (
    hints?.attachmentSum !== undefined &&
    looksLikeStmt2CombinedTotal(picked, hints.attachmentSum) &&
    !looksLikeStmt2CombinedTotal(alt, hints.attachmentSum)
  ) {
    picked = alt;
  }
  return picked;
}

/** Form line 20 / Stmt 2 attachment total from comparison OTHER DEDUCTIONS row. */
export function scanComparisonOtherDeductionsTotal(
  allText: string,
  targetYear: number,
): number | undefined {
  const blockStart =
    allText.search(
      /t\w{0,3}\s*y\s*ear\s*\w{0,6}\s*omparison|two\s*year\s*comparison|(?:\bg\s*)?ross\s+receipts?\s+or\s+sales/i,
    ) ?? -1;
  if (blockStart < 0) return undefined;
  const searchText = allText.slice(blockStart, blockStart + 30_000);

  for (const rawLine of searchText.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!isOtherDeductionsComparisonLine(line)) continue;
    if (/\b20\b/i.test(line) && /attach|stmt\s*2|see\s+stmt/i.test(line)) continue;
    const nums = keepableWorksheetMoneyTokens(line);
    const pair = shrinkToYearColumns(nums);
    if (!pair) continue;
    const years = headerYearsNearLine(allText, line);
    const col = years ? pickComparisonColumnIndex(years[0], years[1], targetYear) : 1;
    return Math.round(col === 0 ? pair[0] : pair[1]);
  }
  return undefined;
}

/** Comparison worksheet present but OTHER DEDUCTIONS row amounts not OCR'd for target year. */
export function comparisonWorksheetIncomplete(allText: string, targetYear: number): boolean {
  if (!/two\s*year\s*comparison|comparison\s+worksheet|t\w{0,3}\s*y\s*ear\s*\w{0,6}\s*omparison/i.test(allText)) {
    return false;
  }
  return scanComparisonOtherDeductionsTotal(allText, targetYear) === undefined;
}

/** Residual opex = comparison OTHER DEDUCTIONS (Form 20) minus known Stmt 2 attachment lines. */
export function computeComparisonOpexResidual(
  allText: string,
  targetYear: number,
  attachmentSum: number,
  hints?: ComparisonOpexHints,
  resolved?: { values: Record<string, number | undefined> },
  formKind?: TaxFormKind,
): { value: number; confidence: number } | undefined {
  const kind = formKind ?? detectTaxForm(allText).kind;
  const stmt2Total =
    scanComparisonOtherDeductionsTotal(allText, targetYear) ??
    hints?.stmt2Total ??
    scanFormLineOtherDeductionsTotalBest(allText, kind);
  if (stmt2Total === undefined) return undefined;

  const prof = resolved?.values.professional_fees ?? 0;
  const util = resolved?.values.utilities ?? 0;
  const bank = resolved?.values.bank_credit_card ?? 0;
  let attachment = attachmentSum > 0 ? attachmentSum : prof + util + bank;

  const wideExcl = scanDocumentWideStmt2Exclusions(allText);
  // Fold document-wide exclusions only while a proper remainder remains (< TOTAL).
  // Replaces legacy $5k / $150k size gates — same charter remainder rule as ranking.
  if (wideExcl >= 1) {
    const extended = Math.round(prof + util + bank + wideExcl);
    if (extended > attachment && extended < stmt2Total) {
      attachment = extended;
    }
  }

  // Misc bank guesses: exclude year tokens and the stmt footer itself — not a stmt×% cap.
  const misc = scanStmt2MiscLineAmounts(allText).filter(
    (n) => n >= 1 && n < stmt2Total && (!targetYear || n !== targetYear),
  );
  let residual = Math.round(stmt2Total - attachment);
  if (residual >= 1 && residual > Math.max(prof, util, bank, 0)) {
    const existingBank = resolved?.values.bank_credit_card;
    for (const bankGuess of misc.sort((a, b) => b - a)) {
      if (bankGuess >= stmt2Total) continue;
      const trial = Math.round(stmt2Total - prof - util - bankGuess);
      if (trial < 1) continue;
      // Misc-line amounts already in attachmentSum are not independent bank substitutes.
      if (
        existingBank !== undefined &&
        attachmentSum > prof + util + Math.round(Math.abs(existingBank)) &&
        Math.round(bankGuess) !== Math.round(Math.abs(existingBank))
      ) {
        continue;
      }
      const trialAttach = Math.round(prof + util + bankGuess);
      // Dollar-exact close (trial is constructed as TOTAL − trialAttach).
      if (trialAttach + trial !== Math.round(stmt2Total)) continue;
      attachment = trialAttach;
      residual = trial;
      break;
    }
  }

  if (attachment < 1) return undefined;
  // Residual is the footer itself, or empty — must leave a proper remainder.
  if (residual < 1 || residual >= stmt2Total) return undefined;
  if (looksLikeStmt2CombinedTotal(residual, attachment)) return undefined;
  return { value: residual, confidence: 91 };
}

/** Year-aware OTHER OPERATING EXPENSES row from two-year comparison block. */
export function scanComparisonOpexRow(
  allText: string,
  targetYear: number,
  hints?: ComparisonOpexHints,
): { value: number; confidence: number } | undefined {
  const blockStart =
    allText.search(
      /t\w{0,3}\s*y\s*ear\s*\w{0,6}\s*omparison|two\s*year\s*comparison|(?:\bg\s*)?ross\s+receipts?\s+or\s+sales/i,
    ) ?? -1;
  const searchTexts =
    blockStart >= 0
      ? [allText.slice(blockStart, blockStart + 30_000)]
      : [allText];

  for (const searchText of searchTexts) {
    for (const rawLine of searchText.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!isOpexComparisonLine(line)) continue;
    if (/\b20\b/i.test(line) && /attach|stmt\s*2|see\s+stmt/i.test(line)) continue;
    if (
      blockStart < 0 &&
      !COMP_CTX.test(
        allText.slice(Math.max(0, allText.indexOf(line) - 400), allText.indexOf(line) + line.length),
      )
    ) {
      continue;
    }
    const nums = lineMoneyTokens(line);
    const picked = pickYearColumn(nums, targetYear, allText, line, hints);
    if (picked === undefined) continue;
    return { value: Math.round(picked), confidence: 92 };
    }
  }
  return undefined;
}

function rejectResidualColumnTrap(
  value: number,
  hints?: ComparisonOpexHints,
): boolean {
  return rejectComparisonOpexValue(value, hints);
}

/** Best comparison opex: residual from OTHER DEDUCTIONS row, then labeled OTHER OPERATING EXPENSES row. */
export function pickComparisonOpex(
  allText: string,
  targetYear: number,
  comparison?: ReturnType<typeof parseTwoYearComparisonBlock> | null,
  hints?: ComparisonOpexHints,
  resolved?: { values: Record<string, number | undefined> },
  formKind?: TaxFormKind,
): { value: number; confidence: number; source: string } | undefined {
  const kind = formKind ?? detectTaxForm(allText).kind;
  const stmt2Total =
    scanComparisonOtherDeductionsTotal(allText, targetYear) ??
    hints?.stmt2Total ??
    scanFormLine20OtherDeductionsTotal(allText, kind) ??
    comparison?.values.other_operating_expenses;
  const enrichedHints: ComparisonOpexHints = { ...hints, stmt2Total };

  const residual = computeComparisonOpexResidual(
    allText,
    targetYear,
    hints?.attachmentSum ?? 0,
    enrichedHints,
    resolved,
    kind,
  );
  if (residual !== undefined) {
    return {
      value: residual.value,
      confidence: residual.confidence,
      source: "Two-year comparison (OTHER DEDUCTIONS residual)",
    };
  }

  const scanned = scanComparisonOpexRow(allText, targetYear, enrichedHints);
  const scannedOk = scanned !== undefined && !rejectResidualColumnTrap(scanned.value, enrichedHints);
  if (scannedOk) {
    return {
      value: scanned!.value,
      confidence: scanned!.confidence,
      source: "Two-year comparison (OTHER OPERATING EXPENSES row)",
    };
  }

  const parsed = comparison?.values.other_operating_expenses;
  const parsedOk = parsed !== undefined && !rejectResidualColumnTrap(parsed, enrichedHints);
  if (parsedOk) {
    return {
      value: Math.round(parsed),
      confidence: comparison?.confidence.other_operating_expenses ?? 90,
      source: "Two-year comparison",
    };
  }
  return undefined;
}
