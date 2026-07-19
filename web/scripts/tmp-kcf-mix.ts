import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { finalizeTaxColumns } from "../src/lib/tax/merge-years";
import { scoreOpexBenchmark, scoreAllFieldsExcludingOpexSlots } from "./lib/tax-benchmark-score";
import { TAX_BENCHMARK_CLIENTS, fixtureKey } from "./lib/tax-benchmark-clients";
import { OPERATING_EXPENSE_SLOT_IDS } from "../src/lib/tax/operating-expenses";
import { isNonExpenseAnchorLabel } from "../src/lib/tax/opex-pool-quality";

async function main() {
  console.log(
    "anchor?",
    isNonExpenseAnchorLabel("Total business deductions"),
    isNonExpenseAnchorLabel("Total deductions"),
  );
  const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === "kcf")!;
  const live23 = "scripts/benchmark-output/tmp-kcf23-ocr.txt";
  let hasLive23 = false;
  try {
    await access(live23);
    hasLive23 = true;
  } catch {
    hasLive23 = false;
  }
  const cols = [];
  for (const year of client.years) {
    const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
    const bytes = await readFile(pdfPath);
    const embedded = await getEmbeddedPdfText(bytes);
    const ocrPath =
      year === 2023 && hasLive23 ? live23 : path.join("scripts/ocr-cache", `kcf-${year}-balanced.txt`);
    const ocr = await readFile(ocrPath, "utf8");
    console.log(year, "ocr", path.basename(ocrPath));
    cols.push({
      ...parseTaxReturnFromText(path.basename(pdfPath), embedded, ocr, year, { ocrMode: "balanced" }),
      filename: path.basename(pdfPath),
    });
  }
  const finalized = finalizeTaxColumns(cols);
  for (const col of finalized.sort((a, b) => b.year - a.year)) {
    const fk = fixtureKey(client, col.year);
    const fields = scoreAllFieldsExcludingOpexSlots(fk, col.values);
    const opex = scoreOpexBenchmark(fk, col.values);
    console.log(
      col.year,
      "fields",
      fields.pct.toFixed(1),
      "opex",
      opex.pct.toFixed(1),
      "other",
      col.values.other_operating_expenses,
      "top8",
      OPERATING_EXPENSE_SLOT_IDS.map((id) => col.values[id] ?? 0).join(","),
    );
    for (const m of [...fields.misses, ...opex.misses]) console.log("  miss", m);
  }
  process.exit(0);
}

void main();
