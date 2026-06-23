import type { ResolvedFields } from "./merge";
import type { TaxFormKind } from "./detect-tax-form";
import { scanFormLine20OtherDeductionsTotal } from "./form-anchors";
import { extractStatementDeductions, scanStatement2Total, sumStmt2BlockLineItems, scanStmt2MiscLineAmounts } from "./statement-extractors";
import { scanComparisonOtherDeductionsTotal } from "./comparison-opex";

function nearEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(2, Math.abs(b) * 0.01);
}

/** Sum of Stmt 2 lines already extracted elsewhere (bank, professional, utilities, amortization). */
export function knownStmt2AttachmentSum(resolved: ResolvedFields, allText?: string): number {
  const ded = allText ? extractStatementDeductions(allText) : { values: {} as Record<string, number> };
  const ids = ["bank_credit_card", "professional_fees", "utilities", "amortization"] as const;
  return ids
    .map((id) => resolved.values[id] ?? ded.values[id])
    .filter((n): n is number => n !== undefined)
    .reduce((sum, n) => sum + Math.abs(n), 0);
}

/**
 * Infer Stmt 2 / Form line 19–20 attachment total from multiple independent signals.
 * OCR often truncates the Stmt 2 "Total" line; reconstructed totals from detail lines are preferred when higher.
 */
export function inferStmt2AttachmentTotal(
  allText: string,
  formKind: TaxFormKind,
  resolved: ResolvedFields,
  hints?: { comparisonOpex?: number; targetYear?: number },
): number | undefined {
  const scanned = scanStatement2Total(allText);
  const compStmt2 =
    hints?.targetYear !== undefined
      ? scanComparisonOtherDeductionsTotal(allText, hints.targetYear)
      : undefined;
  const form = scanFormLine20OtherDeductionsTotal(allText, formKind);
  const itemized = sumStmt2BlockLineItems(allText);
  const ded = extractStatementDeductions(allText);

  const attachmentLines = [
    ded.values.bank_credit_card ?? resolved.values.bank_credit_card,
    ded.values.professional_fees ?? resolved.values.professional_fees,
    ded.values.utilities ?? resolved.values.utilities,
    resolved.values.amortization,
  ].filter((n): n is number => n !== undefined && n > 0);

  const attachmentSum = attachmentLines.reduce((s, n) => s + Math.abs(n), 0);

  const candidates: number[] = [];
  if (compStmt2 !== undefined && compStmt2 >= 10_000) candidates.push(compStmt2);
  if (scanned !== undefined && scanned >= 10_000) {
    if (compStmt2 === undefined || scanned <= compStmt2 * 1.25) candidates.push(scanned);
  }
  if (form !== undefined && form >= 10_000) candidates.push(form);
  if (itemized !== undefined && itemized >= 10_000) {
    if (scanned === undefined) {
      candidates.push(itemized);
    } else if (
      itemized > scanned &&
      itemized <= scanned * 1.15 &&
      itemized >= attachmentSum + 1_000
    ) {
      candidates.push(itemized);
    }
  }

  if (attachmentSum >= 10_000) {
    const compOpex = hints?.comparisonOpex;
    if (compOpex !== undefined && compOpex >= 1_000) {
      candidates.push(attachmentSum + compOpex);
    }
    const miscSum = scanStmt2MiscLineAmounts(allText).reduce((s, n) => s + n, 0);
    const miscCap = scanned !== undefined ? scanned * 0.35 : attachmentSum * 0.5;
    if (miscSum >= 1_000 && miscSum <= miscCap) {
      candidates.push(attachmentSum + miscSum);
    }
    candidates.push(attachmentSum + 1_000);
  }

  if (!candidates.length) return undefined;

  let best = Math.max(...candidates);

  if (scanned !== undefined && best > scanned * 1.15) {
    const capped = candidates.filter((c) => c <= scanned * 1.15 && c >= scanned * 0.98);
    if (capped.length) best = Math.max(...capped);
    else best = scanned;
  }

  // When OCR total is below the sum of known Stmt 2 lines, trust reconstruction.
  if (scanned !== undefined && scanned < attachmentSum + 500) {
    const reconstructed = candidates.filter((c) => c >= attachmentSum + 500);
    if (reconstructed.length) best = Math.max(...reconstructed);
  }

  // Drop candidates that are clearly just a single attachment line mis-read as total.
  if (attachmentLines.some((line) => nearEqual(best, line))) {
    const alt = candidates.filter((c) => !attachmentLines.some((line) => nearEqual(c, line)));
    if (alt.length) best = Math.max(...alt);
  }

  return Math.round(best);
}
