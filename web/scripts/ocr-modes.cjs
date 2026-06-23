/**
 * OCR presets. Env: FREE_OCR_MODE=fast|balanced|thorough|vercel-fast|vercel-balanced
 *
 * fast / balanced / thorough — local & VPS (100% matrix presets; do not retune for Vercel).
 * vercel-fast / vercel-balanced — separate Hobby-tier modes only.
 */
/**
 * Local/VPS tiers (workers=1 for Oracle/Hetzner CPU limits):
 *   fast     — quick preview ~2 min, fewer pages, no hi-DPI
 *   balanced — proven 100% KCF preset (~4 min), promoted from old fast
 *   thorough — max pages + hi-DPI on critical pages only (~6–12 min)
 */
const BALANCED_PRESET = {
  label: "Balanced",
  quickScale: 0.4,
  fullScale: 2.08,
  hiScale: 3.55,
  maxPhase2Pages: 36,
  maxHiDpiPages: 5,
  maxVariantsEasy: 1,
  maxVariantsNormal: 3,
  maxVariantsHeavy: 4,
  maxHiDpiVariants: 4,
  easyPageMinConf: 85,
  easyPageMinMoney: 8,
  baselineGoodConf: 79,
  baselineGoodMoney: 6,
  earlyExitStreak: 1,
  minScoreGain: 1.75,
  skipHiDpiMinConf: 72,
  skipPhase3UnlessCritical: true,
  workers: 1,
};

/** Thorough — balanced baseline + hi-DPI on weak pages (~5–8 min). */
const THOROUGH_PRESET = {
  label: "Thorough",
  quickScale: 0.4,
  fullScale: 2.12,
  hiScale: 3.85,
  maxPhase2Pages: 40,
  maxHiDpiPages: 10,
  maxVariantsEasy: 1,
  maxVariantsNormal: 4,
  maxVariantsHeavy: 5,
  maxHiDpiVariants: 6,
  easyPageMinConf: 82,
  easyPageMinMoney: 7,
  baselineGoodConf: 76,
  baselineGoodMoney: 5,
  earlyExitStreak: 2,
  minScoreGain: 1.5,
  skipHiDpiMinConf: 0,
  skipPhase3UnlessCritical: false,
  workers: 1,
};

/** Vercel Hobby — same page set as local balanced, tuned to finish under 280s on 75pg returns. */
const VERCEL_BALANCED_PRESET = {
  ...BALANCED_PRESET,
  skipPhase1QuickScan: true,
  maxHiDpiVariants: 3,
};

const MODES = {
  fast: {
    label: "Fast",
    quickScale: 0.4,
    fullScale: 1.9,
    hiScale: 3.55,
    maxPhase2Pages: 18,
    maxHiDpiPages: 4,
    maxVariantsEasy: 0,
    maxVariantsNormal: 1,
    maxVariantsHeavy: 3,
    maxHiDpiVariants: 3,
    easyPageMinConf: 86,
    easyPageMinMoney: 8,
    baselineGoodConf: 74,
    baselineGoodMoney: 5,
    earlyExitStreak: 1,
    minScoreGain: 1.75,
    skipHiDpiMinConf: 68,
    skipPhase3UnlessCritical: true,
    skipPhase1QuickScan: true,
    useFastHeuristicPages: true,
    baselineOnly: false,
    workers: 1,
  },
  balanced: { ...BALANCED_PRESET },
  thorough: { ...THOROUGH_PRESET },
};

/** Vercel Hobby only — never merged into fast/balanced/thorough. */
const VERCEL_MODES = {
  "vercel-fast": {
    label: "Vercel Fast",
    ...MODES.fast,
    workers: 1,
  },
  /** Balanced — Vercel budget variant (26 pg, no page-skip heuristics). */
  "vercel-balanced": {
    label: "Vercel Balanced",
    ...VERCEL_BALANCED_PRESET,
    workers: 1,
  },
  /** Thorough pass 1 — more pages than scan, still no hi-DPI (benchmark: better base OCR). */
  "vercel-pass1-wide": {
    label: "Vercel Pass1 Wide",
    quickScale: 0.4,
    fullScale: 1.95,
    hiScale: 3.55,
    maxPhase2Pages: 20,
    maxHiDpiPages: 0,
    maxVariantsEasy: 0,
    maxVariantsNormal: 0,
    maxVariantsHeavy: 2,
    maxHiDpiVariants: 0,
    easyPageMinConf: 84,
    easyPageMinMoney: 8,
    baselineGoodConf: 72,
    baselineGoodMoney: 5,
    earlyExitStreak: 1,
    minScoreGain: 1.75,
    skipHiDpiMinConf: 0,
    skipPhase3: true,
    skipPhase1QuickScan: true,
    useFastHeuristicPages: true,
    baselineOnly: true,
    workers: 1,
  },
  /** Alias for pass 1 in multi-pass flows. */
  "vercel-balanced-scan": {
    label: "Vercel Balanced Scan",
    ...MODES.fast,
    quickScale: 0.4,
    fullScale: 1.88,
    hiScale: 3.55,
    maxPhase2Pages: 16,
    maxHiDpiPages: 0,
    maxVariantsEasy: 0,
    maxVariantsNormal: 0,
    maxVariantsHeavy: 2,
    maxHiDpiVariants: 0,
    easyPageMinConf: 86,
    easyPageMinMoney: 8,
    baselineGoodConf: 74,
    baselineGoodMoney: 5,
    earlyExitStreak: 1,
    minScoreGain: 1.75,
    skipHiDpiMinConf: 0,
    skipPhase3: true,
    skipPhase1QuickScan: true,
    useFastHeuristicPages: true,
    baselineOnly: true,
    workers: 1,
  },
  /** Pass 2 delta hi-DPI for Balanced UI — primary gaps only, capped pages. */
  "vercel-balanced-retry": {
    label: "Vercel Balanced Retry",
    ...MODES.fast,
    fullScale: 1.82,
    hiScale: 3.5,
    maxPhase2Pages: 4,
    maxHiDpiPages: 4,
    maxHiDpiVariants: 3,
    maxVariantsNormal: 3,
    skipHiDpiMinConf: 68,
    skipPhase3UnlessCritical: true,
    workers: 1,
  },
  /** Pass 2 delta hi-DPI for Thorough multi-pass. */
  "vercel-thorough-retry": {
    label: "Vercel Thorough Retry",
    ...MODES.fast,
    fullScale: 1.82,
    hiScale: 4.0,
    maxPhase2Pages: 6,
    maxHiDpiPages: 8,
    maxHiDpiVariants: 6,
    maxVariantsNormal: 5,
    skipHiDpiMinConf: 0,
    skipPhase3UnlessCritical: false,
    workers: 1,
  },
  /** Thorough UI — phase1 discovery + 20 pages + hi-DPI (90% on 75pg @ ~266s; 26 pages times out). */
  "vercel-thorough-full": {
    label: "Vercel Thorough Full",
    ...MODES.fast,
    fullScale: 1.95,
    maxPhase2Pages: 20,
    maxHiDpiPages: 6,
    maxHiDpiVariants: 5,
    maxVariantsNormal: 4,
    skipHiDpiMinConf: 0,
    skipPhase3UnlessCritical: false,
    workers: 1,
  },
  /** Thorough on Vercel — same budget preset as vercel-balanced. */
  "vercel-thorough": {
    label: "Vercel Thorough",
    ...VERCEL_BALANCED_PRESET,
    workers: 1,
  },
};

const ALL_MODES = { ...MODES, ...VERCEL_MODES };

function resolveOcrMode(mode) {
  const key = String(mode || process.env.FREE_OCR_MODE || "balanced").toLowerCase();
  const preset = ALL_MODES[key] || MODES.balanced;
  const resolved = { name: key in ALL_MODES ? key : "balanced", ...preset };
  if (process.env.VERCEL === "1") {
    const envWorkers = Number(process.env.FREE_OCR_WORKERS);
    resolved.workers = Number.isFinite(envWorkers) && envWorkers > 0 ? envWorkers : 1;
  }
  return resolved;
}

function capVariants(variants, max) {
  if (!max || max <= 0) return variants;
  return variants.slice(0, max);
}

/** Always include deskew/contrast; on Schedule L include schedl-* even when capping. */
function selectVariants(variants, max, { scheduleL = false, formCritical = false } = {}) {
  if (max === undefined || max === null) return variants;
  if (max <= 0) return [];
  const priority = ["auto-deskew", "contrast-sharp"];
  if (scheduleL) priority.push("schedl-bin", "schedl-sharp");
  if (formCritical) priority.push("gamma-sharp", "gamma-deskew");
  priority.push("adaptive-bin", "hi-contrast");

  const picked = [];
  const seen = new Set();
  for (const name of priority) {
    const v = variants.find((x) => x.name === name);
    if (v && !seen.has(v.name)) {
      picked.push(v);
      seen.add(v.name);
    }
  }
  for (const v of variants) {
    if (picked.length >= max) break;
    if (!seen.has(v.name)) {
      picked.push(v);
      seen.add(v.name);
    }
  }
  return picked.slice(0, max);
}

module.exports = { MODES, VERCEL_MODES, ALL_MODES, resolveOcrMode, capVariants, selectVariants };
