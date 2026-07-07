import { TAX_WORKBOOK_ROWS, type TaxYearValues } from "@/lib/tax-workbook";
import { computeWorkbookFormulas } from "@/lib/tax/workbook-formulas";

function formulaFieldIds(): Set<string> {
  return new Set(
    TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "formula").map((r) => r.id),
  );
}

function moneyTolerance(expected: number): number {
  return Math.max(1, Math.abs(expected) * 0.005);
}

function moneyDiffers(a: number, b: number): boolean {
  return Math.abs(a - b) > moneyTolerance(b);
}

export function isFormulaFieldId(fieldId: string): boolean {
  return formulaFieldIds().has(fieldId);
}

export function workbookInputValues(col: TaxYearValues): Record<string, number | undefined> {
  return col.workbookValues ?? col.values;
}

/** Display map: computed formulas with user overrides applied. */
export function resolveWorkbookDisplayValues(
  col: TaxYearValues,
): Record<string, number | undefined> {
  const computed = computeWorkbookFormulas(workbookInputValues(col));
  const overrides = col.formulaOverrides ?? {};
  return { ...computed, ...overrides };
}

export type FormulaMismatchHint = {
  kind: "extraction" | "formula";
  label: string;
  referenceValue: number;
};

/** Warnings for auto-calculated cells — non-blocking, shown until math reconciles. */
export function getFormulaMismatchHints(
  col: TaxYearValues | undefined,
  fieldId: string,
): FormulaMismatchHint[] {
  if (!col || !isFormulaFieldId(fieldId)) return [];

  const inputs = workbookInputValues(col);
  const computed = computeWorkbookFormulas(inputs)[fieldId];
  const parserFormula = col.parserFormulaBaseline?.[fieldId];
  const override = col.formulaOverrides?.[fieldId];
  const hints: FormulaMismatchHint[] = [];

  if (override !== undefined && computed !== undefined && moneyDiffers(override, computed)) {
    hints.push({ kind: "formula", label: "Formula expects", referenceValue: computed });
  }

  if (
    parserFormula !== undefined &&
    computed !== undefined &&
    moneyDiffers(computed, parserFormula)
  ) {
    hints.push({ kind: "extraction", label: "From extraction", referenceValue: parserFormula });
  }

  return hints;
}

export function snapshotParserFormulaBaseline(
  values: Record<string, number | undefined>,
): Record<string, number> {
  const computed = computeWorkbookFormulas(values);
  const out: Record<string, number> = {};
  for (const id of formulaFieldIds()) {
    const v = computed[id];
    if (v !== undefined) out[id] = v;
  }
  return out;
}
