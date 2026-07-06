/**
 * Live local OCR: balanced vs thorough on one client-year (field accuracy).
 *   npx tsx scripts/compare-balanced-thorough-live.ts [clientId] [year]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { parseTaxReturn } from "../src/lib/tax-return-parser";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { scoreAllFieldsExcludingOpexSlots, scoreOpexAmountsOnly } from "./lib/tax-benchmark-score";
import { TAX_BENCHMARK_CLIENTS, fixtureKey } from "./lib/tax-benchmark-clients";
import { forceExit } from "./lib/force-exit";

const clientId = process.argv[2] ?? "arizona-sun";
const year = Number(process.argv[3] ?? 2024);

async function main() {
  const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === clientId);
  if (!client) throw new Error(`Unknown client ${clientId}`);
  const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
  const bytes = await readFile(pdfPath);
  const embedded = await getEmbeddedPdfText(bytes);
  const fk = fixtureKey(client, year);
  const name = path.basename(pdfPath);

  for (const mode of ["balanced", "thorough"] as const) {
    const t0 = Date.now();
    const parsed = await parseTaxReturn(name, bytes, embedded, year, mode);
    const fields = scoreAllFieldsExcludingOpexSlots(fk, parsed.values);
    const opex = scoreOpexAmountsOnly(fk, parsed.values);
    console.log(
      `${mode}: fields ${fields.pct.toFixed(1)}% opex ${opex.pct.toFixed(1)}% ` +
        `${((Date.now() - t0) / 1000).toFixed(0)}s` +
        (fields.misses.length ? ` misses: ${fields.misses.join("; ")}` : " ok"),
    );
  }
  forceExit(0);
}

main().catch((e) => {
  console.error(e);
  forceExit(2);
});
