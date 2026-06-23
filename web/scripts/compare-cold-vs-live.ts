/**
 * Compare cold-test parse (cached OCR) vs production pipeline (parseTaxReturn).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { parseTaxReturn } from "../src/lib/tax-return-parser";
import { scorePrimary } from "./lib/tax-benchmark-score";
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
  const cachePath = path.join(process.cwd(), "scripts", "ocr-cache", `kcf-${year}-${mode}.txt`);
  const cachedOcr = await readFile(cachePath, "utf8").catch(() => "");

  const cold = parseTaxReturnFromText(path.basename(pdfPath), embedded, cachedOcr, year, { ocrMode: mode });
  const coldScore = scorePrimary(fixtureKey(client, year), cold.values);

  const live = await parseTaxReturn(path.basename(pdfPath), bytes, embedded, year, mode, cachedOcr);
  const liveScore = scorePrimary(fixtureKey(client, year), live.values);

  console.log(`\n=== ${year} (${mode}) ===`);
  console.log(`cold: ${coldScore.ok}/${coldScore.n} (${coldScore.pct.toFixed(1)}%) source=${cold.source}`);
  console.log(`live: ${liveScore.ok}/${liveScore.n} (${liveScore.pct.toFixed(1)}%) source=${live.source}`);

  const allIds = new Set([...coldScore.misses, ...liveScore.misses].map((m) => m.split(":")[0]!));
  for (const id of [...allIds].sort()) {
    const cv = cold.values[id];
    const lv = live.values[id];
    if (cv !== lv) {
      console.log(
        `  DIFF ${id}: cold=${cv ?? "blank"} (${cold.fieldSources?.[id]}) live=${lv ?? "blank"} (${live.fieldSources?.[id]})`,
      );
    }
  }
  if (coldScore.misses.length) console.log("  cold misses:", coldScore.misses.join("; "));
  if (liveScore.misses.length) console.log("  live misses:", liveScore.misses.join("; "));
}

async function main() {
  for (const year of client.years) await runYear(year);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
