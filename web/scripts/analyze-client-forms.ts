/**
 * Form analysis per client/year — embedded PDF text + detected primary form.
 *
 *   npx tsx scripts/analyze-client-forms.ts
 */
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { TAX_BENCHMARK_CLIENTS, resolveClientDocsDir, type TaxBenchmarkClient } from "./lib/tax-benchmark-clients";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { detectTaxForm } from "../src/lib/tax-return/detect-tax-form";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import type { OcrMode } from "../src/lib/tax-return/local-ocr";

const CACHE_DIR = path.join(process.cwd(), "scripts", "ocr-cache");

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function ocrCacheSnippet(client: TaxBenchmarkClient, year: number): Promise<string> {
  for (const mode of ["balanced", "thorough", "fast"] as OcrMode[]) {
    const names =
      client.id === "kcf"
        ? [`${year}-${mode}.txt`]
        : [`${client.id}-${year}-${mode}.txt`, `${client.id}-${year}-${mode}-run1.txt`];
    for (const n of names) {
      const p = path.join(CACHE_DIR, n);
      if (await fileExists(p)) return readFile(p, "utf8").then((t) => t.slice(0, 120_000));
    }
  }
  return "";
}

async function main() {
  console.log("client:year | detected form | confidence | forms mentioned");
  console.log("-".repeat(72));
  for (const c of TAX_BENCHMARK_CLIENTS) {
    for (const year of c.years) {
      try {
        const pdf = await resolveTaxReturnPdf(resolveClientDocsDir(c), year);
        const bytes = await readFile(pdf);
        const embedded = await getEmbeddedPdfText(bytes).catch(() => "");
        const ocr = await ocrCacheSnippet(c, year);
        const analysis = detectTaxForm(`${embedded}\n${ocr}`);
        const forms =
          analysis.formsMentioned.slice(0, 4).join(", ") || analysis.signals.join(", ") || "—";
        console.log(
          `${c.id}:${year}`.padEnd(14) +
            ` | ${analysis.kind.padEnd(12)} | ${String(analysis.confidence).padStart(3)}%` +
            ` | ${forms}`,
        );
      } catch (e) {
        console.log(`${c.id}:${year}`.padEnd(14) + ` | ERR ${(e as Error).message}`);
      }
    }
  }
}

main();
