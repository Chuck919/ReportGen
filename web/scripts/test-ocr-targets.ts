/**
 * OCR tier regression — enforces speed/accuracy targets (workers=1).
 *
 *   npm run test:ocr-targets           # validate scripts/benchmark-matrix.json
 *   npm run test:ocr-targets -- --run  # fresh full matrix then validate (~30–90 min)
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import {
  TAX_ATTACHMENT_FIELD_IDS,
  WORKBOOK_COMPARISON_FIXTURES,
} from "../src/lib/workbook-comparison-fixtures";
import { runLocalOcr, type OcrMode } from "../src/lib/tax-return/local-ocr";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { TAX_WORKBOOK_ROWS } from "../src/lib/tax-workbook";

const INPUT_IDS = TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "input").map((r) => r.id);
const YEARS = [2023, 2024, 2025] as const;
const MODES: OcrMode[] = ["fast", "balanced", "thorough"];

/** Fast preview on 75pg 2024 — must finish quickly (not 100% required). */
const FAST_MAX_MS_2024 = 150_000;
const FAST_MIN_PCT_2024 = 65;

/** Balanced default — 100% primary within 4 min on 2024. */
const BALANCED_MAX_MS_2024 = 240_000;
const BALANCED_MIN_PCT = 100;

/** Thorough — 100% primary every year. */
const THOROUGH_MIN_PCT = 100;
const THOROUGH_MAX_MS_2024 = 480_000;

type Row = { mode: string; ms: number; primary: string; misses: string[] };
type Matrix = { at: string; matrix: Array<{ year: number; rows: Row[] }> };

function parsePct(primary: string): number {
  const m = primary.match(/\(([\d.]+)%\)/);
  return m ? Number(m[1]) : 0;
}

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
    if (!hit) misses.push(`${id}: exp ${expected}, got ${actual ?? "blank"}`);
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

async function runMatrix(): Promise<Matrix> {
  process.env.VERCEL = "";
  process.env.FREE_OCR_WORKERS = "1";
  process.env.FREE_OCR_TIMEOUT_MS = "1200000";
  const docsDir = path.resolve(process.cwd(), "..", "Documents");
  const matrix: Matrix["matrix"] = [];

  for (const year of YEARS) {
    const pdfPath = await resolveTaxReturnPdf(docsDir, year);
    const bytes = await readFile(pdfPath);
    const embedded = await embeddedText(bytes);
    const rows: Row[] = [];

    for (const mode of MODES) {
      console.log(`\n[${mode}] ${year} OCR…`);
      const t0 = Date.now();
      const ocr = await runLocalOcr(bytes, { profile: "tax", mode });
      const ms = Date.now() - t0;
      await mkdir(path.join(process.cwd(), "scripts", "ocr-cache"), { recursive: true });
      await writeFile(
        path.join(process.cwd(), "scripts", "ocr-cache", `${year}-${mode}.txt`),
        ocr.text,
        "utf8",
      );
      const parsed = parseTaxReturnFromText(path.basename(pdfPath), embedded, ocr.text, year);
      const score = scorePrimary(year, parsed.values);
      rows.push({
        mode,
        ms,
        primary: `${score.ok}/${score.n} (${score.pct.toFixed(1)}%)`,
        misses: score.misses,
      });
      console.log(
        `[${mode}] ${(ms / 1000).toFixed(1)}s | primary ${score.ok}/${score.n} (${score.pct.toFixed(1)}%)`,
      );
      if (score.misses.length) console.log(`  misses: ${score.misses.slice(0, 4).join("; ")}`);
    }
    matrix.push({ year, rows });
  }

  const out: Matrix = { at: new Date().toISOString(), matrix };
  const outPath = path.join(process.cwd(), "scripts", "benchmark-matrix.json");
  await writeFile(outPath, JSON.stringify(out, null, 2), "utf8");
  console.log(`\nWrote ${outPath}`);
  return out;
}

function findRow(data: Matrix, year: number, mode: string): Row | undefined {
  return data.matrix.find((y) => y.year === year)?.rows.find((r) => r.mode === mode);
}

function validate(data: Matrix): string[] {
  const errors: string[] = [];

  const fast2024 = findRow(data, 2024, "fast");
  if (fast2024) {
    const pct = parsePct(fast2024.primary);
    if (fast2024.ms > FAST_MAX_MS_2024) {
      errors.push(`fast 2024: ${(fast2024.ms / 1000).toFixed(0)}s > ${FAST_MAX_MS_2024 / 1000}s max`);
    }
    if (pct < FAST_MIN_PCT_2024) {
      errors.push(`fast 2024: ${pct}% < ${FAST_MIN_PCT_2024}% min (preview tier)`);
    }
  }

  for (const year of YEARS) {
    const row = findRow(data, year, "balanced");
    if (!row) continue;
    const pct = parsePct(row.primary);
    const maxMs = year === 2024 ? BALANCED_MAX_MS_2024 : 270_000;
    if (row.ms > maxMs) {
      errors.push(`balanced ${year}: ${(row.ms / 1000).toFixed(0)}s > ${maxMs / 1000}s max`);
    }
    if (pct < BALANCED_MIN_PCT) {
      errors.push(`balanced ${year}: ${pct}% < ${BALANCED_MIN_PCT}% required`);
      if (row.misses.length) errors.push(`  misses: ${row.misses.slice(0, 4).join("; ")}`);
    }
  }

  const bal2024 = findRow(data, 2024, "balanced");

  for (const year of YEARS) {
    const row = findRow(data, year, "thorough");
    if (!row) continue;
    const pct = parsePct(row.primary);
    if (pct < THOROUGH_MIN_PCT) {
      errors.push(`thorough ${year}: ${pct}% < ${THOROUGH_MIN_PCT}% required`);
      if (row.misses.length) errors.push(`  misses: ${row.misses.slice(0, 4).join("; ")}`);
    }
  }

  const thorough2024 = findRow(data, 2024, "thorough");
  if (thorough2024 && thorough2024.ms > THOROUGH_MAX_MS_2024) {
    errors.push(
      `thorough 2024: ${(thorough2024.ms / 1000).toFixed(0)}s > ${THOROUGH_MAX_MS_2024 / 1000}s soft max`,
    );
  }

  // Tier ordering on 2024: thorough >= balanced >= fast
  if (fast2024 && bal2024 && thorough2024) {
    const f = parsePct(fast2024.primary);
    const b = parsePct(bal2024.primary);
    const t = parsePct(thorough2024.primary);
    if (b < f) errors.push(`tier order 2024: balanced ${b}% < fast ${f}%`);
    if (t < b) errors.push(`tier order 2024: thorough ${t}% < balanced ${b}%`);
  }

  return errors;
}

async function main() {
  const runFresh = process.argv.includes("--run");
  let data: Matrix;

  if (runFresh) {
    console.log("=== OCR TARGETS: fresh matrix (workers=1) ===\n");
    data = await runMatrix();
  } else {
    const p = path.join(process.cwd(), "scripts", "benchmark-matrix.json");
    data = JSON.parse(await readFile(p, "utf8")) as Matrix;
    console.log(`=== OCR TARGETS: validate ${p} (${data.at}) ===\n`);
  }

  console.log("year | fast           | balanced       | thorough");
  for (const { year, rows } of data.matrix) {
    const cells = MODES.map((m) => {
      const r = rows.find((x) => x.mode === m)!;
      const pct = parsePct(r.primary);
      return `${pct}%/${(r.ms / 1000).toFixed(0)}s`.padEnd(14);
    });
    console.log(`${year} | ${cells.join(" | ")}`);
  }

  const errors = validate(data);
  if (errors.length) {
    console.log("\n=== FAIL ===");
    for (const e of errors) console.log(`  ${e}`);
    process.exit(1);
  }
  console.log("\n=== PASS: all OCR tier targets met ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
