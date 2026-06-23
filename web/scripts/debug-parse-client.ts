import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { extractForm1120Anchors } from "../src/lib/tax-return/form-anchors";
import { scorePrimary } from "./lib/tax-benchmark-score";
import { TAX_BENCHMARK_CLIENTS, fixtureKey } from "./lib/tax-benchmark-clients";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";

async function main() {
  const clientId = process.argv[2] ?? "carithers";
  const year = Number(process.argv[3] ?? 2024);
  const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === clientId)!;
  const docsDir = path.resolve(process.cwd(), client.docsDir);

  const pdfPath = await resolveTaxReturnPdf(docsDir, year);
  const bytes = await readFile(pdfPath);
  const p = new PDFParse({ data: Buffer.from(bytes) });
  const t = await p.getText();
  await p.destroy?.();
  const embedded = t.text ?? "";

  const cachePath = path.join(process.cwd(), "scripts", "ocr-cache", `${clientId}-${year}-balanced.txt`);
  const ocr = await readFile(cachePath, "utf8").catch(() => "");

  console.log("PDF:", pdfPath);
  console.log("embedded:", embedded.length, "ocr:", ocr.length);
  console.log("forms:", embedded.match(/Form\s+10\d{2}[A-Z-]*/gi)?.slice(0, 6));

  const r = parseTaxReturnFromText(path.basename(pdfPath), embedded, ocr, year);
  const anchors = extractForm1120Anchors(`${embedded}\n${ocr}`);
  console.log("anchors sales/cogs:", anchors.values.sales, anchors.values.cogs);
  console.log("anchors rent/taxes:", anchors.values.rent, anchors.values.taxes_licenses);
  console.log("year:", r.year, "source:", r.source);
  console.log("sales:", r.values.sales, "cogs:", r.values.cogs);
  console.log("equity:", r.values.other_stock_equity, r.values.unclassified_equity);

  const score = scorePrimary(fixtureKey(client, year), r.values);
  console.log("score:", score.ok, "/", score.n, score.pct.toFixed(1) + "%");
  console.log("misses:", score.misses.slice(0, 12));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
