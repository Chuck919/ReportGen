/**
 * Two-phase OCR: fast low-DPI pass to find pages with financial keywords,
 * then full-resolution OCR only on those pages (plus heuristic fallback).
 * Stdout is a single JSON object (includes logs for debugging).
 */
try {
  require("pdf-parse/worker");
  const { DOMMatrix, ImageData, Path2D } = require("@napi-rs/canvas");
  if (!globalThis.DOMMatrix) globalThis.DOMMatrix = DOMMatrix;
  if (!globalThis.Path2D) globalThis.Path2D = Path2D;
  if (!globalThis.ImageData) globalThis.ImageData = ImageData;
} catch {
  // local dev without canvas still surfaces a clear error from pdf-parse
}
const path = require("node:path");
function requirePkg(name) {
  try {
    return require(name);
  } catch {
    return require(path.join(process.cwd(), "node_modules", name));
  }
}
const { PDFParse } = requirePkg("pdf-parse");
const { createWorker } = requirePkg("tesseract.js");
const { readFile } = require("node:fs/promises");
const { preprocessPageImage, buildTaxVariants } = require("./ocr-preprocess.cjs");
const { resolveOcrMode, selectVariants, effectivePhase2Cap } = require("./ocr-modes.cjs");
const {
  uniqueSorted,
  heuristicPages,
  fastHeuristicPages,
  capPageTargets,
  readPdfPageTotal,
  parseForcePages,
} = require("./ocr-targets.cjs");

const profile = process.env.FREE_OCR_PROFILE || "tax";
const ocrMode = resolveOcrMode(process.env.FREE_OCR_MODE);

const TAX_KW =
  /\b1120-?s\b|form\s*1120|form\s*1041|form\s*1065|schedule\s*l\b|schedule\s*b\b|schedule\s*k-?1|schedule\s*m-?1|\bm-1\b|shareholder|fiduciary|ordinary\s*business|balance\s*sheet|assets?\s+and\s+liabilit|gross\s*receipts|cost\s*of\s*good|total\s*assets|return\s*summary|deductions|worksheet|comparison|1120\b|compensation\s*of|two\s*year|stmt\s*\d|statement\s*\d|other\s+deduct|1125|13a\s+intangible|less\s+accumulated\s+amort|federal\s+statements|interest\s+income|estates?\s+and\s+trusts/i;

const ATTACHMENT_KW =
  /stmt\s*\d|statement\s*\d|other\s+deduct|1125|attached\s+statement|deductions?\s+statement|see\s+stmt|other\s+operating|bank\s*(?:and|&)?\s*credit|professional\s+fees|utilities|federal\s+statements|two\s*year\s*comparison|comparison\s+worksheet/i;

const SCHEDULE_L_KW =
  /schedule\s*l\b|13a\s+intangible|less\s+accumulated\s+(?:amort|deprec)|10a\s+buildings|total\s+assets|total\s+liabilities|retained\s+earn/i;

const BENCH_KW =
  /common\s*size|% of sales|% of total|ibisworld|\bnaics\b|industry average|benchmark|income statement data|balance sheet data|key statistic|sector average/i;

const KEYWORD_RE =
  profile === "benchmark"
    ? new RegExp(`${BENCH_KW.source}|${TAX_KW.source}`, "i")
    : TAX_KW;

function scoreOcrCandidate(result) {
  const text = result.data.text || "";
  const confidence = result.data.confidence || 0;
  const moneyHits = (text.match(/\$?\s*\d[\d,]{2,}(?:\.\d{2})?/g) || []).length;
  const keywordHits = (text.match(KEYWORD_RE) || []).length;
  const schedLBonus = SCHEDULE_L_KW.test(text) ? Math.min(8, moneyHits * 0.15) : 0;
  return confidence + Math.min(18, moneyHits * 0.35) + Math.min(10, keywordHits * 4) + schedLBonus;
}

/** Substantial money tokens on Schedule L / Stmt pages — used to gate hi-dpi append. */
function scheduleLMoneyScore(text) {
  if (!text) return 0;
  let score = 0;
  if (SCHEDULE_L_KW.test(text)) score += 2;
  if (/balance\s*sheets?\s*per\s*books/i.test(text)) score += 3;
  if (/federal\s+statements|statement\s*\d/i.test(text)) score += 1;
  score += (text.match(/\d[\d,]{4,}/g) || []).length;
  return score;
}

function scheduleLLineHasAmount(text, lineNum) {
  const re = new RegExp(`\\b${lineNum}\\b[^\\n]{0,140}\\d[\\d,]{4,}`, "i");
  return re.test(text);
}

/** Only append hi-dpi when it adds Schedule L amounts the full pass missed. */
function hiDpiShouldAppend(fullText, hiText) {
  if (!fullText) return Boolean(hiText);
  if (!hiText) return false;
  if (corruptsFormLineNumbers(fullText, hiText)) return false;

  const slLines = [17, 20, 22, 27];
  const fullHas = slLines.filter((l) => scheduleLLineHasAmount(fullText, l));
  const hiHas = slLines.filter((l) => scheduleLLineHasAmount(hiText, l));

  if (fullHas.length >= 2 && hiHas.length < fullHas.length) return false;
  if (hiHas.length > fullHas.length) return true;

  if (scheduleLLineHasAmount(fullText, 17) && scheduleLLineHasAmount(fullText, 20)) {
    if (!scheduleLLineHasAmount(hiText, 17) || !scheduleLLineHasAmount(hiText, 20)) return false;
  }

  return true;
}

async function recognizeHiDpiPage(worker, page, mode) {
  const baselineBuffer = Buffer.from(page.data);
  const baseline = await worker.recognize(baselineBuffer);
  let best = {
    name: "hi-baseline",
    result: baseline,
    score: scoreOcrCandidate(baseline),
  };

  const variants = selectVariants(
    buildTaxVariants({ heavy: true, hiDpi: true, scheduleL: true }),
    mode.maxHiDpiVariants,
    { scheduleL: true, formCritical: true },
  );

  let stagnant = 0;
  for (const variant of variants) {
    try {
      const buffer = await preprocessPageImage(page.data, variant);
      const result = await worker.recognize(buffer);
      const score = scoreOcrCandidate(result);
      const variantText = result.data.text || "";
      if (corruptsFormLineNumbers(baseline.data.text || "", variantText)) continue;
      const gain = minGainForPage(mode, true);
      if (score > best.score + gain) {
        best = { name: variant.name, result, score };
        stagnant = 0;
      } else {
        stagnant += 1;
        if (stagnant >= mode.earlyExitStreak) break;
      }
    } catch (error) {
      // keep best
    }
  }

  return best;
}

/** Reject variants that corrupt 1120-S line numbers (e.g. 11→111, 16→116). */
function corruptsFormLineNumbers(baselineText, variantText) {
  const pairs = [
    [/\b11\b[^\n]{0,40}Rents/i, /\b111\s+Rents/i],
    [/\b16\b[^\n]{0,40}Advertising/i, /\b116\s+Advertising/i],
    [/\[11\]/i, /=\s*111\s+Rents/i],
    [/\[16\]/i, /\$?\s*116\s+Advertising/i],
  ];
  for (const [good, bad] of pairs) {
    if (good.test(baselineText) && bad.test(variantText) && !good.test(variantText)) {
      return true;
    }
  }
  return false;
}

function minGainForPage(mode, formCritical) {
  const base = mode.minScoreGain || 1.5;
  return formCritical ? Math.max(base, 2.5) : base;
}

function isFormCriticalPage(text) {
  return (
    /gross\s*rec|\[1c\b|1c\b|cost of goods|compensation of officers|1120-?s/i.test(text) ||
    SCHEDULE_L_KW.test(text) ||
    /13a\s+intangible|federal statements|stmt\s*\d|statement\s*\d/i.test(text)
  );
}

function isEasyOcrPage(text, conf, money, mode) {
  if (isFormCriticalPage(text)) return false;
  if (SCHEDULE_L_KW.test(text)) return false;
  if (/13a\s+intangible/i.test(text)) return false;
  if (ATTACHMENT_KW.test(text) && conf < 72) return false;
  return conf >= mode.easyPageMinConf && money >= mode.easyPageMinMoney && text.length >= 280;
}

/** Skip variant passes when baseline OCR is already strong (non-critical pages only). */
function isBaselineGoodEnough(text, conf, money, score, mode) {
  if (!mode.baselineGoodConf || mode.baselineGoodConf <= 0) return false;
  if (isFormCriticalPage(text)) return false;
  if (SCHEDULE_L_KW.test(text)) return false;
  if (/13a\s+intangible/i.test(text)) return false;
  if (ATTACHMENT_KW.test(text)) return false;
  return (
    conf >= mode.baselineGoodConf &&
    money >= (mode.baselineGoodMoney || 6) &&
    text.length >= 260 &&
    score >= mode.baselineGoodConf + 8
  );
}

function phase1ScanPages(total, prof) {
  const head = [];
  for (let i = 1; i <= Math.min(14, total); i++) head.push(i);
  // On 100+ page returns, phase-1 scans only the opening band — keyword hits there
  // plus phase-2 capPageTargets (head+tail) still reach Stmt/Schedule L attachments.
  if (total > 100) return head;
  const heuristic = heuristicPages(total, prof);
  return uniqueSorted([...head, ...heuristic]);
}

async function createOcrWorker(profile, scale) {
  const worker = await createWorker("eng");
  await worker.setParameters({
    tessedit_pageseg_mode: profile === "tax" ? "6" : "3",
    preserve_interword_spaces: "1",
    user_defined_dpi: scale ? String(Math.round(72 * scale)) : "200",
  });
  return worker;
}

async function processPagesParallel(pages, concurrency, profile, scale, handler) {
  const workers = await Promise.all(
    Array.from({ length: concurrency }, () => createOcrWorker(profile, scale)),
  );
  const results = new Array(pages.length);
  let next = 0;
  async function run(worker) {
    while (true) {
      const i = next++;
      if (i >= pages.length) break;
      results[i] = await handler(worker, pages[i], i);
    }
  }
  try {
    await Promise.all(workers.map(run));
    return results;
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
}

async function recognizeBestPage(worker, page, profile, mode) {
  const baselineBuffer = Buffer.from(page.data);
  const baseline = await worker.recognize(baselineBuffer);
  let best = {
    name: "baseline",
    buffer: baselineBuffer,
    result: baseline,
    score: scoreOcrCandidate(baseline),
  };

  if (profile !== "tax") {
    return best;
  }

  const baselineText = baseline.data.text || "";
  const baselineConf = baseline.data.confidence || 0;
  const baselineMoney = (baselineText.match(/\$?\s*\d[\d,]{2,}(?:\.\d{2})?/g) || []).length;
  const isScheduleL = SCHEDULE_L_KW.test(baselineText);
  const needsHeavyPass =
    baselineConf < 74 || baselineText.length < 280 || baselineMoney < 4 || isScheduleL;
  const missingIntangibleAmt =
    /13a\s+intangible/i.test(baselineText) &&
    !/\d[\d,]{5,}/.test(
      baselineText.slice(
        baselineText.search(/13a\s+intangible/i),
        baselineText.search(/13a\s+intangible/i) + 360,
      ),
    );

  if (
    isBaselineGoodEnough(baselineText, baselineConf, baselineMoney, best.score, mode) &&
    !missingIntangibleAmt
  ) {
    return best;
  }

  if (mode.baselineOnly) {
    const formCritical = isFormCriticalPage(baselineText);
    const needsVariants =
      isScheduleL ||
      missingIntangibleAmt ||
      (formCritical && baselineConf < 70) ||
      (ATTACHMENT_KW.test(baselineText) && baselineConf < 66);
    if (!needsVariants || !mode.maxVariantsHeavy) return best;
    const built = buildTaxVariants({
      heavy: true,
      hiDpi: false,
      scheduleL: isScheduleL || missingIntangibleAmt,
    });
    const variants = selectVariants(built, mode.maxVariantsHeavy, {
      scheduleL: isScheduleL || missingIntangibleAmt,
      formCritical,
    });
    for (const variant of variants) {
      try {
        const buffer = await preprocessPageImage(page.data, variant);
        const result = await worker.recognize(buffer);
        const score = scoreOcrCandidate(result);
        const variantText = result.data.text || "";
        if (corruptsFormLineNumbers(baselineText, variantText)) continue;
        const gain = minGainForPage(mode, formCritical);
        if (score > best.score + gain) {
          best = { name: variant.name, buffer, result, score };
        }
      } catch (error) {
        // keep baseline
      }
    }
    return best;
  }

  if (isEasyOcrPage(baselineText, baselineConf, baselineMoney, mode) && !missingIntangibleAmt && !isScheduleL) {
    const light = selectVariants(
      buildTaxVariants({ heavy: false, hiDpi: false, scheduleL: isScheduleL || missingIntangibleAmt }),
      mode.maxVariantsEasy,
      { scheduleL: isScheduleL || missingIntangibleAmt, formCritical: false },
    );
    if (!light.length) return best;
    for (const variant of light) {
      try {
        const buffer = await preprocessPageImage(page.data, variant);
        const result = await worker.recognize(buffer);
        const score = scoreOcrCandidate(result);
        if (score > best.score) best = { name: variant.name, buffer, result, score };
      } catch (error) {
        // keep baseline
      }
    }
    return best;
  }

  const formCritical = isFormCriticalPage(baselineText);
  const built = buildTaxVariants({
    heavy: needsHeavyPass || missingIntangibleAmt,
    hiDpi: false,
    scheduleL: isScheduleL || missingIntangibleAmt,
  });
  const variantCap = needsHeavyPass || missingIntangibleAmt || formCritical
    ? mode.maxVariantsHeavy
    : mode.maxVariantsNormal;
  const variants = selectVariants(built, variantCap, {
    scheduleL: isScheduleL || missingIntangibleAmt,
    formCritical,
  });

  let stagnant = 0;
  const gain = minGainForPage(mode, formCritical);
  for (const variant of variants) {
    try {
      const buffer = await preprocessPageImage(page.data, variant);
      const result = await worker.recognize(buffer);
      const score = scoreOcrCandidate(result);
      const variantText = result.data.text || "";
      if (corruptsFormLineNumbers(baselineText, variantText)) continue;
      if (score > best.score + gain) {
        best = { name: variant.name, buffer, result, score };
        stagnant = 0;
      } else {
        stagnant += 1;
        if (stagnant >= mode.earlyExitStreak) break;
      }
    } catch (error) {
      // Keep the baseline OCR result if a preprocessing variant fails.
    }
  }

  return best;
}

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) throw new Error("Usage: node scripts/free-ocr.cjs <pdf-path>");

  const os = require("node:os");
  if (!process.env.FREE_OCR_WORKERS) {
    const cores = os.cpus()?.length ?? 1;
    const cap = Number(process.env.FREE_OCR_MAX_WORKERS ?? (cores <= 2 ? 2 : 3));
    process.env.FREE_OCR_WORKERS = String(Math.min(cores, cap));
  }

  const logs = [];
  const phases = [];
  const quickScale = Number(process.env.FREE_OCR_QUICK_SCALE ?? ocrMode.quickScale);
  const fullScale = Number(
    process.env.FREE_OCR_PDF_SCALE ?? (profile === "benchmark" ? 1.9 : ocrMode.fullScale),
  );
  const maxPages = Number(process.env.FREE_OCR_MAX_PAGES ?? 0);
  const skipPhase1 = process.env.FREE_OCR_SKIP_PHASE1 === "1";

  /** Node Buffer avoids pdf.js worker DataCloneError seen with some Uint8Array views. */
  const buffer = await readFile(pdfPath);
  const mark = (name) => {
    phases.push({ name, at: Date.now() });
    logs.push(`[${new Date().toISOString()}] ${name}`);
  };

  mark(`start pdf=${pdfPath} bytes=${buffer.length} profile=${profile} mode=${ocrMode.name}`);

  const forcePages = parseForcePages(process.env.FREE_OCR_FORCE_PAGES);
  let interesting = new Set();
  let attachmentCandidates = new Set();
  let quickPageCount = 0;
  let heuristicOnlyTargets = null;
  const quickPageText = new Map();
  let targets;

  if (forcePages.length) {
    targets = forcePages;
    quickPageCount = await readPdfPageTotal(buffer);
    logs.push(`batched OCR — force pages: ${targets.join(",")} of ${quickPageCount} total`);
  } else if (ocrMode.skipPhase1QuickScan) {
    quickPageCount = await readPdfPageTotal(buffer);
    heuristicOnlyTargets =
      ocrMode.useFastHeuristicPages
        ? fastHeuristicPages(quickPageCount)
        : heuristicPages(quickPageCount, profile);
    logs.push(
      `phase1 quick-scan skipped — ${heuristicOnlyTargets.length} heuristic targets from ${quickPageCount} pages`,
    );
  } else if (!skipPhase1) {
    mark(`phase1 getScreenshot quickScale=${quickScale}`);
    const p1 = new PDFParse({ data: buffer });
    const quick = await p1.getScreenshot({
      scale: quickScale,
      imageDataUrl: false,
      imageBuffer: true,
    });
    await p1.destroy?.();
    quickPageCount = quick.pages.length;
    mark(`phase1 render done pages=${quickPageCount}`);

    const scanPageNums = phase1ScanPages(quickPageCount, profile);
    const scanPages = quick.pages.filter((p) => scanPageNums.includes(p.pageNumber));
    const phase1Workers = Number(process.env.FREE_OCR_PHASE1_WORKERS ?? ocrMode.workers ?? 1);
    const tScan = Date.now();
    await processPagesParallel(scanPages, phase1Workers, profile, quickScale, async (worker, page) => {
      const r = await worker.recognize(Buffer.from(page.data));
      const t = r.data.text || "";
      quickPageText.set(page.pageNumber, t);
      if (KEYWORD_RE.test(t)) interesting.add(page.pageNumber);
      if (ATTACHMENT_KW.test(t)) attachmentCandidates.add(page.pageNumber);
      return null;
    });
    logs.push(
      `phase1 scan ${Date.now() - tScan}ms ocrPages=${scanPages.length}/${quickPageCount} keywordPages=${interesting.size} attachmentCandidates=${attachmentCandidates.size}`,
    );
  }

  if (!forcePages.length) {
    targets = heuristicOnlyTargets
      ? heuristicOnlyTargets
      : uniqueSorted(Array.from(interesting));
    if (!targets.length) {
      const total = quickPageCount || (await readPdfPageTotal(buffer));
      targets = heuristicPages(total, profile);
      logs.push(`phase1 had 0 keyword hits — heuristic ${targets.length} of ${total} pages`);
    }

    if (profile === "tax" && attachmentCandidates.size) {
      const merged = uniqueSorted([...targets, ...Array.from(attachmentCandidates)]);
      if (merged.length !== targets.length) {
        logs.push(`added ${merged.length - targets.length} attachment candidate page(s) to OCR targets`);
        targets = merged;
      }
    }

    if (maxPages > 0 && targets.length > maxPages) {
      logs.push(`capped targets ${targets.length} -> ${maxPages} (FREE_OCR_MAX_PAGES)`);
      targets = targets.slice(0, maxPages);
    }

    const totalForCap = quickPageCount || (await readPdfPageTotal(buffer));
    const defaultPhase2Cap = effectivePhase2Cap(ocrMode, totalForCap, profile);
    const maxPhase2 = Number(process.env.FREE_OCR_MAX_PHASE2_PAGES ?? defaultPhase2Cap);
    if (maxPhase2 > 0 && targets.length > maxPhase2) {
      logs.push(`capped phase2 OCR ${targets.length} -> ${maxPhase2} (FREE_OCR_MAX_PHASE2_PAGES)`);
      targets = capPageTargets(targets, maxPhase2);
    }
  }

  mark(`phase2 getScreenshot fullScale=${fullScale} pages=${targets.length}`);
  const p2 = new PDFParse({ data: buffer });
  const full = await p2.getScreenshot({
    scale: fullScale,
    imageDataUrl: false,
    imageBuffer: true,
    partial: targets,
  });
  await p2.destroy?.();
  mark(`phase2 render done`);

  const phase2Workers = Number(process.env.FREE_OCR_WORKERS ?? ocrMode.workers ?? 1);
  const pageTexts = [];
  const pageConfidences = [];
  const tFull = Date.now();
  const phase2Results = await processPagesParallel(
    full.pages,
    phase2Workers,
    profile,
    fullScale,
    async (worker, page) => {
      const best = await recognizeBestPage(worker, page, profile, ocrMode);
      return { page, best };
    },
  );
  for (const { page, best } of phase2Results) {
    const recognized = best.result;
    pageTexts.push(`\n--- OCR PAGE ${page.pageNumber} (full) ---\n${recognized.data.text || ""}`);
    pageConfidences.push(recognized.data.confidence || 0);
    logs.push(`page ${page.pageNumber} variant=${best.name} confidence=${Math.round(recognized.data.confidence || 0)}`);
  }
  logs.push(
    `phase2 tesseract ${Date.now() - tFull}ms for ${full.pages.length} page images workers=${phase2Workers}`,
  );

  const pageTextByNumber = new Map();
  for (let i = 0; i < full.pages.length; i++) {
    const page = full.pages[i];
    const header = `\n--- OCR PAGE ${page.pageNumber} (full) ---\n`;
    pageTextByNumber.set(page.pageNumber, {
      header,
      text: pageTexts[i].slice(header.length),
      confidence: pageConfidences[i],
    });
  }

  if (profile === "tax" && !ocrMode.skipPhase3 && (!forcePages.length || process.env.FREE_OCR_FORCE_PHASE3 === "1")) {
    const hiScale = Number(process.env.FREE_OCR_HI_DPI_SCALE ?? ocrMode.hiScale);
    const hiDpiPages = new Set(attachmentCandidates);
    for (const page of full.pages) {
      const entry = pageTextByNumber.get(page.pageNumber);
      const t = entry?.text || "";
      const money = (t.match(/\$?\s*\d[\d,]{2,}(?:\.\d{2})?/g) || []).length;
      const conf = entry?.confidence || 0;
      if (
        ocrMode.skipHiDpiMinConf > 0 &&
        conf >= ocrMode.skipHiDpiMinConf &&
        money >= 5 &&
        !/13a\s+intangible/i.test(t)
      ) {
        continue;
      }
      if (ATTACHMENT_KW.test(t) && (conf < 68 || money < 4 || t.length < 220)) {
        hiDpiPages.add(page.pageNumber);
      }
      if (SCHEDULE_L_KW.test(t) && (conf < 72 || /13a\s+intangible/i.test(t))) {
        hiDpiPages.add(page.pageNumber);
      }
      if (/13a\s+intangible/i.test(t) && !/\d[\d,]{5,}/.test(t.slice(t.search(/13a\s+intangible/i), t.search(/13a\s+intangible/i) + 320))) {
        hiDpiPages.add(page.pageNumber);
      }
    }

    let hiList = uniqueSorted(Array.from(hiDpiPages));
    if (ocrMode.skipPhase3UnlessCritical) {
      const criticalSet = new Set();
      const considerCritical = (pageNum) => {
        const entry = pageTextByNumber.get(pageNum);
        const t = entry?.text || "";
        const conf = entry?.confidence || 0;
        const money = (t.match(/\$?\s*\d[\d,]{2,}(?:\.\d{2})?/g) || []).length;
        const missingIntangible =
          /13a\s+intangible/i.test(t) &&
          !/\d[\d,]{5,}/.test(
            t.slice(t.search(/13a\s+intangible/i), t.search(/13a\s+intangible/i) + 320),
          );
        const scheduleL = SCHEDULE_L_KW.test(t);
        const weakScheduleL = scheduleL && (conf < 74 || money < 6);
        const weakAttachment = ATTACHMENT_KW.test(t) && (conf < 68 || money < 4);
        const weakForm =
          isFormCriticalPage(t) && !scheduleL && conf < 76 && money >= 3 && t.length >= 200;
        return scheduleL || missingIntangible || weakScheduleL || weakAttachment || weakForm;
      };
      for (const pageNum of hiList) {
        if (considerCritical(pageNum)) criticalSet.add(pageNum);
      }
      for (const page of full.pages) {
        if (considerCritical(page.pageNumber)) criticalSet.add(page.pageNumber);
      }
      const critical = uniqueSorted(Array.from(criticalSet));
      if (critical.length) {
        logs.push(`phase3 fast: ${hiList.length} candidates -> ${critical.length} critical only`);
        hiList = critical;
      } else {
        logs.push(`phase3 fast: skipped (${hiList.length} non-critical candidates)`);
        hiList = [];
      }
    }
    const maxHi = Number(process.env.FREE_OCR_MAX_HI_DPI_PAGES ?? ocrMode.maxHiDpiPages);
    const hiTargets = maxHi > 0 && hiList.length > maxHi ? hiList.slice(0, maxHi) : hiList;

    if (hiTargets.length) {
      mark(`phase3 hi-dpi scale=${hiScale} pages=${hiTargets.length}`);
      const p3 = new PDFParse({ data: buffer });
      const hi = await p3.getScreenshot({
        scale: hiScale,
        imageDataUrl: false,
        imageBuffer: true,
        partial: hiTargets,
      });
      await p3.destroy?.();
      mark(`phase3 render done`);

      const hiWorkers = Number(process.env.FREE_OCR_HI_WORKERS ?? Math.min(phase2Workers, 2));
      const tHi = Date.now();
      const hiResults = await processPagesParallel(
        hi.pages,
        hiWorkers,
        profile,
        hiScale,
        async (worker, page) => {
          const best = await recognizeHiDpiPage(worker, page, ocrMode);
          return { page, best };
        },
      );
      for (const { page, best } of hiResults) {
        const recognized = best.result;
        const existing = pageTextByNumber.get(page.pageNumber);
        const hiText = recognized.data.text || "";
        const fullScore = scheduleLMoneyScore(existing?.text || "");
        const hiScore = scheduleLMoneyScore(hiText);
        const hiConf = recognized.data.confidence || 0;
        const fullConf = existing?.confidence || 0;
        if (!hiDpiShouldAppend(existing?.text || "", hiText)) {
          logs.push(`hi-dpi page ${page.pageNumber} skipped (full pass already has key Schedule L amounts)`);
          continue;
        }
        const isThorough =
          ocrMode.name === "thorough" || ocrMode.name === "vercel-thorough";
        const keepHi =
          hiScore > fullScore + (isThorough ? 2 : 0) ||
          (hiScore === fullScore && hiConf > fullConf + (isThorough ? 8 : 3)) ||
          (!isThorough && hiConf >= fullConf);
        if (!keepHi) {
          logs.push(
            `hi-dpi page ${page.pageNumber} skipped (fullScore=${fullScore} hiScore=${hiScore})`,
          );
          continue;
        }
        const hiBlock = `\n--- OCR PAGE ${page.pageNumber} (hi-dpi) ---\n${hiText}`;
        pageTextByNumber.set(page.pageNumber, {
          header: existing?.header || `\n--- OCR PAGE ${page.pageNumber} (full) ---\n`,
          text: `${existing?.text || ""}${hiBlock}`,
          confidence: Math.max(fullConf, hiConf),
        });
        logs.push(
          `hi-dpi page ${page.pageNumber} variant=${best.name} confidence=${Math.round(hiConf)}`,
        );
      }
      logs.push(
        `phase3 tesseract ${Date.now() - tHi}ms for ${hi.pages.length} page images workers=${hiWorkers}`,
      );
    }
  } else if (profile === "tax" && ocrMode.skipPhase3) {
    logs.push("phase3 skipped (skipPhase3)");
  }

  const orderedPages = uniqueSorted(Array.from(pageTextByNumber.keys()));
  pageTexts.length = 0;
  pageConfidences.length = 0;
  for (const n of orderedPages) {
    const entry = pageTextByNumber.get(n);
    pageTexts.push(`${entry.header}${entry.text}`);
    pageConfidences.push(entry.confidence);
  }

  const confidence =
    pageConfidences.length > 0
      ? pageConfidences.reduce((sum, item) => sum + item, 0) / pageConfidences.length
      : 0;

  const timing = {};
  for (let i = 1; i < phases.length; i++) {
    const key = phases[i].name.replace(/\s+/g, "_");
    timing[key] = (timing[key] || 0) + (phases[i].at - phases[i - 1].at);
  }
  const totalMs = phases.length > 1 ? phases[phases.length - 1].at - phases[0].at : 0;
  for (const line of logs) {
    const m = line.match(/^(phase[123]) (?:scan|tesseract) (\d+)ms/);
    if (m) timing[`${m[1]}_${m[1] === "phase1" ? "ocr" : "tesseract"}_ms`] = Number(m[2]);
  }

  process.stdout.write(
    JSON.stringify({
      text: pageTexts.join("\n"),
      confidence,
      pages: full.pages.length,
      pagesTotal: targets.length,
      pageNumbers: targets,
      ocrMode: ocrMode.name,
      timingMs: { total: totalMs, ...timing },
      logs,
      phases,
    }),
  );
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
