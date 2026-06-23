/** Quick field debug — embedded + optional OCR cache, no full OCR run. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { scoreAllFields } from "./lib/tax-benchmark-score";
import { TAX_BENCHMARK_CLIENTS, fixtureKey } from "./lib/tax-benchmark-clients";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { refillFromComparisonLabeledRows } from "../src/lib/tax-return/comparison-field-rows";
import { pickComparisonOpex } from "../src/lib/tax-return/comparison-opex";
import { parseTwoYearComparisonBlock } from "../src/lib/two-year-comparison-parser";

const clientId = process.argv[2] ?? "carithers";
const year = Number(process.argv[3] ?? 2021);
const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === clientId)!;

async function main() {
  const docsDir = path.resolve(process.cwd(), client.docsDir);
  const pdfPath = await resolveTaxReturnPdf(docsDir, year);
  const bytes = await readFile(pdfPath);
  const embedded = await getEmbeddedPdfText(bytes);
  const cachePath = path.join(process.cwd(), "scripts", "ocr-cache", `${clientId}-${year}-thorough.txt`);
  const ocr = await readFile(cachePath, "utf8").catch(() => "");
  const allText = `${embedded}\n${ocr}`;

  const comparison = parseTwoYearComparisonBlock(allText, year);
  console.log("comparison header:", comparison?.headerYears, "lines:", comparison?.linesMatched);
  console.log("comparison opex:", comparison?.values.other_operating_expenses);
  console.log("comparison utilities:", comparison?.values.utilities);
  console.log("comparison cogs:", comparison?.values.cogs);
  console.log("comparison taxes_lic:", comparison?.values.taxes_licenses, "taxes_paid:", comparison?.values.taxes_paid);

  const opexPick = pickComparisonOpex(allText, year, comparison, {
    attachmentSum: (comparison?.values.bank_credit_card ?? 0) + (comparison?.values.professional_fees ?? 0) + (comparison?.values.utilities ?? 0),
  });
  console.log("pickComparisonOpex:", opexPick);

  // Show UTILITIES lines in comparison block
  const blockStart = allText.search(/two\s*year\s*comparison|t\w{0,3}\s*y\s*ear\s*\w{0,6}\s*omparison|gross\s+receipts/i);
  if (blockStart >= 0) {
    const block = allText.slice(blockStart, blockStart + 8000);
    console.log("\n--- comparison lines (utilities/opex/taxes) ---");
    for (const line of block.split(/\n/)) {
      const t = line.replace(/\s+/g, " ").trim();
      if (/utilit|other\s+operat|other\s+deduct|taxes\s+and\s+lic|cogs|cost\s+of/i.test(t) && /\d/.test(t)) {
        console.log(t.slice(0, 120));
      }
    }
  }

  const r = parseTaxReturnFromText(path.basename(pdfPath), embedded, ocr, year, { ocrMode: "thorough" });
  const score = scoreAllFields(fixtureKey(client, year), r.values);
  console.log(`\n=== ${clientId} ${year} ===`);
  console.log(`all-fields: ${score.pct.toFixed(1)}% (${score.ok}/${score.n})`);
  console.log("misses:", score.misses.join("; "));
        for (const f of ["other_stock_equity", "unclassified_equity", "utilities", "other_operating_expenses", "other_operating_income", "other_income", "cogs", "taxes_licenses", "taxes_paid", "inventory", "depreciation", "interest_expense"]) {
    const v = r.values[f as keyof typeof r.values];
    if (v !== undefined || score.misses.some((m) => m.startsWith(f + ":"))) {
      console.log(`  ${f}: ${v ?? "blank"} src=${r.fieldSources?.[f] ?? "?"}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
