import type { ParsedTaxYear } from "@/lib/api/types";
import type { FieldCandidateOption, TaxFieldCorrection } from "@/lib/tax/correction-storage";
import {
  appendTaxCorrection,
  candidateOptionsForField,
  syncTaxCorrectionToServer,
} from "@/lib/tax/correction-storage";
import { refreshTaxYearVerification } from "@/lib/tax/reconcile-tax-year";
import type { TaxYearValues } from "@/lib/tax-workbook";
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
  return {
    ...col,
    parserBaseline: { ...row.values },
    fieldCandidateOptions: Object.keys(options).length ? options : undefined,
  };
}

function stampUserConfirmed(col: TaxYearValues, fieldId: string, source: string): TaxYearValues {
  return {
    ...col,
    fieldSources: { ...(col.fieldSources ?? {}), [fieldId]: source },
    confidence: { ...(col.confidence ?? {}), [fieldId]: 100 },
    displayConfidence: { ...(col.displayConfidence ?? {}), [fieldId]: 100 },
    fieldStatus: { ...(col.fieldStatus ?? {}), [fieldId]: "verified" },
    fieldTrustTier: { ...(col.fieldTrustTier ?? {}), [fieldId]: "user-confirmed" },
    userEditedFields: { ...(col.userEditedFields ?? {}), [fieldId]: true },
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

  let next: TaxYearValues = {
    ...col,
    values: { ...col.values, [fieldId]: rounded },
    parserBaseline,
    userEditedFields: { ...(col.userEditedFields ?? {}), [fieldId]: true },
  };
  next = stampUserConfirmed(next, fieldId, sourceLabel);
  next = refreshTaxYearVerification(next);
  next = preserveUserConfirmedFields(next, { ...(col.userEditedFields ?? {}), [fieldId]: true });

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

export function preserveUserConfirmedFields(
  col: TaxYearValues,
  edited?: Record<string, boolean>,
): TaxYearValues {
  const flags = edited ?? col.userEditedFields ?? {};
  if (!Object.keys(flags).length) return col;

  const fieldTrustTier = { ...(col.fieldTrustTier ?? {}) };
  const fieldStatus = { ...(col.fieldStatus ?? {}) };
  const displayConfidence = { ...(col.displayConfidence ?? {}) };

  for (const [id, isEdited] of Object.entries(flags)) {
    if (!isEdited) continue;
    fieldTrustTier[id] = "user-confirmed";
    fieldStatus[id] = "verified";
    displayConfidence[id] = 100;
  }

  return { ...col, fieldTrustTier, fieldStatus, displayConfidence };
}

export function parseEditedNumber(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "").trim();
  if (!cleaned || cleaned === "—" || cleaned === "-") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}
