import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { runLocalOcr } from "../src/lib/tax-return/local-ocr";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { finalizeTaxColumns } from "../src/lib/tax/merge-years";
import { scoreOpexBenchmark, scoreAllFieldsExcludingOpexSlots } from "./lib/tax-benchmark-score";
import { TAX_BENCHMARK_CLIENTS, fixtureKey } from "./lib/tax-benchmark-clients";
import { OPERATING_EXPENSE_SLOT_IDS } from "../src/lib/tax/operating-expenses";

async function main() {
  const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === "kcf")!;
  const cols = [];
  for (const year of client.years) {
    const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
    const bytes = await readFile(pdfPath);
    const embedded = await getEmbeddedPdfText(bytes);
    const t0 = Date.now();
    const ocr = await runLocalOcr(bytes, { profile: "tax", mode: "balanced" });
    const pages = (ocr.text.match(/--- OCR PAGE (\d+)/g) ?? []).map((m) =>
      Number(m.replace(/\D/g, "")),
    );
    console.log(
      year,
      "ocr_s",
      ((Date.now() - t0) / 1000).toFixed(0),
      "pages",
      [...new Set(pages)].join(","),
    );
    for (const l of ocr.logs) {
      if (/phase1|capped|heuristic|retry|keyword|attachment/i.test(l)) console.log(" ", l);
    }
    console.log(
      "  has util/adv tokens:",
      year === 2023
        ? { u7787: ocr.text.includes("7,787") || ocr.text.includes("7787"), a19882: ocr.text.includes("19,882") }
        : year === 2024
          ? { u8749: ocr.text.includes("8,749"), junk118: /\b118\b/.test(ocr.text) }
          : { u7584: ocr.text.includes("7,584") },
    );
    cols.push({
      ...parseTaxReturnFromText(path.basename(pdfPath), embedded, ocr.text, year, {
        ocrMode: "balanced",
      }),
      filename: path.basename(pdfPath),
    });
  }
  const finalized = finalizeTaxColumns(cols);
  for (const col of finalized.sort((a, b) => b.year - a.year)) {
    const fk = fixtureKey(client, col.year);
    const fields = scoreAllFieldsExcludingOpexSlots(fk, col.values);
    const opex = scoreOpexBenchmark(fk, col.values);
    const top8 = OPERATING_EXPENSE_SLOT_IDS.map((id) => col.values[id] ?? 0);
    console.log(
      col.year,
      "fields",
      fields.pct.toFixed(1),
      "opex",
      opex.pct.toFixed(1),
      "other",
      col.values.other_operating_expenses,
    );
    console.log("  top8", top8.join(", "));
    for (const m of [...fields.misses, ...opex.misses]) console.log("  miss", m);
  }
  process.exit(0);
}

void main();
