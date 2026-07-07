/** Quick look: what Stmt-2 lines the e5 parser extracts per Carithers year. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { extractOperatingExpenseLinesFromText, expenseCategoryKey } from "../src/lib/tax/operating-expenses";
import { forceExit } from "./lib/force-exit";

const CACHE_DIR = path.join(process.cwd(), "scripts", "ocr-cache");
const years = [2021, 2022, 2023, 2024, 2025];
const docsDir = path.join("..", "Documents", "For Changwen", "carithers-liquor");

async function main() {
  for (const year of years) {
    const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), docsDir), year);
    const bytes = await readFile(pdfPath);
    const embedded = await getEmbeddedPdfText(bytes);
    const ocr = await readFile(path.join(CACHE_DIR, `carithers-${year}-balanced.txt`), "utf8");
    const allText = `${embedded}\n${ocr}`;
    const lines = extractOperatingExpenseLinesFromText(allText);
    console.log(`\n=== ${year} ===`);
    for (const l of lines) {
      console.log(`  ${expenseCategoryKey(l.label) ?? "(uncategorized)"}: ${l.label} = ${l.amount} [${l.source}]`);
    }
    const parsed = parseTaxReturnFromText(path.basename(pdfPath), embedded, ocr, year, { ocrMode: "balanced" });
    console.log(
      `  parsed advertising=${parsed.values.advertising ?? "—"} (${parsed.fieldSources?.advertising ?? "—"})` +
        ` bank_credit_card=${parsed.values.bank_credit_card ?? "—"} (${parsed.fieldSources?.bank_credit_card ?? "—"})`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(forceExit);
