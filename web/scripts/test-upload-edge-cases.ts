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
import { VERCEL_MULTIPASS } from "../src/lib/tax/vercel-multipass-config";
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

const multi = validateClientFileList(
  [
    { name: "a.pdf", size: 1000, type: "application/pdf" } as File,
    { name: "b.pdf", size: 1000, type: "application/pdf" } as File,
  ],
  { isVercel: true },
);
assert(multi.batchWarnings.length > 0, "vercel multi-file warns");

assert(maxFilesPerApiRequest(true) === 1, "vercel max 1 per request");
assert(maxFilesPerApiRequest(false) === 10, "local allows 10");

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

console.log("\n=== vercel mode resolve (local env) ===");
const prev = process.env.VERCEL;
process.env.VERCEL = "1";
assert(resolveOcrModeForDeploy("thorough") === "vercel-thorough", "thorough -> vercel-thorough");
assert(resolveOcrModeForDeploy("fast") === "vercel-balanced", "fast -> vercel-balanced");
process.env.VERCEL = prev;

console.log("\n=== vercel OCR preset diff ===");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveOcrMode } = require("./ocr-modes.cjs") as typeof import("./ocr-modes.cjs");
process.env.VERCEL = "1";
const vFast = resolveOcrMode("vercel-fast");
const vBalanced = resolveOcrMode("vercel-balanced");
const vThorough = resolveOcrMode("vercel-thorough");
process.env.VERCEL = prev;
const localFast = resolveOcrMode("fast");
const localBalanced = resolveOcrMode("balanced");
const localThorough = resolveOcrMode("thorough");
assert(vFast.maxPhase2Pages === localFast.maxPhase2Pages, "vercel-fast mirrors local fast pages");
assert(vBalanced.maxHiDpiPages === localBalanced.maxHiDpiPages, "vercel-balanced mirrors local balanced hi-DPI");
assert(vFast.maxPhase2Pages === 14, "fast caps at 14 pages");
assert(vFast.maxHiDpiPages === 0, "fast skips hi-DPI");
assert(vBalanced.maxPhase2Pages === 26, "balanced scans 26 pages");
assert(vBalanced.maxHiDpiPages > 0, "balanced has selective hi-DPI");
assert(vThorough.maxPhase2Pages === 26, "thorough scans 26 pages");
assert(vThorough.maxPhase2Pages === vBalanced.maxPhase2Pages, "thorough scans same pages as balanced");
assert(vThorough.maxHiDpiPages === vBalanced.maxHiDpiPages, "thorough preset matches balanced (local runs 2×)");
assert(
  localFast.workers === 1 && localBalanced.workers === 1 && localThorough.workers === 1,
  "local workers=1",
);

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
