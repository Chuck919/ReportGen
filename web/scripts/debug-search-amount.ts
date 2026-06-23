import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { TAX_BENCHMARK_CLIENTS } from "./lib/tax-benchmark-clients";

async function main() {
  const clientId = process.argv[2] ?? "carithers";
  const year = Number(process.argv[3] ?? 2023);
  const amounts = process.argv.slice(4).map(Number).filter(Number.isFinite);
  const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === clientId)!;
  const pdf = await resolveTaxReturnPdf(path.resolve(client.docsDir), year);
  const t = await getEmbeddedPdfText(await readFile(pdf));
  for (const n of amounts) {
    const s = String(n);
    const withComma = n.toLocaleString("en-US");
    for (const needle of [s, withComma]) {
      const i = t.indexOf(needle);
      console.log(
        n,
        needle,
        i >= 0 ? t.slice(Math.max(0, i - 70), i + needle.length + 30).replace(/\n/g, " | ") : "NOT FOUND",
      );
    }
  }
}

main();
