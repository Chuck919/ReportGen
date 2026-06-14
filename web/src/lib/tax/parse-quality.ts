import { TAX_ATTACHMENT_FIELD_IDS } from "@/lib/workbook-comparison-fixtures";
import { TAX_WORKBOOK_ROWS } from "@/lib/tax-workbook";
import type { ParsedTaxYear } from "@/lib/api/types";
import { INCOMPLETE_PRIMARY_FILL_RATIO } from "./upload-policy";

const PRIMARY_INPUT_IDS = TAX_WORKBOOK_ROWS.filter(
  (r) => r.excelBehavior === "input" && !TAX_ATTACHMENT_FIELD_IDS.has(r.id),
).map((r) => r.id);

export type ParseQualityReport = {
  primaryFilled: number;
  primaryTotal: number;
  fillRatio: number;
  incomplete: boolean;
  missingLabels: string[];
};

export function assessParseQuality(values: Record<string, number | undefined>): ParseQualityReport {
  let primaryFilled = 0;
  const missingLabels: string[] = [];
  for (const row of TAX_WORKBOOK_ROWS) {
    if (row.excelBehavior !== "input" || TAX_ATTACHMENT_FIELD_IDS.has(row.id)) continue;
    if (values[row.id] !== undefined) primaryFilled++;
    else missingLabels.push(row.label);
  }
  const primaryTotal = PRIMARY_INPUT_IDS.length;
  const fillRatio = primaryTotal ? primaryFilled / primaryTotal : 0;
  return {
    primaryFilled,
    primaryTotal,
    fillRatio,
    incomplete: fillRatio < INCOMPLETE_PRIMARY_FILL_RATIO,
    missingLabels: missingLabels.slice(0, 8),
  };
}

export function detectDuplicateYears(parsed: ParsedTaxYear[]): string[] {
  const byYear = new Map<number, string[]>();
  for (const row of parsed) {
    const list = byYear.get(row.year) ?? [];
    list.push(row.filename);
    byYear.set(row.year, list);
  }
  const warnings: string[] = [];
  for (const [year, names] of byYear) {
    if (names.length > 1) {
      warnings.push(
        `Multiple files mapped to tax year ${year} (${names.join(", ")}). Values merge by confidence — upload a single combined PDF when possible.`,
      );
    }
  }
  return warnings;
}

export function summarizeReupload(existingYears: number[], incoming: ParsedTaxYear[]): string[] {
  const notes: string[] = [];
  for (const row of incoming) {
    if (existingYears.includes(row.year)) {
      notes.push(
        `Tax year ${row.year} already exists — new values merge by field confidence (higher confidence wins).`,
      );
    }
  }
  return notes;
}
