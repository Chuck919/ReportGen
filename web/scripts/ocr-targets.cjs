/**
 * Shared OCR page-target resolution for free-ocr and ocr-plan.
 */
const { PDFParse } = require("pdf-parse");

function uniqueSorted(nums) {
  return Array.from(new Set(nums)).sort((a, b) => a - b);
}

function heuristicPages(total, prof) {
  if (total <= 0) return [];
  const cap = prof === "benchmark" ? 14 : 34;
  const out = [];
  for (let i = 1; i <= Math.min(12, total); i++) out.push(i);
  const midLo = Math.max(14, Math.floor(total * 0.3));
  const midHi = Math.min(total - 2, Math.floor(total * 0.64));
  for (let i = midLo; i <= Math.min(midHi, midLo + 22); i++) out.push(i);
  if (total > 24) {
    for (let i = Math.max(total - 14, 1); i <= total; i++) out.push(i);
  }
  const u = uniqueSorted(out.filter((p) => p >= 1 && p <= total));
  if (u.length > cap) return u.slice(0, cap);
  return u;
}

function fastHeuristicPages(total) {
  if (total <= 0) return [];
  const out = [];
  for (let i = 1; i <= Math.min(10, total); i++) out.push(i);
  for (let i = Math.max(total - 8, 1); i <= total; i++) out.push(i);
  const midLo = Math.max(12, Math.floor(total * 0.38));
  const midHi = Math.min(total - 10, midLo + 6);
  for (let i = midLo; i <= midHi; i++) out.push(i);
  return uniqueSorted(out);
}

function capPageTargets(targets, max) {
  if (!max || max <= 0 || targets.length <= max) return targets;
  const sorted = uniqueSorted(targets);
  const total = sorted[sorted.length - 1];
  const head = sorted.filter((p) => p <= 12);
  const tail = sorted.filter((p) => p >= Math.max(total - 12, 1));
  const picked = new Set([...head, ...tail]);
  for (const p of sorted) {
    if (picked.size >= max) break;
    picked.add(p);
  }
  return uniqueSorted(Array.from(picked)).slice(0, max);
}

async function readPdfPageTotal(buffer) {
  const p = new PDFParse({ data: buffer });
  const info = await p.getInfo();
  await p.destroy?.();
  return info.total;
}

function parseForcePages(raw) {
  if (!raw) return [];
  return uniqueSorted(
    String(raw)
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0),
  );
}

function stmt2HintPagesFromEmbedded(embeddedText) {
  if (!embeddedText) return [];
  const pages = new Set();
  const pageRe = /---\s*EMBEDDED\s+PAGE\s+(\d+)/gi;
  const markers = [];
  let m;
  while ((m = pageRe.exec(embeddedText)) !== null) {
    markers.push({ page: Number(m[1]), idx: m.index });
  }
  if (!markers.length) return [];
  const findPage = (idx) => {
    let p = markers[0].page;
    for (const mk of markers) {
      if (mk.idx <= idx) p = mk.page;
      else break;
    }
    return p;
  };
  const hints = [
    /federal\s+statements/i,
    /statement\s*2\s*[-–].*form\s+1120/i,
    /see\s+stmt\s*2/i,
    /description\s+amount[\s\S]{0,200}other\s+deduct/i,
  ];
  for (const re of hints) {
    let hit;
    const r = new RegExp(re.source, re.flags.includes("i") ? re.flags : re.flags + "i");
    while ((hit = r.exec(embeddedText)) !== null) {
      const pg = findPage(hit.index);
      if (pg > 0) {
        pages.add(pg);
        if (pg > 1) pages.add(pg - 1);
        if (pg < markers[markers.length - 1].page) pages.add(pg + 1);
      }
    }
  }
  return uniqueSorted(Array.from(pages));
}

/**
 * @param {number} totalPages
 * @param {object} mode - resolved OCR mode preset
 * @param {'tax'|'benchmark'} profile
 * @param {{ full?: boolean, embeddedText?: string }} options
 */
function planOcrTargets(totalPages, mode, profile, options = {}) {
  let targets;
  if (mode.useFastHeuristicPages) {
    targets = fastHeuristicPages(totalPages);
  } else {
    targets = heuristicPages(totalPages, profile);
  }
  if (options.embeddedText) {
    targets = uniqueSorted([...targets, ...stmt2HintPagesFromEmbedded(options.embeddedText)]);
  }
  if (!options.full) {
    const cap = mode.maxPhase2Pages || 0;
    if (cap > 0 && targets.length > cap) {
      targets = capPageTargets(targets, cap);
    }
  }
  return uniqueSorted(targets.filter((p) => p >= 1 && p <= totalPages));
}

function chunkPages(targets, batchSize) {
  const batches = [];
  for (let i = 0; i < targets.length; i += batchSize) {
    batches.push(targets.slice(i, i + batchSize));
  }
  return batches;
}

const EARLY_IS_FIELDS = new Set([
  "sales",
  "cogs",
  "depreciation",
  "amortization",
  "officer_compensation",
  "salaries_wages",
  "advertising",
  "rent",
  "taxes_licenses",
  "bank_credit_card",
  "professional_fees",
  "utilities",
  "other_operating_expenses",
  "interest_expense",
  "other_income",
]);

const SCHEDULE_L_FIELDS = new Set([
  "cash",
  "accounts_receivable",
  "inventory",
  "other_current_assets",
  "gross_fixed_assets",
  "accumulated_depreciation",
  "gross_intangible_assets",
  "accumulated_amortization",
  "other_assets",
  "accounts_payable",
  "other_current_liabilities",
  "notes_minus_short_term",
  "unclassified_equity",
]);

const ATTACHMENT_FIELDS = new Set([
  "professional_fees",
  "utilities",
  "bank_credit_card",
  "other_operating_expenses",
  "advertising",
  "rent",
  "taxes_licenses",
]);

function pagesForMissingFields(missingFieldIds, totalPages) {
  if (!missingFieldIds.length || totalPages <= 0) return [];
  const pages = new Set();
  const needsEarly = missingFieldIds.some((f) => EARLY_IS_FIELDS.has(f));
  const needsScheduleL = missingFieldIds.some((f) => SCHEDULE_L_FIELDS.has(f));
  const needsAttachments = missingFieldIds.some((f) => ATTACHMENT_FIELDS.has(f));

  if (needsEarly) {
    for (let i = 1; i <= Math.min(8, totalPages); i++) pages.add(i);
  }
  if (needsScheduleL) {
    const mid = Math.max(10, Math.floor(totalPages * 0.35));
    for (let i = mid; i <= Math.min(mid + 10, totalPages); i++) pages.add(i);
  }
  if (needsAttachments) {
    for (let i = Math.max(1, totalPages - 12); i <= totalPages; i++) pages.add(i);
  }
  return uniqueSorted(Array.from(pages).filter((p) => p >= 1 && p <= totalPages));
}

function planDeltaTargets(totalPages, toMode, fromMode, profile, alreadyPages, missingFieldIds) {
  const { resolveOcrMode } = require("./ocr-modes.cjs");
  const fromPreset = resolveOcrMode(typeof fromMode === "string" ? fromMode : fromMode.name);
  const toPreset = resolveOcrMode(typeof toMode === "string" ? toMode : toMode.name);

  const fromTargets = new Set(planOcrTargets(totalPages, fromPreset, profile, { full: false }));
  const toTargets = planOcrTargets(totalPages, toPreset, profile, { full: false });
  const already = new Set(alreadyPages || []);

  const delta = [];
  for (const p of toTargets) {
    if (!fromTargets.has(p)) delta.push(p);
  }

  const reOcr = [];
  const hintPages = pagesForMissingFields(missingFieldIds || [], totalPages);
  for (const p of hintPages) {
    if (already.has(p)) {
      if (!reOcr.includes(p)) reOcr.push(p);
    } else if (!delta.includes(p)) {
      delta.push(p);
    }
  }

  const needsScheduleL = missingFieldIds?.some((f) => SCHEDULE_L_FIELDS.has(f));
  const needsAttachments = missingFieldIds?.some((f) => ATTACHMENT_FIELDS.has(f));
  for (const p of already) {
    if (needsScheduleL && p >= Math.floor(totalPages * 0.3) && p <= Math.floor(totalPages * 0.65)) {
      if (!reOcr.includes(p)) reOcr.push(p);
    }
    if (needsAttachments && p >= Math.max(1, totalPages - 14)) {
      if (!reOcr.includes(p)) reOcr.push(p);
    }
  }

  const targets = uniqueSorted([...delta, ...reOcr]);
  return { targets, fromTargets: Array.from(fromTargets), toTargets, deltaOnly: delta, reOcr };
}

module.exports = {
  uniqueSorted,
  heuristicPages,
  fastHeuristicPages,
  capPageTargets,
  readPdfPageTotal,
  parseForcePages,
  planOcrTargets,
  chunkPages,
  pagesForMissingFields,
  planDeltaTargets,
  stmt2HintPagesFromEmbedded,
};
