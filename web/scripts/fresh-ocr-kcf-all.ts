/**
 * Fresh OCR all KCF years — matches live web upload (no cache).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { parseTaxReturn } from "../src/lib/tax-return-parser";
import { scoreAllFields, scorePrimary } from "./lib/tax-benchmark-score";
import { TAX_BENCHMARK_CLIENTS, fixtureKey } from "./lib/tax-benchmark-clients";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import type { OcrMode } from "../src/lib/tax-return/local-ocr";

const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === "kcf")!;
const mode: OcrMode = (process.argv[2] as OcrMode) ?? "thorough";

async function runYear(year: number) {
  const docsDir = path.resolve(process.cwd(), client.docsDir);
  const pdfPath = await resolveTaxReturnPdf(docsDir, year);
  const bytes = await readFile(pdfPath);
  const embedded = await getEmbeddedPdfText(bytes);
  console.log(`\n[fresh OCR] ${year} ${mode}…`);
  const live = await parseTaxReturn(path.basename(pdfPath), bytes, embedded, year, mode);
  const primary = scorePrimary(fixtureKey(client, year), live.values);
  const all = scoreAllFields(fixtureKey(client, year), live.values);
  console.log(`  primary ${primary.ok}/${primary.n} (${primary.pct.toFixed(1)}%)`);
  console.log(`  all     ${all.ok}/${all.n} (${all.pct.toFixed(1)}%)`);
  console.log(`  amort=${live.values.amortization ?? "blank"} (${live.fieldSources?.amortization ?? "-"})`);
  if (all.misses.length) console.log(`  misses: ${all.misses.join("; ")}`);
}

async function main() {
  for (const year of client.years) await runYear(year);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
