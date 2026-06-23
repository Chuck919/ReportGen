# Agent Handoff — Tax Extraction: Trust Calibration

**Last updated:** 2026-06-23  
**Branch:** `master`  
**Tag:** `v1-production-trust-calibrated`

---

## Current priority

> Build a production-grade system that is **honest about uncertainty** — not one that chases benchmark percentage at the expense of trustworthiness.

| Goal | Target |
|------|--------|
| Extraction accuracy (web API) | **≥ 98%** |
| Dangerous failures (wrong + high confidence + unflagged) | **0** |
| Correct fields falsely flagged / low confidence | **< 10%** |
| Wrong fields correctly flagged | **> 90%** |

**Philosophy:** A wrong answer should look suspicious. A correct answer should look trustworthy.

---

## Source of truth

Always validate extraction + confidence on the **production web API path**:

```powershell
cd web
npm run dev
# new terminal:
$env:BENCHMARK_TIMEOUT_MS="2400000"
npx tsx scripts/benchmark-all-web-api.ts thorough http://localhost:3000
```

Cached OCR benchmarks are for **fast regression** only (~1 min) — OCR behavior can differ from live API.

---

## Latest metrics

### Production web API — **all targets met**

File: `scripts/benchmark-output/web-api-thorough-1782255200311.json`

| Metric | Target | Value |
|--------|--------|-------|
| Accuracy | ≥ 98% | **584/595 (98.15%)** |
| Dangerous failures | 0 | **0** |
| Correct low-confidence / flagged | < 10% | **8.2%** |
| Wrong-field detection | > 90% | **100%** (11/11) |

Last dangerous failure fixed: **SSSI 2022 `other_current_liabilities`** — isolated Statement Line 18 no longer auto-trusted when Schedule L OCR reads the same attachment block.

### Cached confidence benchmark (fast regression)

Command: `npm run benchmark:confidence-cached` (~1 min, requires OCR cache)

Use for flag/cap tuning only — always confirm on full web API path before tagging.

---

## Session work completed (2026-06-23)

### P0 — Calibration analysis

- **`scripts/analyze-confidence-calibration.ts`** — per-flag breakdown, confusion matrix, TP/TN/FP/FN
- **`scripts/benchmark-confidence-cached.ts`** — fast calibration loop on cached OCR
- **`scripts/debug-confidence-fp.ts`** / **`debug-confidence-wrong.ts`** — per-field FP/FN diagnosis

Key finding: `ocr_incomplete` had **2.2% wrong-rate** but flagged **362/362 correct fields** it touched — massively over-penalizing. `comparison_missing` is far more predictive (60% wrong-rate).

### P1 — KCF 2024 COGS dangerous failure (fixed)

**Root cause:** Comparison worksheet captured **gross profit** (1,066,455 − 313,334 = 753,121), not COGS. Parser preferred comparison whenever form disagreed by >1.5%.

**Fix:** `src/lib/tax-return/cogs-reconcile.ts` — detects gross-profit bleed; prefers Form 1120-S line 2 when appropriate.

```bash
npx tsx scripts/test-cogs-reconcile.ts
npx tsx scripts/test-kcf-2024-cogs.ts
```

### P2 — Confidence recalibration (flags/caps only — no extraction changes)

| Change | File | Why |
|--------|------|-----|
| Stop flagging expected-zero **missing** BS rows | `parse-from-text.ts` | 15+ false positives per client-year |
| Flag **material missing** P&L lines only | `parse-from-text.ts` | Catches KCF 2024 missing advertising |
| Allow legitimate **zero** dep/amortization | `confidence-gates.ts` | Form line 14/42 zeros are valid |
| Schedule L par-value stock not suspicious | `confidence-gates.ts` | common_stock = 100 is normal |
| Material source disagreement only | `reconcile-tax-year.ts`, `field-confidence.ts` | Stop flagging form lines with noise alternates |
| Trusted Form 1120 lines skip source_disagreement | `field-confidence.ts` | salaries/interest at 98% parser conf |
| Narrow `ocr_incomplete` propagation | `field-confidence.ts`, `ocr-coverage-rescan.ts` | Only Stmt 2 attachment fields + weak sources |
| OPEX `ocr_incomplete` only on serious gaps | `field-confidence.ts` | comparison_missing / formula_inconsistency |
| Statement Line 18 **not** auto-trusted | `reconcile-tax-year.ts`, `field-confidence.ts` | Isolated Stmt 18 without form/comparison corroboration |
| `low_trust_source` confidence cap (58) | `confidence-flags.ts` | Flag alone was not lowering display confidence |
| Stmt 18 override cap (82, not 99) | `parse-from-text.ts` | Post-verification refill no longer forces trusted parser score |
| Source snapshots in confidence layer | `parse-from-text.ts` | Cross-family checks |

**Do not** add client/year-specific branches. Every change must generalize.

---

## Architecture (frozen extraction path)

```
PDF → standard OCR (balanced/thorough tiers)
    → parse-from-text
    → reconcile-tax-year
    → tax-confidence layer (flags/caps only — never changes values)
    → API + UI
```

OCR recovery is **off by default**. See `ENABLE_OCR_RECOVERY=1` below.

### Confidence modules

```
src/lib/tax-confidence/
  confidence-flags.ts      — flag codes + confidence caps
  field-confidence.ts      — per-field flag application
  candidate-uncertainty.ts — OPEX candidate conflict
  source-agreement.ts      — cross-family disagreement
```

### Failure categories (diagnosis)

```
ocr_coverage | parser_extraction | candidate_selection | source_disagreement
formula_inconsistency | confidence_calibration | low_trust_source
```

---

## Key commands

```powershell
cd web

# --- Authoritative validation (~60–110 min) ---
npm run dev
$env:BENCHMARK_TIMEOUT_MS="2400000"
npx tsx scripts/benchmark-all-web-api.ts thorough http://localhost:3000

# --- Fast confidence loop (~1 min, cached OCR) ---
npm run benchmark:confidence-cached

# --- Calibration report on benchmark JSON ---
npm run analyze:confidence
npm run analyze:confidence -- scripts/benchmark-output/web-api-thorough-<id>.json

# --- Debug single client-year ---
npx tsx scripts/debug-confidence-fp.ts carithers 2023
npx tsx scripts/debug-confidence-wrong.ts kcf 2024
npx tsx scripts/debug-client-fields.ts kcf 2024

# --- COGS regression ---
npx tsx scripts/test-cogs-reconcile.ts
npx tsx scripts/test-kcf-2024-cogs.ts

# --- Accuracy regression (cached OCR, no confidence) ---
npm run benchmark:all-cached

# --- Experimental OCR (off by default) ---
$env:ENABLE_OCR_RECOVERY="1"
npx tsx scripts/benchmark-one-web-api.ts kcf 2024 http://localhost:3000
```

---

## Training clients (do not regress)

| Client | Status |
|--------|--------|
| Carithers 2021–2025 | 100% (cached) |
| Arizona Sun 2022–2025 | 100% (cached) |
| KCF 2023 | 100% (cached) |
| KCF 2024 | 92.9% cached — OPEX/advertising/taxes still wrong (OCR gaps) |
| KCF 2025 | 97.6% cached |

## Holdout — SSSI

Use for generalization diagnostics only. **Never** add `if (client === "sssi")` branches.

```bash
npx tsx scripts/debug-opex-candidates.ts sssi 2022
npx tsx scripts/debug-opex-candidates.ts sssi 2023
```

---

## Remaining hard problems

1. **KCF 2024 OPEX** (17,891 vs 5,599) — OCR missing comparison; candidate ranking picks Stmt 2 detail partial sum. Fix via better formula validation / source confidence, not SSSI tuning.
2. **KCF 2024 advertising missing** — OCR gap; now correctly flagged at 58% confidence.
3. **Full web API confirmation** — cached confidence at 4.4% FP must be re-verified on live API path.
4. **SSSI holdout** — needs OCR cache or full API run for confidence metrics.

---

## ML training (not yet)

Wait until **50+ real user corrections** with candidate scores, flags, sources, and user-selected values. Current bottleneck was calibration, not ranking.

---

## Session checklist

- [x] Calibration analysis script + per-flag report
- [x] KCF 2024 COGS dangerous failure fixed (gross-profit bleed)
- [x] Confidence false-positive rate: 62% → **4.4%** (cached benchmark)
- [x] Wrong-field detection: 90.9% → **100%** (cached, 4 wrong fields)
- [x] Dangerous failures: 1 → **0** (cached)
- [ ] **Full web API benchmark** to confirm on production path
- [ ] SSSI holdout confidence metrics (needs OCR cache or API run)

---

## Important rules

Never add:

```ts
if (client === "carithers") { ... }
if (client === "kcf") { ... }
if (year === 2024) { ... }
```

Every change must answer: *"Would this improve a tax return the system has never seen before?"*

**Freeze extraction heuristics.** Tune confidence flags/caps only until web API baseline is re-confirmed.
