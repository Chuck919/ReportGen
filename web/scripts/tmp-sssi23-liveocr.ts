/** POST sssi 2023 alone to the live API with includeOcrText=1; save OCR and report key amounts. */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { TAX_BENCHMARK_CLIENTS } from "./lib/tax-benchmark-clients";

async function main() {
const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === "sssi")!;
const year = 2023;
const base = process.env.BASE_URL ?? "http://localhost:3000";

const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
const bytes = await readFile(pdfPath);
const form = new FormData();
form.append("files", new Blob([bytes], { type: "application/pdf" }), path.basename(pdfPath));
form.append("ocrMode", "balanced");
form.append("format", "json");
form.append("includeOcrText", "1");

const t0 = Date.now();
const res = await undiciFetch(`${base}/api/parse-tax-return`, {
  method: "POST",
  body: form as unknown as BodyInit,
  dispatcher: new Agent({ headersTimeout: 3_600_000, bodyTimeout: 3_600_000 }),
});
console.log("status", res.status, "elapsed_s", ((Date.now() - t0) / 1000).toFixed(0));
const json = (await res.json()) as {
  parsed?: Array<{ year: number; values: Record<string, number>; sources?: Record<string, string> }>;
  ocrText?: string;
};
const row = json.parsed?.[0];
if (!row) throw new Error("no parse row");
console.log("year", row.year);
for (const id of [
  "officer_compensation",
  "salaries_wages",
  "advertising",
  "rent",
  "taxes_licenses",
  "bank_credit_card",
  "professional_fees",
  "utilities",
  "other_operating_expenses",
  "interest_expense",
]) {
  console.log(id, "=", row.values[id], "|", row.sources?.[id] ?? "");
}
const ocr = json.ocrText ?? "";
console.log("ocr length", ocr.length);
await writeFile("scripts/benchmark-output/sssi-2023-liveocr.txt", ocr);
for (const amt of ["324,036", "27,159", "53,833", "178,480", "625,131", "206,165", "129,064", "78,334"]) {
  const count = ocr.split(amt).length - 1;
  console.log(`live OCR contains ${amt}: ${count}x`);
}
}
main().catch((e) => { console.error(e); process.exit(1); });
