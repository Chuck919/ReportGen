/**
 * True live simulation — fresh OCR, no cache (matches web upload).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { parseTaxReturn } from "../src/lib/tax-return-parser";
import { scorePrimary, scoreAllFields } from "./lib/tax-benchmark-score";
import { TAX_BENCHMARK_CLIENTS, fixtureKey } from "./lib/tax-benchmark-clients";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import type { OcrMode } from "../src/lib/tax-return/local-ocr";

const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === "kcf")!;
const mode: OcrMode = (process.argv[2] as OcrMode) ?? "thorough";
const year = Number(process.argv[3] ?? 2023);

async function main() {
  const docsDir = path.resolve(process.cwd(), client.docsDir);
  const pdfPath = await resolveTaxReturnPdf(docsDir, year);
  const bytes = await readFile(pdfPath);
  const embedded = await getEmbeddedPdfText(bytes);

  console.log(`Fresh OCR ${mode} for ${year}…`);
  const live = await parseTaxReturn(path.basename(pdfPath), bytes, embedded, year, mode);
  const score = scorePrimary(fixtureKey(client, year), live.values);
  const allScore = scoreAllFields(fixtureKey(client, year), live.values);

  console.log(`primary: ${score.ok}/${score.n} (${score.pct.toFixed(1)}%)`);
  console.log(`all fields: ${allScore.ok}/${allScore.n} (${allScore.pct.toFixed(1)}%) source=${live.source}`);
  console.log("amortization:", live.values.amortization, live.fieldSources?.amortization);
  console.log("depreciation:", live.values.depreciation, live.fieldSources?.depreciation);
  if (allScore.misses.length) {
    for (const m of allScore.misses) {
      const id = m.split(":")[0]!;
      console.log(`  ${m} | src=${live.fieldSources?.[id]}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
