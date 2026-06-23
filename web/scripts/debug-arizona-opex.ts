import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import {
  extractOtherDeductionsBlockOpex,
  blockOpexClosesStatement,
  scanStatement2Total,
} from "../src/lib/tax-return/statement-extractors";
import { TAX_BENCHMARK_CLIENTS } from "./lib/tax-benchmark-clients";
import { scoreAllFields } from "./lib/tax-benchmark-score";
import { fixtureKey } from "./lib/tax-benchmark-clients";

async function main() {
const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === "arizona-sun")!;
const years = process.argv.slice(2).map(Number).filter(Boolean);
const targetYears = years.length ? years : [2022, 2023, 2024, 2025];

for (const year of targetYears) {
  const docsDir = path.resolve(process.cwd(), client.docsDir);
  const pdfPath = await resolveTaxReturnPdf(docsDir, year);
  const bytes = await readFile(pdfPath);
  const embedded = await getEmbeddedPdfText(bytes);
  const parsed = parseTaxReturnFromText(path.basename(pdfPath), embedded, "", year);
  const block = extractOtherDeductionsBlockOpex(embedded);
  const closes = blockOpexClosesStatement(block, parsed, embedded);
  const score = scoreAllFields(fixtureKey(client, year), parsed.values);
  console.log(`--- arizona-sun ${year} ---`);
  console.log("allPct:", score.pct.toFixed(1), "misses:", score.misses.join("; ") || "OK");
  console.log("opex:", parsed.values.other_operating_expenses, "src:", parsed.fieldSources?.other_operating_expenses);
  console.log("block:", JSON.stringify(block));
  console.log("closes:", closes, "stmt2Total:", scanStatement2Total(embedded));
  console.log(
    "prof/util/bank:",
    parsed.values.professional_fees,
    parsed.values.utilities,
    parsed.values.bank_credit_card,
  );
}
}

main().catch((e) => { console.error(e); process.exit(1); });
