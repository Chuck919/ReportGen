/**
 * OCR presets. Env: FREE_OCR_MODE=fast|balanced|thorough|vercel-fast|vercel-balanced
 *
 * fast / balanced / thorough — local & VPS (100% matrix presets; do not retune for Vercel).
 * vercel-fast / vercel-balanced — separate Hobby-tier modes only.
 */
const MODES = {
  fast: {
    label: "Fast",
    quickScale: 0.4,
    fullScale: 2.08,
    hiScale: 3.55,
    maxPhase2Pages: 26,
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
    workers: 3,
  },
  balanced: {
    label: "Balanced",
    quickScale: 0.5,
    fullScale: 2.35,
    hiScale: 4.2,
    maxPhase2Pages: 30,
    maxHiDpiPages: 8,
    maxVariantsEasy: 2,
    maxVariantsNormal: 4,
    maxVariantsHeavy: 5,
    maxHiDpiVariants: 4,
    easyPageMinConf: 82,
    easyPageMinMoney: 8,
    baselineGoodConf: 78,
    baselineGoodMoney: 6,
    earlyExitStreak: 2,
    minScoreGain: 1.5,
    skipHiDpiMinConf: 72,
    workers: 2,
  },
  thorough: {
    label: "Thorough",
    quickScale: 0.55,
    fullScale: 2.35,
    hiScale: 4.65,
    maxPhase2Pages: 36,
    maxHiDpiPages: 12,
    maxVariantsEasy: 3,
    maxVariantsNormal: 6,
    maxVariantsHeavy: 8,
    maxHiDpiVariants: 6,
    easyPageMinConf: 78,
    easyPageMinMoney: 7,
    baselineGoodConf: 0,
    baselineGoodMoney: 0,
    earlyExitStreak: 3,
    minScoreGain: 1.5,
    skipHiDpiMinConf: 0,
    workers: 2,
  },
};

/** Vercel Hobby only — never merged into fast/balanced/thorough. */
const VERCEL_MODES = {
  "vercel-fast": {
    label: "Vercel Fast",
    quickScale: 0.4,
    fullScale: 1.82,
    hiScale: 3.55,
    maxPhase2Pages: 14,
    maxHiDpiPages: 0,
    maxVariantsEasy: 0,
    maxVariantsNormal: 0,
    maxVariantsHeavy: 2,
    maxHiDpiVariants: 0,
    easyPageMinConf: 88,
    easyPageMinMoney: 9,
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
  /** Same pipeline as local `fast`; workers capped to 1 on Vercel (1 vCPU). */
  "vercel-balanced": {
    label: "Vercel Balanced",
    ...MODES.fast,
    workers: 1,
  },
  /**
   * Balanced + deeper hi-DPI: higher scale, more pages/variants, lower skip threshold.
   * Slower than Balanced; use when Schedule L / attachment fields are still blank.
   */
  /**
   * Pass-2 preset for delta hi-DPI (used after a full vercel-balanced pass).
   * Each /api/ocr-pages call is a small page subset — can run deeper OCR within 300s.
   */
  "vercel-thorough": {
    label: "Vercel Thorough",
    ...MODES.fast,
    hiScale: 4.0,
    maxHiDpiPages: 10,
    maxHiDpiVariants: 6,
    maxVariantsNormal: 5,
    skipHiDpiMinConf: 0,
    skipPhase3UnlessCritical: false,
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
