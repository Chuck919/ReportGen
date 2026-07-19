/**
 * Depreciation / amortization reconciliation tests.
 * Run: npx tsx scripts/test-income-dep-amort.ts
 */
import { reconcileDepreciationAmortization } from "../src/lib/tax-return/income-depreciation-amort";
import type { ResolvedFields } from "../src/lib/tax-return/merge";

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

function baseResolved(): ResolvedFields {
  return { values: {}, confidence: {}, sources: {}, warnings: [] };
}

console.log("=== income dep/amort ===");

{
  const resolved = baseResolved();
  resolved.values.depreciation = 175_050;
  resolved.values.accumulated_depreciation = 175_050;
  resolved.sources.depreciation = "OCR label match";
  reconcileDepreciationAmortization(resolved, {
    formAnchors: { values: { depreciation: 0 }, confidence: { depreciation: 97 }, sources: { depreciation: "Form 1120-S line 14" } },
    formPage1: "14 Depreciation",
    allText: "",
    targetYear: 2024,
    comparison: { values: { depreciation: 0 }, confidence: { depreciation: 86 }, linesMatched: 8 },
  });
  assert(resolved.values.depreciation === 0, "clears accumulated dep confusion → form zero");
}

{
  const resolved = baseResolved();
  resolved.values.amortization = 283_400;
  resolved.values.accumulated_amortization = 283_400;
  resolved.sources.amortization = "OCR label match";
  reconcileDepreciationAmortization(resolved, {
    formAnchors: { values: {}, confidence: {}, sources: {} },
    formPage1: "",
    allText: `Two Year Comparison 2022 & 2023\nAMORTIZATION 14,174 0`,
    targetYear: 2023,
    comparison: { values: { amortization: 14_174 }, confidence: { amortization: 86 }, linesMatched: 8 },
  });
  assert(resolved.values.amortization === 14_174, "comparison amortization beats accumulated trap");
}

{
  const resolved = baseResolved();
  reconcileDepreciationAmortization(resolved, {
    formAnchors: { values: { depreciation: 12_860 }, confidence: { depreciation: 99 }, sources: { depreciation: "Form 1120-S line 14 (page 1 block)" } },
    formPage1: "14 Depreciation 12,860",
    allText: "",
    targetYear: 2025,
    comparison: { values: { depreciation: 12_860 }, confidence: { depreciation: 86 }, linesMatched: 8 },
  });
  assert(resolved.values.depreciation === 12_860, "form line 14 depreciation for 2025");
}

{
  const resolved = baseResolved();
  reconcileDepreciationAmortization(resolved, {
    formAnchors: { values: { depreciation: 50_000 }, confidence: { depreciation: 99 }, sources: { depreciation: "Form 1120-S line 14" } },
    formPage1: "",
    allText: "",
    targetYear: 2024,
    comparison: { values: { depreciation: 250_000 }, confidence: { depreciation: 86 }, linesMatched: 8 },
  });
  assert(resolved.values.depreciation === 50_000, "high-confidence Form line beats comparison disagreement");
  assert(/form 1120-s line 14/i.test(resolved.sources.depreciation ?? ""), "source remains Form line");
}

console.log(`\n=== income dep/amort: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
