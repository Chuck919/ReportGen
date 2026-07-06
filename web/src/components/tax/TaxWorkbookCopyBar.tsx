"use client";

import { useMemo } from "react";
import {
  buildFullWorkbookPasteTsv,
  buildPasteTsv,
  type TaxYearValues,
} from "@/lib/tax-workbook";
import { sharedOpexSlotLabels } from "@/lib/tax/operating-expenses";
import { CopyButton } from "@/components/CopyButton";

export function TaxWorkbookCopyBar({ columns }: { columns: TaxYearValues[] }) {
  const multiYear = columns.length > 1;
  const years = useMemo(
    () => [...columns].map((c) => c.year).sort((a, b) => b - a),
    [columns],
  );
  const dynamicOpexLabels = useMemo(() => sharedOpexSlotLabels(columns), [columns]);

  const pasteBase = useMemo(
    () => ({
      singleColumn: !multiYear,
      dynamicOpexLabels,
    }),
    [multiYear, dynamicOpexLabels],
  );

  const fullTsv = useMemo(
    () => buildFullWorkbookPasteTsv(columns, pasteBase),
    [columns, pasteBase],
  );

  const fullWithLabels = useMemo(
    () =>
      buildFullWorkbookPasteTsv(columns, {
        ...pasteBase,
        includeLabels: true,
      }),
    [columns, pasteBase],
  );

  const integratorTsv = useMemo(
    () =>
      buildFullWorkbookPasteTsv(columns, {
        ...pasteBase,
        singleColumn: false,
        reverseYears: true,
        includeLabels: true,
      }),
    [columns, pasteBase],
  );

  const verifiedTsv = useMemo(
    () =>
      buildFullWorkbookPasteTsv(columns, {
        ...pasteBase,
        confirmedOnly: true,
      }),
    [columns, pasteBase],
  );

  const incomeTsv = useMemo(
    () =>
      buildPasteTsv(columns, {
        ...pasteBase,
        section: "Income Statement Data",
      }),
    [columns, pasteBase],
  );

  const balanceTsv = useMemo(
    () =>
      buildPasteTsv(columns, {
        ...pasteBase,
        section: "Balance Sheet Data",
      }),
    [columns, pasteBase],
  );

  return (
    <div className="rounded-2xl border border-stone-200 bg-gradient-to-br from-stone-50 to-white px-5 py-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-stone-900">Copy for Excel</p>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-stone-500">
            Tab-separated values match the integrator workbook layout. Multi-year uploads align the same eight
            expense rows across all columns (ranked by largest amount in any year). Use &quot;Integrator paste&quot;
            for newest→oldest column order with line-item labels on each row. Years: {years.join(", ")}.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {multiYear ? <CopyButton label="Integrator paste" text={integratorTsv} /> : null}
          <CopyButton label="Copy all rows" text={fullTsv} />
          <CopyButton label="Copy with labels" text={fullWithLabels} />
          <CopyButton label="Copy verified only" text={verifiedTsv} />
          <CopyButton label="Income statement" text={incomeTsv} />
          <CopyButton label="Balance sheet" text={balanceTsv} />
        </div>
      </div>
    </div>
  );
}
