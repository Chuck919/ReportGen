import {
  TAX_WORKBOOK_ROWS,
  buildPasteTsv,
  formatExcelNumber,
  type TaxYearValues,
} from "@/lib/tax-workbook";
import { resolveWorkbookDisplayValues } from "@/lib/tax/workbook-display";
import {
  OPERATING_EXPENSE_SLOT_IDS,
  resolveOpexSlotLabel,
  sharedOpexSlotLabels,
} from "@/lib/tax/operating-expenses";

export type TaxTableRow = {
  id: string;
  label: string;
  section: string;
  excelBehavior: "input" | "formula";
  excelRow: number;
  values: Record<string, number | null>;
};

export type TaxTableResponse = {
  columns: number[];
  rows: TaxTableRow[];
  tsv: string;
};

export type BuildTaxTableOptions = {
  /** When true, year columns display newest-first (UI only — paste order unchanged). */
  reverseYears?: boolean;
};

/** Workbook table for API consumers and UI — all rows including formula lines. */
export function buildTaxTable(columns: TaxYearValues[], options?: BuildTaxTableOptions): TaxTableResponse {
  const years = Array.from(new Set(columns.map((c) => c.year))).sort((a, b) =>
    options?.reverseYears ? b - a : a - b,
  );
  const byYear = new Map(columns.map((c) => [c.year, c]));
  const sharedLabels = sharedOpexSlotLabels(columns);

  const rows: TaxTableRow[] = TAX_WORKBOOK_ROWS.map((row) => {
    const values: Record<string, number | null> = {};
    for (const year of years) {
      const col = byYear.get(year);
      const computed = col ? resolveWorkbookDisplayValues(col) : {};
      const v = computed[row.id];
      values[String(year)] = v !== undefined ? v : null;
    }
    const latestCol = [...columns].sort((a, b) => b.year - a.year)[0];
    const dynamicLabel =
      OPERATING_EXPENSE_SLOT_IDS.includes(row.id as (typeof OPERATING_EXPENSE_SLOT_IDS)[number])
        ? sharedLabels[row.id] ?? resolveOpexSlotLabel(latestCol, row.id) ?? row.label
        : row.label;
    return {
      id: row.id,
      label: dynamicLabel,
      section: row.section,
      excelBehavior: row.excelBehavior,
      excelRow: row.row,
      values,
    };
  });

  return {
    columns: years,
    rows,
    tsv: buildPasteTsv(columns, { workbookLayout: true, singleColumn: false }),
  };
}

export function formatTableAsMarkdown(table: TaxTableResponse): string {
  if (!table.columns.length) return "";
  const header = ["Line item", ...table.columns.map(String)].join(" | ");
  const sep = ["---", ...table.columns.map(() => "---")].join(" | ");
  const body = table.rows
    .map((row) => {
      const cells = table.columns.map((y) => {
        const v = row.values[String(y)];
        return v !== null && v !== undefined ? formatExcelNumber(v) : "";
      });
      return [row.label, ...cells].join(" | ");
    })
    .join("\n");
  return `${header}\n${sep}\n${body}`;
}
