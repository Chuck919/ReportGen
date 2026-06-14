/**
 * Lightweight OCR plan: page count + target list for progressive / batched OCR.
 * Env: FREE_OCR_DELTA_FROM, FREE_OCR_ALREADY_PAGES, FREE_OCR_MISSING_FIELDS
 */
const { readFile } = require("node:fs/promises");
const { resolveOcrMode } = require("./ocr-modes.cjs");
const { readPdfPageTotal, planOcrTargets, planDeltaTargets, chunkPages } = require("./ocr-targets.cjs");

const profile = process.env.FREE_OCR_PROFILE || "tax";
const batchSize = Number(process.env.FREE_OCR_BATCH_SIZE || 7);

function parseCsv(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parsePageList(raw) {
  return parseCsv(raw)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) throw new Error("Usage: node scripts/ocr-plan.cjs <pdf-path>");

  const mode = resolveOcrMode(process.env.FREE_OCR_MODE);
  const deltaFrom = process.env.FREE_OCR_DELTA_FROM;
  const alreadyPages = parsePageList(process.env.FREE_OCR_ALREADY_PAGES);
  const missingFields = parseCsv(process.env.FREE_OCR_MISSING_FIELDS);
  const full = process.env.FREE_OCR_PLAN_FULL === "1";

  const buffer = await readFile(pdfPath);
  const totalPages = await readPdfPageTotal(buffer);

  let targets;
  let planMeta = {};

  if (deltaFrom) {
    const delta = planDeltaTargets(totalPages, mode, deltaFrom, profile, alreadyPages, missingFields);
    targets = delta.targets;
    planMeta = {
      kind: "delta",
      deltaFrom,
      alreadyPages,
      missingFields,
      deltaOnly: delta.deltaOnly,
      reOcr: delta.reOcr,
    };
  } else {
    targets = planOcrTargets(totalPages, mode, profile, { full });
    planMeta = { kind: full ? "full" : "tier" };
  }

  const batches = chunkPages(targets, batchSize);

  process.stdout.write(
    JSON.stringify({
      totalPages,
      targets,
      batches,
      batchSize,
      ocrMode: mode.name,
      ...planMeta,
    }),
  );
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
