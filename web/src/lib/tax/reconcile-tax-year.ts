import { TAX_WORKBOOK_ROWS, type TaxYearValues } from "@/lib/tax-workbook";
import {
  isAuthoritativeSource,
  isResidualOpexSource,
  isSuspiciousTaxValue,
  isWeakSource,
} from "@/lib/tax-return/confidence-gates";
import type { ResolvedFields } from "@/lib/tax-return/merge";
import type { FieldExtraction } from "@/lib/tax-return/form-anchors";
import type { FieldTrustTier } from "./field-trust-tier";
import { resolveFieldTrustTier, hasHardFieldFlag } from "./field-trust-tier";
import { computeWorkbookFormulas } from "./workbook-formulas";
import {
  buildSourceSnapshots,
  classifySourceFamily,
  countAgreeingFamilies,
  hasMaterialDisagreement,
  resolveValuesFromSnapshots,
  sourceDisagreementDetail,
  valuesExactlyEqual,
  type SourceFamily,
  type SourceSnapshot,
} from "./source-agreement";

export type { FieldTrustTier } from "./field-trust-tier";
export { TRUST_TIER_LEGEND, resolveTrustTierFromColumn } from "./field-trust-tier";

export type FieldReviewStatus = "verified" | "review" | "missing";

export type ReconcileInput = {
  values: Record<string, number>;
  confidence?: Record<string, number>;
  fieldSources?: Record<string, string>;
  sourceSnapshots?: Record<string, SourceSnapshot[]>;
  /** When snapshots are unavailable (e.g. localStorage reload), use stored counts. */
  persistedAgreement?: Record<string, number>;
  taxYear?: number;
  /** Parser warnings (e.g. P&L identity gaps) — used for review flags. */
  warnings?: string[];
};

export type ReconcileResult = {
  fieldFlags: Record<string, string[]>;
  fieldStatus: Record<string, FieldReviewStatus>;
  displayConfidence: Record<string, number>;
  sourceAgreement: Record<string, number>;
  fieldTrustTier: Record<string, FieldTrustTier>;
};

const INPUT_IDS = TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "input").map((r) => r.id);

const SCHEDULE_L_BS_IDS = new Set([
  "cash",
  "accounts_receivable",
  "inventory",
  "other_current_assets",
  "gross_fixed_assets",
  "accumulated_depreciation",
  "gross_intangible_assets",
  "accumulated_amortization",
  "other_assets",
  "accounts_payable",
  "other_current_liabilities",
  "notes_minus_short_term",
  "unclassified_equity",
]);

const DISPLAY_CONF_CAP_SINGLE = 85;
const DISPLAY_CONF_CAP_TRUSTED = 95;
const DISPLAY_CONF_CAP_AGREED = 99;
const DISPLAY_CONF_CAP_HIGH_PARSER = 92;
const SUBTRACTIVE_CONF_CAP = 78;
/** Residual / federal-table-minus-slots opex — keep below high-confidence green threshold. */
const RESIDUAL_OPEX_CONF_CAP = 58;

const STRUCTURAL_CLOSURE_SOURCE =
  /closes\s+stmt|detail\s+sum|misc\s+detail|summed\s+detail|residual.*closes|structural\s+closure/i;

/** Hard failures — always force review. */
function isHardFlag(msg: string): boolean {
  return hasHardFieldFlag([msg]) || /structural-mismatch|formula-disagreement|high-confidence-no-closure/i.test(msg);
}

function statementPassesStructuralClosure(source: string | undefined): boolean {
  return STRUCTURAL_CLOSURE_SOURCE.test(source ?? "");
}

function isSubtractiveStatementSource(source: string | undefined): boolean {
  return /total\s+minus\s+util/i.test(source ?? "");
}

function isStatementLine18Source(source: string | undefined): boolean {
  return /statement\s*\(?\s*line\s*18\)?/i.test(source ?? "");
}

/** Form/comparison corroboration for Stmt Line 18 — not Schedule L attachment OCR. */
function statementLine18CrossCheckSnapshots(snaps: SourceSnapshot[]): SourceSnapshot[] {
  return snaps.filter((s) => s.family === "form" || s.family === "comparison");
}

function statementLine18Uncorroborated(
  value: number,
  source: string | undefined,
  snaps: SourceSnapshot[],
): boolean {
  if (!isStatementLine18Source(source)) return false;
  const crossCheck = statementLine18CrossCheckSnapshots(snaps);
  if (!crossCheck.length) return true;
  return !crossCheck.some((s) => valuesExactlyEqual(s.value, value));
}

function isTrustedSingleSource(source: string | undefined, parserConf: number): boolean {
  if (isStatementLine18Source(source)) return false;
  if (isAuthoritativeSource(source)) return parserConf >= 65;
  if (/comparison/i.test(source ?? "") && parserConf >= 84) return true;
  if (/structured financial/i.test(source ?? "")) return true;
  // Rank-path top-8 paste slots — intentional integrator rows, not weak OCR.
  if (/^Operating expenses \(top-8/i.test(source ?? "") && parserConf >= 70) return true;
  // Intentional clears (no intangibles → amort 0, small non-form interest → 0).
  if (/^Coherence:/i.test(source ?? "") && parserConf >= 80) return true;
  return false;
}

function shouldFlagMaterialDisagreement(
  snaps: SourceSnapshot[],
  chosen: number,
): boolean {
  return hasMaterialDisagreement(chosen, snaps);
}

function addFlag(flags: Record<string, string[]>, id: string, msg: string): void {
  const list = flags[id] ?? [];
  if (!list.includes(msg)) list.push(msg);
  flags[id] = list;
}

/** Math + source-trust checks. Cheap — safe for all OCR modes. */
export function reconcileTaxYear(input: ReconcileInput): ReconcileResult {
  const {
    values,
    confidence = {},
    fieldSources = {},
    sourceSnapshots = {},
    persistedAgreement = {},
    warnings = [],
  } = input;
  const fieldFlags: Record<string, string[]> = {};
  const fieldStatus: Record<string, FieldReviewStatus> = {};
  const displayConfidence: Record<string, number> = {};
  const sourceAgreement: Record<string, number> = {};
  const fieldTrustTier: Record<string, FieldTrustTier> = {};

  if (values.sales !== undefined && values.cogs !== undefined) {
    if (values.cogs > values.sales) {
      addFlag(fieldFlags, "sales", "COGS exceeds sales");
      addFlag(fieldFlags, "cogs", "COGS exceeds sales");
    }
  }

  // Reconcile the exact totals displayed/pasted by the workbook. Keeping a second
  // BS formula engine here previously produced different totals based on arbitrary
  // "3 asset parts / 2 L+E parts" presence counts.
  const workbookFormulas = computeWorkbookFormulas(values);
  const totalAssets = workbookFormulas.total_assets;
  const totalLE = workbookFormulas.total_liabilities_equity;
  // Balance sheet identity must be exact (within $1). A $100 equity miss is a real error.
  if (totalAssets !== undefined && totalLE !== undefined && Math.abs(totalAssets - totalLE) > 1) {
    const gap = totalAssets - totalLE;
    const msg = `Balance sheet does not balance (assets ${totalAssets.toLocaleString()} vs liabilities+equity ${totalLE.toLocaleString()}, gap ${gap.toLocaleString()})`;
    for (const id of [
      "cash",
      "accounts_receivable",
      "inventory",
      "other_current_assets",
      "gross_fixed_assets",
      "other_assets",
      "accounts_payable",
      "other_current_liabilities",
      "notes_minus_short_term",
      "common_stock",
      "other_stock_equity",
      "unclassified_equity",
    ]) {
      if (values[id] !== undefined) addFlag(fieldFlags, id, msg);
    }
  }

  if (values.depreciation !== undefined && isSuspiciousTaxValue("depreciation", values.depreciation, fieldSources.depreciation, input.taxYear)) {
    addFlag(fieldFlags, "depreciation", "Value looks like OCR noise or form line number — verify");
  }
  if (values.amortization !== undefined && isSuspiciousTaxValue("amortization", values.amortization, fieldSources.amortization, input.taxYear)) {
    addFlag(fieldFlags, "amortization", "Value looks like balance-sheet line or OCR noise — verify");
  }
  if (
    values.amortization !== undefined &&
    values.accumulated_amortization !== undefined &&
    valuesExactlyEqual(values.amortization, values.accumulated_amortization)
  ) {
    addFlag(fieldFlags, "amortization", "P&L amortization equals accumulated amortization — likely wrong field");
  }
  if (
    values.depreciation !== undefined &&
    values.accumulated_depreciation !== undefined &&
    valuesExactlyEqual(values.depreciation, values.accumulated_depreciation) &&
    (values.gross_fixed_assets === undefined ||
      valuesExactlyEqual(values.depreciation, values.gross_fixed_assets))
  ) {
    addFlag(fieldFlags, "depreciation", "P&L depreciation equals accumulated depreciation — likely wrong field");
  }

  // Sales-% “typical range” bands removed — they only flagged review state, never rewrote paste.
  // Keep structural COGS>sales / COGS>95% above; value-mutating clears stay in coherence-gates.

  for (const id of INPUT_IDS) {
    const value = values[id];
    if (value === undefined) {
      fieldStatus[id] = "missing";
      fieldTrustTier[id] = "empty";
      continue;
    }

    const snaps = sourceSnapshots[id] ?? [];
    const source = fieldSources[id];
    const line18Isolated = statementLine18Uncorroborated(value, source, snaps);
    const agreement = snaps.length
      ? line18Isolated
        ? countAgreeingFamilies(value, statementLine18CrossCheckSnapshots(snaps))
        : countAgreeingFamilies(value, snaps)
      : (persistedAgreement[id] ?? 0);
    sourceAgreement[id] = agreement;

    const family = classifySourceFamily(source);
    const parserConf = confidence[id] ?? 70;

    if (line18Isolated) {
      addFlag(fieldFlags, id, "low_trust_source");
    }

    if (agreement < 2) {
      if (family === "ocr" || isWeakSource(source)) {
        addFlag(fieldFlags, id, "OCR label match only — no corroboration");
      } else if (isSubtractiveStatementSource(source)) {
        addFlag(fieldFlags, id, "Subtractive formula — verify against detail lines");
      } else if (
        isStatementLine18Source(source) &&
        snaps.length &&
        shouldFlagMaterialDisagreement(snaps, value)
      ) {
        addFlag(fieldFlags, id, "Statement Line 18 — corroborating source disagrees");
      } else if (
        !isResidualOpexSource(source) &&
        !isTrustedSingleSource(source, parserConf) &&
        !statementPassesStructuralClosure(source)
      ) {
        addFlag(fieldFlags, id, "Low-trust source — verify manually");
      }
    }

    if (
      id === "other_operating_expenses" &&
      isSubtractiveStatementSource(source) &&
      !statementPassesStructuralClosure(source)
    ) {
      addFlag(fieldFlags, id, "formula-disagreement — subtractive vs detail lines may diverge");
    }

    if (id === "other_operating_expenses" && isResidualOpexSource(source)) {
      // Only force review when P&L identity already disagrees — residual math alone is expected.
      if (warnings.some((w) => /P&L does not close|other_operating_expenses may be wrong/i.test(w))) {
        addFlag(fieldFlags, id, "Residual opex — verify against statement detail");
      }
    }

    if (
      id === "other_operating_expenses" &&
      warnings.some((w) => /P&L does not close|other_operating_expenses may be wrong/i.test(w))
    ) {
      addFlag(fieldFlags, id, "P&L does not close to Form ordinary income — verify other opex");
    }

    if (isSuspiciousTaxValue(id, value, source, input.taxYear)) {
      addFlag(fieldFlags, id, "Likely form line number or OCR noise — verify");
    }

    const materialDisagree = shouldFlagMaterialDisagreement(snaps, value);
    const disagreeMsg = materialDisagree ? sourceDisagreementDetail(snaps, value) : undefined;
    if (disagreeMsg) addFlag(fieldFlags, id, disagreeMsg);

    // Residual other_opex is derived math — never paint as multi-source "agreed" green.
    const residualOpex = isResidualOpexSource(source);
    const capped =
      residualOpex
        ? Math.min(parserConf, RESIDUAL_OPEX_CONF_CAP)
        : line18Isolated
          ? Math.min(parserConf, DISPLAY_CONF_CAP_SINGLE)
          : agreement >= 2
            ? Math.min(parserConf, DISPLAY_CONF_CAP_AGREED)
            : materialDisagree
              ? Math.min(parserConf, DISPLAY_CONF_CAP_SINGLE)
              : isTrustedSingleSource(source, parserConf)
                ? Math.min(parserConf, parserConf >= 92 ? DISPLAY_CONF_CAP_HIGH_PARSER : DISPLAY_CONF_CAP_TRUSTED)
                : statementPassesStructuralClosure(source)
                  ? Math.min(parserConf, DISPLAY_CONF_CAP_TRUSTED)
                  : isSubtractiveStatementSource(source)
                    ? Math.min(parserConf, SUBTRACTIVE_CONF_CAP)
                    : Math.min(parserConf, DISPLAY_CONF_CAP_SINGLE);
    displayConfidence[id] = capped;

    const hardFlags = (fieldFlags[id] ?? []).filter(isHardFlag);
    const suspicious = isSuspiciousTaxValue(id, value, source, input.taxYear);
    const structuralOk = statementPassesStructuralClosure(source);
    const needsReview =
      hardFlags.length > 0 ||
      suspicious ||
      materialDisagree ||
      parserConf < 65 ||
      (family === "ocr" && agreement < 2) ||
      isWeakSource(source) ||
      line18Isolated ||
      (agreement < 2 &&
        !isTrustedSingleSource(source, parserConf) &&
        !structuralOk &&
        !(family === "statement" && parserConf >= 88 && !isSubtractiveStatementSource(source) && !isStatementLine18Source(source)));
    fieldStatus[id] = needsReview ? "review" : "verified";

    fieldTrustTier[id] = resolveFieldTrustTier({
      fieldId: id,
      value,
      source,
      parserConfidence: parserConf,
      displayConfidence: capped,
      agreement,
      flags: fieldFlags[id],
      taxYear: input.taxYear,
    });
  }

  // Surface P&L gaps on formula rows so NI/NPBT are not shown as trusted green when off.
  if (warnings.some((w) => /P&L does not close|Net income .+ ≠ Form ordinary/i.test(w))) {
    for (const id of ["net_profit_before_taxes", "net_income", "operating_profit"] as const) {
      addFlag(fieldFlags, id, "math-warning — workbook total vs Form ordinary income");
      if (fieldTrustTier[id] === undefined || fieldTrustTier[id] === "authoritative") {
        fieldTrustTier[id] = "math-warning";
      }
    }
  }

  return { fieldFlags, fieldStatus, displayConfidence, sourceAgreement, fieldTrustTier };
}

export type VerificationTierSnapshots = {
  formAnchors: FieldExtraction;
  comparison?: FieldExtraction | null;
  embeddedScheduleL: FieldExtraction;
  ocrScheduleL?: FieldExtraction;
  statements: FieldExtraction;
  fuzzy: FieldExtraction;
  structured?: FieldExtraction | null;
  /** Post-reconcile P&L reads (NET DEPRECIATION, Form 4562, etc.) — beats blank Form inference. */
  crossReferenced?: FieldExtraction | null;
};

export function buildVerificationSnapshots(
  tiers: VerificationTierSnapshots,
): Record<string, SourceSnapshot[]> {
  const formValues = { ...tiers.formAnchors.values };
  const formConfidence = { ...tiers.formAnchors.confidence };
  const formSources = { ...tiers.formAnchors.sources };

  // Blank / inferred Form line-14/20 zero is not an independent read — NET DEPRECIATION / comparison win.
  for (const id of ["depreciation", "amortization"] as const) {
    const v = formValues[id];
    const src = formSources?.[id] ?? "";
    if (
      v === 0 &&
      (/blank|\(blank\)/i.test(src) || (!/page 1 block/i.test(src) && /form 1120/i.test(src)))
    ) {
      delete formValues[id];
      delete formConfidence[id];
      delete formSources[id];
    }
  }

  const list: Array<{
    family: SourceFamily;
    values: Record<string, number>;
    confidence?: Record<string, number>;
    sources?: Record<string, string>;
  }> = [
    {
      family: "form",
      values: formValues,
      confidence: formConfidence,
      sources: formSources,
    },
    {
      family: "statement",
      values: tiers.statements.values,
      confidence: tiers.statements.confidence,
      sources: tiers.statements.sources,
    },
    {
      family: "ocr",
      values: tiers.fuzzy.values,
      confidence: tiers.fuzzy.confidence,
      sources: tiers.fuzzy.sources,
    },
  ];
  if (tiers.comparison && Object.keys(tiers.comparison.values).length) {
    list.push({
      family: "comparison",
      values: tiers.comparison.values,
      confidence: tiers.comparison.confidence,
      sources: tiers.comparison.sources,
    });
  }
  if (Object.keys(tiers.embeddedScheduleL.values).length) {
    list.push({
      family: "schedule-l",
      values: tiers.embeddedScheduleL.values,
      confidence: tiers.embeddedScheduleL.confidence,
      sources: tiers.embeddedScheduleL.sources,
    });
  }
  if (tiers.ocrScheduleL && Object.keys(tiers.ocrScheduleL.values).length) {
    list.push({
      family: "schedule-l",
      values: tiers.ocrScheduleL.values,
      confidence: tiers.ocrScheduleL.confidence,
      sources: tiers.ocrScheduleL.sources,
    });
  }
  if (tiers.structured && Object.keys(tiers.structured.values).length) {
    list.push({
      family: "structured",
      values: tiers.structured.values,
      confidence: tiers.structured.confidence,
      sources: tiers.structured.sources,
    });
  }
  if (tiers.crossReferenced && Object.keys(tiers.crossReferenced.values).length) {
    list.push({
      family: "form",
      values: tiers.crossReferenced.values,
      confidence: tiers.crossReferenced.confidence,
      sources: tiers.crossReferenced.sources,
    });
  }
  return buildSourceSnapshots(list);
}

/**
 * Thorough only: clear Schedule L balance-sheet fields when independent reads disagree.
 * Text-only — no extra OCR cost.
 */
export function applyThoroughScheduleLAgreement(
  resolved: ResolvedFields,
  embeddedScheduleL: FieldExtraction,
  ocrScheduleL: FieldExtraction,
  comparison?: FieldExtraction | null,
): void {
  for (const id of SCHEDULE_L_BS_IDS) {
    if (resolved.values[id] === undefined) continue;

    const candidates: number[] = [];
    if (embeddedScheduleL.values[id] !== undefined) candidates.push(embeddedScheduleL.values[id]!);
    if (ocrScheduleL.values[id] !== undefined) candidates.push(ocrScheduleL.values[id]!);
    if (comparison?.values[id] !== undefined) candidates.push(comparison.values[id]!);

    if (candidates.length < 2) {
      const ocr = ocrScheduleL.values[id];
      const ocrConf = ocrScheduleL.confidence[id] ?? 0;
      if (
        ocr !== undefined &&
        ocrConf >= 95 &&
        /schedule l line/i.test(ocrScheduleL.sources?.[id] ?? "") &&
        embeddedScheduleL.values[id] === undefined &&
        resolved.values[id] === undefined
      ) {
        resolved.values[id] = ocr;
        resolved.confidence[id] = ocrConf;
        resolved.sources[id] = ocrScheduleL.sources![id]!;
        resolved.warnings.push(`Thorough: kept ${id}=${ocr} (OCR Schedule L — no embedded read)`);
      }
      continue;
    }

    let agreePair = false;
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        if (valuesExactlyEqual(candidates[i]!, candidates[j]!)) {
          agreePair = true;
          break;
        }
      }
      if (agreePair) break;
    }

    if (!agreePair) {
      const emb = embeddedScheduleL.values[id];
      const embConf = embeddedScheduleL.confidence[id] ?? 0;
      const ocr = ocrScheduleL.values[id];
      const ocrSrc = ocrScheduleL.sources?.[id] ?? "";
      if (
        emb !== undefined &&
        embConf >= 95 &&
        /embedded schedule l/i.test(embeddedScheduleL.sources?.[id] ?? "") &&
        (ocr === undefined || ocr === 0 || /OCR label|fuzzy/i.test(ocrSrc))
      ) {
        resolved.values[id] = emb;
        resolved.confidence[id] = embConf;
        resolved.sources[id] = embeddedScheduleL.sources![id]!;
        resolved.warnings.push(`Thorough: kept ${id}=${emb} (embedded Schedule L over weak OCR)`);
        continue;
      }

      // Do not blank balanced-path values when Schedule L sources disagree — that made
      // thorough worse than balanced. Keep resolved and flag for review instead.
      resolved.warnings.push(`Thorough: Schedule L sources disagree on ${id} — kept parser value`);
    }
  }
}

export function applyTaxYearVerification(
  parsed: TaxYearValues & { fieldSources?: Record<string, string> },
  snapshots: Record<string, SourceSnapshot[]>,
): TaxYearValues {
  const resolved = resolveValuesFromSnapshots(
    parsed.values,
    parsed.confidence ?? {},
    parsed.fieldSources ?? {},
    snapshots,
  );

  const reconciliation = reconcileTaxYear({
    values: resolved.values,
    confidence: resolved.confidence,
    fieldSources: resolved.fieldSources,
    sourceSnapshots: snapshots,
    taxYear: parsed.year,
    warnings: parsed.warnings,
  });

  const fieldAlternates = Object.fromEntries(
    Object.entries(resolved.fieldAlternates).map(([id, alts]) => [
      id,
      alts.map((a) => ({
        family: a.family,
        value: a.value,
        confidence: a.confidence,
        sourceLabel: a.sourceLabel,
      })),
    ]),
  );

  return {
    ...parsed,
    values: resolved.values,
    confidence: resolved.confidence,
    fieldSources: resolved.fieldSources,
    fieldAlternates: Object.keys(fieldAlternates).length ? fieldAlternates : undefined,
    fieldFlags: reconciliation.fieldFlags,
    fieldStatus: reconciliation.fieldStatus,
    displayConfidence: reconciliation.displayConfidence,
    sourceAgreement: reconciliation.sourceAgreement,
    fieldTrustTier: reconciliation.fieldTrustTier,
  };
}

/** Re-run verification when loading stored columns (snapshots may be absent). */
export function refreshTaxYearVerification(col: TaxYearValues): TaxYearValues {
  const reconciliation = reconcileTaxYear({
    values: col.values,
    confidence: col.confidence,
    fieldSources: col.fieldSources,
    sourceSnapshots: {},
    persistedAgreement: col.sourceAgreement,
    taxYear: col.year,
  });

  const fieldTrustTier = { ...reconciliation.fieldTrustTier };
  const fieldStatus = { ...reconciliation.fieldStatus };
  const displayConfidence = { ...reconciliation.displayConfidence };

  for (const [id, edited] of Object.entries(col.userEditedFields ?? {})) {
    if (!edited) continue;
    fieldTrustTier[id] = "user-confirmed";
    fieldStatus[id] = "verified";
    displayConfidence[id] = 100;
  }

  return {
    ...col,
    fieldFlags: reconciliation.fieldFlags,
    fieldStatus,
    displayConfidence,
    sourceAgreement: reconciliation.sourceAgreement,
    fieldTrustTier,
  };
}
