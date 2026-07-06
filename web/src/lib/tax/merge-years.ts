import type { TaxYearValues } from "@/lib/tax-workbook";
import { TAX_WORKBOOK_ROWS } from "@/lib/tax-workbook";
import { applyCrossYearFlags } from "@/lib/tax/cross-year-reconcile";
import { refreshTaxYearVerification } from "@/lib/tax/reconcile-tax-year";
import { alignOperatingExpensesAcrossYears } from "@/lib/tax/operating-expenses";
import { snapshotParserFormulaBaseline } from "@/lib/tax/workbook-display";

const INPUT_IDS = new Set(
  TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "input").map((r) => r.id),
);

function applyCrossYearComparisonBackfill(columns: TaxYearValues[]): TaxYearValues[] {
  const byYear = new Map(columns.map((col) => [col.year, { ...col, values: { ...col.values } }]));

  for (const col of columns) {
    if (!col.comparisonPriorYear || !col.comparisonPriorValues) continue;
    const prior = byYear.get(col.comparisonPriorYear);
    if (!prior) continue;

    for (const [id, value] of Object.entries(col.comparisonPriorValues)) {
      if (!INPUT_IDS.has(id) || value === undefined) continue;
      const cur = prior.values[id];
      const curConf = prior.confidence?.[id] ?? 0;
      const curSrc = prior.fieldSources?.[id] ?? "";
      const weak = !curSrc || /OCR label|fuzzy|label match/i.test(curSrc);
      if (cur === undefined || (weak && curConf < 85)) {
        prior.values[id] = value;
        prior.confidence = { ...(prior.confidence ?? {}), [id]: 88 };
        prior.fieldSources = {
          ...(prior.fieldSources ?? {}),
          [id]: `Two-year comparison (from ${col.year} return)`,
        };
      }
    }
    byYear.set(col.comparisonPriorYear, refreshTaxYearVerification(prior));
  }

  return Array.from(byYear.values()).sort((a, b) => b.year - a.year);
}

export function finalizeTaxColumns(columns: TaxYearValues[]): TaxYearValues[] {
  let cols: TaxYearValues[] = applyCrossYearComparisonBackfill(columns).map((col) => {
    const refreshed = refreshTaxYearVerification(col);
    return {
      ...refreshed,
      parserFormulaBaseline:
        refreshed.parserFormulaBaseline ??
        snapshotParserFormulaBaseline(refreshed.parserBaseline ?? refreshed.values),
    };
  });
  cols = alignOperatingExpensesAcrossYears(cols).map(refreshTaxYearVerification);
  return applyCrossYearFlags(cols);
}

export function mergeTaxYearRecords(existing: TaxYearValues, incoming: TaxYearValues): TaxYearValues {
  const values = { ...existing.values };
  const confidence = { ...(existing.confidence ?? {}) };
  const fieldSources = { ...(existing.fieldSources ?? {}) };
  const sourceAgreement = { ...(existing.sourceAgreement ?? {}) };
  let mergedFromIncoming = false;

  for (const id of Object.keys(incoming.values)) {
    if (existing.userEditedFields?.[id]) continue;
    const newVal = incoming.values[id];
    if (newVal === undefined) continue;
    const newConf = incoming.confidence?.[id] ?? 0;
    const oldConf = confidence[id] ?? 0;
    if (values[id] === undefined || newConf >= oldConf) {
      values[id] = newVal;
      confidence[id] = newConf;
      if (incoming.fieldSources?.[id]) fieldSources[id] = incoming.fieldSources[id];
      if (incoming.sourceAgreement?.[id] !== undefined) {
        sourceAgreement[id] = incoming.sourceAgreement[id];
      }
      if (newConf >= oldConf) mergedFromIncoming = true;
    }
  }

  return refreshTaxYearVerification({
    year: existing.year,
    values,
    confidence,
    fieldSources,
    sourceAgreement,
    warnings: [...(existing.warnings ?? []), ...(incoming.warnings ?? [])],
    source: mergedFromIncoming ? incoming.source : existing.source,
    clientKey: existing.clientKey ?? incoming.clientKey,
    clientName: existing.clientName ?? incoming.clientName,
    userEditedFields: existing.userEditedFields,
    userVerifiedFields: existing.userVerifiedFields ?? incoming.userVerifiedFields,
    userOpexSlotLabels: existing.userOpexSlotLabels ?? incoming.userOpexSlotLabels,
    parserBaseline: existing.parserBaseline ?? incoming.parserBaseline,
    parserFormulaBaseline: existing.parserFormulaBaseline ?? incoming.parserFormulaBaseline,
    formulaOverrides: existing.formulaOverrides ?? incoming.formulaOverrides,
    workbookValues: existing.workbookValues ?? incoming.workbookValues,
    fieldCandidateOptions: {
      ...(incoming.fieldCandidateOptions ?? {}),
      ...(existing.fieldCandidateOptions ?? {}),
    },
    fieldAlternates: existing.fieldAlternates ?? incoming.fieldAlternates,
    comparisonPriorYear: existing.comparisonPriorYear ?? incoming.comparisonPriorYear,
    comparisonPriorValues: existing.comparisonPriorValues ?? incoming.comparisonPriorValues,
  });
}

export function mergeTaxYearsByYear(existing: TaxYearValues[], incoming: TaxYearValues[]): TaxYearValues[] {
  const byYear = new Map(existing.map((item) => [item.year, item]));
  for (const item of incoming) {
    const prev = byYear.get(item.year);
    byYear.set(item.year, prev ? mergeTaxYearRecords(prev, item) : item);
  }
  return finalizeTaxColumns(Array.from(byYear.values()).sort((a, b) => a.year - b.year));
}
