/**
 * Regression tests for upload validation, merge policy, and parse quality (no OCR).
 * Run: npm run test:upload
 */
import { mergeTaxYearRecords } from "../src/lib/tax/merge-years";
import {
  assessParseQuality,
  detectDuplicateYears,
  summarizeReupload,
} from "../src/lib/tax/parse-quality";
import { isProcessTimeoutError } from "../src/lib/tax/ocr-errors";
import { resolveOcrModeForDeploy } from "../src/lib/tax/resolve-ocr-mode";
import {
  isLikelyScannedPdf,
  isLikelyTaxReturnText,
  validateClientFileList,
  validatePdfFileSize,
} from "../src/lib/tax/validate-upload";
import { maxFilesPerApiRequest } from "../src/lib/tax/upload-policy";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ok: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

console.log("=== validate upload ===");
assert(validatePdfFileSize(1024).length === 0, "accepts 1KB file");
assert(validatePdfFileSize(0).length > 0, "rejects empty file");
assert(isLikelyScannedPdf(100), "100 chars = scanned");
assert(!isLikelyScannedPdf(500), "500 chars = not scanned threshold");
assert(isLikelyTaxReturnText("Form 1120-S Schedule L"), "detects tax return");
assert(!isLikelyTaxReturnText("Hello world"), "rejects non-tax text");

const multi = validateClientFileList([
  { name: "a.pdf", size: 1000, type: "application/pdf" } as File,
  { name: "b.pdf", size: 1000, type: "application/pdf" } as File,
]);
assert(multi.ok, "multi-file upload accepted");
assert(multi.batchWarnings.length === 0, "two files do not warn");

assert(maxFilesPerApiRequest() === 10, "allows 10 files per request");

console.log("\n=== merge / re-upload ===");
const merged = mergeTaxYearRecords(
  { year: 2024, values: { sales: 100 }, confidence: { sales: 80 }, warnings: [] },
  { year: 2024, values: { sales: 200 }, confidence: { sales: 95 }, warnings: [] },
);
assert(merged.values.sales === 200, "re-upload higher confidence wins");

const dup = detectDuplicateYears([
  { year: 2024, filename: "a.pdf", values: {}, warnings: [] },
  { year: 2024, filename: "b.pdf", values: {}, warnings: [] },
]);
assert(dup.length === 1, "duplicate year warning");

const reup = summarizeReupload([2023], [{ year: 2023, filename: "x.pdf", values: {}, warnings: [] }]);
assert(reup.length === 1, "reupload note");

console.log("\n=== parse quality ===");
const q = assessParseQuality({ sales: 1, cogs: 2, cash: 3 });
assert(q.primaryFilled >= 3, "counts filled fields");
assert(q.incomplete, "few fields = incomplete");

console.log("\n=== ocr errors ===");
assert(isProcessTimeoutError({ killed: true, message: "x" }), "killed = timeout");
assert(isProcessTimeoutError(new Error("timed out")), "message timeout");

console.log("\n=== ocr mode resolve ===");
assert(resolveOcrModeForDeploy("thorough") === "thorough", "thorough stays thorough");
assert(resolveOcrModeForDeploy("fast") === "fast", "fast stays fast");
assert(resolveOcrModeForDeploy("balanced") === "balanced", "balanced stays balanced");
assert(resolveOcrModeForDeploy("nope") === "balanced", "unknown -> balanced");
assert(resolveOcrModeForDeploy("") === "balanced", "empty -> balanced");

console.log("\n=== OCR presets ===");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveOcrMode } = require("./ocr-modes.cjs") as typeof import("./ocr-modes.cjs");
const prevWorkers = process.env.FREE_OCR_WORKERS;
delete process.env.FREE_OCR_WORKERS;
const localFast = resolveOcrMode("fast");
const localBalanced = resolveOcrMode("balanced");
const localThorough = resolveOcrMode("thorough");
if (prevWorkers !== undefined) process.env.FREE_OCR_WORKERS = prevWorkers;
assert(localFast.maxHiDpiPages === 0, "fast skips hi-DPI");
assert(localBalanced.skipPhase1QuickScan === false, "balanced keeps phase1 keyword scan for accuracy");
assert(!localBalanced.useFastHeuristicPages, "balanced must not use fast page subset");
assert(localBalanced.maxPhase2Pages === 36, "balanced scans up to 36 pages");
assert(localBalanced.maxHiDpiPages > 0, "balanced has selective hi-DPI");
assert(localThorough.maxPhase2Pages >= localBalanced.maxPhase2Pages, "thorough scans at least as many pages as balanced");
assert(localFast.workers === 1, "fast workers=1");
assert(localBalanced.workers === 2, "balanced workers=2");
assert(localThorough.workers === 2, "thorough workers=2");

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
