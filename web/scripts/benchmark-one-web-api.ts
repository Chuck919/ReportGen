/** Single PDF API timing test — same path as benchmark harness. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { scoreAllFields } from "./lib/tax-benchmark-score";
import { TAX_BENCHMARK_CLIENTS, fixtureKey } from "./lib/tax-benchmark-clients";
import { forceExit } from "./lib/force-exit";

const clientId = process.argv[2] ?? "sssi";
const year = Number(process.argv[3] ?? 2023);
const base = process.argv[4] ?? "http://localhost:3000";
const timeoutMs = 25 * 60_000;

const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === clientId)!;
const agent = new Agent({ connectTimeout: 60_000, headersTimeout: timeoutMs, bodyTimeout: timeoutMs });

async function main() {
  const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
  const bytes = await readFile(pdfPath);
  const fd = new FormData();
  fd.append("files", new Blob([bytes], { type: "application/pdf" }), path.basename(pdfPath));
  fd.append("ocrMode", "thorough");

  const t0 = Date.now();
  const res = await undiciFetch(`${base}/api/parse-tax-return`, {
    method: "POST",
    body: fd,
    dispatcher: agent,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  const json = (await res.json()) as {
    parsed?: Array<{ values: Record<string, number>; fieldSources?: Record<string, string> }>;
    serverLogs?: string[];
  };
  const row = json.parsed?.[0];
  const score = row ? scoreAllFields(fixtureKey(client, year), row.values) : null;
  console.log(`HTTP ${res.status} in ${elapsed}s`);
  console.log(`all-fields: ${score?.pct.toFixed(1)}% misses: ${score?.misses.join("; ") || "n/a"}`);
  console.log(`opex: ${row?.values.other_operating_expenses ?? "blank"}`);
  const gapLog = json.serverLogs?.find((l) => /Attachment gap rescan/i.test(l));
  if (gapLog) console.log(gapLog);
  forceExit(score?.misses.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  forceExit(1);
});
