import { readFile } from "node:fs/promises";
import { PDFParse } from "pdf-parse";
import { TAX_BENCHMARK_CLIENTS, resolveClientDocsDir } from "./lib/tax-benchmark-clients";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";

async function main() {
  for (const c of TAX_BENCHMARK_CLIENTS.filter((x) => x.id !== "kcf")) {
    for (const year of c.years) {
      try {
        const pdf = await resolveTaxReturnPdf(resolveClientDocsDir(c), year);
        const bytes = await readFile(pdf);
        const p = new PDFParse({ data: Buffer.from(bytes) });
        const t = await p.getText();
        await p.destroy?.();
        const forms = [...new Set((t.text ?? "").match(/Form\s+10\d{2}[A-Z-]*/gi) ?? [])].slice(0, 3);
        console.log(`${c.id} ${year}: ${forms.join(", ") || "unknown"}`);
      } catch (e) {
        console.log(`${c.id} ${year}: ERR ${(e as Error).message}`);
      }
    }
  }
}

main();
