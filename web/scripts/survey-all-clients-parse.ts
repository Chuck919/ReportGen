/**
 * Cross-client parse survey — score existing OCR caches with current parser.
 * No new OCR; use to compare companies before tuning (avoid KCF-only fixes).
 *
 *   npx tsx scripts/survey-all-clients-parse.ts
 *   npx tsx scripts/survey-all-clients-parse.ts --json
 */
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import {
  TAX_BENCHMARK_CLIENTS,
  fixtureKey,
  resolveClientDocsDir,
  type TaxBenchmarkClient,
} from "./lib/tax-benchmark-clients";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { scorePrimary } from "./lib/tax-benchmark-score";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import type { OcrMode } from "../src/lib/tax-return/local-ocr";

const MODES: OcrMode[] = ["fast", "balanced", "thorough"];
const CACHE_DIR = path.join(process.cwd(), "scripts", "ocr-cache");

type Row = {
  clientId: string;
  year: number;
  mode: OcrMode;
  pct: number;
  ok: number;
  n: number;
  cache: string;
  misses: string[];
};

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function cacheCandidates(client: TaxBenchmarkClient, year: number, mode: OcrMode): string[] {
  const names = [`${client.id}-${year}-${mode}.txt`, `${client.id}-${year}-${mode}-run1.txt`];
  if (client.id === "kcf") names.unshift(`${year}-${mode}.txt`);
  return names.map((n) => path.join(CACHE_DIR, n));
}

async function embeddedText(bytes: Uint8Array): Promise<string> {
  return getEmbeddedPdfText(bytes);
}

async function surveyClientMode(
  client: TaxBenchmarkClient,
  year: number,
  mode: OcrMode,
): Promise<Row | null> {
  let cachePath: string | undefined;
  for (const c of cacheCandidates(client, year, mode)) {
    if (await fileExists(c)) {
      cachePath = c;
      break;
    }
  }
  if (!cachePath) return null;

  const docsDir = resolveClientDocsDir(client);
  const pdfPath = await resolveTaxReturnPdf(docsDir, year);
  const bytes = await readFile(pdfPath);
  const embedded = await embeddedText(bytes);
  const ocr = await readFile(cachePath, "utf8");
  const parsed = parseTaxReturnFromText(path.basename(pdfPath), embedded, ocr, year, { ocrMode: mode });
  const score = scorePrimary(fixtureKey(client, year), parsed.values);
  return {
    clientId: client.id,
    year,
    mode,
    pct: score.pct,
    ok: score.ok,
    n: score.n,
    cache: path.basename(cachePath),
    misses: score.misses,
  };
}

function fieldIdFromMiss(miss: string): string {
  return miss.split(":")[0] ?? miss;
}

async function main() {
  const asJson = process.argv.includes("--json");
  const rows: Row[] = [];

  for (const client of TAX_BENCHMARK_CLIENTS) {
    for (const year of client.years) {
      for (const mode of MODES) {
        const row = await surveyClientMode(client, year, mode);
        if (row) rows.push(row);
      }
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
    return;
  }

  console.log("=== CROSS-CLIENT PARSE SURVEY (cached OCR, current parser) ===\n");
  console.log("client:year | fast | balanced | thorough");
  const byKey = new Map<string, Record<OcrMode, Row | undefined>>();
  for (const r of rows) {
    const k = `${r.clientId}:${r.year}`;
    const slot = byKey.get(k) ?? { fast: undefined, balanced: undefined, thorough: undefined };
    slot[r.mode] = r;
    byKey.set(k, slot);
  }
  for (const k of [...byKey.keys()].sort()) {
    const slot = byKey.get(k)!;
    const cells = MODES.map((m) => {
      const r = slot[m];
      return r ? `${r.pct.toFixed(0)}% (${r.ok}/${r.n})`.padEnd(16) : "—".padEnd(16);
    });
    console.log(`${k.padEnd(14)} | ${cells.join(" | ")}`);
  }

  const missByField = new Map<string, Map<string, number>>();
  for (const r of rows) {
    for (const m of r.misses) {
      const id = fieldIdFromMiss(m);
      const perClient = missByField.get(id) ?? new Map();
      perClient.set(r.clientId, (perClient.get(r.clientId) ?? 0) + 1);
      missByField.set(id, perClient);
    }
  }

  console.log("\n=== MISS FREQUENCY BY FIELD (across cached runs) ===");
  const ranked = [...missByField.entries()].sort((a, b) => {
    const sum = (m: Map<string, number>) => [...m.values()].reduce((s, n) => s + n, 0);
    return sum(b[1]) - sum(a[1]);
  });
  for (const [field, clients] of ranked.slice(0, 20)) {
    const total = [...clients.values()].reduce((s, n) => s + n, 0);
    const spread = [...clients.entries()].map(([c, n]) => `${c}:${n}`).join(", ");
    const universal = clients.size >= 3 ? " [multi-client]" : " [client-specific]";
    console.log(`  ${field}: ${total}x (${spread})${universal}`);
  }

  const missing = TAX_BENCHMARK_CLIENTS.flatMap((c) =>
    c.years.flatMap((y) => MODES.filter((m) => !rows.some((r) => r.clientId === c.id && r.year === y && r.mode === m)).map((m) => `${c.id}:${y}:${m}`)),
  );
  if (missing.length) {
    console.log(`\nNo cache yet: ${missing.slice(0, 12).join(", ")}${missing.length > 12 ? ` … +${missing.length - 12} more` : ""}`);
  }

  console.log("\n=== TIER ORDER (thorough >= balanced >= fast) ===");
  let tierViolations = 0;
  for (const k of [...byKey.keys()].sort()) {
    const slot = byKey.get(k)!;
    const f = slot.fast?.pct ?? -1;
    const b = slot.balanced?.pct ?? -1;
    const t = slot.thorough?.pct ?? -1;
    if (f < 0 || b < 0 || t < 0) continue;
    const ok = t >= b && b >= f;
    if (!ok) {
      tierViolations++;
      console.log(`  VIOLATION ${k}: fast ${f.toFixed(0)}% | balanced ${b.toFixed(0)}% | thorough ${t.toFixed(0)}%`);
    }
  }
  if (!tierViolations) console.log("  All cached client/years respect tier ordering.");
  else console.log(`  ${tierViolations} tier violation(s) — fix thorough merge or parser before tuning presets.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
