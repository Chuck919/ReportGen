/**
 * OCR presets. Env: FREE_OCR_MODE=fast|balanced|thorough
 *
 * Local/OVH VPS targets (single ~75pg return, workers≥2):
 *   fast     — ~1–2 min, opening pages preview only
 *   balanced — ~5 min, production accuracy (phase1 + selective hi-DPI)
 *   thorough — ≤10 min, balanced baseline + hi-DPI on weak Schedule L / Stmt pages
 */
const BALANCED_PRESET = {
  label: "Balanced",
  quickScale: 0.4,
  fullScale: 2.08,
  hiScale: 3.55,
  maxPhase2Pages: 36,
  /** When PDF exceeds this page count, phase-2 cap scales down (large returns). */
  largeDocPages: 100,
  maxPhase2PagesLarge: 28,
  maxHiDpiPages: 4,
  maxVariantsEasy: 1,
  maxVariantsNormal: 3,
  maxVariantsHeavy: 3,
  maxHiDpiVariants: 3,
  easyPageMinConf: 85,
  easyPageMinMoney: 8,
  baselineGoodConf: 79,
  baselineGoodMoney: 6,
  earlyExitStreak: 1,
  minScoreGain: 1.75,
  skipHiDpiMinConf: 74,
  skipPhase3UnlessCritical: true,
  // Keep phase1 keyword scan — skipping it regressed live holdout accuracy.
  skipPhase1QuickScan: false,
  useFastHeuristicPages: false,
  // Local machines: 2 workers keeps ~5 min balanced on typical returns; 1 worker often 8–15+ min.
  workers: 2,
};

/** Thorough — balanced baseline + hi-DPI retry on weak pages (≤10 min wall clock). */
const THOROUGH_PRESET = {
  label: "Thorough",
  quickScale: 0.4,
  fullScale: 2.12,
  hiScale: 3.85,
  maxPhase2Pages: 40,
  largeDocPages: 100,
  maxPhase2PagesLarge: 30,
  maxHiDpiPages: 8,
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
  workers: 2,
};

const MODES = {
  fast: {
    label: "Fast",
    quickScale: 0.4,
    fullScale: 1.75,
    hiScale: 3.55,
    maxPhase2Pages: 10,
    maxHiDpiPages: 0,
    maxVariantsEasy: 0,
    maxVariantsNormal: 1,
    maxVariantsHeavy: 1,
    maxHiDpiVariants: 0,
    easyPageMinConf: 86,
    easyPageMinMoney: 8,
    baselineGoodConf: 74,
    baselineGoodMoney: 5,
    earlyExitStreak: 1,
    minScoreGain: 1.75,
    skipHiDpiMinConf: 0,
    skipPhase3UnlessCritical: true,
    skipPhase1QuickScan: true,
    useFastHeuristicPages: true,
    baselineOnly: true,
    workers: 1,
  },
  balanced: { ...BALANCED_PRESET },
  thorough: { ...THOROUGH_PRESET },
};

function resolveOcrMode(mode) {
  const key = String(mode || process.env.FREE_OCR_MODE || "balanced").toLowerCase();
  const preset = MODES[key] || MODES.balanced;
  const resolved = { name: key in MODES ? key : "balanced", ...preset };
  const envWorkers = Number(process.env.FREE_OCR_WORKERS);
  if (Number.isFinite(envWorkers) && envWorkers > 0) {
    resolved.workers = envWorkers;
  }
  return resolved;
}

/** Scale phase-2 page cap down on very large PDFs (100+ pages) to hold ~5 min balanced. */
function effectivePhase2Cap(mode, totalPages, profile) {
  const base = profile === "benchmark" ? 12 : mode.maxPhase2Pages || 36;
  const largeAt = mode.largeDocPages ?? 100;
  const largeCap = mode.maxPhase2PagesLarge ?? Math.max(24, base - 8);
  if (totalPages > largeAt + 40) return Math.min(base, largeCap - 4);
  if (totalPages > largeAt) return Math.min(base, largeCap);
  return base;
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

module.exports = { MODES, ALL_MODES: MODES, resolveOcrMode, effectivePhase2Cap, capVariants, selectVariants };
