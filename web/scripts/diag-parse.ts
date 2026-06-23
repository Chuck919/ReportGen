import { readFile } from "node:fs/promises";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { TAX_BENCHMARK_CLIENTS, fixtureKey, resolveClientDocsDir } from "./lib/tax-benchmark-clients";
import { scorePrimary } from "./lib/tax-benchmark-score";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { extractEmbeddedScheduleL } from "../src/lib/tax-return/embedded-schedule-l";

async function main() {
const [clientId, yearStr] = process.argv.slice(2);
const year = Number(yearStr);
const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === clientId)!;
const docsDir = resolveClientDocsDir(client);
const pdfPath = await resolveTaxReturnPdf(docsDir, year);
const bytes = await readFile(pdfPath);
const embedded = await getEmbeddedPdfText(bytes);
const cache = client.id === "kcf" ? `${year}-balanced.txt` : `${client.id}-${year}-balanced.txt`;
const ocr = await readFile(`scripts/ocr-cache/${cache}`, "utf8").catch(() => "");
const parsed = parseTaxReturnFromText("x.pdf", embedded, ocr, year);
const score = scorePrimary(fixtureKey(client, year), parsed.values);
const sl = extractEmbeddedScheduleL(embedded);
console.log("score", score.pct.toFixed(1), score.ok, score.n);
console.log("misses", score.misses.join("; "));
console.log("embedded len", embedded.length, "SL fields", Object.keys(sl.values).length, sl.values);
for (const m of score.misses) {
  const id = m.split(":")[0]!;
  console.log(`  ${id} =>`, parsed.values[id as keyof typeof parsed.values], parsed.fieldSources?.[id]);
}
}

main().catch((e) => { console.error(e); process.exit(1); });
