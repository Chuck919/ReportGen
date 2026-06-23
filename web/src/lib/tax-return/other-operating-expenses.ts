import type { ResolvedFields } from "./merge";
import type { TaxFormKind } from "./detect-tax-form";
import {
  extractOtherDeductionsBlockOpex,
  blockOpexClosesStatement,
} from "./statement-extractors";
import { scanComparisonOtherDeductionsTotal } from "./comparison-opex";
import { knownStmt2AttachmentSum } from "./stmt2-total-inference";
import type { parseTwoYearComparisonBlock } from "@/lib/two-year-comparison-parser";
import {
  confidenceFromCandidate,
  generateOpexCandidates,
  rankOpexCandidates,
  type OpexCandidate,
} from "./opex-candidate-ranking";
import {
  collidesWithResolvedPnl,
  isPlausibleOtherOperatingExpense,
  type OpexContext,
} from "./opex-plausibility";

export type { OpexCandidate } from "./opex-candidate-ranking";
export type { OpexContext } from "./opex-plausibility";
export { collidesWithResolvedPnl, isPlausibleOtherOperatingExpense } from "./opex-plausibility";

export type OpexReconcileDebug = {
  candidates: OpexCandidate[];
  chosenSource?: string;
  chosenScore?: number;
  /** Final value on resolved after all post-verification OPEX passes. */
  finalValue?: number;
};

/**
 * Emit debug metadata that matches the final resolved OPEX field (after all reconcile passes).
 */
export function emitOpexReconcileDebug(
  resolved: ResolvedFields,
  ctx: {
    allText: string;
    formKind: TaxFormKind;
    targetYear: number;
    comparison?: ReturnType<typeof parseTwoYearComparisonBlock>;
    priorYearValues?: Record<number, Record<string, number>>;
  },
): OpexReconcileDebug {
  const candidates = generateOpexCandidates(resolved, ctx);
  const finalValue = resolved.values.other_operating_expenses;
  const finalSource = resolved.sources.other_operating_expenses;
  const exact = candidates.find(
    (c) => c.value === finalValue && c.source === finalSource,
  );
  const byValue = exact ?? candidates.find((c) => c.value === finalValue);
  const ranked = rankOpexCandidates(candidates).winner;
  const matched = byValue ?? (ranked?.value === finalValue ? ranked : undefined);

  return {
    candidates,
    chosenSource: finalSource ?? matched?.source,
    chosenScore: matched?.totalScore,
    finalValue,
  };
}

/**
 * Rank all opex candidates by structural closure + evidence + cross-year consistency.
 * Replaces sequential if/else — no client-specific formula branches.
 */
export function reconcileOtherOperatingExpenses(
  resolved: ResolvedFields,
  ctx: {
    allText: string;
    formKind: TaxFormKind;
    targetYear: number;
    comparison?: ReturnType<typeof parseTwoYearComparisonBlock>;
    priorYearValues?: Record<number, Record<string, number>>;
    debugOut?: (debug: OpexReconcileDebug) => void;
  },
): void {
  const candidates = generateOpexCandidates(resolved, ctx);
  const { winner } = rankOpexCandidates(candidates);

  const debug: OpexReconcileDebug = {
    candidates,
    chosenSource: winner?.source,
    chosenScore: winner?.totalScore,
  };
  ctx.debugOut?.(debug);

  if (!winner) {
    const cur = resolved.values.other_operating_expenses;
    const plausibilityCtx: OpexContext = {
      sales: resolved.values.sales,
      knownStmt2Lines: knownStmt2AttachmentSum(resolved, ctx.allText),
    };
    if (
      cur !== undefined &&
      (collidesWithResolvedPnl(cur, resolved) ||
        !isPlausibleOtherOperatingExpense(cur, plausibilityCtx))
    ) {
      delete resolved.values.other_operating_expenses;
      delete resolved.confidence.other_operating_expenses;
      delete resolved.sources.other_operating_expenses;
    }
    return;
  }

  const existing = resolved.values.other_operating_expenses;
  const existingSource = resolved.sources.other_operating_expenses ?? "";
  const existingIsSubtractive = /comparison|residual|document-wide/i.test(existingSource);
  const winnerIsAuthoritativeDetail =
    /summed detail|misc detail closes|office\/supplies|telephone\/travel\/bank detail/i.test(
      winner.source,
    ) && winner.closureScore >= 0.85;

  const replace =
    existing === undefined ||
    collidesWithResolvedPnl(existing, resolved) ||
    !isPlausibleOtherOperatingExpense(existing, {
      sales: resolved.values.sales,
      stmt2Total: undefined,
      knownStmt2Lines: knownStmt2AttachmentSum(resolved, ctx.allText),
    }) ||
    (existingIsSubtractive && winnerIsAuthoritativeDetail && winner.totalScore >= 75) ||
    Math.abs(existing - winner.value) > Math.max(500, Math.abs(winner.value) * 0.12);

  if (replace) {
    resolved.values.other_operating_expenses = winner.value;
    resolved.confidence.other_operating_expenses = confidenceFromCandidate(winner);
    resolved.sources.other_operating_expenses = winner.source;
  }
}

/** Post-verification block opex override for large corps — requires closure proof. */
export function applyLargeCorpBlockOpexOverride(
  resolved: ResolvedFields,
  ctx: {
    allText: string;
    targetYear: number;
    sales?: number;
  },
): boolean {
  const compOtherDed = scanComparisonOtherDeductionsTotal(ctx.allText, ctx.targetYear);
  if (compOtherDed === undefined || compOtherDed < 100_000) return false;
  if (ctx.sales === undefined || ctx.sales <= 1_000_000) return false;

  const blockOpex = extractOtherDeductionsBlockOpex(ctx.allText);
  const plausibilityCtx: OpexContext = {
    sales: ctx.sales,
    stmt2Total: compOtherDed,
    knownStmt2Lines: knownStmt2AttachmentSum(resolved, ctx.allText),
  };
  if (
    blockOpex.opex === undefined ||
    blockOpex.opex < 10_000 ||
    !blockOpexClosesStatement(blockOpex, resolved, ctx.allText) ||
    !isPlausibleOtherOperatingExpense(blockOpex.opex, plausibilityCtx)
  ) {
    return false;
  }

  resolved.values.other_operating_expenses = blockOpex.opex;
  resolved.confidence.other_operating_expenses = blockOpex.confidence;
  resolved.sources.other_operating_expenses = blockOpex.source;
  return true;
}

// Re-export for comparison-field-rows and scripts
export { scanComparisonOpexRow } from "./comparison-opex";
