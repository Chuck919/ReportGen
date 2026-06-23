/**
 * Experimental OCR attachment recovery — OFF by default.
 * Enable with ENABLE_OCR_RECOVERY=1 (server) for controlled A/B benchmarks only.
 * Do not merge into default path until it improves KCF without regressing Carithers/Arizona.
 */
import type { OcrMode } from "@/lib/api/types";
import { mergeOcrPageTexts, chunkArray, OCR_BATCH_SIZE } from "@/lib/api/batched-ocr";
import { getMissingAttachmentFieldIds } from "@/lib/tax/gap-analysis";
import { parseTaxReturnFromText } from "@/lib/tax-return/parse-from-text";
import { probeOcrCoverageGaps } from "@/lib/tax-return/ocr-coverage-rescan";
import { buildOcrCoverageDiagnostics } from "@/lib/tax-return/ocr-coverage-diagnostics";
import { detectTaxForm } from "@/lib/tax-return/detect-tax-form";
import { runLocalOcrPages, runOcrPlan } from "@/lib/tax-return/local-ocr";

const MAX_ATTACHMENT_RESCAN_PAGES = 14;

const ATTACHMENT_RESCAN_FIELDS = [
  "other_operating_expenses",
  "professional_fees",
  "utilities",
  "bank_credit_card",
] as const;

async function ocrPageBatch(
  bytes: Uint8Array,
  mode: OcrMode,
  pages: number[],
  forcePhase3: boolean,
): Promise<{ text: string; pageNumbers: number[]; ms: number }> {
  if (!pages.length) return { text: "", pageNumbers: [], ms: 0 };
  const batches = chunkArray(pages, OCR_BATCH_SIZE);
  const texts: string[] = [];
  const pageNumbers: number[] = [];
  let ms = 0;

  for (const batch of batches) {
    const t0 = Date.now();
    const result = await runLocalOcrPages(bytes, batch, {
      profile: "tax",
      mode,
      forcePhase3,
    });
    ms += Date.now() - t0;
    texts.push(result.text);
    pageNumbers.push(...(result.pageNumbers ?? batch));
  }

  return {
    text: mergeOcrPageTexts(texts),
    pageNumbers: Array.from(new Set(pageNumbers)).sort((a, b) => a - b),
    ms,
  };
}

function needsStmt2AttachmentRescan(embeddedText: string, ocrText: string): boolean {
  const probe = `${embeddedText}\n${ocrText}`;
  if (/see\s+stmt\s*2|stmt\s*2.*other\s+deduct|other\s+deduct.*attach\s+statement/i.test(probe)) {
    return true;
  }
  return /\bother\s+deduct[^|\n]{0,80}\|\s*\d{1,3}(?:,\d{3}){2,}/i.test(probe);
}

function prioritizeAttachmentRescanTargets(
  plan: { totalPages: number; targets: number[]; deltaOnly?: number[]; reOcr?: number[] },
  alreadyPages: number[],
): number[] {
  const already = new Set(alreadyPages);
  const deltaOnly = plan.deltaOnly?.length
    ? plan.deltaOnly
    : plan.targets.filter((page) => !already.has(page));
  const reOcr = plan.reOcr?.length
    ? plan.reOcr
    : plan.targets.filter((page) => already.has(page));
  const tailStart = Math.max(1, plan.totalPages - 14);
  const midEnd = Math.max(28, Math.floor(plan.totalPages * 0.6));
  const picked = new Set<number>();
  const add = (pages: number[]) => {
    for (const page of pages) {
      if (plan.targets.includes(page)) picked.add(page);
      if (picked.size >= MAX_ATTACHMENT_RESCAN_PAGES) break;
    }
  };

  add(deltaOnly.filter((page) => page >= tailStart));
  add(deltaOnly.filter((page) => page >= 12 && page <= midEnd));
  add(reOcr.filter((page) => page >= tailStart));
  add(reOcr.filter((page) => page >= 12 && page <= midEnd));
  add(deltaOnly);
  add(plan.targets);
  return [...picked].sort((a, b) => a - b).slice(0, MAX_ATTACHMENT_RESCAN_PAGES);
}

export function isOcrRecoveryEnabled(): boolean {
  const v = process.env.ENABLE_OCR_RECOVERY?.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Experimental — mutates OCR text corpus; use only in A/B benchmarks. */
export async function rescanMissingAttachmentsExperimental(
  bytes: Uint8Array,
  embeddedText: string,
  ocrText: string,
  filename: string,
  year?: number,
  baselineMode: OcrMode = "balanced",
): Promise<{ ocrText: string; pages: number[]; ms: number; ran: boolean; reasons?: string[] }> {
  const parsed = parseTaxReturnFromText(filename, embeddedText, ocrText, year, { ocrMode: "thorough" });
  const missingAttach = getMissingAttachmentFieldIds(parsed);
  const allText = `${embeddedText}\n${ocrText}`;
  const formKind = detectTaxForm(allText).kind;
  const coverage = buildOcrCoverageDiagnostics(
    allText,
    formKind,
    {
      values: parsed.values,
      confidence: parsed.confidence ?? {},
      sources: parsed.fieldSources ?? {},
      warnings: [],
    },
    { targetYear: year, opex: parsed.values.other_operating_expenses },
  );
  const gap = probeOcrCoverageGaps(embeddedText, ocrText, year, coverage);
  const opexClosureBad =
    coverage.opexClosureRatio !== undefined && coverage.opexClosureRatio < 0.45;
  const needsGapRescan =
    gap.needsRescan &&
    (missingAttach.includes("other_operating_expenses") ||
      parsed.values.other_operating_expenses === undefined ||
      opexClosureBad);
  const needsRescan =
    missingAttach.includes("other_operating_expenses") ||
    needsGapRescan ||
    needsStmt2AttachmentRescan(embeddedText, ocrText);
  if (!needsRescan) {
    return { ocrText, pages: [], ms: 0, ran: false };
  }

  const missingFields = [
    ...new Set([
      ...ATTACHMENT_RESCAN_FIELDS.filter((id) => missingAttach.includes(id)),
      ...gap.hintFields,
      ...(gap.needsRescan ? (["other_operating_expenses"] as const) : []),
    ]),
  ];
  const alreadyPages = [
    ...new Set(
      (ocrText.match(/--- OCR PAGE (\d+)/g) ?? []).map((m) => Number(m.replace(/\D/g, ""))),
    ),
  ];

  const plan = await runOcrPlan(bytes, "thorough", {
    deltaFrom: baselineMode,
    alreadyPages,
    missingFields: missingFields.length ? [...missingFields] : ["other_operating_expenses"],
  });
  const targets = prioritizeAttachmentRescanTargets(plan, alreadyPages);
  if (!targets.length) {
    return { ocrText, pages: [], ms: 0, ran: false };
  }

  const t0 = Date.now();
  const delta = await ocrPageBatch(bytes, "thorough", targets, true);
  const merged = mergeOcrPageTexts([ocrText, delta.text]);
  return {
    ocrText: merged,
    pages: targets,
    ms: Date.now() - t0,
    ran: true,
    reasons: gap.reasons,
  };
}
