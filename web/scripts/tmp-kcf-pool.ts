import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { finalizeTaxColumns } from "../src/lib/tax/merge-years";
import {
  expenseCategoryKey,
  OPERATING_EXPENSE_SLOT_IDS,
  selectSharedTop8ByCrossYearSum,
} from "../src/lib/tax/operating-expenses";
import { TAX_BENCHMARK_CLIENTS } from "./lib/tax-benchmark-clients";

async function main() {
  process.env.DEBUG_OPEX_FOLD = "1";
  const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === "kcf")!;
  const cols = [];
  for (const year of client.years) {
    const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
    const bytes = await readFile(pdfPath);
    const embedded = await getEmbeddedPdfText(bytes);
    const ocrPath =
      year === 2023
        ? "scripts/benchmark-output/tmp-kcf23-ocr.txt"
        : path.join("scripts/ocr-cache", `kcf-${year}-balanced.txt`);
    const ocr = await readFile(ocrPath, "utf8");
    const parsed = parseTaxReturnFromText(path.basename(pdfPath), embedded, ocr, year, {
      ocrMode: "balanced",
    });
    cols.push({ ...parsed, filename: path.basename(pdfPath) });
    console.log("=== pre-merge", year, "lines", parsed.operatingExpenseLines?.length ?? 0);
    for (const line of parsed.operatingExpenseLines ?? []) {
      if (Math.round(Math.abs(line.amount)) >= 100_000 || Math.round(line.amount) === 596314) {
        console.log(
          " ",
          line.amount,
          "cat=" + (expenseCategoryKey(line.label) ?? "-"),
          JSON.stringify(line.label).slice(0, 90),
          line.source,
        );
      }
    }
  }
  const finalized = finalizeTaxColumns(cols);
  for (const col of finalized) {
    console.log(
      "post",
      col.year,
      OPERATING_EXPENSE_SLOT_IDS.map((id) => col.values[id] ?? 0).join(","),
      "other",
      col.values.other_operating_expenses,
    );
  }
  process.exit(0);
}

void main();
