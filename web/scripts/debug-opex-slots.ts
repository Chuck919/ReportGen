import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { fixtureKey, TAX_BENCHMARK_CLIENTS } from "./lib/tax-benchmark-clients";
import { OPERATING_EXPENSE_SLOT_IDS } from "../src/lib/tax/operating-expenses";
import changwenFixtures from "./changwen-fixtures.json";
import { WORKBOOK_COMPARISON_FIXTURES } from "../src/lib/workbook-comparison-fixtures";

const clientId = process.argv[2] ?? "arizona-sun";
const year = Number(process.argv[3] ?? 2022);
const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === clientId)!;
const ALL = { ...WORKBOOK_COMPARISON_FIXTURES.tax, ...changwenFixtures } as Record<
  string,
  { values: Record<string, number> }
>;
const fk = fixtureKey(client, year);
const exp = ALL[fk]?.values ?? {};

async function main() {
  const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
  const bytes = await readFile(pdfPath);
  const embedded = await getEmbeddedPdfText(bytes);
  const ocr = await readFile(`scripts/ocr-cache/${clientId}-${year}-balanced.txt`, "utf8");
  const parsed = parseTaxReturnFromText(path.basename(pdfPath), embedded, ocr, year, { ocrMode: "balanced" });
  console.log(`\n${clientId} ${year} other_opex:`, parsed.values.other_operating_expenses);
  for (const id of OPERATING_EXPENSE_SLOT_IDS) {
    console.log(`${id}: exp=${exp[id] ?? 0} got=${parsed.values[id] ?? 0}`);
  }
}

main().catch(console.error);
