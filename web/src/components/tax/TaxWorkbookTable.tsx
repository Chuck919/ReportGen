"use client";

import { formatExcelNumber, type TaxYearValues } from "@/lib/tax-workbook";
import { buildTaxTable } from "@/lib/tax/export-table";

export function TaxWorkbookTable({ columns }: { columns: TaxYearValues[] }) {
  const table = buildTaxTable(columns);
  if (!table.columns.length) return null;

  let lastSection = "";

  return (
    <div className="overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-stone-200 bg-stone-50/80">
            <th className="px-5 py-3.5 text-left font-medium text-stone-700">Line item</th>
            {table.columns.map((year) => (
              <th key={year} className="w-32 px-5 py-3.5 text-right font-medium text-stone-700">
                {year}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => {
            const sectionBreak = row.section !== lastSection;
            lastSection = row.section;

            return (
              <tr key={row.id} className="border-t border-stone-100 hover:bg-stone-50/50">
                <td className="px-5 py-3 text-stone-800">
                  {sectionBreak && (
                    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-stone-400">
                      {row.section}
                    </span>
                  )}
                  {row.label}
                </td>
                {table.columns.map((year) => {
                  const v = row.values[String(year)];
                  const low =
                    columns.find((c) => c.year === year)?.confidence?.[row.id] !== undefined &&
                    (columns.find((c) => c.year === year)?.confidence?.[row.id] ?? 100) < 65;
                  return (
                    <td
                      key={year}
                      className={[
                        "px-5 py-3 text-right font-mono tabular-nums text-stone-900",
                        low ? "bg-amber-50/80" : "",
                      ].join(" ")}
                    >
                      {v != null ? formatExcelNumber(v) : "—"}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
