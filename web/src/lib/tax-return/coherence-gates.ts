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

function nearEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(2, Math.abs(b) * 0.01);
}

const NOMINAL_PAR_VALUES = new Set([100, 500, 1000, 5000, 10_000]);

function isNominalParCommonStock(value: number): boolean {
  return NOMINAL_PAR_VALUES.has(Math.round(Math.abs(value)));
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
      const fullyAmort = isFullyAmortizedIntangibles(resolved);
      if (
        !traps.some((t) => t !== undefined && nearEqual(stmt.value, t)) &&
        !(fullyAmort && stmt.value > 0 && stmt.value < 500)
      ) {
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

  if (sales !== undefined && sales > 50_000) {
    const stmt2 =
      inferStmt2AttachmentTotal(ctx.allText, ctx.formKind, resolved, {
        comparisonOpex: ctx.comparison?.values.other_operating_expenses,
      }) ?? scanFormLine20OtherDeductionsTotal(ctx.allText, ctx.formKind);
    const opex = resolved.values.other_operating_expenses;
    if (
      opex !== undefined &&
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
    for (const [id, ratioMin, ratioMax] of [
      ["cogs", 0.05, 0.95],
      ["rent", 0.001, 0.35],
      ["officer_compensation", 0, 0.25],
      ["salaries_wages", 0.01, 0.45],
    ] as const) {
      const v = resolved.values[id];
      if (v === undefined || v <= 1) continue;
      const ratio = v / sales;
      if (ratio < ratioMin || ratio > ratioMax) {
        if (isWeakSource(resolved.sources[id])) {
          delete resolved.values[id];
          delete resolved.confidence[id];
          delete resolved.sources[id];
          resolved.warnings.push(
            `Coherence: cleared ${id}=${v} (${(ratio * 100).toFixed(1)}% of sales — out of range)`,
          );
        } else {
          resolved.warnings.push(
            `Coherence: ${id} is ${(ratio * 100).toFixed(1)}% of sales — verify`,
          );
        }
      }
    }
  }

  if (resolved.values.cash !== undefined && Math.abs(resolved.values.cash) < 5_000) {
    if (isWeakSource(resolved.sources.cash)) {
      const v = resolved.values.cash;
      delete resolved.values.cash;
      delete resolved.confidence.cash;
      delete resolved.sources.cash;
      resolved.warnings.push(`Coherence: cleared cash=${v} (too small for operating company)`);
    }
  }

  if (
    resolved.values.common_stock !== undefined &&
    resolved.values.common_stock > 0 &&
    resolved.values.common_stock < 10_000 &&
    (resolved.values.other_stock_equity ?? 0) > 50_000
  ) {
    // Keep par-value common stock when equity is in other_stock_equity
  } else if (
    resolved.values.common_stock !== undefined &&
    resolved.values.common_stock > 0 &&
    resolved.values.common_stock < 10_000 &&
    !isNominalParCommonStock(resolved.values.common_stock) &&
    resolved.values.unclassified_equity !== undefined &&
    resolved.values.unclassified_equity > 50_000 &&
    (resolved.values.other_stock_equity ?? 0) < 50_000
  ) {
    const v = resolved.values.common_stock;
    delete resolved.values.common_stock;
    delete resolved.confidence.common_stock;
    delete resolved.sources.common_stock;
    resolved.warnings.push(`Coherence: cleared common_stock=${v} (nominal par; equity is unclassified/retained)`);
  }

  if (
    resolved.values.preferred_stock !== undefined &&
    resolved.values.preferred_stock > 0 &&
    resolved.values.preferred_stock < 10_000 &&
    resolved.values.unclassified_equity !== undefined &&
    resolved.values.unclassified_equity > 50_000
  ) {
    const v = resolved.values.preferred_stock;
    delete resolved.values.preferred_stock;
    delete resolved.confidence.preferred_stock;
    delete resolved.sources.preferred_stock;
    resolved.warnings.push(`Coherence: cleared preferred_stock=${v} (nominal par)`);
  }

  if (
    resolved.values.unclassified_equity !== undefined &&
    resolved.values.unclassified_equity > 0 &&
    resolved.values.unclassified_equity < 5_000 &&
    isWeakSource(resolved.sources.unclassified_equity)
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
    resolved.values.amortization < 500 &&
    isFullyAmortizedIntangibles(resolved)
  ) {
    resolved.values.amortization = 0;
    resolved.confidence.amortization = 90;
    resolved.sources.amortization = "Coherence: intangibles fully amortized (P&L amort = 0)";
    resolved.warnings.push("Coherence: cleared small amortization — intangibles fully amortized on Schedule L");
  }

  if (
    resolved.values.unclassified_equity !== undefined &&
    resolved.values.unclassified_equity > 0 &&
    /schedule\s+l/i.test(resolved.sources.unclassified_equity ?? "") &&
    /line\s*24|23\+25|retained|unappropriated|apic \+ retained/i.test(
      resolved.sources.unclassified_equity ?? "",
    ) &&
    resolved.values.other_stock_equity !== undefined &&
    resolved.values.other_stock_equity > 50_000
  ) {
    const v = resolved.values.other_stock_equity;
    delete resolved.values.other_stock_equity;
    delete resolved.confidence.other_stock_equity;
    delete resolved.sources.other_stock_equity;
    resolved.warnings.push(`Coherence: cleared duplicate other_stock_equity=${v} (retained in unclassified_equity)`);
  } else if (
    resolved.values.unclassified_equity !== undefined &&
    resolved.values.unclassified_equity > 0 &&
    resolved.values.unclassified_equity < 50_000 &&
    resolved.values.other_stock_equity !== undefined &&
    resolved.values.other_stock_equity > 500_000
  ) {
    const v = resolved.values.unclassified_equity;
    delete resolved.values.unclassified_equity;
    delete resolved.confidence.unclassified_equity;
    delete resolved.sources.unclassified_equity;
    resolved.warnings.push(`Coherence: cleared unclassified_equity=${v} (equity is other_stock_equity)`);
  } else if (
    resolved.values.unclassified_equity !== undefined &&
    resolved.values.unclassified_equity > 0 &&
    resolved.values.unclassified_equity < 100_000 &&
    resolved.values.other_stock_equity !== undefined &&
    resolved.values.other_stock_equity > 400_000 &&
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
    resolved.values.interest_expense < 5_000 &&
    !/form 1120/i.test(resolved.sources.interest_expense ?? "")
  ) {
    const v = resolved.values.interest_expense;
    delete resolved.values.interest_expense;
    delete resolved.confidence.interest_expense;
    delete resolved.sources.interest_expense;
    resolved.warnings.push(`Coherence: cleared interest_expense=${v} (likely OCR noise)`);
  }

  if (
    resolved.values.utilities !== undefined &&
    resolved.values.utilities > 0 &&
    resolved.values.utilities < 5_000 &&
    resolved.values.sales !== undefined &&
    resolved.values.sales > 100_000 &&
    (isWeakSource(resolved.sources.utilities) ||
      /statement\s*2|embedded detail/i.test(resolved.sources.utilities ?? ""))
  ) {
    const v = resolved.values.utilities;
    delete resolved.values.utilities;
    delete resolved.confidence.utilities;
    delete resolved.sources.utilities;
    resolved.warnings.push(`Coherence: cleared utilities=${v} (too small vs sales — refill from comparison)`);
  }

  if (
    resolved.values.amortization !== undefined &&
    (hasNoIntangibleAssets(resolved) || Math.abs(resolved.values.amortization) > 100_000)
  ) {
    const v = resolved.values.amortization;
    if (v !== 0) {
      resolved.values.amortization = 0;
      resolved.confidence.amortization = 90;
      resolved.sources.amortization = "Coherence: no intangibles / OCR junk cleared to zero";
      resolved.warnings.push(`Coherence: cleared amortization=${v} (no intangible assets on Schedule L)`);
    }
  }
}
