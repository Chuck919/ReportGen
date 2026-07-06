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
import { closureTolerance } from "./structural-tolerance";
import {
  collidesWithResolvedPnl,
  isPlausibleOtherOperatingExpense,
  type OpexContext,
} from "./opex-plausibility";
import { scoreOpexCandidateBlended } from "@/lib/tax/ml/linear-ranker";
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
  if (/P&L reverse math|ordinary income/i.test(source)) return 0.72;
  if (/summed detail|detail lines|misc detail/i.test(source)) return detailPreferred ? 1 : 0.95;
  if (/statement 3/i.test(source)) return detailPreferred ? 0.97 : 0.94;
  if (/other deductions \(office|office\/supplies|telephone\/travel/i.test(source)) return 0.96;
  if (/Statement 2 \(total minus/i.test(source)) return 0.75;
  if (/comparison.*OTHER DEDUCTIONS residual/i.test(source)) return 0.88;
  if (/comparison.*OTHER OPERATING/i.test(source)) return 0.82;
  if (/Form line 20 residual/i.test(source)) return 0.85;
  if (/small attachment residual/i.test(source)) return 0.9;
  if (/Stmt 2 residual/i.test(source)) return 0.72;
  if (/misc detail closes/i.test(source)) return 0.92;
  if (/federal table minus slot/i.test(source)) return 0.93;
  if (/document-wide exclusion/i.test(source)) return 0.68;
  return 0.65;
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
  if (/document exclusions/i.test(source)) {
    closureScore = Math.min(closureScore, 0.65);
  }
    if (
      /office\/supplies|telephone\/travel\/bank detail/i.test(source) &&
      closureScore < 0.6
    ) {
      flags.push("weak_block_closure");
    }
    if (
      /office\/supplies|telephone\/travel\/bank detail/i.test(source) &&
      stmtForClosure !== undefined &&
      attachForClosure > 0 &&
      closureScore >= 0.85 &&
      attachForClosure + rounded < stmtForClosure * 0.7
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
    plausibilityFlags: [...flags, ...identityFlags],
    valid: flags.length === 0,
  };
  let totalScore = scoreOpexCandidateBlended(draft, mlCtx);
  // Prefer candidates that make workbook NPBT match Form ordinary income.
  if (closesPnl) totalScore += 25;
  else if (identityFlags.includes("pnl_identity_gap")) totalScore -= 8;

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
    wideExcl >= 500 && attachmentSum + wideExcl < (stmt2Total ?? Infinity) * 0.92
      ? attachmentSum + wideExcl
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
  if (
    stmtDedOpex !== undefined &&
    (stmt2Total === undefined || stmtDedOpex < stmt2Total * 0.65) &&
    (form20Early === undefined || stmtDedOpex < form20Early * 0.65)
  ) {
    raw.push({ value: stmtDedOpex, source: "Statement 2 (summed detail lines)", detailPreferred: true });
  }

  const stmt3Opex = extractStatement3OtherOperatingExpenses(ctx.allText).values.other_operating_expenses;
  const stmt3Plausible =
    form20Early === undefined ||
    stmt3Opex === undefined ||
    (stmt3Opex >= 10_000 && stmt3Opex >= form20Early * 0.05) ||
    (stmt2Total !== undefined && stmt3Opex >= stmt2Total * 0.25);
  if (
    stmt3Opex !== undefined &&
    stmt3Plausible &&
    (stmt2Total === undefined || stmt3Opex < stmt2Total * 0.85) &&
    (form20Early === undefined || stmt3Opex < form20Early * 0.85)
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
    const blockDetail =
      blockOpex.opex !== undefined &&
      (blockOpex.detailPreferred || /federal table minus slot|office\/supplies/i.test(blockOpex.source));
    if (
      formResidual >= 1_000 &&
      attach >= 1_000 &&
      formResidual < form20 * 0.72 &&
      formResidual <= form20 - Math.max(500, form20 * 0.05) &&
      !(blockDetail && blockOpex.opex !== undefined && formResidual > blockOpex.opex * 1.15)
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
  const miscSum = miscLines.reduce((sum, n) => sum + n, 0);
  const salesFloor =
    resolved.values.sales !== undefined && resolved.values.sales > 0
      ? resolved.values.sales * 0.0005
      : 0;
  if (miscSum > salesFloor) {
    raw.push({
      value: Math.round(miscSum),
      source: "Statement 2 (misc detail sum)",
      detailPreferred: true,
    });
  }
  for (const n of miscLines.filter((x) => x > salesFloor)) {
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
    // Prefer any candidate that closes Form ordinary income identity.
    const identityWinners = valid.filter((c) => c.plausibilityFlags.includes("pnl_identity_close"));
    let winner = (identityWinners.length ? identityWinners : valid).reduce((best, c) =>
      c.totalScore > best.totalScore ? c : best,
    );

    const officeAny = candidates.find((c) => /other deductions \(office/i.test(c.source));
    if (
      officeAny &&
      officeAny.totalScore >= 85 &&
      /comparison.*OTHER DEDUCTIONS residual/i.test(winner.source) &&
      (officeAny.totalScore >= winner.totalScore - 5 ||
        (officeAny.closureScore >= 0.8 && winner.value > officeAny.value * 1.2))
    ) {
      winner = officeAny;
    }

    const compInflate = candidates.find(
      (c) =>
        (/comparison.*OTHER DEDUCTIONS residual|document-wide exclusion residual/i.test(c.source)) &&
        !c.plausibilityFlags.includes("pnl_collision") &&
        !c.plausibilityFlags.includes("implausible"),
    );
    if (
      compInflate &&
      /summed detail lines/i.test(winner.source) &&
      winner.value > compInflate.value * 1.15
    ) {
      winner = compInflate;
    }

    const detailPool = valid.filter((c) => isDetailEvidenceSource(c.source));

    if (/P&L reverse math/i.test(winner.source) && detailPool.length) {
      const stmtDetail = detailPool
        .filter(
          (c) =>
            c.closureScore >= 0.75 &&
            winner.value > c.value * 1.12 &&
            c.value >= 500,
        )
        .sort((a, b) => b.closureScore - a.closureScore || a.value - b.value)[0];
      if (stmtDetail) winner = stmtDetail;
    }

    const compOpexResidual = valid.find(
      (c) =>
        (/comparison.*OTHER DEDUCTIONS residual|comparison.*OTHER OPERATING/i.test(c.source)) &&
        !c.plausibilityFlags.includes("comparison_reject"),
    );
    if (
      compOpexResidual &&
      /P&L reverse math/i.test(winner.source) &&
      compOpexResidual.closureScore >= 0.75 &&
      winner.value > compOpexResidual.value * 1.04
    ) {
      const nearDetail = detailPool.find(
        (c) =>
          Math.abs(c.value - compOpexResidual.value) <=
          Math.max(90, compOpexResidual.value * 0.006),
      );
      winner = nearDetail ?? compOpexResidual;
    }

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
      } else if (winner.value > bestDetail.value * 3 && bestDetail.evidenceScore >= 0.75) {
        winner = bestDetail;
      }
    }

    if (/summed detail lines/i.test(winner.source)) {
      const miscCloses = detailPool.find(
        (c) =>
          /misc detail closes/i.test(c.source) &&
          c.closureScore >= 0.85 &&
          c.totalScore > winner.totalScore,
      );
      if (miscCloses) {
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

    const compResidualAny = candidates.find(
      (c) =>
        /comparison.*OTHER DEDUCTIONS residual/i.test(c.source) &&
        !c.plausibilityFlags.includes("pnl_collision") &&
        !c.plausibilityFlags.includes("implausible"),
    );

    const officeDetail = detailPool.find((c) => /other deductions \(office/i.test(c.source));
    if (officeDetail && officeDetail.value >= 1_000) {
      const winnerIsWeakSummed =
        /summed detail lines/i.test(winner.source) && winner.closureScore < 0.5;
      const winnerIsInflatedDetail =
        isDetailEvidenceSource(winner.source) &&
        !/other deductions \(office/i.test(winner.source) &&
        winner.value >= officeDetail.value * 1.1;
      const winnerIsWeakOffice =
        /office\/supplies|telephone\/travel\/bank detail/i.test(winner.source) &&
        winner.closureScore < 0.7;
      if (winnerIsWeakOffice) {
        const betterClosure = valid
          .filter((c) => c.closureScore >= 0.75 && c.evidenceScore >= 0.8)
          .reduce<OpexCandidate | undefined>(
            (best, c) => (!best || c.closureScore > best.closureScore ? c : best),
            undefined,
          );
        if (betterClosure) winner = betterClosure;
      } else if (
        officeDetail.closureScore >= 0.85 &&
        officeDetail.evidenceScore >= 0.9 &&
        (winnerIsWeakSummed || winnerIsInflatedDetail) &&
        !(compResidualAny && officeDetail.value < compResidualAny.value * 0.75)
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
    if (compResidual) {
      if (
        /summed detail lines/i.test(winner.source) &&
        winner.value > compResidual.value * 1.25 &&
        compResidual.evidenceScore >= 0.82 &&
        !compResidual.plausibilityFlags.includes("comparison_reject")
      ) {
        winner = compResidual;
      } else if (
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
    }

    if (/comparison.*OTHER DEDUCTIONS residual/i.test(winner.source)) {
      const officeDetail = valid.find((c) => /other deductions \(office/i.test(c.source));
      if (
        officeDetail &&
        officeDetail.closureScore >= 0.85 &&
        !officeDetail.plausibilityFlags.includes("weak_block_closure") &&
        officeDetail.totalScore > winner.totalScore + 2
      ) {
        winner = officeDetail;
      }
    }

    // Never demote a higher-scoring office detail block to an inflated comparison residual.
    if (
      compResidualAny &&
      /office\/supplies|telephone\/travel\/bank detail|other deductions \(office/i.test(winner.source) &&
      /comparison.*OTHER DEDUCTIONS residual/i.test(compResidualAny.source) &&
      winner.totalScore > compResidualAny.totalScore + 3
    ) {
      // keep office/detail winner
    } else if (
      compResidualAny &&
      /office\/supplies|telephone\/travel\/bank detail/i.test(winner.source) &&
      compResidualAny.evidenceScore >= 0.8 &&
      winner.value < compResidualAny.value * 0.75 &&
      winner.closureScore < 0.8 &&
      winner.value < compResidualAny.value * 0.6 &&
      winner.totalScore <= compResidualAny.totalScore + 3
    ) {
      winner = compResidualAny;
    }

    const subtractiveUtil = valid.find((c) => /total minus util/i.test(c.source));
    const compResAny = candidates.find((c) =>
      /comparison.*OTHER DEDUCTIONS residual/i.test(c.source),
    );
    if (/total minus util/i.test(winner.source)) {
      const summed = valid.find((c) => /summed detail lines/i.test(c.source));
      if (summed && winner.value > summed.value * 1.08) {
        winner = summed;
      } else if (
        compResAny &&
        winner.value > compResAny.value * 2 &&
        compResAny.closureScore >= 0.85
      ) {
        winner = compResAny;
      } else if (
        compResAny &&
        winner.value > compResAny.value * 1.25 &&
        compResAny.evidenceScore >= 0.75
      ) {
        winner = compResAny;
      }
    } else if (
      subtractiveUtil &&
      compResAny &&
      subtractiveUtil.totalScore >= winner.totalScore - 8 &&
      subtractiveUtil.value > compResAny.value * 1.25 &&
      compResAny.closureScore >= 0.85 &&
      compResAny.evidenceScore >= 0.75
    ) {
      winner = compResAny;
    } else if (
      /total minus util/i.test(winner.source) &&
      compResAny &&
      winner.closureScore < 0.85 &&
      winner.value > compResAny.value * 2 &&
      compResAny.closureScore >= 0.85 &&
      compResAny.evidenceScore >= 0.7
    ) {
      winner = compResAny;
    }
    if (
      subtractiveUtil &&
      /summed detail lines/i.test(winner.source) &&
      subtractiveUtil.closureScore >= 0.85 &&
      subtractiveUtil.evidenceScore >= 0.88 &&
      subtractiveUtil.value < winner.value
    ) {
      winner = subtractiveUtil;
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

    if (/summed detail lines/i.test(winner.source) && compResidualAny) {
      if (
        winner.value > compResidualAny.value * 1.2 &&
        winner.totalScore > compResidualAny.totalScore + 5 &&
        !compResidualAny.plausibilityFlags.includes("comparison_reject")
      ) {
        // keep higher-scoring summed detail (Arizona-style rich Stmt 2)
      } else if (
        winner.value > compResidualAny.value * 1.2 &&
        compResidualAny.totalScore > winner.totalScore &&
        !compResidualAny.plausibilityFlags.includes("comparison_reject")
      ) {
        winner = compResidualAny;
      }
    }

    const federalDetailWinner = valid.find((c) => /federal table minus slot/i.test(c.source));
    if (
      federalDetailWinner &&
      (isWeakResidualSource(winner.source) ||
        (/comparison.*residual/i.test(winner.source) &&
          federalDetailWinner.value < winner.value * 0.75) ||
        (/form line 20 residual/i.test(winner.source) &&
          federalDetailWinner.value < winner.value * 0.85))
    ) {
      winner = federalDetailWinner;
    }

    if (/summed detail lines/i.test(winner.source)) {
      const officeBucket = valid.find((c) => /other deductions \(office/i.test(c.source));
      if (
        officeBucket &&
        officeBucket.value > winner.value &&
        officeBucket.value <= winner.value * 1.25 &&
        officeBucket.closureScore >= winner.closureScore - 0.05 &&
        officeBucket.totalScore >= winner.totalScore - 5
      ) {
        winner = officeBucket;
      } else if (
        officeBucket &&
        officeBucket.closureScore > winner.closureScore + 0.02 &&
        officeBucket.totalScore >= winner.totalScore - 2
      ) {
        winner = officeBucket;
      }
    }

    const structuralStmt = valid.find((c) =>
      /total minus util\/auto|total minus util|statement 3/i.test(c.source),
    );
    if (
      structuralStmt &&
      /comparison.*OTHER DEDUCTIONS residual/i.test(winner.source) &&
      structuralStmt.totalScore > winner.totalScore + 3 &&
      structuralStmt.closureScore >= winner.closureScore - 0.05
    ) {
      winner = structuralStmt;
    }

    if (
      /summed detail lines/i.test(winner.source) &&
      winner.closureScore < 0.85
    ) {
      const alt = valid
        .filter((c) => !/summed detail lines|misc detail sum/i.test(c.source))
        .sort((a, b) => b.totalScore - a.totalScore)[0];
      if (alt && alt.totalScore >= winner.totalScore - 8) winner = alt;
    }

    const tied = valid.filter((c) => Math.abs(c.totalScore - winner.totalScore) <= 0.5);
    if (tied.length > 1) {
      const miscClosesTied = tied.find((c) => /misc detail closes/i.test(c.source));
      const summedTied = tied.find((c) => /summed detail lines/i.test(c.source));
      if (
        miscClosesTied &&
        summedTied &&
        miscClosesTied.closureScore >= summedTied.closureScore - 0.05
      ) {
        winner = miscClosesTied;
      } else {
        winner = tied.reduce((best, c) =>
          c.closureScore > best.closureScore
            ? c
            : c.closureScore === best.closureScore && c.evidenceScore > best.evidenceScore
              ? c
              : best,
        );
      }
    }

    return { winner, candidates };
  }

  // No fully valid candidates — prefer high-closure reads that aren't comparison traps.
  const softPool = candidates.filter(
    (c) =>
      !c.plausibilityFlags.includes("comparison_reject") &&
      !c.plausibilityFlags.includes("stmt2_total_trap") &&
      !c.plausibilityFlags.includes("form_line_total_trap") &&
      !c.plausibilityFlags.includes("pnl_collision") &&
      !c.plausibilityFlags.includes("implausible") &&
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

  // Prefer a comparison residual over blank when Stmt-2 OCR is incomplete.
  const comparisonPool = candidates.filter(
    (c) =>
      /comparison/i.test(c.source) &&
      c.value >= 1_000 &&
      !c.plausibilityFlags.includes("pnl_collision") &&
      !c.plausibilityFlags.includes("form_line_total_trap"),
  );
  if (comparisonPool.length) {
    const winner = comparisonPool.reduce((best, c) => (c.totalScore > best.totalScore ? c : best));
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
