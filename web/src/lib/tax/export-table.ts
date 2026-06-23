import {
  TAX_WORKBOOK_ROWS,
  buildPasteTsv,
  formatExcelNumber,
  type TaxYearValues,
} from "@/lib/tax-workbook";

export type TaxTableRow = {
  id: string;
  label: string;
  section: string;
  values: Record<string, number | null>;
};

export type TaxTableResponse = {
  columns: number[];
  rows: TaxTableRow[];
  tsv: string;
};

/** Workbook table for API consumers and UI — all input rows, empty/null when not extracted. */
export function buildTaxTable(columns: TaxYearValues[]): TaxTableResponse {
  const years = Array.from(new Set(columns.map((c) => c.year))).sort((a, b) => a - b);
  const byYear = new Map(columns.map((c) => [c.year, c]));

  const rows: TaxTableRow[] = TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "input").map((row) => {
    const values: Record<string, number | null> = {};
    for (const year of years) {
      const v = byYear.get(year)?.values[row.id];
      values[String(year)] = v !== undefined ? v : null;
    }
    return { id: row.id, label: row.label, section: row.section, values };
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
