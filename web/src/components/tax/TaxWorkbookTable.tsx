"use client";

import { useMemo } from "react";
import { formatTableNumber, type TaxYearValues, type WorkbookSection } from "@/lib/tax-workbook";
import { buildTaxTable } from "@/lib/tax/export-table";
import {
  TRUST_TIER_LEGEND,
  resolveTrustTierFromColumn,
  type FieldTrustTier,
} from "@/lib/tax/field-trust-tier";
import { candidateOptionsForField } from "@/lib/tax/correction-storage";
import { inputFieldNeedsReview, fieldFlagsNeedReview, isFieldMathCorroborated } from "@/lib/tax/field-review";
import { getFormulaMismatchHints } from "@/lib/tax/workbook-display";
import { CopyButton } from "@/components/CopyButton";
import { buildPasteTsv } from "@/lib/tax-workbook";
import { OPERATING_EXPENSE_SLOT_IDS, sharedOpexSlotLabels } from "@/lib/tax/operating-expenses";
import { TaxEditableCell } from "./TaxEditableCell";
import { FieldConfidenceHint } from "./FieldConfidenceHint";
import { OpexSlotLabelCell } from "./OpexSlotLabelCell";

function cellTooltip(
  col: TaxYearValues | undefined,
  rowId: string,
  tier: FieldTrustTier,
  verified: boolean,
): string | undefined {
  if (!col) return undefined;
  const parts: string[] = [];
  if (verified) {
    parts.push("Verified by you");
    const source = col.fieldSources?.[rowId];
    if (source) parts.push(`Source: ${source}`);
    parts.push("Click value to edit · checkbox to unverify");
    return parts.join("\n");
  }
  const legend = TRUST_TIER_LEGEND.find((item) => item.tier === tier);
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

function FormulaCell({ value, label }: { value: number | null; label: string }) {
  return (
    <td
      title={`${label} — auto-calculated (editable)`}
      className="border-l border-stone-100 bg-amber-50/60 px-3 py-2.5 text-right font-mono text-sm tabular-nums text-stone-600"
    >
      {value == null ? (
        <span className="text-stone-400">—</span>
      ) : (
        <span className="font-medium">{formatTableNumber(value)}</span>
      )}
    </td>
  );
}

const OPEX_SLOT_SET = new Set<string>(OPERATING_EXPENSE_SLOT_IDS);

export function TaxWorkbookTable({
  columns,
  section,
  reverseYears = false,
  onFieldEdit,
  onFieldVerify,
  onOpexLabelEdit,
}: {
  columns: TaxYearValues[];
  section: WorkbookSection;
  reverseYears?: boolean;
  onFieldEdit?: (year: number, fieldId: string, value: number, source?: string) => void;
  onFieldVerify?: (year: number, fieldId: string, verified: boolean) => void;
  onOpexLabelEdit?: (slotId: string, label: string) => void;
}) {
  const table = buildTaxTable(columns, { reverseYears });
  const rows = table.rows.filter((row) => row.section === section);
  if (!table.columns.length || !rows.length) return null;

  const multiYear = columns.length > 1;
  const dynamicOpexLabels = useMemo(() => sharedOpexSlotLabels(columns), [columns]);
  const pasteTsv = useMemo(
    () =>
      buildPasteTsv(columns, {
        section,
        singleColumn: !multiYear,
        dynamicOpexLabels,
        includeLabels: multiYear,
      }),
    [columns, section, multiYear, dynamicOpexLabels],
  );

  const sectionTitle = section === "Income Statement Data" ? "Income Statement Data" : "Balance Sheet Data";
  const inputCount = rows.filter((r) => r.excelBehavior === "input").length;
  const formulaCount = rows.filter((r) => r.excelBehavior === "formula").length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-stone-900">{sectionTitle}</h2>
          <p className="mt-0.5 text-xs text-stone-500">
            {inputCount} input rows · {formulaCount} calculated (yellow) · click top-8 expense titles to rename
          </p>
        </div>
        <CopyButton label={`Copy ${section === "Income Statement Data" ? "I/S" : "B/S"}`} text={pasteTsv} />
      </div>

      <div className="overflow-x-auto rounded-xl border border-stone-300 bg-white shadow-sm">
        <table className="min-w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-stone-300 bg-stone-100">
              <th className="w-12 border-r border-stone-200 px-2 py-2.5 text-center text-[10px] font-semibold uppercase tracking-wide text-stone-500">
                Row
              </th>
              <th className="min-w-[14rem] border-r border-stone-200 px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-stone-600">
                Line item
              </th>
              {table.columns.map((year) => (
                <th
                  key={year}
                  className="min-w-[7.5rem] border-l border-stone-200 px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-stone-700"
                >
                  {year}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isFormula = row.excelBehavior === "formula";
              const isOpexSlot = OPEX_SLOT_SET.has(row.id);
              return (
                <tr
                  key={row.id}
                  className={[
                    "border-t border-stone-200 transition-colors",
                    isFormula ? "bg-amber-50/90 hover:bg-amber-100/80" : "bg-white hover:bg-stone-50/80",
                  ].join(" ")}
                >
                  <td className="border-r border-stone-100 px-2 py-2 text-center font-mono text-[10px] tabular-nums text-stone-400">
                    {row.excelRow}
                  </td>
                  <td
                    className={[
                      "border-r border-stone-100 px-4 py-2.5 text-stone-800",
                      isFormula ? "font-medium text-stone-700" : "",
                    ].join(" ")}
                  >
                    <span className="flex items-center gap-2">
                      {isFormula ? (
                        <span
                          className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm bg-amber-300 ring-1 ring-amber-400/60"
                          title="Excel formula row — included when copying"
                          aria-hidden
                        />
                      ) : null}
                      {isOpexSlot && onOpexLabelEdit ? (
                        <OpexSlotLabelCell
                          slotId={row.id}
                          label={row.label}
                          onCommit={onOpexLabelEdit}
                        />
                      ) : (
                        row.label
                      )}
                    </span>
                  </td>
                  {table.columns.map((year) => {
                    const col = columns.find((c) => c.year === year);
                    const v = row.values[String(year)];
                    const mathCorroborated = isFieldMathCorroborated(col, row.id);

                    if (isFormula && !onFieldEdit) {
                      return <FormulaCell key={year} value={v} label={row.label} />;
                    }

                    const tier = col?.fieldTrustTier?.[row.id] ?? resolveTrustTierFromColumn(col, row.id);
                    const status = col?.fieldStatus?.[row.id];
                    const fieldFlags = col?.fieldFlags?.[row.id];
                    const displayConf = col?.displayConfidence?.[row.id] ?? col?.confidence?.[row.id];
                    const verified = col?.userVerifiedFields?.[row.id] === true;
                    const tooltip = isFormula
                      ? `${row.label} — auto-calculated. Click to override.`
                      : cellTooltip(col, row.id, tier, verified);
                    const missing = v == null;
                    const needsReviewFlag = inputFieldNeedsReview({
                      verified,
                      value: missing ? null : v,
                      status,
                      tier,
                      displayConfidence: displayConf,
                      fieldFlags,
                      mathCorroborated,
                    });
                    const editable = Boolean(onFieldEdit);
                    const options = candidateOptionsForField(col, row.id).filter(
                      (o) => o.value !== (v ?? undefined),
                    );
                    const showHint =
                      !verified &&
                      !isFormula &&
                      (missing ||
                        status === "review" ||
                        fieldFlagsNeedReview(fieldFlags));

                    const formulaHints = isFormula ? getFormulaMismatchHints(col, row.id) : [];

                    if (!editable) {
                      return (
                        <td
                          key={year}
                          title={tooltip}
                          className={[
                            "border-l border-stone-100 px-3 py-2.5 text-right font-mono tabular-nums text-stone-800",
                            isFormula ? "bg-amber-50/60" : "",
                            missing ? "italic text-stone-400" : "",
                          ].join(" ")}
                        >
                          {missing ? "—" : formatTableNumber(v!)}
                        </td>
                      );
                    }

                    return (
                      <TaxEditableCell
                        key={year}
                        className={["border-l border-stone-100", isFormula ? "bg-amber-50/40" : ""].join(" ")}
                        value={missing ? null : v}
                        tier={tier}
                        tooltip={tooltip}
                        needsReview={needsReviewFlag}
                        verified={verified}
                        options={isFormula ? [] : options}
                        hint={
                          showHint ? (
                            missing ? (
                              <p className="text-[10px] text-stone-500">Not extracted</p>
                            ) : (
                              <FieldConfidenceHint
                                displayConfidence={displayConf}
                                flags={fieldFlags}
                                compact
                              />
                            )
                          ) : null
                        }
                        formulaHints={formulaHints}
                        onCommit={(num, source) => onFieldEdit?.(year, row.id, num, source)}
                        onVerifyToggle={(v) => onFieldVerify?.(year, row.id, v)}
                      />
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] leading-relaxed text-stone-500">
        Copy all rows pastes every line — including recalculated totals — ready to overwrite the integrator sheet.
        Check each input cell when you&apos;ve confirmed the value.
      </p>
    </div>
  );
}
