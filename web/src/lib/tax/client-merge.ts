import type { ParsedTaxYear } from "@/lib/api/types";
import type { TaxYearValues } from "@/lib/tax-workbook";
import { enrichParsedTaxYear } from "@/lib/tax/apply-user-correction";
import { mergeTaxYearsByYear } from "./merge-years";

export function stampClientOnColumns(
  columns: TaxYearValues[],
  clientKey?: string,
  clientName?: string,
): TaxYearValues[] {
  if (!clientKey && !clientName) return columns;
  return columns.map((col) => ({
    ...col,
    clientKey: col.clientKey ?? clientKey,
    clientName: col.clientName ?? clientName,
  }));
}

/**
 * If incoming PDFs are a different company, replace the workbook instead of merging years.
 */
export function mergeParsedTaxYears(
  existing: TaxYearValues[],
  incoming: ParsedTaxYear[],
): { columns: TaxYearValues[]; warnings: string[] } {
  const warnings: string[] = [];
  const incomingKey = incoming.find((r) => r.clientKey)?.clientKey;
  const incomingName = incoming.find((r) => r.clientName)?.clientName;
  const existingKey = existing.find((c) => c.clientKey)?.clientKey;
  const existingName = existing.find((c) => c.clientName)?.clientName;

  let base = existing;
  if (incomingKey && existingKey && incomingKey !== existingKey) {
    warnings.push(
      `Different company detected (“${incomingName ?? incomingKey}”). Cleared previous results for “${existingName ?? existingKey}”.`,
    );
    base = [];
  }

  const stamped = stampClientOnColumns(incoming.map(enrichParsedTaxYear), incomingKey, incomingName);
  return { columns: mergeTaxYearsByYear(base, stamped), warnings };
}
