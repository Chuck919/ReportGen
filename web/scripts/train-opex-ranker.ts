/**
 * Train OPEX linear ranker from benchmark fixtures (+ optional user corrections file).
 *
 *   npx tsx scripts/train-opex-ranker.ts [mode]
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseTaxReturn } from "../src/lib/tax-return-parser";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { TAX_BENCHMARK_CLIENTS, fixtureKey } from "./lib/tax-benchmark-clients";
import { moneyTolerance } from "./lib/tax-benchmark-score";
import changwenFixtures from "./changwen-fixtures.json";
import { WORKBOOK_COMPARISON_FIXTURES } from "../src/lib/workbook-comparison-fixtures";
import { opexCandidateFeatures } from "../src/lib/tax/ml/feature-vector";
import { OPEX_FEATURE_NAMES } from "../src/lib/tax/ml/feature-vector";
import type { OpexCandidate } from "../src/lib/tax-return/opex-candidate-ranking";
import type { OcrMode } from "../src/lib/tax-return/local-ocr";
import { forceExit } from "./lib/force-exit";

const mode = (process.argv[2] ?? "thorough") as OcrMode;
const holdout = "sssi";

const ALL_FIXTURES: Record<string, { year: number; values: Record<string, number> }> = {
  ...WORKBOOK_COMPARISON_FIXTURES.tax,
  ...(changwenFixtures as Record<string, { year: number; values: Record<string, number> }>),
};

type Sample = { features: number[]; label: number };

async function loadUserCorrectionSamples(): Promise<Sample[]> {
  const p = path.join(process.cwd(), "data", "tax-corrections.jsonl");
  try {
    const raw = await readFile(p, "utf8");
    const rows = raw
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as {
        fieldId: string;
        correctedValue: number;
        rejectedOptions?: Array<{ value: number; source: string; closureScore?: number; totalScore?: number; valid?: boolean }>;
      });
    const out: Sample[] = [];
    for (const row of rows) {
      if (row.fieldId !== "other_operating_expenses" || !row.rejectedOptions?.length) continue;
      const correct = row.correctedValue;
      for (const rej of row.rejectedOptions) {
        const cand: OpexCandidate = {
          value: rej.value,
          source: rej.source,
          closureScore: rej.closureScore ?? 0.5,
          evidenceScore: 0.65,
          consistencyScore: 0.5,
          totalScore: rej.totalScore ?? 0,
          plausibilityFlags: rej.valid === false ? ["reject"] : [],
          valid: rej.valid !== false,
        };
        const features = opexCandidateFeatures(cand);
        out.push({ features, label: 0 });
      }
      const win: OpexCandidate = {
        value: correct,
        source: "User correction",
        closureScore: 1,
        evidenceScore: 1,
        consistencyScore: 1,
        totalScore: 100,
        plausibilityFlags: [],
        valid: true,
      };
      out.push({ features: opexCandidateFeatures(win), label: 1 });
    }
    return out;
  } catch {
    return [];
  }
}

async function fixtureSamples(): Promise<Sample[]> {
  const out: Sample[] = [];
  for (const client of TAX_BENCHMARK_CLIENTS) {
    if (client.id === holdout) continue;
    for (const year of client.years) {
      const fk = fixtureKey(client, year);
      const expected = ALL_FIXTURES[fk]?.values.other_operating_expenses;
      if (expected === undefined || expected === 0) continue;

      const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
      const bytes = new Uint8Array(await readFile(pdfPath));
      const embedded = await getEmbeddedPdfText(bytes);
      const result = await parseTaxReturn(path.basename(pdfPath), bytes, embedded, year, mode);
      const candidates = result.debug.opexCandidates ?? [];
      if (!candidates.length) continue;

      const tol = moneyTolerance(expected);
      const labelIdx = candidates.findIndex((c) => Math.abs(c.value - expected) <= tol);
      if (labelIdx < 0) continue;

      const sales = result.values.sales;
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]!;
        out.push({
          features: opexCandidateFeatures(c, { sales, stmt2Total: undefined }),
          label: i === labelIdx ? 1 : 0,
        });
      }
      process.stdout.write(`  ${client.id} ${year}: ${candidates.length} candidates\n`);
    }
  }
  return out;
}

function trainLogistic(samples: Sample[], epochs = 400, lr = 0.08): { weights: number[]; bias: number } {
  const dim = OPEX_FEATURE_NAMES.length;
  const weights = new Array(dim).fill(0);
  let bias = 0;

  for (let e = 0; e < epochs; e++) {
    for (const s of samples) {
      let z = bias;
      for (let i = 0; i < dim; i++) z += weights[i]! * (s.features[i] ?? 0);
      const p = 1 / (1 + Math.exp(-z));
      const err = p - s.label;
      bias -= lr * err;
      for (let i = 0; i < dim; i++) {
        weights[i]! -= lr * (err * (s.features[i] ?? 0) + 0.001 * weights[i]!);
      }
    }
  }

  // Scale to comparable magnitude with legacy 0-100 scores
  const scale = 35;
  return {
    weights: weights.map((w) => Math.round(w * scale * 100) / 100),
    bias: Math.round(bias * scale * 100) / 100,
  };
}

async function main() {
  console.log(`=== train OPEX ranker mode=${mode} ===\n`);
  const fixture = await fixtureSamples();
  const user = await loadUserCorrectionSamples();
  const samples = [...fixture, ...user];
  console.log(`\nSamples: ${samples.length} (${fixture.length} fixture, ${user.length} user corrections)`);
  if (samples.length < 8) {
    console.log("Not enough samples — keeping default weights.");
    forceExit(0);
  }

  const { weights, bias } = trainLogistic(samples);
  const payload = {
    version: 2,
    features: [...OPEX_FEATURE_NAMES],
    weights,
    bias,
    trainedAt: new Date().toISOString(),
    sampleCount: samples.length,
    notes: `Logistic regression on ${samples.length} candidate rows.`,
  };

  const outPath = path.join(process.cwd(), "src", "lib", "tax", "ml", "opex-ranker-weights.json");
  await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${outPath}`);
  console.log(JSON.stringify(payload, null, 2));
  forceExit(0);
}

main().catch((e) => {
  console.error(e);
  forceExit(2);
});
