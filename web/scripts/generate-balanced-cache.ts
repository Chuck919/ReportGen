/**
 * One-off: generate balanced-mode OCR cache for all benchmark clients/years
 * that are missing `${clientId}-${year}-balanced.txt` in scripts/ocr-cache.
 *
 * Usage: npx tsx scripts/generate-balanced-cache.ts [clientId?]
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runLocalOcr } from "../src/lib/tax-return/local-ocr";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { TAX_BENCHMARK_CLIENTS } from "./lib/tax-benchmark-clients";
import { forceExit } from "./lib/force-exit";

const CACHE_DIR = path.join(process.cwd(), "scripts", "ocr-cache");
const onlyClient = process.argv[2];

async function hasCache(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const clients = TAX_BENCHMARK_CLIENTS.filter((c) => !onlyClient || c.id === onlyClient);
  await mkdir(CACHE_DIR, { recursive: true });

  for (const client of clients) {
    for (const year of client.years) {
      const cachePath = path.join(CACHE_DIR, `${client.id}-${year}-balanced.txt`);
      if (await hasCache(cachePath)) {
        console.log(`skip ${client.id} ${year}: cache exists`);
        continue;
      }
      const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
      const bytes = await readFile(pdfPath);
      console.log(`OCR ${client.id} ${year} (balanced)…`);
      const t0 = Date.now();
      const ocr = await runLocalOcr(bytes, { profile: "tax", mode: "balanced" });
      const ms = Date.now() - t0;
      await writeFile(cachePath, ocr.text, "utf8");
      console.log(`  wrote ${cachePath} (${(ms / 1000).toFixed(1)}s, ${ocr.pages} pages)`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(forceExit);
