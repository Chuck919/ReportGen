import type { TaxYearValues } from "@/lib/tax-workbook";
import { TAX_WORKBOOK_ROWS } from "@/lib/tax-workbook";
import { applyCrossYearFlags } from "@/lib/tax/cross-year-reconcile";
import { refreshTaxYearVerification } from "@/lib/tax/reconcile-tax-year";
import { alignOperatingExpensesAcrossYears } from "@/lib/tax/operating-expenses";
import { snapshotParserFormulaBaseline } from "@/lib/tax/workbook-display";
import { flagPnlIdentityFromAnchors, applyOrdinaryIncomeReverseOpexFromAnchor } from "@/lib/tax-return/pnl-identity";
import { isSuspiciousTaxValue } from "@/lib/tax-return/confidence-gates";

const INPUT_IDS = new Set(
  TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "input").map((r) => r.id),
);

/** Comparison-only SG&A categories that still belong in the rank-by-amount pool. */
const RANK_POOL_EXTRA_IDS: Record<string, string> = {
  employee_benefits: "Employee benefit programs",
  gasoline: "Gasoline",
  insurance: "Insurance",
  supplies: "Supplies",
  repairs: "Repairs and maintenance",
  travel: "Travel",
};

function applyCrossYearComparisonBackfill(columns: TaxYearValues[]): TaxYearValues[] {
  const byYear = new Map(columns.map((col) => [col.year, { ...col, values: { ...col.values } }]));

  for (const col of columns) {
    if (!col.comparisonPriorYear || !col.comparisonPriorValues) continue;
    const prior = byYear.get(col.comparisonPriorYear);
    if (!prior) continue;

    for (const [id, value] of Object.entries(col.comparisonPriorValues)) {
      if (value === undefined) continue;
      // Depreciation / amortization belong on each year's Form page-1 — comparison prior
      // columns often carry instruction / line-noise (e.g. $114) into blank years.
      if (id === "depreciation" || id === "amortization") continue;
      if (INPUT_IDS.has(id)) {
        // Never cross-year-refill income rows — tax-refund / Stmt-1 amounts are year-local.
        if (id === "other_income" || id === "other_operating_income") continue;
        // Skip comparison crumbs (form line numbers, Form 8990 / §163(j) interest noise, etc.).
        if (
          isSuspiciousTaxValue(
            id,
            value,
            `Two-year comparison (from ${col.year} return)`,
            col.comparisonPriorYear,
          )
        ) {
          continue;
        }
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
      const extraLabel = RANK_POOL_EXTRA_IDS[id];
      if (extraLabel && Math.round(Math.abs(value)) >= 1) {
        const src = `Two-year comparison (from ${col.year} return) (${id} row)`;
        const lines = [...(prior.operatingExpenseLines ?? [])];
        const already = lines.some(
          (l) => Math.round(l.amount) === Math.round(Math.abs(value)) && /\([a-z_]+\s+row\)/i.test(l.source ?? ""),
        );
        if (!already) {
          lines.push({ label: extraLabel, amount: Math.round(Math.abs(value)), source: src });
          prior.operatingExpenseLines = lines;
        }
      }
    }
    byYear.set(col.comparisonPriorYear, refreshTaxYearVerification(prior));
  }

  return Array.from(byYear.values()).sort((a, b) => b.year - a.year);
}

/**
 * After opex align: Form-OI reverse plug may fill when residual fails identity —
 * but never shrinks labeled Stmt itemized other_opex (cross-year top-8 remapping
 * understates the plug). Then re-flag so NI/NPBT stay honest.
 */
function reflagPnlIdentityAfterOpexAlign(col: TaxYearValues): TaxYearValues {
  if (col.formOrdinaryBusinessIncome === undefined && col.formGrossProfit === undefined) {
    return col;
  }
  const warnings = [...(col.warnings ?? [])];
  const resolved = {
    values: { ...col.values },
    confidence: { ...(col.confidence ?? {}) },
    sources: { ...(col.fieldSources ?? {}) },
    warnings,
  };
  if (col.formOrdinaryBusinessIncome !== undefined) {
    applyOrdinaryIncomeReverseOpexFromAnchor(resolved, col.formOrdinaryBusinessIncome);
  }
  flagPnlIdentityFromAnchors(resolved, col.formOrdinaryBusinessIncome, col.formGrossProfit);
  return refreshTaxYearVerification({
    ...col,
    values: resolved.values,
    confidence: resolved.confidence,
    fieldSources: resolved.sources,
    warnings: resolved.warnings,
  });
}

/**
 * Finalization is a pure projection of parser output plus explicit user edits.
 * Rebuild from the immutable parser snapshot so progressive merges, edits, and
 * hydration cannot rank already-ranked paste seats or compound residual math.
 */
function restoreParserBaseline(col: TaxYearValues): TaxYearValues {
  if (!col.parserBaseline) return col;

  const values = { ...col.parserBaseline };
  const fieldSources = col.parserFieldSources
    ? { ...col.parserFieldSources }
    : { ...(col.fieldSources ?? {}) };

  for (const [id, edited] of Object.entries(col.userEditedFields ?? {})) {
    if (!edited) continue;
    const value = col.workbookValues?.[id] ?? col.values[id];
    if (value !== undefined) values[id] = value;
    const source = col.fieldSources?.[id];
    if (source) fieldSources[id] = source;
  }

  return { ...col, values, fieldSources };
}

export function finalizeTaxColumns(columns: TaxYearValues[]): TaxYearValues[] {
  const baselineColumns = columns.map(restoreParserBaseline);
  let cols: TaxYearValues[] = applyCrossYearComparisonBackfill(baselineColumns).map((col) => {
    const refreshed = refreshTaxYearVerification(col);
    return {
      ...refreshed,
      parserFormulaBaseline:
        refreshed.parserFormulaBaseline ??
        snapshotParserFormulaBaseline(refreshed.parserBaseline ?? refreshed.values),
    };
  });
  cols = alignOperatingExpensesAcrossYears(cols)
    .map(refreshTaxYearVerification)
    .map(reflagPnlIdentityAfterOpexAlign);
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
    operatingExpenseLines: incoming.operatingExpenseLines ?? existing.operatingExpenseLines,
    opexSlotLabels: incoming.opexSlotLabels ?? existing.opexSlotLabels,
    stmtOtherDeductionsTotal: incoming.stmtOtherDeductionsTotal ?? existing.stmtOtherDeductionsTotal,
    formOrdinaryBusinessIncome:
      incoming.formOrdinaryBusinessIncome ?? existing.formOrdinaryBusinessIncome,
    formGrossProfit: incoming.formGrossProfit ?? existing.formGrossProfit,
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
