/**
 * Client identity + merge isolation tests.
 * Run: npx tsx scripts/test-client-merge.ts
 */
import { normalizeClientKey, extractBusinessName } from "../src/lib/tax-return/extract-business-name";
import { mergeParsedTaxYears } from "../src/lib/tax/client-merge";

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

console.log("=== client merge ===");

assert(normalizeClientKey("KC Fudge LLC") !== normalizeClientKey("Arizona Sun Supply Inc"), "KCF vs Arizona keys differ");

const arizona = extractBusinessName("PREPARED FOR:\nArizona Sun Supply Inc\n123 Main St", "arizona-2023.pdf");
assert(arizona?.includes("Arizona"), "extracts Arizona from prepared for");

const { columns: merged, warnings } = mergeParsedTaxYears(
  [
    {
      year: 2023,
      values: { sales: 100 },
      clientKey: "arizona sun supply",
      clientName: "Arizona Sun Supply Inc",
      source: "test",
    },
  ],
  [
    {
      year: 2024,
      values: { sales: 200 },
      clientKey: "kc fudge",
      clientName: "KC Fudge LLC",
      filename: "kcf.pdf",
      source: "test",
    },
  ],
);
assert(merged.length === 1 && merged[0]!.year === 2024, "different company replaces prior years");
assert(warnings.length > 0, "warns on company switch");

const sameCo = mergeParsedTaxYears(merged, [
  {
    year: 2023,
    values: { sales: 150 },
    clientKey: "kc fudge",
    clientName: "KC Fudge LLC",
    filename: "kcf-2023.pdf",
    source: "test",
  },
]);
assert(sameCo.columns.length === 2, "same company merges multiple years");

// Progressive multi-year upload: OCR caption junk must not wipe prior years.
let prog = mergeParsedTaxYears([], [
  {
    year: 2023,
    values: { sales: 1 },
    clientKey: "identification incorporation stock owned",
    clientName: "Identification incorporation Stock Owned",
    source: "test",
  },
]);
prog = mergeParsedTaxYears(prog.columns, [
  {
    year: 2024,
    values: { sales: 2 },
    clientKey: "kc fudge",
    clientName: "KC Fudge LLC",
    source: "test",
  },
]);
prog = mergeParsedTaxYears(prog.columns, [
  {
    year: 2025,
    values: { sales: 3 },
    clientKey: "kc fudge",
    clientName: "KC Fudge LLC",
    source: "test",
  },
]);
assert(prog.columns.length === 3, "OCR junk key does not wipe progressive years");
assert(prog.warnings.length === 0, "no company-switch warning on OCR junk drift");

// Preparer LLC OCR vs real taxpayer — still same progressive upload.
let cari = mergeParsedTaxYears([], [
  {
    year: 2021,
    values: { sales: 1 },
    clientKey: "adamsbrown",
    clientName: "ADAMSBROWN, LLC",
    source: "test",
  },
]);
cari = mergeParsedTaxYears(cari.columns, [
  {
    year: 2023,
    values: { sales: 2 },
    clientKey: "carithers liquor",
    clientName: "CARITHERS LIQUOR, LLC",
    source: "test",
  },
]);
assert(cari.columns.length === 2, "preparer vs taxpayer OCR does not wipe progressive years");

// SSSI: preparer "Judd & Judd, PLLC" must not wipe Strategic Solution years.
let sssi = mergeParsedTaxYears([], [
  {
    year: 2022,
    values: { sales: 1 },
    clientKey: "strategic solution services",
    clientName: "STRATEGIC SOLUTION SERVICES INC",
    source: "test",
  },
]);
sssi = mergeParsedTaxYears(sssi.columns, [
  {
    year: 2023,
    values: { sales: 2 },
    clientKey: "judd judd",
    clientName: "Judd & Judd, PLLC",
    source: "test",
  },
]);
assert(sssi.columns.length === 2, "SSSI preparer OCR does not wipe progressive years");

console.log(`\n=== client merge: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
