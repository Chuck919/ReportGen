import type { ResolvedFields } from "./merge";
import type { TaxFormKind } from "./detect-tax-form";
import { scanFormLine20OtherDeductionsTotal } from "./form-anchors";
import {
  extractStatementDeductions,
  scanStatement2Total,
  sumStmt2BlockLineItems,
  scanStmt2MiscLineAmounts,
} from "./statement-extractors";
import { scanComparisonOtherDeductionsTotal } from "./comparison-opex";
import { isFormReferenceNumber, isReasonableMoneyAmount } from "./money";

function exactAgree(a: number, b: number): boolean {
  return Math.round(a) === Math.round(b);
}

function keepableOdTotal(n: number): boolean {
  const abs = Math.round(Math.abs(n));
  if (abs < 1) return false;
  if (!isReasonableMoneyAmount(abs)) return false;
  if (isFormReferenceNumber(abs)) return false;
  if (abs >= 1990 && abs <= 2035) return false;
  return true;
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
 * Infer Stmt 2 / Form line 19–20 attachment total from structural signals.
 * Prefer Form footer / exact agreement across sources — no $10k floors or 0.98–1.15/% miscCap envelopes.
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
  const miscSum = scanStmt2MiscLineAmounts(allText).reduce((s, n) => s + n, 0);

  const candidates = new Set<number>();
  const push = (n: number | undefined) => {
    if (n !== undefined && keepableOdTotal(n)) candidates.add(Math.round(n));
  };

  push(form);
  push(compStmt2);
  push(scanned);

  // Itemized: admit when it exact-agrees with Form/scanned, or when footer is missing/truncated.
  if (itemized !== undefined && keepableOdTotal(itemized)) {
    if (
      (form !== undefined && exactAgree(itemized, form)) ||
      (scanned !== undefined && exactAgree(itemized, scanned)) ||
      (scanned === undefined && form === undefined) ||
      (scanned !== undefined && itemized > scanned && attachmentSum > 0 && itemized >= attachmentSum)
    ) {
      push(itemized);
    }
  }

  // attach + comparison other_opex only when it exact-agrees with an independent TOTAL.
  const compOpex = hints?.comparisonOpex;
  if (attachmentSum >= 1 && compOpex !== undefined && keepableOdTotal(compOpex)) {
    const reconstructed = Math.round(attachmentSum + compOpex);
    if (
      (form !== undefined && exactAgree(reconstructed, form)) ||
      (scanned !== undefined && exactAgree(reconstructed, scanned)) ||
      (compStmt2 !== undefined && exactAgree(reconstructed, compStmt2))
    ) {
      push(reconstructed);
    }
  }

  // attach + misc only on dollar-exact agreement with Form/footer (no ×0.35 miscCap).
  if (attachmentSum >= 1 && miscSum >= 1) {
    const reconstructed = Math.round(attachmentSum + miscSum);
    if (
      (form !== undefined && exactAgree(reconstructed, form)) ||
      (scanned !== undefined && exactAgree(reconstructed, scanned))
    ) {
      push(reconstructed);
    }
  }

  if (!candidates.size) {
    const fallback = [form, scanned, itemized, compStmt2].find(
      (n): n is number => n !== undefined && keepableOdTotal(n),
    );
    return fallback !== undefined ? Math.round(fallback) : undefined;
  }

  // Prefer Form-20 when any candidate exact-agrees with it.
  if (form !== undefined && keepableOdTotal(form)) {
    const formRound = Math.round(form);
    if ([...candidates].some((c) => exactAgree(c, formRound))) return formRound;
  }

  // Prefer scanned footer when it exact-agrees with itemized/comp.
  if (scanned !== undefined && keepableOdTotal(scanned)) {
    const scannedRound = Math.round(scanned);
    if (
      (itemized !== undefined && exactAgree(itemized, scannedRound)) ||
      (compStmt2 !== undefined && exactAgree(compStmt2, scannedRound))
    ) {
      return scannedRound;
    }
  }

  // Drop candidates that are clearly just a single attachment line mis-read as total.
  let list = [...candidates];
  if (attachmentLines.some((line) => list.some((c) => exactAgree(c, line)))) {
    const alt = list.filter((c) => !attachmentLines.some((line) => exactAgree(c, line)));
    if (alt.length) list = alt;
  }

  return Math.round(Math.max(...list));
}
