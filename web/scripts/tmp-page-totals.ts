/** Page totals for every fixture PDF — bound the phase-1 blind-gap fix blast radius. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { TAX_BENCHMARK_CLIENTS } from "./lib/tax-benchmark-clients";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readPdfPageTotal } = require("./ocr-targets.cjs");

async function main() {
  for (const client of TAX_BENCHMARK_CLIENTS) {
    for (const year of client.years) {
      try {
        const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
        const bytes = await readFile(pdfPath);
        const total = await readPdfPageTotal(Buffer.from(bytes));
        const midLo = Math.max(14, Math.floor(total * 0.3));
        const gap = total <= 100 && midLo > 15 ? `15-${midLo - 1}` : "(none)";
        console.log(`${client.id} ${year}: ${total}pp  blind-gap=${gap}`);
      } catch (e) {
        console.log(`${client.id} ${year}: error ${(e as Error).message}`);
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
