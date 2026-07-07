import { readFile } from "node:fs/promises";
import path from "node:path";
import { fetch as undiciFetch, Agent } from "undici";
import { TAX_BENCHMARK_CLIENTS } from "./lib/tax-benchmark-clients";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";

async function main() {
  const clientId = process.argv[2] ?? "sssi";
  const year = Number(process.argv[3] ?? 2023);
  const mode = process.argv[4] ?? "balanced";
  const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === clientId)!;
  const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
  const bytes = await readFile(pdfPath);
  const form = new FormData();
  form.append("files", new Blob([bytes], { type: "application/pdf" }), path.basename(pdfPath));
  form.append("ocrMode", mode);
  form.append("format", "json");
  const t0 = Date.now();
  const res = await undiciFetch("http://localhost:3000/api/parse-tax-return", {
    method: "POST",
    body: form as unknown as BodyInit,
    dispatcher: new Agent({ headersTimeout: 1_500_000, bodyTimeout: 1_500_000 }),
  });
  const ms = Date.now() - t0;
  if (!res.ok) {
    console.log("HTTP", res.status, await res.text());
    process.exit(1);
  }
  const json = (await res.json()) as { parsed?: Array<Record<string, unknown>> };
  const row = json.parsed?.[0] as unknown as {
    values: Record<string, number>;
    fieldSources?: Record<string, string>;
  };
  console.log(`took ${ms}ms`);
  console.log("other_operating_expenses:", row.values.other_operating_expenses, row.fieldSources?.other_operating_expenses);
  for (const slot of [
    "officer_compensation",
    "salaries_wages",
    "advertising",
    "rent",
    "taxes_licenses",
    "bank_credit_card",
    "professional_fees",
    "utilities",
  ]) {
    console.log(slot, row.values[slot]);
  }
  process.exit(0);
}
main();
