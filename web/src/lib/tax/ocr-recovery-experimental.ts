/**
 * Experimental OCR attachment recovery — OFF by default.
 * Enable with ENABLE_OCR_RECOVERY=1 (server) for controlled A/B benchmarks only.
 * Experimental OCR recovery — not in the default path until it improves holdout benches without regressions.
 */
import type { OcrMode } from "@/lib/api/types";
import { mergeOcrPageTexts, chunkArray, OCR_BATCH_SIZE } from "@/lib/api/batched-ocr";
import { getMissingAttachmentFieldIds } from "@/lib/tax/gap-analysis";
import { parseTaxReturnFromText } from "@/lib/tax-return/parse-from-text";
import { probeOcrCoverageGaps } from "@/lib/tax-return/ocr-coverage-rescan";
import type { CoverageGapProbe } from "@/lib/tax-return/ocr-coverage-rescan";
import { buildOcrCoverageDiagnostics } from "@/lib/tax-return/ocr-coverage-diagnostics";
import { detectTaxForm } from "@/lib/tax-return/detect-tax-form";
import { runLocalOcrPages, runOcrPlan } from "@/lib/tax-return/local-ocr";

const MAX_ATTACHMENT_RESCAN_PAGES = 14;
const MAX_BALANCED_RECOVERY_PAGES = 5;

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

function needsStmt2AttachmentRescan(
  embeddedText: string,
  ocrText: string,
  gap: CoverageGapProbe,
): boolean {
  // Form page-1 almost always says "Other deductions … SEE STMT 2" even when the attachment
  // was already OCR'd — matching that boilerplate alone re-OCRs 14 thorough pages on every
  // large return (100+ pages can take a long OCR). Only rescan when coverage probe found a
  // real attachment gap, not a form cross-reference.
  if (
    !gap.reasons.some((r) =>
      /stmt2-detail-missing|stmt2-total-unparseable|attachment-page-missing/i.test(r),
    )
  ) {
    return false;
  }
  const probe = `${embeddedText}\n${ocrText}`;
  return /see\s+stmt\s*2|stmt\s*2.*other\s+deduct|other\s+deduct.*attach\s+statement/i.test(probe);
}

function prioritizeAttachmentRescanTargets(
  plan: { totalPages: number; targets: number[]; deltaOnly?: number[]; reOcr?: number[] },
  alreadyPages: number[],
  maxPages: number,
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
      if (picked.size >= maxPages) break;
    }
  };

  add(deltaOnly.filter((page) => page >= tailStart));
  add(deltaOnly.filter((page) => page >= 12 && page <= midEnd));
  add(reOcr.filter((page) => page >= tailStart));
  add(reOcr.filter((page) => page >= 12 && page <= midEnd));
  add(deltaOnly);
  add(plan.targets);
  return [...picked].sort((a, b) => a - b).slice(0, maxPages);
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
  const probeOcrMode = "balanced";
  const parsed = parseTaxReturnFromText(filename, embeddedText, ocrText, year, {
    ocrMode: probeOcrMode,
  });
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
  const stmt2DetailMissing = gap.reasons.some((r) =>
    /stmt2-detail-missing|attachment-page-missing/i.test(r),
  );
  const stmt2TotalMissing = gap.reasons.some((r) => /stmt2-total-unparseable/i.test(r));
  const attachmentFieldsMissing = missingAttach.some((id) =>
    ATTACHMENT_RESCAN_FIELDS.includes(id as (typeof ATTACHMENT_RESCAN_FIELDS)[number]),
  );
  const keyOpexBlank =
    parsed.values.other_operating_expenses === undefined &&
    parsed.values.bank_credit_card === undefined &&
    parsed.values.professional_fees === undefined &&
    parsed.values.utilities === undefined;

  // Hard evidence only — never rescan just because form page-1 says "SEE STMT 2".
  const needsRescan =
    stmt2DetailMissing ||
    stmt2TotalMissing ||
    (attachmentFieldsMissing && (stmt2DetailMissing || keyOpexBlank)) ||
    needsStmt2AttachmentRescan(embeddedText, ocrText, gap);
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
  const maxPages =
    baselineMode === "balanced"
      ? MAX_BALANCED_RECOVERY_PAGES
      : MAX_ATTACHMENT_RESCAN_PAGES;
  const targets = prioritizeAttachmentRescanTargets(plan, alreadyPages, maxPages);
  if (!targets.length) {
    return { ocrText, pages: [], ms: 0, ran: false };
  }

  const recoveryMode = "balanced";
  const useThoroughRecovery = baselineMode === "thorough";
  const t0 = Date.now();
  const delta = await ocrPageBatch(
    bytes,
    useThoroughRecovery ? "thorough" : recoveryMode,
    targets,
    useThoroughRecovery,
  );
  const merged = mergeOcrPageTexts([ocrText, delta.text]);
  return {
    ocrText: merged,
    pages: targets,
    ms: Date.now() - t0,
    ran: true,
    reasons: gap.reasons,
  };
}
