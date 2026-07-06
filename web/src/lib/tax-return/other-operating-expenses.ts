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
import {
  applyOrdinaryIncomeReverseOpex,
  flagPnlIdentityMismatches,
} from "./pnl-identity";

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
  const { winner: rankedWinner } = rankOpexCandidates(candidates);
  let winner = rankedWinner;

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
    const fallback = candidates
      .filter(
        (c) =>
          c.closureScore >= 0.75 &&
          !c.plausibilityFlags.includes("pnl_collision") &&
          !c.plausibilityFlags.includes("comparison_reject") &&
          isPlausibleOtherOperatingExpense(c.value, plausibilityCtx) &&
          !collidesWithResolvedPnl(c.value, resolved),
      )
      .sort((a, b) => b.totalScore - a.totalScore)[0];
    if (fallback) {
      resolved.values.other_operating_expenses = fallback.value;
      resolved.confidence.other_operating_expenses = confidenceFromCandidate(fallback);
      resolved.sources.other_operating_expenses = fallback.source;
    } else {
      const softFallback = candidates
        .filter(
          (c) =>
            c.closureScore >= 0.35 &&
            !c.plausibilityFlags.includes("pnl_collision") &&
            !/misc detail sum/i.test(c.source) &&
            isPlausibleOtherOperatingExpense(c.value, plausibilityCtx) &&
            !collidesWithResolvedPnl(c.value, resolved),
        )
        .sort((a, b) => b.totalScore - a.totalScore)[0];
      if (softFallback) {
        resolved.values.other_operating_expenses = softFallback.value;
        resolved.confidence.other_operating_expenses = confidenceFromCandidate(softFallback);
        resolved.sources.other_operating_expenses = softFallback.source;
      } else {
        const stmtDed = candidates.find(
          (c) =>
            /summed detail lines|small attachment residual|total minus bank/i.test(c.source) &&
            isPlausibleOtherOperatingExpense(c.value, plausibilityCtx) &&
            !collidesWithResolvedPnl(c.value, resolved),
        );
        if (stmtDed) {
          resolved.values.other_operating_expenses = stmtDed.value;
          resolved.confidence.other_operating_expenses = confidenceFromCandidate(stmtDed);
          resolved.sources.other_operating_expenses = stmtDed.source;
        }
      }
    }
    applyOrdinaryIncomeReverseOpex(resolved, ctx.allText, ctx.targetYear);
    flagPnlIdentityMismatches(resolved, ctx.allText, ctx.targetYear);
    return;
  }

  const existing = resolved.values.other_operating_expenses;
  const existingSource = resolved.sources.other_operating_expenses ?? "";
  const existingCandidate = candidates.find((c) => c.value === existing);
  const existingIsSubtractive = /comparison|residual|document-wide/i.test(existingSource);
  const winnerIsAuthoritativeDetail =
    /summed detail|misc detail closes|office\/supplies|telephone\/travel\/bank detail/i.test(
      winner.source,
    ) && winner.closureScore >= 0.85;

  const valueDelta =
    existing !== undefined
      ? Math.abs(existing - winner.value) / Math.max(Math.abs(winner.value), 1)
      : 1;
  const winnerBeatsExistingScore =
    existingCandidate !== undefined &&
    winner.totalScore > existingCandidate.totalScore + 12 &&
    winner.closureScore >= 0.88 &&
    existingCandidate.closureScore < 0.75;

  const existingIsWeakResidual = /comparison.*OTHER DEDUCTIONS residual|document-wide exclusion/i.test(
    existingSource,
  );
  const winnerIsOfficeDetail = /other deductions \(office/i.test(winner.source);

  const replace =
    existing === undefined ||
    collidesWithResolvedPnl(existing, resolved) ||
    !isPlausibleOtherOperatingExpense(existing, {
      sales: resolved.values.sales,
      stmt2Total: undefined,
      knownStmt2Lines: knownStmt2AttachmentSum(resolved, ctx.allText),
    }) ||
    (existingIsSubtractive && winnerIsAuthoritativeDetail && winner.totalScore >= 75) ||
    (existingIsWeakResidual && winnerIsOfficeDetail && winner.totalScore >= 75) ||
    valueDelta > 0.12 ||
    (winnerBeatsExistingScore && valueDelta > 0.02);

  if (replace) {
    const plausibilityCtx: OpexContext = {
      sales: resolved.values.sales,
      knownStmt2Lines: knownStmt2AttachmentSum(resolved, ctx.allText),
    };
    if (!isPlausibleOtherOperatingExpense(winner.value, plausibilityCtx)) {
      const fallback = candidates
        .filter(
          (c) =>
            !c.plausibilityFlags.includes("pnl_collision") &&
            !c.plausibilityFlags.includes("comparison_reject") &&
            isPlausibleOtherOperatingExpense(c.value, plausibilityCtx) &&
            !collidesWithResolvedPnl(c.value, resolved),
        )
        .sort((a, b) => b.totalScore - a.totalScore)[0];
      if (fallback) {
        winner = fallback;
      } else {
        const closureFallback = candidates
          .filter(
            (c) =>
              c.closureScore >= 0.85 &&
              !c.plausibilityFlags.includes("pnl_collision") &&
              !collidesWithResolvedPnl(c.value, resolved),
          )
          .sort(
            (a, b) =>
              b.closureScore - a.closureScore || b.totalScore - a.totalScore,
          )[0];
        if (!closureFallback) return;
        winner = closureFallback;
      }
    }
    resolved.values.other_operating_expenses = winner.value;
    resolved.confidence.other_operating_expenses = confidenceFromCandidate(winner);
    resolved.sources.other_operating_expenses = winner.source;
  }

  // When top-8 is strong, Form ordinary income reverse-math is authoritative for other_opex.
  applyOrdinaryIncomeReverseOpex(resolved, ctx.allText, ctx.targetYear);
  flagPnlIdentityMismatches(resolved, ctx.allText, ctx.targetYear);
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
  // Percentage of sales only — no fixed company-size dollar gates.
  if (ctx.sales === undefined || ctx.sales <= 0) return false;
  if (compOtherDed === undefined || compOtherDed < ctx.sales * 0.05) return false;

  const blockOpex = extractOtherDeductionsBlockOpex(ctx.allText);
  const plausibilityCtx: OpexContext = {
    sales: ctx.sales,
    stmt2Total: compOtherDed,
    knownStmt2Lines: knownStmt2AttachmentSum(resolved, ctx.allText),
  };
  if (
    blockOpex.opex === undefined ||
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
