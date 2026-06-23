"use client";

import { useMemo } from "react";
import { TAX_WORKBOOK_ROWS, type TaxYearValues, type WorkbookSection, buildPasteTsv } from "@/lib/tax-workbook";
import { buildTaxTable } from "@/lib/tax/export-table";
import {
  TRUST_TIER_LEGEND,
  resolveTrustTierFromColumn,
  type FieldTrustTier,
} from "@/lib/tax/field-trust-tier";
import { candidateOptionsForField } from "@/lib/tax/correction-storage";
import { CopyButton } from "@/components/CopyButton";
import { TaxEditableCell } from "./TaxEditableCell";
import { FieldConfidenceHint } from "./FieldConfidenceHint";

const INPUT_ROW_IDS = new Set(
  TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "input").map((r) => r.id),
);

function cellTooltip(col: TaxYearValues | undefined, rowId: string, tier: FieldTrustTier): string | undefined {
  if (!col) return undefined;
  const legend = TRUST_TIER_LEGEND.find((item) => item.tier === tier);
  const parts: string[] = [];
  if (legend) parts.push(`${legend.label}: ${legend.description}`);
  const source = col.fieldSources?.[rowId];
  if (source) parts.push(`Source: ${source}`);
  if (col.userEditedFields?.[rowId]) parts.push("Edited by you");
  const display = col.displayConfidence?.[rowId] ?? col.confidence?.[rowId];
  if (display !== undefined) parts.push(`Trust: ${display}%`);
  const agreement = col.sourceAgreement?.[rowId];
  if (agreement !== undefined && agreement > 0) parts.push(`Sources agreeing: ${agreement}`);
  const alternates = col.fieldAlternates?.[rowId];
  if (alternates?.length) {
    const altText = alternates
      .map((a) => {
        const label = a.sourceLabel ? `${a.family} (${a.sourceLabel})` : a.family;
        const conf = a.confidence !== undefined ? `, ${a.confidence}%` : "";
        return `${label}: ${a.value.toLocaleString()}${conf}`;
      })
      .join(" · ");
    parts.push(`Alternate reads: ${altText}`);
  }
  const flags = col.fieldFlags?.[rowId];
  if (flags?.length) parts.push(flags.join(" · "));
  parts.push("Click a value to edit · ▾ picks another extraction");
  return parts.length ? parts.join("\n") : undefined;
}

export function TaxWorkbookTable({
  columns,
  section,
  onFieldEdit,
}: {
  columns: TaxYearValues[];
  section: WorkbookSection;
  onFieldEdit?: (year: number, fieldId: string, value: number, source?: string) => void;
}) {
  const table = buildTaxTable(columns);
  const rows = table.rows.filter((row) => row.section === section);
  if (!table.columns.length || !rows.length) return null;

  const multiYear = columns.length > 1;
  const pasteTsv = useMemo(
    () => buildPasteTsv(columns, { section, singleColumn: !multiYear }),
    [columns, section, multiYear],
  );
  const confirmedTsv = useMemo(
    () => buildPasteTsv(columns, { section, singleColumn: !multiYear, confirmedOnly: true }),
    [columns, section, multiYear],
  );

  const sectionTitle = section === "Income Statement Data" ? "Income statement" : "Balance sheet";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-stone-900">{sectionTitle}</h2>
        <div className="flex flex-wrap gap-2">
          <CopyButton label="Copy for Excel" text={pasteTsv} />
          <CopyButton label="Copy verified only" text={confirmedTsv} />
        </div>
      </div>
      <p className="text-xs text-stone-500">
        Click any value to edit. Use ▾ to pick a different extraction. Copy buttons include your edits (tab-separated for Excel / Word).
      </p>
      <div className="overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-stone-200 bg-stone-50/80">
              <th className="px-5 py-3.5 text-left font-medium text-stone-700">Line item</th>
              {table.columns.map((year) => (
                <th key={year} className="w-40 px-3 py-3.5 text-right font-medium text-stone-700">
                  {year}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-stone-100">
                <td className="bg-white px-5 py-3 text-stone-800">{row.label}</td>
                {table.columns.map((year) => {
                  const col = columns.find((c) => c.year === year);
                  const v = row.values[String(year)];
                  const tier = col?.fieldTrustTier?.[row.id] ?? resolveTrustTierFromColumn(col, row.id);
                  const status = col?.fieldStatus?.[row.id];
                  const fieldFlags = col?.fieldFlags?.[row.id];
                  const displayConf = col?.displayConfidence?.[row.id] ?? col?.confidence?.[row.id];
                  const tooltip = cellTooltip(col, row.id, tier);
                  const missing = v == null;
                  const needsReview =
                    !col?.userEditedFields?.[row.id] &&
                    (status === "review" ||
                      tier === "low" ||
                      tier === "ocr-only" ||
                      tier === "moderate" ||
                      (displayConf !== undefined && displayConf < 65) ||
                      fieldFlags?.some((f) =>
                        /candidate_conflict|source_disagreement|ocr_incomplete|verify manually/i.test(f),
                      ));
                  const editable = INPUT_ROW_IDS.has(row.id) && Boolean(onFieldEdit);

                  if (!editable) {
                    return (
                      <td
                        key={year}
                        title={tooltip}
                        className={[
                          "px-5 py-3 text-right font-mono tabular-nums text-stone-500",
                          missing ? "italic text-stone-400" : "",
                        ].join(" ")}
                      >
                        {missing ? "—" : v!.toLocaleString()}
                      </td>
                    );
                  }

                  const options = candidateOptionsForField(col, row.id).filter(
                    (o) => o.value !== (v ?? undefined),
                  );
                  const showHint =
                    fieldFlags?.length || (displayConf !== undefined && displayConf < 75);

                  return (
                    <td key={year} className="align-top px-1 py-1">
                      <TaxEditableCell
                        value={missing ? null : v}
                        tier={tier}
                        tooltip={tooltip}
                        needsReview={needsReview}
                        userEdited={Boolean(col?.userEditedFields?.[row.id])}
                        options={options}
                        displayConfidence={displayConf}
                        flags={fieldFlags}
                        onCommit={(num, source) => onFieldEdit?.(year, row.id, num, source)}
                      />
                      {showHint ? (
                        <FieldConfidenceHint
                          displayConfidence={displayConf}
                          flags={fieldFlags}
                          compact
                        />
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
