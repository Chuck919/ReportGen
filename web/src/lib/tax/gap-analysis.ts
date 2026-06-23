import { TAX_ATTACHMENT_FIELD_IDS } from "@/lib/workbook-comparison-fixtures";
import { TAX_WORKBOOK_ROWS, type TaxYearValues } from "@/lib/tax-workbook";

/** Below this confidence, a field counts as needing a higher OCR tier. */
export const MIN_FIELD_CONF = 72;

const STRUCTURAL_RESCAN_FLAG =
  /structural-mismatch|formula-disagreement|high-confidence-no-closure|Subtractive formula/i;

function fieldHasStructuralFailure(
  column: Pick<TaxYearValues, "fieldFlags">,
  rowId: string,
): boolean {
  const flags = column.fieldFlags?.[rowId] ?? [];
  return flags.some((f) => STRUCTURAL_RESCAN_FLAG.test(f));
}

function fieldHasNoMatchWarning(warnings: string[] | undefined, label: string): boolean {
  return (warnings ?? []).some((w) => w.startsWith("No OCR/text match") && w.includes(label));
}

function isFieldGap(
  row: (typeof TAX_WORKBOOK_ROWS)[number],
  column: Pick<TaxYearValues, "values" | "confidence" | "warnings" | "fieldFlags">,
  minConf: number,
): boolean {
  const value = column.values[row.id];
  const conf = column.confidence?.[row.id] ?? 0;
  if (fieldHasStructuralFailure(column, row.id)) return true;
  if (fieldHasNoMatchWarning(column.warnings, row.label)) return true;
  if (value === undefined) return true;
  return conf < minConf;
}

/** Primary form / Schedule L fields — gate for balanced tier. */
export function getMissingPrimaryFieldIds(
  column: Pick<TaxYearValues, "values" | "confidence" | "warnings" | "fieldFlags">,
  minConf = MIN_FIELD_CONF,
): string[] {
  return TAX_WORKBOOK_ROWS.filter((row) => row.excelBehavior === "input")
    .filter((row) => !TAX_ATTACHMENT_FIELD_IDS.has(row.id))
    .filter((row) => isFieldGap(row, column, minConf))
    .map((row) => row.id);
}

/** Statement / attachment fields — gate for thorough tier after balanced. */
export function getMissingAttachmentFieldIds(
  column: Pick<TaxYearValues, "values" | "confidence" | "warnings" | "fieldFlags">,
  minConf = MIN_FIELD_CONF,
): string[] {
  return TAX_WORKBOOK_ROWS.filter((row) => row.excelBehavior === "input")
    .filter((row) => TAX_ATTACHMENT_FIELD_IDS.has(row.id))
    .filter((row) => isFieldGap(row, column, minConf))
    .map((row) => row.id);
}

/** All input rows — used for thorough final pass. */
export function getMissingInputFieldIds(
  column: Pick<TaxYearValues, "values" | "confidence" | "warnings" | "fieldFlags">,
  minConf = MIN_FIELD_CONF,
): string[] {
  return TAX_WORKBOOK_ROWS.filter((row) => row.excelBehavior === "input")
    .filter((row) => isFieldGap(row, column, minConf))
    .map((row) => row.id);
}

/** Which fields should trigger the next OCR tier. */
export function getMissingFieldsForNextTier(
  column: Pick<TaxYearValues, "values" | "confidence" | "warnings" | "fieldFlags">,
  nextTierMode: string,
): string[] {
  if (nextTierMode === "primary") {
    return getMissingPrimaryFieldIds(column);
  }
  if (nextTierMode === "primary+attach") {
    const primary = getMissingPrimaryFieldIds(column);
    const attach = getMissingAttachmentFieldIds(column);
    return Array.from(new Set([...primary, ...attach]));
  }
  if (nextTierMode === "all-input") {
    return getMissingInputFieldIds(column);
  }
  if (nextTierMode === "vercel-balanced" || nextTierMode === "balanced") {
    return getMissingPrimaryFieldIds(column);
  }
  if (nextTierMode === "vercel-thorough" || nextTierMode === "thorough") {
    const primary = getMissingPrimaryFieldIds(column);
    const attach = getMissingAttachmentFieldIds(column);
    return Array.from(new Set([...primary, ...attach]));
  }
  return getMissingInputFieldIds(column);
}

export function countFilledInputFields(column: Pick<TaxYearValues, "values">): number {
  return TAX_WORKBOOK_ROWS.filter((row) => row.excelBehavior === "input" && column.values[row.id] !== undefined)
    .length;
}
