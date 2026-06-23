/**
 * Re-score cached OCR with current parser (no new OCR).
 *
 *   npm run reparse:cached              # all clients with cache
 *   npm run reparse:cached -- kcf 2025 balanced
 */
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import {
  TAX_BENCHMARK_CLIENTS,
  fixtureKey,
  resolveClientDocsDir,
  type TaxBenchmarkClient,
} from "./lib/tax-benchmark-clients";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { scorePrimary } from "./lib/tax-benchmark-score";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { detectTaxForm } from "../src/lib/tax-return/detect-tax-form";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import type { OcrMode } from "../src/lib/tax-return/local-ocr";

const MODES: OcrMode[] = ["fast", "balanced", "thorough"];
const CACHE_DIR = path.join(process.cwd(), "scripts", "ocr-cache");

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function cachePath(client: TaxBenchmarkClient, year: number, mode: OcrMode): string {
  if (client.id === "kcf") return path.join(CACHE_DIR, `${year}-${mode}.txt`);
  return path.join(CACHE_DIR, `${client.id}-${year}-${mode}.txt`);
}

async function embeddedText(bytes: Uint8Array): Promise<string> {
  return getEmbeddedPdfText(bytes);
}

async function reparseOne(client: TaxBenchmarkClient, year: number, mode: OcrMode) {
  const cp = cachePath(client, year, mode);
  if (!(await fileExists(cp))) {
    console.log(`${client.id} ${year} ${mode}: no cache (${path.basename(cp)})`);
    return;
  }
  const docsDir = resolveClientDocsDir(client);
  const pdfPath = await resolveTaxReturnPdf(docsDir, year);
  const bytes = await readFile(pdfPath);
  const embedded = await embeddedText(bytes);
  const ocr = await readFile(cp, "utf8");
  const allText = `${embedded}\n${ocr}`;
  const form = detectTaxForm(allText);
  const parsed = parseTaxReturnFromText(path.basename(pdfPath), embedded, ocr, year, { ocrMode: mode });
  const score = scorePrimary(fixtureKey(client, year), parsed.values);
  console.log(
    `${client.id} ${year} ${mode}: ${score.pct.toFixed(1)}% (${score.ok}/${score.n}) form=${form.kind}`,
  );
  if (score.misses.length) {
    for (const m of score.misses.slice(0, 5)) {
      const id = m.split(":")[0]!;
      const conf = parsed.confidence[id];
      const src = parsed.fieldSources?.[id];
      console.log(`  ${m}${conf != null ? ` conf=${conf}` : ""}${src ? ` (${src})` : ""}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const [clientId, yearStr, modeArg] = args;
  if (clientId && yearStr && modeArg) {
    const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === clientId);
    if (!client) throw new Error(`Unknown client ${clientId}`);
    await reparseOne(client, Number(yearStr), modeArg as OcrMode);
    return;
  }
  for (const client of TAX_BENCHMARK_CLIENTS) {
    for (const year of client.years) {
      for (const mode of MODES) {
        const cp = cachePath(client, year, mode);
        if (await fileExists(cp)) await reparseOne(client, year, mode);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
