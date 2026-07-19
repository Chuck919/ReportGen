/**
 * Compare OCR modes on one tax year: wall time + primary-field accuracy.
 *
 *   npx tsx scripts/benchmark-ocr.ts              # 2024, fast + balanced
 *   npx tsx scripts/benchmark-ocr.ts 2024 thorough
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import { TAX_ATTACHMENT_FIELD_IDS } from "../src/lib/workbook-comparison-fixtures";
import { WORKBOOK_COMPARISON_FIXTURES } from "./lib/workbook-comparison-fixtures";
import { runLocalOcr, type OcrMode } from "../src/lib/tax-return/local-ocr";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { TAX_WORKBOOK_ROWS } from "../src/lib/tax-workbook";

const INPUT_IDS = TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "input").map((r) => r.id);

function scorePrimary(year: number, values: Record<string, number | undefined>) {
  const exp = WORKBOOK_COMPARISON_FIXTURES.tax[`KCF MAIN CURRENT EXCEL.xlsx / ${year}`]?.values;
  if (!exp) throw new Error(`No fixture for ${year}`);
  let ok = 0;
  let n = 0;
  const misses: string[] = [];
  for (const id of INPUT_IDS) {
    const expected = exp[id];
    if (expected === undefined) continue;
    if (TAX_ATTACHMENT_FIELD_IDS.has(id)) continue;
    if (expected === 0 && values[id] === undefined) continue;
    n++;
    const actual = values[id];
    const hit =
      actual !== undefined &&
      (expected === 0 ? actual === 0 : Math.abs(actual - expected) / Math.abs(expected) <= 0.01);
    if (!hit) misses.push(`${id}: exp ${expected}, got ${actual ?? "(blank)"}`);
    else ok++;
  }
  return { ok, n, pct: n ? (ok / n) * 100 : 0, misses };
}

async function embeddedText(bytes: Uint8Array) {
  const p = new PDFParse({ data: Buffer.from(bytes) });
  const t = await p.getText();
  await p.destroy?.();
  return t.text ?? "";
}

async function benchYear(year: number, modes: OcrMode[], docsDir: string) {
  const pdfPath = await resolveTaxReturnPdf(docsDir, year);
  const bytes = await readFile(pdfPath);
  const embedded = await embeddedText(bytes);
  const rows: Array<{ mode: OcrMode; ms: number; primary: string; misses: string[] }> = [];

  for (const mode of modes) {
    const t0 = Date.now();
    console.log(`\n[${mode}] OCR starting…`);
    const ocr = await runLocalOcr(bytes, { profile: "tax", mode });
    const ocrMs = Date.now() - t0;
    await mkdir(path.join(process.cwd(), "scripts", "ocr-cache"), { recursive: true });
    await writeFile(path.join(process.cwd(), "scripts", "ocr-cache", `${year}-${mode}.txt`), ocr.text, "utf8");
    const parsed = parseTaxReturnFromText(path.basename(pdfPath), embedded, ocr.text, year);
    const score = scorePrimary(year, parsed.values);
    rows.push({
      mode,
      ms: ocrMs,
      primary: `${score.ok}/${score.n} (${score.pct.toFixed(1)}%)`,
      misses: score.misses.slice(0, 8),
    });
    const timing = (ocr as { timingMs?: Record<string, number> }).timingMs;
    const phase2 = timing?.phase2_tesseract_ms;
    const phase3 = timing?.phase3_tesseract_ms;
    const timingNote =
      phase2 != null
        ? ` | OCR phases: p2=${(phase2 / 1000).toFixed(0)}s${phase3 ? ` p3=${(phase3 / 1000).toFixed(0)}s` : ""}`
        : "";
    console.log(
      `[${mode}] ${(ocrMs / 1000).toFixed(1)}s | primary ${score.ok}/${score.n} (${score.pct.toFixed(1)}%) | pages ${ocr.pages}${timingNote}`,
    );
    if (score.misses.length) console.log(`  misses: ${score.misses.slice(0, 5).join("; ")}`);
  }

  console.log("\n--- summary ---");
  for (const r of rows) {
    console.log(`${r.mode.padEnd(10)} ${(r.ms / 1000).toFixed(1)}s  primary ${r.primary}`);
  }
  return rows;
}

const year = Number(process.argv[2] ?? 2024);
const extra = process.argv[3] as OcrMode | undefined;
const runAll = process.argv.includes("--all");
const docsDir = path.resolve(process.cwd(), process.env.DOCS_DIR ?? "../Documents");
const modes: OcrMode[] = extra
  ? [extra]
  : (process.env.BENCHMARK_OCR_MODES?.split(",") as OcrMode[]) ?? ["fast", "balanced"];

async function runMatrix() {
  const allModes: OcrMode[] = ["fast", "balanced", "thorough"];
  const years = [2023, 2024, 2025];
  const matrix: Array<{ year: number; rows: Awaited<ReturnType<typeof benchYear>> }> = [];

  for (const y of years) {
    const rows = await benchYear(y, allModes, docsDir);
    matrix.push({ year: y, rows });
  }

  await mkdir(path.join(process.cwd(), "scripts"), { recursive: true });
  const outPath = path.join(process.cwd(), "scripts", "benchmark-matrix.json");
  await writeFile(outPath, JSON.stringify({ at: new Date().toISOString(), matrix }, null, 2), "utf8");

  console.log("\n========== MATRIX ==========");
  console.log("year | fast      | balanced  | thorough");
  for (const { year: y, rows } of matrix) {
    const cells = allModes.map((m) => {
      const r = rows.find((x) => x.mode === m)!;
      const pct = r.primary.match(/\(([\d.]+)%\)/)?.[1] ?? "?";
      return `${pct}%/${(r.ms / 1000).toFixed(0)}s`.padEnd(10);
    });
    console.log(`${y} | ${cells.join(" | ")}`);
  }
  console.log(`Wrote ${outPath}`);
}

if (runAll) {
  runMatrix().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  benchYear(year, modes.length === 1 && extra ? [extra] : modes, docsDir).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
