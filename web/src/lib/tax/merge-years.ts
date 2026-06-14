import type { TaxYearValues } from "@/lib/tax-workbook";

export function mergeTaxYearRecords(existing: TaxYearValues, incoming: TaxYearValues): TaxYearValues {
  const values = { ...existing.values };
  const confidence = { ...(existing.confidence ?? {}) };
  const fieldSources = { ...(existing.fieldSources ?? {}) };
  let mergedFromIncoming = false;

  for (const id of Object.keys(incoming.values)) {
    const newVal = incoming.values[id];
    if (newVal === undefined) continue;
    const newConf = incoming.confidence?.[id] ?? 0;
    const oldConf = confidence[id] ?? 0;
    if (values[id] === undefined || newConf >= oldConf) {
      values[id] = newVal;
      confidence[id] = newConf;
      if (incoming.fieldSources?.[id]) fieldSources[id] = incoming.fieldSources[id];
      if (newConf >= oldConf) mergedFromIncoming = true;
    }
  }

  return {
    year: existing.year,
    values,
    confidence,
    fieldSources,
    warnings: [...(existing.warnings ?? []), ...(incoming.warnings ?? [])],
    source: mergedFromIncoming ? incoming.source : existing.source,
  };
}

export function mergeTaxYearsByYear(existing: TaxYearValues[], incoming: TaxYearValues[]): TaxYearValues[] {
  const byYear = new Map(existing.map((item) => [item.year, item]));
  for (const item of incoming) {
    const prev = byYear.get(item.year);
    byYear.set(item.year, prev ? mergeTaxYearRecords(prev, item) : item);
  }
  return Array.from(byYear.values()).sort((a, b) => b.year - a.year);
}
