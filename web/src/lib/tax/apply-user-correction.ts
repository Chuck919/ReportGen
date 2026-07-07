import type { ParsedTaxYear } from "@/lib/api/types";
import type { FieldCandidateOption, TaxFieldCorrection } from "@/lib/tax/correction-storage";
import {
  appendTaxCorrection,
  candidateOptionsForField,
  syncTaxCorrectionToServer,
} from "@/lib/tax/correction-storage";
import { refreshTaxYearVerification } from "@/lib/tax/reconcile-tax-year";
import { OPERATING_EXPENSE_SLOT_IDS } from "@/lib/tax/operating-expenses";
import { isFormulaFieldId, snapshotParserFormulaBaseline } from "@/lib/tax/workbook-display";
import type { ParserReviewSnapshot, TaxYearValues } from "@/lib/tax-workbook";
import type { OpexCandidate } from "@/lib/tax-return/opex-candidate-ranking";

export function enrichParsedTaxYear(row: ParsedTaxYear): TaxYearValues {
  const options: Record<string, FieldCandidateOption[]> = {};

  if (row.fieldAlternates) {
    for (const [id, alts] of Object.entries(row.fieldAlternates)) {
      options[id] = alts.map((a) => ({
        value: a.value,
        source: a.sourceLabel ? `${a.family} (${a.sourceLabel})` : a.family,
        kind: "alternate" as const,
        confidence: a.confidence,
      }));
    }
  }

  if (row.fieldCandidateOptions) {
    for (const [id, opts] of Object.entries(row.fieldCandidateOptions)) {
      options[id] = opts;
    }
  }

  const debug = row.debug as { opexCandidates?: OpexCandidate[] } | undefined;
  if (debug?.opexCandidates?.length && !options.other_operating_expenses?.length) {
    options.other_operating_expenses = debug.opexCandidates.map((c) => ({
      value: c.value,
      source: c.source,
      kind: "opex" as const,
      closureScore: c.closureScore,
      evidenceScore: c.evidenceScore,
      consistencyScore: c.consistencyScore,
      totalScore: c.totalScore,
      valid: c.valid,
    }));
  }

  const { filename: _fn, debug: _dbg, parseStatus: _ps, ...col } = row;
  const parserBaseline = { ...row.values };
  return {
    ...col,
    parserBaseline,
    parserFormulaBaseline: snapshotParserFormulaBaseline(parserBaseline),
    parserFieldSources: col.fieldSources ? { ...col.fieldSources } : undefined,
    fieldCandidateOptions: Object.keys(options).length ? options : undefined,
  };
}

function snapshotParserSources(col: TaxYearValues): Record<string, string> {
  return { ...(col.parserFieldSources ?? col.fieldSources ?? {}) };
}

/** Capture post-parse values and review flags for one column (call once after finalize). */
export function snapshotParserReview(col: TaxYearValues): ParserReviewSnapshot {
  const values = { ...(col.workbookValues ?? col.values) };
  return {
    values,
    fieldSources: col.fieldSources ? { ...col.fieldSources } : undefined,
    fieldFlags: col.fieldFlags
      ? Object.fromEntries(Object.entries(col.fieldFlags).map(([k, v]) => [k, [...v]]))
      : undefined,
    fieldStatus: col.fieldStatus ? { ...col.fieldStatus } : undefined,
    displayConfidence: col.displayConfidence ? { ...col.displayConfidence } : undefined,
    fieldTrustTier: col.fieldTrustTier ? { ...col.fieldTrustTier } : undefined,
  };
}

function restoreReviewField(col: TaxYearValues, snap: ParserReviewSnapshot | undefined, fieldId: string) {
  if (!snap) return {};
  const patch: Partial<TaxYearValues> = {};
  if (snap.fieldSources && fieldId in snap.fieldSources) {
    patch.fieldSources = { ...(col.fieldSources ?? {}), [fieldId]: snap.fieldSources[fieldId]! };
  }
  if (snap.fieldFlags && snap.fieldFlags[fieldId]) {
    patch.fieldFlags = { ...(col.fieldFlags ?? {}), [fieldId]: [...snap.fieldFlags[fieldId]!] };
  } else if (col.fieldFlags?.[fieldId]) {
    const fieldFlags = { ...col.fieldFlags };
    delete fieldFlags[fieldId];
    patch.fieldFlags = fieldFlags;
  }
  if (snap.fieldStatus && snap.fieldStatus[fieldId]) {
    patch.fieldStatus = { ...(col.fieldStatus ?? {}), [fieldId]: snap.fieldStatus[fieldId]! };
  }
  if (snap.displayConfidence && snap.displayConfidence[fieldId] !== undefined) {
    patch.displayConfidence = {
      ...(col.displayConfidence ?? {}),
      [fieldId]: snap.displayConfidence[fieldId]!,
    };
  }
  if (snap.fieldTrustTier && snap.fieldTrustTier[fieldId]) {
    patch.fieldTrustTier = { ...(col.fieldTrustTier ?? {}), [fieldId]: snap.fieldTrustTier[fieldId]! };
  }
  return patch;
}

function restoreFieldFromParserReview(col: TaxYearValues, fieldId: string): TaxYearValues {
  const snap = col.parserReviewSnapshot;
  const baseline = col.parserBaseline ?? col.values;

  const userEditedFields = { ...(col.userEditedFields ?? {}) };
  delete userEditedFields[fieldId];

  const userVerifiedFields = { ...(col.userVerifiedFields ?? {}) };
  userVerifiedFields[fieldId] = false;

  let values = { ...col.values };
  let workbookValues = col.workbookValues ? { ...col.workbookValues } : undefined;
  let formulaOverrides = col.formulaOverrides ? { ...col.formulaOverrides } : undefined;

  if (isFormulaFieldId(fieldId)) {
    if (formulaOverrides) {
      delete formulaOverrides[fieldId];
      if (!Object.keys(formulaOverrides).length) formulaOverrides = undefined;
    }
  } else {
    const restored = snap?.values[fieldId] ?? baseline[fieldId];
    if (restored !== undefined) {
      values[fieldId] = restored;
      if (
        OPERATING_EXPENSE_SLOT_IDS.includes(fieldId as (typeof OPERATING_EXPENSE_SLOT_IDS)[number]) ||
        fieldId === "other_operating_expenses"
      ) {
        workbookValues = { ...(workbookValues ?? values), [fieldId]: restored };
      }
    }
  }

  if (!snap) {
    const legacy: TaxYearValues = {
      ...col,
      values,
      workbookValues,
      formulaOverrides,
      userEditedFields,
      userVerifiedFields,
      parserFieldSources: snapshotParserSources(col),
    };
    const restoredSrc = col.parserFieldSources?.[fieldId];
    if (restoredSrc) {
      legacy.fieldSources = { ...(col.fieldSources ?? {}), [fieldId]: restoredSrc };
    }
    return refreshTaxYearVerification(legacy);
  }

  return {
    ...col,
    ...restoreReviewField(col, snap, fieldId),
    values,
    workbookValues,
    formulaOverrides,
    userEditedFields,
    userVerifiedFields,
    parserFieldSources: snapshotParserSources(col),
  };
}

function withUserVerified(col: TaxYearValues, fieldId: string, source: string): TaxYearValues {
  return {
    ...col,
    parserFieldSources: snapshotParserSources(col),
    fieldSources: { ...(col.fieldSources ?? {}), [fieldId]: source },
    userVerifiedFields: { ...(col.userVerifiedFields ?? {}), [fieldId]: true },
    fieldFlags: {
      ...(col.fieldFlags ?? {}),
      [fieldId]: (col.fieldFlags?.[fieldId] ?? []).filter(
        (f) => !/verify manually|Other reads|Sources disagree/i.test(f),
      ),
    },
  };
}

export function applyUserFieldCorrection(
  col: TaxYearValues,
  fieldId: string,
  correctedValue: number,
  sourceLabel = "User correction",
): TaxYearValues {
  const parserBaseline = col.parserBaseline ?? { ...col.values };
  const parserValue = parserBaseline[fieldId] ?? col.values[fieldId];
  const rounded = Math.round(correctedValue);
  const formulaField = isFormulaFieldId(fieldId);

  let next: TaxYearValues = {
    ...col,
    parserBaseline,
    userEditedFields: { ...(col.userEditedFields ?? {}), [fieldId]: true },
    userVerifiedFields: { ...(col.userVerifiedFields ?? {}), [fieldId]: true },
  };

  if (formulaField) {
    next = {
      ...next,
      formulaOverrides: { ...(col.formulaOverrides ?? {}), [fieldId]: rounded },
    };
  } else {
    next = {
      ...next,
      values: { ...col.values, [fieldId]: rounded },
    };
    if (
      OPERATING_EXPENSE_SLOT_IDS.includes(fieldId as (typeof OPERATING_EXPENSE_SLOT_IDS)[number]) ||
      fieldId === "other_operating_expenses"
    ) {
      next = {
        ...next,
        workbookValues: { ...(col.workbookValues ?? col.values), [fieldId]: rounded },
      };
    }
  }
  next = withUserVerified(next, fieldId, sourceLabel);
  next = refreshTaxYearVerification(next);

  const rejected = candidateOptionsForField(col, fieldId).filter((o) => o.value !== rounded);

  const chosenOption = candidateOptionsForField(col, fieldId).find((o) => o.value === (parserValue ?? -1));
  const activeFlags = (col.fieldFlags?.[fieldId] ?? []).filter((f) =>
    /candidate_conflict|source_disagreement|formula_inconsistency|ocr_incomplete|verify manually|Other reads/i.test(f),
  );

  const correction: Omit<TaxFieldCorrection, "id" | "createdAt"> = {
    clientKey: col.clientKey,
    clientName: col.clientName,
    year: col.year,
    fieldId,
    parserValue,
    correctedValue: rounded,
    chosenSource: sourceLabel,
    rejectedOptions: rejected,
    chosenCandidateScores: chosenOption
      ? {
          closure: chosenOption.closureScore,
          evidence: chosenOption.evidenceScore,
          consistency: chosenOption.consistencyScore,
          total: chosenOption.totalScore ?? chosenOption.confidence,
        }
      : undefined,
    flags: activeFlags.length ? activeFlags : undefined,
  };
  const saved = appendTaxCorrection(correction);
  void syncTaxCorrectionToServer(saved);

  return next;
}

/** Mark a field as user-verified without changing its value (or clear verification). */
export function applyUserFieldVerification(
  col: TaxYearValues,
  fieldId: string,
  verified: boolean,
): TaxYearValues {
  const userVerifiedFields = { ...(col.userVerifiedFields ?? {}) };
  if (verified) {
    userVerifiedFields[fieldId] = true;
    let next: TaxYearValues = { ...col, userVerifiedFields };
    next = withUserVerified(next, fieldId, "User verified");
    return refreshTaxYearVerification(next);
  }

  userVerifiedFields[fieldId] = false;
  return restoreFieldFromParserReview({ ...col, userVerifiedFields }, fieldId);
}

export function parseEditedNumber(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "").trim();
  if (!cleaned || cleaned === "—" || cleaned === "-") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}
