/**
 * Table export regression tests.
 * Run: npm run test:upload
 */
import { buildTaxTable, formatTableAsMarkdown } from "../src/lib/tax/export-table";
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

const sample: TaxYearValues[] = [
  {
    year: 2024,
    values: { sales: 1000000, cogs: 300000 },
    source: "test",
  },
];

const table = buildTaxTable(sample);
assert(table.columns.length === 1 && table.columns[0] === 2024, "columns from data");
assert(table.rows.some((r) => r.id === "sales" && r.values["2024"] === 1000000), "sales row");
assert(
  table.rows.some((r) => r.id === "rent" && r.values["2024"] === null),
  "missing fields appear as null with label",
);
assert(table.rows.length >= 40, "all input rows included");
assert(table.tsv.includes("1000000"), "tsv has value");
assert(formatTableAsMarkdown(table).includes("Sales"), "markdown has header");
assert(formatTableAsMarkdown(table).includes("Rent"), "markdown includes rows without values");

console.log(`\n=== table export: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
