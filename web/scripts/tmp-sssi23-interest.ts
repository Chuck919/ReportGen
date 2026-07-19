/** Trace where interest_expense=250 comes from in the live OCR parse. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { parseTwoYearComparisonBlock } from "../src/lib/two-year-comparison-parser";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { TAX_BENCHMARK_CLIENTS } from "./lib/tax-benchmark-clients";

async function main() {
  const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === "sssi")!;
  const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), 2023);
  const bytes = await readFile(pdfPath);
  const embedded = await getEmbeddedPdfText(bytes);
  const live = await readFile("scripts/benchmark-output/sssi-2023-liveocr.txt", "utf8");
  const allText = `${embedded}\n${live}`;

  const comp = parseTwoYearComparisonBlock(allText, 2023);
  console.log("headerYears:", comp?.headerYears, "linesMatched:", comp?.linesMatched);
  console.log("interest:", comp?.values.interest_expense, "conf:", comp?.confidence.interest_expense);
  console.log("all comp values:", JSON.stringify(comp?.values));

  // Which raw lines classify as interest?
  for (const raw of allText.split(/\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!/interest/i.test(line)) continue;
    if (!/250/.test(line)) continue;
    console.log("CANDIDATE:", JSON.stringify(line.slice(0, 200)));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
