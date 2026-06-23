import type { ResolvedFields } from "./merge";
import type { TaxFormKind } from "./detect-tax-form";
import type { parseTwoYearComparisonBlock } from "@/lib/two-year-comparison-parser";
import { consistencyScoreForField } from "@/lib/tax/cross-year-consistency";
import {
  extractOtherDeductionsBlockOpex,
  blockOpexClosesStatement,
  blockStmtTotalCorroborated,
  extractStatementDeductions,
  scanStatement2Total,
  scanStmt2MiscLineAmounts,
  scanDocumentWideStmt2Exclusions,
} from "./statement-extractors";
import { inferStmt2AttachmentTotal, knownStmt2AttachmentSum } from "./stmt2-total-inference";
import {
  pickComparisonOpex,
  computeComparisonOpexResidual,
  scanComparisonOtherDeductionsTotal,
  closesTruncatedStmt2Total,
  rejectComparisonOpexValue,
} from "./comparison-opex";
import { scanFormLine20OtherDeductionsTotal } from "./form-anchors";
import { closureTolerance } from "./structural-tolerance";
import {
  collidesWithResolvedPnl,
  isPlausibleOtherOperatingExpense,
  type OpexContext,
} from "./opex-plausibility";
import { scoreOpexCandidateBlended } from "@/lib/tax/ml/linear-ranker";

export type OpexCandidate = {
  value: number;
  source: string;
  closureScore: number;
  evidenceScore: number;
  consistencyScore: number;
  totalScore: number;
  plausibilityFlags: string[];
  valid: boolean;
};

export type OpexCandidateRankingResult = {
  winner?: OpexCandidate;
  candidates: OpexCandidate[];
};

function isLikelyStmt2TotalNotResidual(value: number, stmt2Total: number): boolean {
  return Math.abs(value - stmt2Total) <= Math.max(500, stmt2Total * 0.04);
}

function computeClosureScore(
  opex: number,
  stmt2Total: number | undefined,
  attachmentSum: number,
): number {
  if (stmt2Total === undefined || stmt2Total <= 0) return 0.5;
  const sum = attachmentSum + opex;
  const diff = Math.abs(sum - stmt2Total);
  const tol = closureTolerance(stmt2Total);
  if (diff <= tol) return 1;
  if (diff <= tol * 3) return 0.85;
  if (diff <= stmt2Total * 0.05) return 0.6;
  if (diff <= stmt2Total * 0.15) return 0.3;
  return 0;
}

function evidenceScoreForSource(source: string, detailPreferred?: boolean): number {
  if (/summed detail|detail lines|misc detail/i.test(source)) return detailPreferred ? 1 : 0.95;
  if (/other deductions \(office|office\/supplies|telephone\/travel/i.test(source)) return 0.96;
  if (/Statement 2 \(total minus/i.test(source)) return 0.75;
  if (/comparison.*OTHER DEDUCTIONS residual/i.test(source)) return 0.88;
  if (/comparison.*OTHER OPERATING/i.test(source)) return 0.82;
  if (/Form line 20 residual/i.test(source)) return 0.85;
  if (/Stmt 2 residual/i.test(source)) return 0.72;
  if (/misc detail closes/i.test(source)) return 0.92;
  if (/document-wide exclusion/i.test(source)) return 0.68;
  return 0.65;
}

function isDetailEvidenceSource(source: string): boolean {
  return /summed detail|detail lines|other deductions \(office|office\/supplies|misc detail closes|total minus util/i.test(
    source,
  );
}

function isSubtractiveResidualSource(source: string): boolean {
  return /residual|comparison.*residual/i.test(source);
}

function buildCandidate(
  value: number,
  source: string,
  ctx: {
    stmt2Total?: number;
    attachmentSum: number;
    plausibilityCtx: OpexContext;
    resolved: ResolvedFields;
    priorYearValues?: Record<number, Record<string, number>>;
    detailPreferred?: boolean;
    attachmentOverride?: number;
    stmtTotalOverride?: number;
  },
): OpexCandidate {
  const flags: string[] = [];
  const rounded = Math.round(value);
  const attachForClosure = ctx.attachmentOverride ?? ctx.attachmentSum;
  const stmtForClosure = ctx.stmtTotalOverride ?? ctx.stmt2Total;
  const plausibilityCtx = {
    ...ctx.plausibilityCtx,
    stmt2Total: stmtForClosure ?? ctx.plausibilityCtx.stmt2Total,
    knownStmt2Lines: attachForClosure,
  };

  if (collidesWithResolvedPnl(rounded, ctx.resolved)) flags.push("pnl_collision");
  if (!isPlausibleOtherOperatingExpense(rounded, plausibilityCtx)) flags.push("implausible");
  if (
    stmtForClosure !== undefined &&
    isLikelyStmt2TotalNotResidual(rounded, stmtForClosure)
  ) {
    flags.push("stmt2_total_trap");
  }
  if (rejectComparisonOpexValue(rounded, {
    attachmentSum: attachForClosure,
    stmt2Total: stmtForClosure,
  })) {
    flags.push("comparison_reject");
  }

  let closureScore = computeClosureScore(rounded, stmtForClosure, attachForClosure);
  if (/document exclusions/i.test(source)) {
    closureScore = Math.min(closureScore, 0.65);
  }
  if (
    /office\/supplies|telephone\/travel\/bank detail/i.test(source) &&
    closureScore < 0.6
  ) {
    flags.push("weak_block_closure");
  }
  const evidenceScore = evidenceScoreForSource(source, ctx.detailPreferred);
  const consistencyScore = consistencyScoreForField(
    "other_operating_expenses",
    rounded,
    ctx.priorYearValues,
  );

  const mlCtx = {
    sales: ctx.plausibilityCtx.sales,
    stmt2Total: stmtForClosure ?? ctx.plausibilityCtx.stmt2Total,
  };
  const draft: OpexCandidate = {
    value: rounded,
    source,
    closureScore,
    evidenceScore,
    consistencyScore,
    totalScore: 0,
    plausibilityFlags: flags,
    valid: flags.length === 0,
  };
  const totalScore = scoreOpexCandidateBlended(draft, mlCtx);

  return {
    ...draft,
    totalScore,
  };
}

function stmt2ResidualCandidate(
  stmt2Total: number,
  resolved: ResolvedFields,
  allText: string,
): { value: number; source: string } | undefined {
  const wideExcl = scanDocumentWideStmt2Exclusions(allText);
  const baseKnown = knownStmt2AttachmentSum(resolved, allText);
  const knownWithWide =
    wideExcl >= 500 && baseKnown + wideExcl < stmt2Total * 0.92
      ? baseKnown + wideExcl
      : baseKnown;

  const withAmort = Math.round(stmt2Total - knownWithWide);
  if (withAmort >= 1_000 && withAmort < stmt2Total && !isLikelyStmt2TotalNotResidual(withAmort, stmt2Total)) {
    return {
      value: withAmort,
      source:
        wideExcl >= 500
          ? "Stmt 2 residual (minus known lines + document exclusions)"
          : "Stmt 2 residual (minus known attachment lines)",
    };
  }
  const bankProfUtil = [
    resolved.values.bank_credit_card,
    resolved.values.professional_fees,
    resolved.values.utilities,
  ]
    .filter((n): n is number => n !== undefined)
    .reduce((sum, n) => sum + Math.abs(n), 0);
  const withoutAmort = Math.round(stmt2Total - bankProfUtil);
  if (
    withoutAmort >= 1_000 &&
    withoutAmort < stmt2Total &&
    withoutAmort !== withAmort &&
    !isLikelyStmt2TotalNotResidual(withoutAmort, stmt2Total)
  ) {
    return { value: withoutAmort, source: "Stmt 2 residual (excl amortization)" };
  }
  return undefined;
}

/** Generate all opex candidates from existing extractors — no client-specific branches. */
export function generateOpexCandidates(
  resolved: ResolvedFields,
  ctx: {
    allText: string;
    formKind: TaxFormKind;
    targetYear: number;
    comparison?: ReturnType<typeof parseTwoYearComparisonBlock>;
    priorYearValues?: Record<number, Record<string, number>>;
  },
): OpexCandidate[] {
  const attachmentSumEarly = knownStmt2AttachmentSum(resolved, ctx.allText);
  const compStmt2Early =
    ctx.targetYear !== undefined
      ? scanComparisonOtherDeductionsTotal(ctx.allText, ctx.targetYear)
      : undefined;
  const stmt2TotalEarly = inferStmt2AttachmentTotal(ctx.allText, ctx.formKind, resolved, {
    targetYear: ctx.targetYear,
  });

  const plausibilityCtx: OpexContext = {
    sales: resolved.values.sales,
    stmt2Total: stmt2TotalEarly,
    knownStmt2Lines: attachmentSumEarly,
    priorYearValues: ctx.priorYearValues,
  };

  const compPick = pickComparisonOpex(
    ctx.allText,
    ctx.targetYear,
    ctx.comparison,
    { attachmentSum: attachmentSumEarly, stmt2Total: stmt2TotalEarly },
    resolved,
  );

  const stmt2Total = inferStmt2AttachmentTotal(ctx.allText, ctx.formKind, resolved, {
    comparisonOpex: compPick?.value,
    targetYear: ctx.targetYear,
  });
  plausibilityCtx.stmt2Total = stmt2Total;
  plausibilityCtx.knownStmt2Lines = knownStmt2AttachmentSum(resolved, ctx.allText);

  const attachmentSum = knownStmt2AttachmentSum(resolved, ctx.allText);
  const wideExcl = scanDocumentWideStmt2Exclusions(ctx.allText);
  const attachmentForClosure =
    wideExcl >= 500 && attachmentSum + wideExcl < (stmt2Total ?? Infinity) * 0.92
      ? attachmentSum + wideExcl
      : attachmentSum;

  const candCtx = {
    stmt2Total,
    attachmentSum: attachmentForClosure,
    plausibilityCtx,
    resolved,
    priorYearValues: ctx.priorYearValues,
  };

  const raw: Array<{
    value: number;
    source: string;
    detailPreferred?: boolean;
    attachmentOverride?: number;
    stmtTotalOverride?: number;
  }> = [];

  const blockOpex = extractOtherDeductionsBlockOpex(ctx.allText);
  const form20Early = scanFormLine20OtherDeductionsTotal(ctx.allText, ctx.formKind);
  if (blockOpex.opex !== undefined) {
    const blockClosesInternally =
      blockOpex.stmtTotal !== undefined &&
      blockOpex.excludedSum !== undefined &&
      Math.abs(blockOpex.excludedSum + blockOpex.opex - blockOpex.stmtTotal) <=
        closureTolerance(blockOpex.stmtTotal);
    const corroborated = blockStmtTotalCorroborated(blockOpex.stmtTotal, [
      stmt2TotalEarly,
      form20Early,
      compStmt2Early,
    ]);
    const attachForBlock =
      blockOpex.excludedSum ??
      (blockOpex.stmtTotal !== undefined &&
      blockOpex.opex !== undefined &&
      (corroborated || blockClosesInternally)
        ? blockOpex.stmtTotal - blockOpex.opex
        : undefined);
    raw.push({
      value: blockOpex.opex,
      source: blockOpex.source,
      detailPreferred: blockOpex.detailPreferred,
      attachmentOverride: attachForBlock,
      stmtTotalOverride:
        corroborated || blockClosesInternally ? blockOpex.stmtTotal : undefined,
    });
  }

  const stmtDedOpex = extractStatementDeductions(ctx.allText).values.other_operating_expenses;
  if (stmtDedOpex !== undefined) {
    raw.push({ value: stmtDedOpex, source: "Statement 2 (summed detail lines)", detailPreferred: true });
  }

  if (compPick !== undefined) {
    raw.push({ value: compPick.value, source: compPick.source });
  }

  const compResidual = computeComparisonOpexResidual(
    ctx.allText,
    ctx.targetYear,
    attachmentSum,
    { attachmentSum, stmt2Total },
    resolved,
  );
  if (compResidual !== undefined && compPick?.value !== compResidual.value) {
    raw.push({
      value: compResidual.value,
      source: "Two-year comparison (OTHER DEDUCTIONS residual, full exclusions)",
    });
  }

  const form20 = scanFormLine20OtherDeductionsTotal(ctx.allText, ctx.formKind);
  if (form20 !== undefined && attachmentSum > 0) {
    const formResidual = Math.round(form20 - knownStmt2AttachmentSum(resolved, ctx.allText));
    if (formResidual >= 1_000) {
      raw.push({
        value: formResidual,
        source: "Form line 20 residual (Stmt 2 attachment total)",
      });
    }
  }

  if (stmt2Total !== undefined) {
    const residual = stmt2ResidualCandidate(stmt2Total, resolved, ctx.allText);
    if (residual) raw.push(residual);

    const wideExcl = scanDocumentWideStmt2Exclusions(ctx.allText);
    if (wideExcl >= 5_000) {
      const prof = resolved.values.professional_fees ?? 0;
      const util = resolved.values.utilities ?? 0;
      const bank = resolved.values.bank_credit_card ?? 0;
      const extendedAttach = prof + util + bank + wideExcl;
      const docResidual = Math.round(stmt2Total - extendedAttach);
      if (docResidual >= 1_000 && docResidual < stmt2Total * 0.85) {
        raw.push({
          value: docResidual,
          source: "Document-wide exclusion residual",
        });
      }
    }
  }

  const miscLines = scanStmt2MiscLineAmounts(ctx.allText);
  const miscSum = miscLines.reduce((sum, n) => sum + n, 0);
  if (miscSum >= 1_000) {
    raw.push({
      value: Math.round(miscSum),
      source: "Statement 2 (misc detail sum)",
      detailPreferred: true,
    });
  }
  for (const n of miscLines.filter((x) => x >= 1_000)) {
    if (
      stmt2Total !== undefined &&
      attachmentSum > 0 &&
      attachmentSum + n > stmt2Total * 1.002 &&
      attachmentSum + n <= stmt2Total * 1.15
    ) {
      const stmt2Scan = scanStatement2Total(ctx.allText);
      if (stmt2Scan === undefined || !closesTruncatedStmt2Total(n, attachmentSum, stmt2Scan)) {
        raw.push({
          value: n,
          source: "Statement 2 (misc detail closes Stmt 2 total)",
          detailPreferred: true,
        });
      }
    }
  }

  const seen = new Set<number>();
  const candidates: OpexCandidate[] = [];
  for (const r of raw) {
    const key = `${r.value}:${r.source.slice(0, 40)}`;
    if (seen.has(r.value) && /comparison/i.test(r.source)) continue;
    seen.add(r.value);
    candidates.push(
      buildCandidate(r.value, r.source, {
        ...candCtx,
        detailPreferred: r.detailPreferred,
        attachmentOverride: r.attachmentOverride,
        stmtTotalOverride: r.stmtTotalOverride,
      }),
    );
  }

  return candidates.sort((a, b) => b.totalScore - a.totalScore);
}

export function rankOpexCandidates(candidates: OpexCandidate[]): OpexCandidateRankingResult {
  const valid = candidates.filter((c) => c.valid);
  if (valid.length) {
    let winner = valid.reduce((best, c) => (c.totalScore > best.totalScore ? c : best));

    const detailPool = valid.filter((c) => isDetailEvidenceSource(c.source));
    if (isSubtractiveResidualSource(winner.source) && detailPool.length) {
      const bestDetail = detailPool.reduce((best, c) =>
        c.evidenceScore > best.evidenceScore ||
        (c.evidenceScore === best.evidenceScore && c.totalScore > best.totalScore)
          ? c
          : best,
      );
      if (
        bestDetail.value >= 1_000 &&
        winner.value > bestDetail.value * 1.2 &&
        bestDetail.evidenceScore >= 0.9 &&
        Math.abs(winner.value - bestDetail.value) / Math.max(winner.value, 1) <= 0.2
      ) {
        winner = bestDetail;
      }
    }

    if (/summed detail lines/i.test(winner.source)) {
      const miscCloses = detailPool.find(
        (c) => /misc detail closes/i.test(c.source) && c.closureScore >= 0.85,
      );
      if (miscCloses && miscCloses.totalScore >= winner.totalScore - 0.5) {
        winner = miscCloses;
      }
    }

    if (/misc detail sum/i.test(winner.source) && detailPool.length) {
      const authoritativeDetail = detailPool
        .filter((c) => !/misc detail sum/i.test(c.source))
        .reduce<OpexCandidate | undefined>(
          (best, c) => (!best || c.evidenceScore > best.evidenceScore ? c : best),
          undefined,
        );
      if (authoritativeDetail && authoritativeDetail.evidenceScore >= 0.9) {
        winner = authoritativeDetail;
      }
    }

    const officeDetail = detailPool.find((c) => /other deductions \(office/i.test(c.source));
    if (officeDetail && officeDetail.value >= 1_000) {
      const winnerIsWeakSummed =
        /summed detail lines/i.test(winner.source) && winner.closureScore < 0.5;
      const winnerIsInflatedDetail =
        isDetailEvidenceSource(winner.source) &&
        !/other deductions \(office/i.test(winner.source) &&
        winner.value >= officeDetail.value * 1.1;
      if (
        officeDetail.closureScore >= 0.85 &&
        officeDetail.evidenceScore >= 0.9 &&
        (winnerIsWeakSummed || winnerIsInflatedDetail)
      ) {
        winner = officeDetail;
      } else if (
        winner.value >= officeDetail.value * 1.4 &&
        isDetailEvidenceSource(winner.source) &&
        !/other deductions \(office/i.test(winner.source)
      ) {
        winner = officeDetail;
      }
    }

    const compResidual = valid.find((c) =>
      /comparison.*OTHER DEDUCTIONS residual/i.test(c.source),
    );
    if (
      compResidual &&
      winner.value > compResidual.value * 1.15 &&
      Math.abs(compResidual.value - winner.value) / Math.max(compResidual.value, 1) > 0.12
    ) {
      const detailNearComp = detailPool.find(
        (c) => Math.abs(c.value - compResidual.value) <= Math.max(500, compResidual.value * 0.02),
      );
      if (detailNearComp) {
        winner = detailNearComp;
      } else if (compResidual.evidenceScore >= 0.85) {
        winner = compResidual;
      }
    }

    const miscClosesWinner = valid.find(
      (c) => /misc detail closes/i.test(c.source) && c.closureScore >= 0.85,
    );
    if (
      miscClosesWinner &&
      isSubtractiveResidualSource(winner.source) &&
      winner.closureScore >= 0.85 &&
      Math.abs(winner.value - miscClosesWinner.value) / Math.max(winner.value, 1) > 0.05 &&
      miscClosesWinner.value >= winner.value * 0.85 &&
      miscClosesWinner.value <= winner.value * 1.15
    ) {
      winner = miscClosesWinner;
    }

    return { winner, candidates };
  }

  // No fully valid candidates — prefer high-closure reads that aren't comparison traps.
  const softPool = candidates.filter(
    (c) =>
      !c.plausibilityFlags.includes("comparison_reject") &&
      !c.plausibilityFlags.includes("stmt2_total_trap") &&
      !c.plausibilityFlags.includes("pnl_collision") &&
      c.closureScore >= 0.6,
  );
  if (softPool.length) {
    const winner = softPool.reduce((best, c) => (c.totalScore > best.totalScore ? c : best));
    return { winner, candidates };
  }

  // Last resort: best closure among detail sources; never pick misc sum over detail sum.
  const detailPool = candidates.filter(
    (c) =>
      /summed detail|detail lines|misc detail closes|total minus/i.test(c.source) &&
      !c.plausibilityFlags.includes("comparison_reject"),
  );
  if (detailPool.length) {
    const winner = detailPool.reduce((best, c) =>
      c.closureScore > best.closureScore || (c.closureScore === best.closureScore && c.totalScore > best.totalScore)
        ? c
        : best,
    );
    return { winner, candidates };
  }

  return { winner: undefined, candidates };
}

/** Confidence 0–99 from ranked candidate scores. */
export function confidenceFromCandidate(c: OpexCandidate): number {
  const base = Math.round(c.totalScore * 0.95);
  if (c.plausibilityFlags.length) return Math.min(base, 72);
  if (/verify|residual/i.test(c.source)) return Math.min(base, 88);
  return Math.min(Math.max(base, 70), 96);
}
