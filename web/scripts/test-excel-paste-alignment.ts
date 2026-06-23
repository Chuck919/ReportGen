/**
 * Verify TSV paste layout matches KCF Excel workbook (row order, year columns, input rows).
 * Run: npm run test:excel-paste
 */
import { buildPasteTsv, TAX_WORKBOOK_ROWS, TAX_YEARS } from "../src/lib/tax-workbook";
import { WORKBOOK_COMPARISON_FIXTURES } from "../src/lib/workbook-comparison-fixtures";
import type { TaxYearValues } from "../src/lib/tax-workbook";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ok: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function fixtureToColumn(year: number): TaxYearValues {
  const key = `KCF MAIN CURRENT EXCEL.xlsx / ${year}`;
  const f = WORKBOOK_COMPARISON_FIXTURES.tax[key];
  if (!f) throw new Error(`missing fixture ${key}`);
  return { year: f.year, values: f.values, source: "fixture" };
}

const columns = [2025, 2024, 2023].map(fixtureToColumn);
const tsv = buildPasteTsv(columns, { workbookLayout: true, singleColumn: false });
const lines = tsv.split("\n");

assert(lines.length === TAX_WORKBOOK_ROWS.length, `TSV line count ${lines.length} = workbook rows ${TAX_WORKBOOK_ROWS.length}`);

let lineIdx = 0;
for (const row of TAX_WORKBOOK_ROWS) {
  const cells = lines[lineIdx]!.split("\t");
  assert(cells.length === TAX_YEARS.length, `row ${row.row} (${row.id}) has ${TAX_YEARS.length} year columns`);
  if (row.excelBehavior === "formula") {
    assert(cells.every((c) => c === ""), `formula row ${row.id} leaves year cells empty for Excel formulas`);
  }
  lineIdx++;
}

// Year column order: 2023, 2024, 2025 — newest on the right
const salesLine = lines[TAX_WORKBOOK_ROWS.findIndex((r) => r.id === "sales")];
const salesCells = salesLine!.split("\t");
assert(salesCells[0] === "1086475.00", "2023 sales in column 1 (left)");
assert(salesCells[1] === "1066455.00", "2024 sales in column 2");
assert(salesCells[2] === "1027658.00", "2025 sales in column 3 (right)");

const cogsLine = lines[TAX_WORKBOOK_ROWS.findIndex((r) => r.id === "cogs")];
assert(cogsLine!.split("\t")[1] === "313334.00", "2024 cogs in column 2");

const depLine = lines[TAX_WORKBOOK_ROWS.findIndex((r) => r.id === "depreciation")];
const depCells = depLine!.split("\t");
assert(depCells[0] === "0.00", "2023 depreciation");
assert(depCells[1] === "0.00", "2024 depreciation");
assert(depCells[2] === "12860.00", "2025 depreciation");

const amortLine = lines[TAX_WORKBOOK_ROWS.findIndex((r) => r.id === "amortization")];
const amortCells = amortLine!.split("\t");
assert(amortCells[0] === "14174.00", "2023 amortization");
assert(amortCells[1] === "0.00", "2024 amortization");
assert(amortCells[2] === "0.00", "2025 amortization");

// Partial year upload: only 2024 — other year columns blank (workbook layout)
const partial = buildPasteTsv([fixtureToColumn(2024)], { workbookLayout: true, singleColumn: false });
const partialSales = partial.split("\n")[TAX_WORKBOOK_ROWS.findIndex((r) => r.id === "sales")]!.split("\t");
assert(partialSales[0] === "", "missing 2025 is blank");
assert(partialSales[1] === "1066455.00", "2024 still in column 2");
assert(partialSales[2] === "", "missing 2023 is blank");

// Single-column paste (UI default): one value per row for latest year
const singleCol = buildPasteTsv([fixtureToColumn(2024)], { section: "Income Statement Data" });
const singleLines = singleCol.split("\n");
assert(singleLines[0]!.split("\t").length === 1, "single-column income paste is one cell wide");
assert(singleLines[0] === "1066455.00", "single-column sales with cents");

console.log(`\n=== excel paste alignment: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
