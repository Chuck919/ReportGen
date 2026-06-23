import { TAX_WORKBOOK_ROWS, type TaxYearValues } from "@/lib/tax-workbook";
import { isAuthoritativeSource, isSuspiciousTaxValue, isWeakSource } from "@/lib/tax-return/confidence-gates";
import type { ResolvedFields } from "@/lib/tax-return/merge";
import type { FieldExtraction } from "@/lib/tax-return/form-anchors";
import type { FieldTrustTier } from "./field-trust-tier";
import { resolveFieldTrustTier, hasHardFieldFlag } from "./field-trust-tier";
import {
  buildSourceSnapshots,
  classifySourceFamily,
  countAgreeingFamilies,
  hasSourceDisagreement,
  resolveValuesFromSnapshots,
  sourceDisagreementDetail,
  valuesExactlyEqual,
  type SourceFamily,
  type SourceSnapshot,
  withinTolerance,
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
const SUBTRACTIVE_CONF_CAP = 78;

const STRUCTURAL_CLOSURE_SOURCE =
  /closes\s+stmt|detail\s+sum|misc\s+detail|summed\s+detail|residual.*closes|structural\s+closure/i;
const SUBTRACTIVE_SOURCE = /total\s+minus|subtractive|verify\)/i;

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

function isTrustedSingleSource(source: string | undefined, parserConf: number): boolean {
  if (isAuthoritativeSource(source)) return parserConf >= 65;
  if (/comparison/i.test(source ?? "") && parserConf >= 84) return true;
  if (/structured financial/i.test(source ?? "")) return true;
  return false;
}

function addFlag(flags: Record<string, string[]>, id: string, msg: string): void {
  const list = flags[id] ?? [];
  if (!list.includes(msg)) list.push(msg);
  flags[id] = list;
}

function roundSum(values: Record<string, number>, ids: string[]): number | undefined {
  const present = ids.filter((id) => values[id] !== undefined);
  if (present.length < Math.ceil(ids.length * 0.75)) return undefined;
  return Math.round(present.reduce((s, id) => s + values[id]!, 0));
}

function netFixed(values: Record<string, number>): number | undefined {
  if (values.gross_fixed_assets === undefined) return undefined;
  const acc = values.accumulated_depreciation ?? 0;
  return Math.round(values.gross_fixed_assets - Math.abs(acc));
}

function netIntangible(values: Record<string, number>): number | undefined {
  if (values.gross_intangible_assets === undefined) return undefined;
  const acc = values.accumulated_amortization ?? 0;
  return Math.round(values.gross_intangible_assets - Math.abs(acc));
}

function computeTotalAssets(values: Record<string, number>): number | undefined {
  const current = roundSum(values, ["cash", "accounts_receivable", "inventory", "other_current_assets"]);
  const nf = netFixed(values);
  const ni = netIntangible(values);
  const other = values.other_assets;
  const parts = [current, nf, ni, other].filter((n): n is number => n !== undefined);
  if (parts.length < 3) return undefined;
  return Math.round(parts.reduce((a, b) => a + b, 0));
}

function computeTotalLiabilitiesEquity(values: Record<string, number>): number | undefined {
  const currentLiab = roundSum(values, [
    "accounts_payable",
    "short_term_debt",
    "current_portion_ltd",
    "other_current_liabilities",
  ]);
  const ltLiab = roundSum(values, ["notes_minus_short_term", "subordinated", "other_long_term_liabilities"]);
  const equity = roundSum(values, [
    "preferred_stock",
    "common_stock",
    "additional_paid_in_capital",
    "other_stock_equity",
    "unclassified_equity",
  ]);
  const parts = [currentLiab, ltLiab, equity].filter((n): n is number => n !== undefined);
  if (parts.length < 2) return undefined;
  return Math.round(parts.reduce((a, b) => a + b, 0));
}

/** Math + source-trust checks. Cheap — safe for all OCR modes. */
export function reconcileTaxYear(input: ReconcileInput): ReconcileResult {
  const {
    values,
    confidence = {},
    fieldSources = {},
    sourceSnapshots = {},
    persistedAgreement = {},
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
    } else if (values.sales > 0 && values.cogs / values.sales > 0.95) {
      addFlag(fieldFlags, "cogs", "COGS is >95% of sales — verify");
    }
  }

  const totalAssets = computeTotalAssets(values);
  const totalLE = computeTotalLiabilitiesEquity(values);
  if (totalAssets !== undefined && totalLE !== undefined && !withinTolerance(totalAssets, totalLE)) {
    const msg = `Balance sheet does not balance (assets ${totalAssets.toLocaleString()} vs liabilities+equity ${totalLE.toLocaleString()})`;
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

  if (values.sales !== undefined && values.sales > 0) {
    for (const [id, lo, hi] of [
      ["cogs", 0.03, 0.95],
      ["rent", 0.002, 0.4],
      ["officer_compensation", 0, 0.3],
      ["salaries_wages", 0.01, 0.5],
      ["advertising", 0, 0.15],
    ] as const) {
      const v = values[id];
      if (v === undefined || v <= 0) continue;
      const pct = v / values.sales!;
      if (pct < lo || pct > hi) {
        addFlag(fieldFlags, id, `${id} is ${(pct * 100).toFixed(1)}% of sales — outside typical range`);
      }
    }
  }

  for (const id of INPUT_IDS) {
    const value = values[id];
    if (value === undefined) {
      fieldStatus[id] = "missing";
      fieldTrustTier[id] = "empty";
      continue;
    }

    const snaps = sourceSnapshots[id] ?? [];
    const agreement = snaps.length
      ? countAgreeingFamilies(value, snaps)
      : (persistedAgreement[id] ?? 0);
    sourceAgreement[id] = agreement;

    const family = classifySourceFamily(fieldSources[id]);
    const source = fieldSources[id];
    const parserConf = confidence[id] ?? 70;

    if (agreement < 2) {
      if (family === "ocr" || isWeakSource(source)) {
        addFlag(fieldFlags, id, "OCR label match only — no corroboration");
      } else if (isSubtractiveStatementSource(source)) {
        addFlag(fieldFlags, id, "Subtractive formula — verify against detail lines");
      } else if (!isTrustedSingleSource(source, parserConf) && !statementPassesStructuralClosure(source)) {
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

    if (isSuspiciousTaxValue(id, value, source, input.taxYear)) {
      addFlag(fieldFlags, id, "Likely form line number or OCR noise — verify");
    }

    const disagreeMsg = hasSourceDisagreement(snaps)
      ? sourceDisagreementDetail(snaps, value)
      : undefined;
    if (disagreeMsg) addFlag(fieldFlags, id, disagreeMsg);

    const capped =
      agreement >= 2
        ? Math.min(parserConf, DISPLAY_CONF_CAP_AGREED)
        : isTrustedSingleSource(source, parserConf)
          ? Math.min(parserConf, DISPLAY_CONF_CAP_TRUSTED)
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
      hasSourceDisagreement(snaps) ||
      parserConf < 65 ||
      family === "ocr" ||
      isWeakSource(source) ||
      (agreement < 2 &&
        !isTrustedSingleSource(source, parserConf) &&
        !structuralOk &&
        !(family === "statement" && parserConf >= 88 && !isSubtractiveStatementSource(source)));
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
};

export function buildVerificationSnapshots(tiers: VerificationTierSnapshots): Record<string, SourceSnapshot[]> {
  const list: Array<{
    family: SourceFamily;
    values: Record<string, number>;
    confidence?: Record<string, number>;
    sources?: Record<string, string>;
  }> = [
    {
      family: "form",
      values: tiers.formAnchors.values,
      confidence: tiers.formAnchors.confidence,
      sources: tiers.formAnchors.sources,
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

      const val = resolved.values[id];
      delete resolved.values[id];
      delete resolved.confidence[id];
      delete resolved.sources[id];
      resolved.warnings.push(`Thorough: cleared ${id} (${val}) — Schedule L sources disagree`);
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
