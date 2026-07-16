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
  const exact = candidates.find((c) => c.value === finalValue && c.source === finalSource);
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

function isExactCloser(c: OpexCandidate): boolean {
  return c.closureScore >= 1;
}

function isIdentityResidualSource(source: string): boolean {
  return /total minus bank|OTHER DEDUCTIONS residual|Form line 20 residual|itemized closure|partition|stmtTOTAL|stmtInTop8/i.test(
    source,
  );
}

/**
 * Paste only from exact TOTAL closers or identity residuals — no softFallback / valueDelta.
 * Align path still owns final residual identity after top-8.
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
  // Paste from exact TOTAL closers only — never soft % rankedWinner fallback.
  const exactWinners = candidates
    .filter(
      (c) =>
        isExactCloser(c) &&
        !c.plausibilityFlags.includes("pnl_collision") &&
        !c.plausibilityFlags.includes("comparison_reject"),
    )
    .sort((a, b) => b.evidenceScore - a.evidenceScore || b.consistencyScore - a.consistencyScore);
  let winner = exactWinners[0];

  const debug: OpexReconcileDebug = {
    candidates,
    chosenSource: winner?.source,
    chosenScore: winner?.totalScore,
  };
  ctx.debugOut?.(debug);

  const plausibilityCtx: OpexContext = {
    sales: resolved.values.sales,
    knownStmt2Lines: knownStmt2AttachmentSum(resolved, ctx.allText),
  };

  if (!winner) {
    const cur = resolved.values.other_operating_expenses;
    if (
      cur !== undefined &&
      (collidesWithResolvedPnl(cur, resolved) ||
        !isPlausibleOtherOperatingExpense(cur, plausibilityCtx))
    ) {
      delete resolved.values.other_operating_expenses;
      delete resolved.confidence.other_operating_expenses;
      delete resolved.sources.other_operating_expenses;
    }
    const exactFallback = candidates
      .filter(
        (c) =>
          isExactCloser(c) &&
          !c.plausibilityFlags.includes("pnl_collision") &&
          isPlausibleOtherOperatingExpense(c.value, plausibilityCtx) &&
          !collidesWithResolvedPnl(c.value, resolved),
      )
      .sort((a, b) => b.evidenceScore - a.evidenceScore)[0];
    if (exactFallback) {
      resolved.values.other_operating_expenses = exactFallback.value;
      resolved.confidence.other_operating_expenses = confidenceFromCandidate(exactFallback);
      resolved.sources.other_operating_expenses = exactFallback.source;
    } else if (resolved.values.other_operating_expenses === undefined) {
      const identity = candidates.find(
        (c) =>
          isIdentityResidualSource(c.source) &&
          isPlausibleOtherOperatingExpense(c.value, plausibilityCtx) &&
          !collidesWithResolvedPnl(c.value, resolved),
      );
      if (identity) {
        resolved.values.other_operating_expenses = identity.value;
        resolved.confidence.other_operating_expenses = confidenceFromCandidate(identity);
        resolved.sources.other_operating_expenses = identity.source;
      }
    }
    applyOrdinaryIncomeReverseOpex(resolved, ctx.allText, ctx.targetYear);
    flagPnlIdentityMismatches(resolved, ctx.allText, ctx.targetYear);
    return;
  }

  const existing = resolved.values.other_operating_expenses;
  const existingSource = resolved.sources.other_operating_expenses ?? "";
  const existingExact =
    existing !== undefined &&
    candidates.some((c) => Math.round(c.value) === Math.round(existing) && isExactCloser(c));
  const existingIdentity = isIdentityResidualSource(existingSource);
  const winnerExact = isExactCloser(winner);

  const replace =
    existing === undefined ||
    collidesWithResolvedPnl(existing, resolved) ||
    !isPlausibleOtherOperatingExpense(existing, plausibilityCtx) ||
    (winnerExact && !existingExact && !existingIdentity) ||
    (winnerExact &&
      existing !== undefined &&
      Math.round(existing) !== Math.round(winner.value) &&
      (/comparison|OCR|fuzzy|document-wide/i.test(existingSource) || !existingExact));

  // Non-exact ranked winners must not overwrite extraction via soft % / score deltas.
  if (replace && (winnerExact || existing === undefined || !existingIdentity)) {
    if (!winnerExact && existing !== undefined && existingIdentity) {
      // Keep identity residual over soft ranked candidate.
    } else if (!isPlausibleOtherOperatingExpense(winner.value, plausibilityCtx)) {
      const exactOk = exactWinners.find(
        (c) =>
          isPlausibleOtherOperatingExpense(c.value, plausibilityCtx) &&
          !collidesWithResolvedPnl(c.value, resolved),
      );
      if (exactOk) {
        winner = exactOk;
        resolved.values.other_operating_expenses = winner.value;
        resolved.confidence.other_operating_expenses = confidenceFromCandidate(winner);
        resolved.sources.other_operating_expenses = winner.source;
      }
    } else if (winnerExact || existing === undefined) {
      resolved.values.other_operating_expenses = winner.value;
      resolved.confidence.other_operating_expenses = confidenceFromCandidate(winner);
      resolved.sources.other_operating_expenses = winner.source;
    }
  }

  applyOrdinaryIncomeReverseOpex(resolved, ctx.allText, ctx.targetYear);
  flagPnlIdentityMismatches(resolved, ctx.allText, ctx.targetYear);
}

/** Block opex overlay when construction closes an independent OD TOTAL — not a sales-ratio gate. */
export function applyLargeCorpBlockOpexOverride(
  resolved: ResolvedFields,
  ctx: {
    allText: string;
    targetYear: number;
    sales?: number;
  },
): boolean {
  const compOtherDed = scanComparisonOtherDeductionsTotal(ctx.allText, ctx.targetYear);
  if (compOtherDed === undefined || compOtherDed < 1) return false;

  const block = extractOtherDeductionsBlockOpex(ctx.allText);
  if (block.opex === undefined || block.stmtTotal === undefined) return false;
  if (!blockOpexClosesStatement(block, resolved, ctx.allText)) return false;
  if (!(block.opex >= 1 && block.opex < block.stmtTotal)) return false;

  resolved.values.other_operating_expenses = Math.round(block.opex);
  resolved.confidence.other_operating_expenses = 93;
  resolved.sources.other_operating_expenses = block.source;
  return true;
}
