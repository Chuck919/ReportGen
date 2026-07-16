import type { ResolvedFields } from "./merge";
import type { TaxFormKind } from "./detect-tax-form";
import type { parseTwoYearComparisonBlock } from "@/lib/two-year-comparison-parser";
import { consistencyScoreForField } from "@/lib/tax/cross-year-consistency";
import {
  extractOtherDeductionsBlockOpex,
  blockStmtTotalCorroborated,
  extractStatementDeductions,
  extractStatement3OtherOperatingExpenses,
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
  comparisonWorksheetIncomplete,
} from "./comparison-opex";
import { scanFormLine20OtherDeductionsTotal, scanFormLineOtherDeductionsTotalBest } from "./form-anchors";
import { exactClosureTolerance } from "./structural-tolerance";
import {
  collidesWithResolvedPnl,
  isPlausibleOtherOperatingExpense,
  type OpexContext,
} from "./opex-plausibility";
import {
  candidateClosesOrdinaryIncome,
  deriveOtherOpexFromOrdinaryIncome,
  scanFormOrdinaryBusinessIncome,
} from "./pnl-identity";

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
  return (
    Math.abs(Math.round(value) - Math.round(stmt2Total)) <= exactClosureTolerance(stmt2Total)
  );
}

/** Candidate equals Form/Stmt footer — not a residual leftover. */
function isFooterEcho(value: number, footer: number): boolean {
  return Math.abs(Math.round(value) - Math.round(footer)) <= exactClosureTolerance(footer);
}

/**
 * Closure quality for ranking. Dollar-exact TOTAL agreement only (charter) —
 * no 5%/15% / max($50,1%) soft bands that can flip paste winners.
 */
function computeClosureScore(
  opex: number,
  stmt2Total: number | undefined,
  attachmentSum: number,
): number {
  if (stmt2Total === undefined || stmt2Total <= 0) return 0;
  const sum = attachmentSum + opex;
  const diff = Math.abs(sum - stmt2Total);
  return diff <= exactClosureTolerance(stmt2Total) ? 1 : 0;
}

/** Prefer left over right: exact closure first, then source evidence, then consistency. */
function preferCandidate(a: OpexCandidate, b: OpexCandidate): OpexCandidate {
  if (a.closureScore !== b.closureScore) return a.closureScore > b.closureScore ? a : b;
  const aDetail = isDetailEvidenceSource(a.source) ? 1 : 0;
  const bDetail = isDetailEvidenceSource(b.source) ? 1 : 0;
  if (aDetail !== bDetail) return aDetail > bDetail ? a : b;
  if (a.evidenceScore !== b.evidenceScore) return a.evidenceScore > b.evidenceScore ? a : b;
  if (a.consistencyScore !== b.consistencyScore) {
    return a.consistencyScore > b.consistencyScore ? a : b;
  }
  return a;
}

/** Discrete source priority (integers) — not %-looking floats that steer soft winners. */
function evidenceScoreForSource(source: string, detailPreferred?: boolean): number {
  if (/summed detail|detail lines|misc detail/i.test(source)) return detailPreferred ? 100 : 95;
  if (/statement 3/i.test(source)) return detailPreferred ? 97 : 94;
  if (/other deductions \(office|office\/supplies|telephone\/travel/i.test(source)) return 96;
  if (/misc detail closes/i.test(source)) return 92;
  if (/federal table minus slot/i.test(source)) return 93;
  if (/small attachment residual/i.test(source)) return 90;
  if (/comparison.*OTHER DEDUCTIONS residual/i.test(source)) return 88;
  if (/Form line 20 residual/i.test(source)) return 85;
  if (/comparison.*OTHER OPERATING/i.test(source)) return 82;
  if (/Statement 2 \(total minus/i.test(source)) return 75;
  if (/P&L reverse math|ordinary income/i.test(source)) return 72;
  if (/Stmt 2 residual/i.test(source)) return 72;
  if (/document-wide exclusion/i.test(source)) return 68;
  return 65;
}

function isWeakResidualSource(source: string): boolean {
  return /comparison.*residual|document-wide exclusion residual|stmt 2 residual|form line 20 residual/i.test(
    source,
  );
}

function isDetailEvidenceSource(source: string): boolean {
  return /summed detail|detail lines|other deductions \(office|office\/supplies|misc detail closes|total minus util|total minus util\/merchant|federal table minus slot|statement 3/i.test(
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
    comparisonIncomplete?: boolean;
    formLineOtherDedTotal?: number;
    ordinaryIncome?: number;
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
  const closesPnl =
    ctx.ordinaryIncome !== undefined &&
    candidateClosesOrdinaryIncome(
      ctx.resolved.values,
      rounded,
      ctx.ordinaryIncome,
      ctx.resolved.sources,
    );
  // Identity tags are ranking signals only — they do not invalidate a candidate.
  const identityFlags: string[] = [];
  if (closesPnl) identityFlags.push("pnl_identity_close");
  else if (ctx.ordinaryIncome !== undefined) identityFlags.push("pnl_identity_gap");
  if (
    stmtForClosure !== undefined &&
    isLikelyStmt2TotalNotResidual(rounded, stmtForClosure)
  ) {
    flags.push("stmt2_total_trap");
  }
  if (
    ctx.formLineOtherDedTotal !== undefined &&
    isLikelyStmt2TotalNotResidual(rounded, ctx.formLineOtherDedTotal)
  ) {
    flags.push("form_line_total_trap");
  }
  if (rejectComparisonOpexValue(rounded, {
    attachmentSum: attachForClosure,
    stmt2Total: stmtForClosure,
  })) {
    flags.push("comparison_reject");
  }
  if (
    ctx.comparisonIncomplete &&
    /comparison.*OTHER DEDUCTIONS residual|document-wide exclusion residual/i.test(source)
  ) {
    flags.push("comparison_reject");
  }

  let closureScore = computeClosureScore(rounded, stmtForClosure, attachForClosure);
  // Office inventory is invalid only when it cannot be a proper TOTAL remainder.
  if (
    /office\/supplies|telephone\/travel\/bank detail/i.test(source) &&
    stmtForClosure !== undefined &&
    stmtForClosure > 0 &&
    (rounded >= stmtForClosure ||
      (attachForClosure > 0 && attachForClosure + rounded > stmtForClosure))
  ) {
    flags.push("weak_block_closure");
  }
  const evidenceScore = evidenceScoreForSource(source, ctx.detailPreferred);
  const consistencyScore = consistencyScoreForField(
    "other_operating_expenses",
    rounded,
    ctx.priorYearValues,
  );

  // Exact closure dominates; source evidence breaks ties — no ML 0.35/0.65 blend on paste.
  let totalScore = closureScore * 1000 + evidenceScore + consistencyScore;
  if (closesPnl) totalScore += 25;
  else if (identityFlags.includes("pnl_identity_gap")) totalScore -= 8;
  const draft: OpexCandidate = {
    value: rounded,
    source,
    closureScore,
    evidenceScore,
    consistencyScore,
    totalScore: 0,
    plausibilityFlags: [...flags, ...identityFlags],
    valid: flags.length === 0,
  };

  return {
    ...draft,
    totalScore,
  };
}

/**
 * Fold document-wide category exclusions into "known" only when the combined sum
 * stays strictly below Stmt TOTAL (proper residual remainder). Replaces the old
 * ×0.92 soft band that papered over double-counting between known slots and the
 * wide scrape — charter identity at align owns final other_opex.
 */
function foldWideExclusionsIntoKnown(
  stmt2Total: number,
  baseKnown: number,
  wideExcl: number,
): number {
  if (wideExcl < 1 || !(stmt2Total > 0)) return baseKnown;
  const combined = baseKnown + wideExcl;
  if (combined > 0 && combined < stmt2Total) return combined;
  return baseKnown;
}

function stmt2ResidualCandidate(
  stmt2Total: number,
  resolved: ResolvedFields,
  allText: string,
): { value: number; source: string } | undefined {
  const wideExcl = scanDocumentWideStmt2Exclusions(allText);
  const baseKnown = knownStmt2AttachmentSum(resolved, allText);
  const knownWithWide = foldWideExclusionsIntoKnown(stmt2Total, baseKnown, wideExcl);

  const withAmort = Math.round(stmt2Total - knownWithWide);
  const plausibilityCtx: OpexContext = {
    sales: resolved.values.sales,
    stmt2Total,
    knownStmt2Lines: knownWithWide,
  };
  if (
    withAmort >= 0 &&
    withAmort < stmt2Total &&
    !isLikelyStmt2TotalNotResidual(withAmort, stmt2Total) &&
    isPlausibleOtherOperatingExpense(withAmort, plausibilityCtx)
  ) {
    return {
      value: withAmort,
      source:
        knownWithWide > baseKnown
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
    withoutAmort >= 0 &&
    withoutAmort < stmt2Total &&
    withoutAmort !== withAmort &&
    !isLikelyStmt2TotalNotResidual(withoutAmort, stmt2Total) &&
    isPlausibleOtherOperatingExpense(withoutAmort, plausibilityCtx)
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
    ctx.formKind,
  );

  const stmt2Total = inferStmt2AttachmentTotal(ctx.allText, ctx.formKind, resolved, {
    comparisonOpex: compPick?.value,
    targetYear: ctx.targetYear,
  });
  plausibilityCtx.stmt2Total = stmt2Total;
  plausibilityCtx.knownStmt2Lines = knownStmt2AttachmentSum(resolved, ctx.allText);

  const attachmentSum = knownStmt2AttachmentSum(resolved, ctx.allText);
  const wideExcl = scanDocumentWideStmt2Exclusions(ctx.allText);
  const comparisonIncomplete = comparisonWorksheetIncomplete(ctx.allText, ctx.targetYear);
  const attachmentForClosure =
    stmt2Total !== undefined
      ? foldWideExclusionsIntoKnown(stmt2Total, attachmentSum, wideExcl)
      : attachmentSum;

  const form20Early = scanFormLineOtherDeductionsTotalBest(ctx.allText, ctx.formKind);
  const ordinaryIncome = scanFormOrdinaryBusinessIncome(ctx.allText, ctx.targetYear);

  const candCtx = {
    stmt2Total,
    attachmentSum: attachmentForClosure,
    plausibilityCtx,
    resolved,
    priorYearValues: ctx.priorYearValues,
    comparisonIncomplete,
    formLineOtherDedTotal: form20Early,
    ordinaryIncome,
  };

  const raw: Array<{
    value: number;
    source: string;
    detailPreferred?: boolean;
    attachmentOverride?: number;
    stmtTotalOverride?: number;
  }> = [];

  const blockOpex = extractOtherDeductionsBlockOpex(ctx.allText);
  if (blockOpex.opex !== undefined) {
    const blockClosesInternally =
      blockOpex.stmtTotal !== undefined &&
      blockOpex.excludedSum !== undefined &&
      Math.abs(blockOpex.excludedSum + blockOpex.opex - blockOpex.stmtTotal) <=
        exactClosureTolerance(blockOpex.stmtTotal);
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
  // Include summed detail unless it is the stmt/Form-20 footer itself.
  if (
    stmtDedOpex !== undefined &&
    (stmt2Total === undefined || !isFooterEcho(stmtDedOpex, stmt2Total)) &&
    (form20Early === undefined || !isFooterEcho(stmtDedOpex, form20Early))
  ) {
    raw.push({ value: stmtDedOpex, source: "Statement 2 (summed detail lines)", detailPreferred: true });
  }

  const stmt3Opex = extractStatement3OtherOperatingExpenses(ctx.allText).values.other_operating_expenses;
  if (
    stmt3Opex !== undefined &&
    stmt3Opex >= 1 &&
    (stmt2Total === undefined || !isFooterEcho(stmt3Opex, stmt2Total)) &&
    (form20Early === undefined || !isFooterEcho(stmt3Opex, form20Early))
  ) {
    raw.push({
      value: stmt3Opex,
      source: "Statement 3 (total minus util/merchant/auto/licenses)",
      detailPreferred: true,
    });
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
    ctx.formKind,
  );
  if (compResidual !== undefined && compPick?.value !== compResidual.value) {
    raw.push({
      value: compResidual.value,
      source: "Two-year comparison (OTHER DEDUCTIONS residual, full exclusions)",
    });
  }

  const form20 = scanFormLineOtherDeductionsTotalBest(ctx.allText, ctx.formKind);
  if (form20 !== undefined) {
    const attach = knownStmt2AttachmentSum(resolved, ctx.allText);
    const formResidual = Math.round(form20 - attach);
    if (
      formResidual >= 1 &&
      attach >= 1 &&
      // Residual must be a leftover, not the Form-20 footer itself.
      !isFooterEcho(formResidual, form20) &&
      formResidual < form20
    ) {
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
    if (wideExcl >= 1) {
      const prof = resolved.values.professional_fees ?? 0;
      const util = resolved.values.utilities ?? 0;
      const bank = resolved.values.bank_credit_card ?? 0;
      const extendedAttach = Math.round(prof + util + bank + wideExcl);
      // Soft ranking candidate only — must leave a proper remainder (< TOTAL).
      if (extendedAttach > 0 && extendedAttach < stmt2Total) {
        const docResidual = Math.round(stmt2Total - extendedAttach);
        if (docResidual >= 1 && docResidual < stmt2Total) {
          raw.push({
            value: docResidual,
            source: "Document-wide exclusion residual",
          });
        }
      }
    }
  }

  if (ordinaryIncome !== undefined) {
    const reverseOpex = deriveOtherOpexFromOrdinaryIncome(
      resolved.values,
      ordinaryIncome,
      resolved.sources,
    );
    if (reverseOpex !== undefined) {
      raw.push({
        value: reverseOpex,
        source: "P&L reverse math (Form ordinary income − top-8 − known lines)",
      });
    }
  }

  const miscLines = scanStmt2MiscLineAmounts(ctx.allText);
  // Unlabeled misc soup is not an other_opex candidate by size. Only nominate a misc amount
  // when attachment + amount closes the Stmt TOTAL (identity) — no $500 / sales floors.
  if (stmt2Total !== undefined && attachmentSum > 0) {
    for (const n of miscLines) {
      const abs = Math.round(Math.abs(n));
      if (abs < 1) continue;
      if (closesTruncatedStmt2Total(abs, attachmentSum, stmt2Total)) {
        raw.push({
          value: abs,
          source: "Statement 2 (misc detail closes Stmt 2 total)",
          detailPreferred: true,
        });
      }
    }
  }

  const seen = new Set<number>();
  const candidates: OpexCandidate[] = [];
  for (const r of raw) {
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
    // 1) Prefer Form ordinary-income identity closers when present.
    const identityWinners = valid.filter((c) => c.plausibilityFlags.includes("pnl_identity_close"));
    let pool = identityWinners.length ? identityWinners : valid;

    // 2) Prefer dollar-exact TOTAL closers over soft score/% winner swaps.
    const exactClosers = pool.filter((c) => c.closureScore >= 1);
    if (exactClosers.length) pool = exactClosers;

    let winner = pool.reduce((best, c) => preferCandidate(c, best));

    // 3) Structural source preferences — evidence only, no relative size bands.
    const detailPool = valid.filter((c) => isDetailEvidenceSource(c.source));
    const federalDetail = valid.find((c) => /federal table minus slot/i.test(c.source));
    if (federalDetail && isWeakResidualSource(winner.source)) {
      winner = federalDetail;
    }

    const miscCloses = valid.find((c) => /misc detail closes/i.test(c.source) && c.closureScore >= 1);
    if (
      miscCloses &&
      isSubtractiveResidualSource(winner.source) &&
      winner.closureScore >= 1
    ) {
      winner = miscCloses;
    }

    if (/misc detail sum/i.test(winner.source) && detailPool.length) {
      const authoritativeDetail = detailPool
        .filter((c) => !/misc detail sum/i.test(c.source))
        .reduce<OpexCandidate | undefined>(
          (best, c) => (!best || preferCandidate(c, best) === c ? c : best),
          undefined,
        );
      if (authoritativeDetail) winner = authoritativeDetail;
    }

    if (
      /P&L reverse math/i.test(winner.source) &&
      detailPool.length
    ) {
      const bestDetail = detailPool.reduce((best, c) => preferCandidate(c, best));
      winner = bestDetail;
    }

    if (
      /comparison.*OTHER DEDUCTIONS residual/i.test(winner.source)
    ) {
      const officeDetail = valid.find(
        (c) =>
          /other deductions \(office|office\/supplies|telephone\/travel\/bank detail/i.test(
            c.source,
          ) && !c.plausibilityFlags.includes("weak_block_closure"),
      );
      if (officeDetail && preferCandidate(officeDetail, winner) === officeDetail) {
        winner = officeDetail;
      } else {
        const structuralStmt = valid.find((c) =>
          /total minus util\/auto|total minus util|statement 3|federal table minus slot/i.test(
            c.source,
          ),
        );
        if (structuralStmt && preferCandidate(structuralStmt, winner) === structuralStmt) {
          winner = structuralStmt;
        }
      }
    }

    if (/total minus util/i.test(winner.source)) {
      const summed = valid.find((c) => /summed detail lines/i.test(c.source));
      if (summed && preferCandidate(summed, winner) === summed) winner = summed;
    }

    return { winner, candidates };
  }

  // No fully valid candidates — pick by score among non-trap reads (no soft closure floor).
  const softPool = candidates.filter(
    (c) =>
      !c.plausibilityFlags.includes("comparison_reject") &&
      !c.plausibilityFlags.includes("stmt2_total_trap") &&
      !c.plausibilityFlags.includes("form_line_total_trap") &&
      !c.plausibilityFlags.includes("pnl_collision") &&
      !c.plausibilityFlags.includes("implausible") &&
      !c.plausibilityFlags.includes("weak_block_closure"),
  );
  if (softPool.length) {
    const winner = softPool.reduce((best, c) => preferCandidate(c, best));
    return { winner, candidates };
  }

  const detailPool = candidates.filter(
    (c) =>
      /summed detail|detail lines|misc detail closes|total minus|federal table/i.test(c.source) &&
      !c.plausibilityFlags.includes("comparison_reject"),
  );
  if (detailPool.length) {
    const winner = detailPool.reduce((best, c) => preferCandidate(c, best));
    return { winner, candidates };
  }

  const comparisonPool = candidates.filter(
    (c) =>
      /comparison/i.test(c.source) &&
      c.value >= 1 &&
      !c.plausibilityFlags.includes("pnl_collision") &&
      !c.plausibilityFlags.includes("form_line_total_trap"),
  );
  if (comparisonPool.length) {
    const winner = comparisonPool.reduce((best, c) => preferCandidate(c, best));
    return { winner, candidates };
  }

  return { winner: undefined, candidates };
}

/** Confidence 0–99 from ranked candidate scores. */
export function confidenceFromCandidate(c: OpexCandidate): number {
  // Exact closers sit near 1000+; map to high conf. Soft/non-closers stay review-tier.
  const base = c.closureScore >= 1 ? 92 : Math.min(78, 60 + Math.round(c.evidenceScore / 5));
  if (c.plausibilityFlags.length) return Math.min(base, 72);
  if (/verify|residual/i.test(c.source)) return Math.min(base, 88);
  return Math.min(Math.max(base, 70), 96);
}
