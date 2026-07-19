import type { ResolvedFields } from "@/lib/tax-return/merge";
import {
  reconcileDepreciationAmortization,
  scanStatementAmortization,
  scanComparisonIsExpense,
  isFullyAmortizedIntangibles,
  hasNoIntangibleAssets,
} from "@/lib/tax-return/income-depreciation-amort";
import { isPlausibleOtherOperatingExpense } from "@/lib/tax-return/other-operating-expenses";
import { inferStmt2AttachmentTotal } from "@/lib/tax-return/stmt2-total-inference";
import { scanFormLine20OtherDeductionsTotal } from "@/lib/tax-return/form-anchors";
import type { TaxFormKind } from "./detect-tax-form";
import type { FieldExtraction } from "@/lib/tax-return/form-anchors";
import { isSuspiciousTaxValue, isWeakSource } from "@/lib/tax-return/confidence-gates";
import { isInterestInstructionCrumb } from "@/lib/tax-return/interest-crumb";

function nearEqual(a: number, b: number): boolean {
  return Math.round(a) === Math.round(b);
}

function matchesAny(value: number, traps: Array<number | undefined>): boolean {
  return traps.some((t) => t !== undefined && nearEqual(value, t));
}

/** P&L line must not equal a balance-sheet accumulated / gross intangible line. */
function isBalanceSheetTrapForPl(
  id: "depreciation" | "amortization",
  value: number,
  resolved: ResolvedFields,
): boolean {
  if (id === "depreciation") {
    return matchesAny(value, [
      resolved.values.accumulated_depreciation,
      resolved.values.gross_fixed_assets,
    ]);
  }
  return matchesAny(value, [
    resolved.values.accumulated_amortization,
    resolved.values.gross_intangible_assets,
  ]);
}

export type CoherenceGateContext = {
  allText: string;
  targetYear: number;
  formKind: TaxFormKind;
  formAnchors: FieldExtraction;
  formPage1: string;
  comparison?: {
    values: Record<string, number>;
    confidence: Record<string, number>;
    linesMatched: number;
  } | null;
};

/**
 * Final pass: reject incoherent values (P&L vs BS confusion, OCR 0/1 junk, ratio outliers).
 * Re-runs dep/amort cross-reference after clearing traps.
 */
export function applyCoherenceGates(resolved: ResolvedFields, ctx: CoherenceGateContext): void {
  const sales = resolved.values.sales;
  const cogs = resolved.values.cogs;

  for (const id of Object.keys(resolved.values)) {
    const value = resolved.values[id]!;
    const source = resolved.sources[id];
    if (isSuspiciousTaxValue(id, value, source, ctx.targetYear)) {
      delete resolved.values[id];
      delete resolved.confidence[id];
      delete resolved.sources[id];
      resolved.warnings.push(`Coherence: cleared ${id}=${value} (suspicious magnitude/source)`);
    }
  }

  for (const plId of ["depreciation", "amortization"] as const) {
    const v = resolved.values[plId];
    if (v === undefined) continue;
    if (isBalanceSheetTrapForPl(plId, v, resolved)) {
      delete resolved.values[plId];
      delete resolved.confidence[plId];
      delete resolved.sources[plId];
      resolved.warnings.push(`Coherence: cleared ${plId}=${v} (matched balance-sheet line)`);
    }
  }

  reconcileDepreciationAmortization(resolved, {
    formAnchors: ctx.formAnchors,
    formPage1: ctx.formPage1,
    allText: ctx.allText,
    targetYear: ctx.targetYear,
    comparison: ctx.comparison,
  });

  if (resolved.values.amortization === undefined) {
    const stmt = scanStatementAmortization(ctx.allText);
    if (stmt) {
      const traps = [
        resolved.values.accumulated_amortization,
        resolved.values.gross_intangible_assets,
      ];
      if (!traps.some((t) => t !== undefined && nearEqual(stmt.value, t))) {
        resolved.values.amortization = stmt.value;
        resolved.confidence.amortization = stmt.confidence;
        resolved.sources.amortization = "Statement amortization (coherence refill)";
      }
    } else {
      const comp = scanComparisonIsExpense(ctx.allText, ctx.targetYear, "amortization");
      if (comp && comp.value === 0) {
        resolved.values.amortization = 0;
        resolved.confidence.amortization = comp.confidence;
        resolved.sources.amortization = "Two-year comparison AMORTIZATION zero (coherence)";
      } else if (ctx.comparison?.values.amortization === 0) {
        resolved.values.amortization = 0;
        resolved.confidence.amortization = 88;
        resolved.sources.amortization = "Two-year comparison (AMORTIZATION zero)";
      }
    }
  }

  if (resolved.values.depreciation === undefined) {
    const comp = scanComparisonIsExpense(ctx.allText, ctx.targetYear, "depreciation");
    if (comp) {
      resolved.values.depreciation = comp.value;
      resolved.confidence.depreciation = comp.confidence;
      resolved.sources.depreciation = "Two-year comparison DEPRECIATION (coherence refill)";
    }
  }

  if (sales !== undefined && cogs !== undefined && cogs > sales) {
    resolved.warnings.push(`Coherence: COGS (${cogs}) exceeds sales (${sales}) — verify`);
  }

  if (sales !== undefined && sales > 0) {
    const stmt2 =
      inferStmt2AttachmentTotal(ctx.allText, ctx.formKind, resolved, {
        comparisonOpex: ctx.comparison?.values.other_operating_expenses,
      }) ?? scanFormLine20OtherDeductionsTotal(ctx.allText, ctx.formKind);
    const opex = resolved.values.other_operating_expenses;
    const opexSrc = resolved.sources.other_operating_expenses ?? "";
    // Keep comparison / form residuals — ranking already scored them; blanking forces worse UX.
    const opexFromTrustedRead =
      /comparison|form\s*line|other deductions residual|document-wide exclusion/i.test(opexSrc);
    if (
      opex !== undefined &&
      !opexFromTrustedRead &&
      !isPlausibleOtherOperatingExpense(opex, {
        sales,
        stmt2Total: stmt2,
        knownStmt2Lines: [
          resolved.values.bank_credit_card,
          resolved.values.professional_fees,
          resolved.values.utilities,
          resolved.values.amortization,
        ]
          .filter((n): n is number => n !== undefined)
          .reduce((s, n) => s + Math.abs(n), 0),
      })
    ) {
      delete resolved.values.other_operating_expenses;
      delete resolved.confidence.other_operating_expenses;
      delete resolved.sources.other_operating_expenses;
      resolved.warnings.push(`Coherence: cleared other_operating_expenses=${opex} (structurally implausible)`);
    }
    // Sales-% “typical range” clears removed (charter) — they wiped real high-rent/payroll on weak
    // sources. Structural COGS>sales flags live in reconcile; Form collision replaces live in parse.
  }

  if (resolved.values.cash !== undefined && isWeakSource(resolved.sources.cash)) {
    const v = resolved.values.cash;
    // Weak OCR cash that looks like form-ref / year — not a bare dollar floor.
    if (isSuspiciousTaxValue("cash", v, resolved.sources.cash, ctx.targetYear)) {
      delete resolved.values.cash;
      delete resolved.confidence.cash;
      delete resolved.sources.cash;
      resolved.warnings.push(`Coherence: cleared cash=${v} (weak OCR / form-ref crumb)`);
    }
  }

  if (
    resolved.values.common_stock !== undefined &&
    resolved.values.common_stock > 0 &&
    isWeakSource(resolved.sources.common_stock) &&
    matchesAny(resolved.values.common_stock, [
      resolved.values.unclassified_equity,
      resolved.values.other_stock_equity,
    ])
  ) {
    const v = resolved.values.common_stock;
    delete resolved.values.common_stock;
    delete resolved.confidence.common_stock;
    delete resolved.sources.common_stock;
    resolved.warnings.push(
      `Coherence: cleared common_stock=${v} (weak duplicate of unclassified/other stock equity)`,
    );
  }

  if (
    resolved.values.preferred_stock !== undefined &&
    resolved.values.preferred_stock > 0 &&
    isWeakSource(resolved.sources.preferred_stock) &&
    matchesAny(resolved.values.preferred_stock, [resolved.values.unclassified_equity])
  ) {
    const v = resolved.values.preferred_stock;
    delete resolved.values.preferred_stock;
    delete resolved.confidence.preferred_stock;
    delete resolved.sources.preferred_stock;
    resolved.warnings.push(`Coherence: cleared preferred_stock=${v} (weak duplicate of unclassified equity)`);
  }

  if (
    resolved.values.unclassified_equity !== undefined &&
    resolved.values.unclassified_equity > 0 &&
    isWeakSource(resolved.sources.unclassified_equity) &&
    isSuspiciousTaxValue(
      "unclassified_equity",
      resolved.values.unclassified_equity,
      resolved.sources.unclassified_equity,
      ctx.targetYear,
    )
  ) {
    const v = resolved.values.unclassified_equity;
    delete resolved.values.unclassified_equity;
    delete resolved.confidence.unclassified_equity;
    delete resolved.sources.unclassified_equity;
    resolved.warnings.push(`Coherence: cleared unclassified_equity=${v} (likely OCR noise)`);
  }

  if (
    resolved.values.amortization !== undefined &&
    resolved.values.amortization > 0 &&
    isFullyAmortizedIntangibles(resolved) &&
    (isWeakSource(resolved.sources.amortization) ||
      /comparison/i.test(resolved.sources.amortization ?? ""))
  ) {
    resolved.values.amortization = 0;
    resolved.confidence.amortization = 90;
    resolved.sources.amortization = "Coherence: intangibles fully amortized (P&L amort = 0)";
    resolved.warnings.push("Coherence: cleared weak amortization — intangibles fully amortized on Schedule L");
  }

  if (
    resolved.values.unclassified_equity !== undefined &&
    resolved.values.unclassified_equity > 0 &&
    /schedule\s+l/i.test(resolved.sources.unclassified_equity ?? "") &&
    /line\s*24|23\+25|retained|unappropriated|apic \+ retained/i.test(
      resolved.sources.unclassified_equity ?? "",
    ) &&
    resolved.values.other_stock_equity !== undefined &&
    (nearEqual(resolved.values.other_stock_equity, resolved.values.unclassified_equity) ||
      /routed to other stock|comparison/i.test(resolved.sources.other_stock_equity ?? ""))
  ) {
    const v = resolved.values.other_stock_equity;
    delete resolved.values.other_stock_equity;
    delete resolved.confidence.other_stock_equity;
    delete resolved.sources.other_stock_equity;
    resolved.warnings.push(`Coherence: cleared duplicate other_stock_equity=${v} (retained in unclassified_equity)`);
  } else if (
    resolved.values.unclassified_equity !== undefined &&
    resolved.values.unclassified_equity > 0 &&
    resolved.values.other_stock_equity !== undefined &&
    /embedded schedule l \(paired-column\)/i.test(resolved.sources.other_stock_equity ?? "") &&
    isWeakSource(resolved.sources.unclassified_equity) &&
    !/schedule\s+l.*(?:line\s*24|23\+25|retained|unappropriated)/i.test(
      resolved.sources.unclassified_equity ?? "",
    )
  ) {
    const v = resolved.values.unclassified_equity;
    delete resolved.values.unclassified_equity;
    delete resolved.confidence.unclassified_equity;
    delete resolved.sources.unclassified_equity;
    resolved.warnings.push(`Coherence: cleared unclassified_equity=${v} (reported in other_stock_equity)`);
  }

  if (
    resolved.values.interest_expense !== undefined &&
    resolved.values.interest_expense > 0 &&
    isInterestInstructionCrumb(
      resolved.values.interest_expense,
      resolved.sources.interest_expense ?? "",
    )
  ) {
    const v = resolved.values.interest_expense;
    delete resolved.values.interest_expense;
    delete resolved.confidence.interest_expense;
    delete resolved.sources.interest_expense;
    resolved.warnings.push(`Coherence: cleared interest_expense=${v} (Form 8990 / §163(j) crumb)`);
  }

  if (
    resolved.values.utilities !== undefined &&
    resolved.values.utilities > 0 &&
    isSuspiciousTaxValue(
      "utilities",
      resolved.values.utilities,
      resolved.sources.utilities,
      ctx.targetYear,
    )
  ) {
    const v = resolved.values.utilities;
    delete resolved.values.utilities;
    delete resolved.confidence.utilities;
    delete resolved.sources.utilities;
    resolved.warnings.push(`Coherence: cleared utilities=${v} (OCR crumb / form-ref)`);
  }

  if (resolved.values.amortization !== undefined && resolved.values.amortization > 0) {
    const v = resolved.values.amortization;
    const digits = String(Math.abs(Math.round(v))).length;
    // Digit-run / OMB scrapes are not P&L amort — cell digit length, not a company-size floor.
    if (digits > 7) {
      delete resolved.values.amortization;
      delete resolved.confidence.amortization;
      delete resolved.sources.amortization;
      resolved.warnings.push(`Coherence: cleared amortization=${v} (OCR digit-run / OMB scrape)`);
    } else if (
      hasNoIntangibleAssets(resolved) &&
      (isWeakSource(resolved.sources.amortization) ||
        /comparison|omb|4562/i.test(resolved.sources.amortization ?? ""))
    ) {
      resolved.values.amortization = 0;
      resolved.confidence.amortization = 90;
      resolved.sources.amortization = "Coherence: no intangibles — weak/comparison amort cleared";
      resolved.warnings.push(`Coherence: cleared amortization=${v} (no intangible assets on Schedule L)`);
    }
  }
}
