# Agent Handoff — Tax Extraction: Baseline Recovery & Confidence-First Strategy

**Last updated:** 2026-06-23  
**Branch:** `revert-ocr-rescan`

---

## Strategic reset

We hit a classic failure mode: **optimized observability and added OCR recovery heuristics before freezing the stable extraction baseline**. OCR rescan changed the text corpus entering the parser and caused regressions (KCF 2023: 100% → 90.5%, aggregate ~98% → 96.3%).

**Two goals were incorrectly merged:**

| Goal | Status | Action |
|------|--------|--------|
| **A — Confidence calibration** | Good — did not change extracted values | **Keep** `src/lib/tax-confidence/`, UI hints, benchmark calibration |
| **B — OCR recovery** | Bad — changed extraction behavior | **Disable by default**; experiment behind flag only |

---

## Golden baseline (target to restore)

Web API run 1 (`web-api-thorough-1782169670043.json`) — **before aggressive OCR rescan:**

| Client | Result |
|--------|--------|
| Carithers 2021–2025 | 100% |
| Arizona 2022–2025 | 100% |
| KCF 2023 | 100% |
| KCF 2024 | 95.2% |
| KCF 2025 | 97.6% |
| SSSI 2022–2024 | 94.9–97.4% |

~**98%+ aggregate**. Main known gaps: KCF OCR missing pages, SSSI OPEX candidate ambiguity.

**Regressed run** (`web-api-thorough-1782178498814.json`): 96.3%, 22 wrong fields — do not treat as baseline.

---

## Phase 0 — Baseline recovery (this branch)

### Reverted / disabled

- `ocr-targets.cjs` → committed baseline (no expanded page targeting)
- `rescanMissingAttachments()` → **removed from default path**
- Aggressive OCR recovery → moved to `src/lib/tax/ocr-recovery-experimental.ts`

### Kept

- `src/lib/tax-confidence/` — flags, caps, candidate conflict, calibration
- `scripts/lib/tax-benchmark-confidence.ts` — P0/P1 metrics
- UI: `FieldConfidenceHint`, review highlighting, correction metadata
- `ocr-coverage-rescan.ts` — `STMT_ATTACHMENT_FIELD_IDS` + `probeOcrCoverageGaps()` for **diagnostics only**

### Experimental OCR recovery (off by default)

```powershell
# Only for controlled A/B — never in production default
$env:ENABLE_OCR_RECOVERY="1"
npm run dev
```

Workflow:

```
normal OCR → benchmark          # baseline
normal OCR + ENABLE_OCR_RECOVERY=1 → compare delta   # experiment
```

Merge OCR changes only if: **improves KCF AND does not regress Carithers/Arizona**.

---

## Phase 1 — Confidence as first-class metric

Track on every benchmark:

```
accuracy
wrong field count
dangerous errors (wrong + high confidence + unflagged)
failure detection rate
false warning rate (correct fields flagged)
```

**Production success targets:**

```
Accuracy >= 98%
Wrong fields flagged > 90%
Dangerous wrong values = 0
```

A 97% parser that says "I am unsure" beats a 99% parser that confidently hallucinates.

### Calibration report buckets

```
correct_high_confidence
correct_low_confidence
wrong_high_confidence   ← dangerous
wrong_low_confidence    ← acceptable uncertainty
```

Tune **confidence caps only** — do not change extraction until baseline is frozen.

---

## Phase 2 — Controlled OCR experiments

- No default-path OCR changes
- Use `ENABLE_OCR_RECOVERY=1` + per-client web API benchmarks
- Compare against golden JSON before merging

---

## Phase 3 — ML (ranking + calibration, not OCR)

Start with benchmark misses + fixtures as labels (don't wait for 50 user corrections to experiment).

1. **Candidate ranking model** — closure/evidence/consistency scores, source type, OCR flags, candidate disagreement → P(correct)
2. **Confidence calibration model** — chosen confidence, score gap, flags, source → P(value correct)

---

## Architecture (frozen extraction path)

```
PDF → standard OCR (balanced/thorough tiers)
    → parse-from-text (unchanged heuristics)
    → reconcile-tax-year
    → tax-confidence layer (flags/caps only)
    → API + UI
```

OCR recovery is a **side branch**, not part of this path unless explicitly enabled.

---

## Key commands

```powershell
cd web
git checkout revert-ocr-rescan

# Verify baseline (~60–110 min) — NO ENABLE_OCR_RECOVERY
taskkill /F /IM node.exe
npm run dev
$env:BENCHMARK_TIMEOUT_MS="2400000"
npx tsx scripts/benchmark-all-web-api.ts thorough http://localhost:3000

# Fast regression (~1 min, training set)
npm run benchmark:all-cached

# Experimental OCR A/B
$env:ENABLE_OCR_RECOVERY="1"
npx tsx scripts/benchmark-one-web-api.ts kcf 2024 http://localhost:3000
```

---

## 48-hour roadmap

### Day 1 (must do)

1. Verify 15/15 web API benchmark on `revert-ocr-rescan` matches golden baseline (~98%)
2. Generate calibration bucket report; tune caps only
3. Target: 0 dangerous failures

### Day 2

1. Controlled OCR experiments (`ENABLE_OCR_RECOVERY=1`) on KCF only
2. Begin ML calibration training on benchmark labels

---

## Session checklist

- [x] Identify regression source (OCR rescan + expanded page targeting)
- [x] Branch `revert-ocr-rescan`
- [x] Disable default OCR recovery; move to experimental module
- [x] Revert `ocr-targets.cjs` to committed baseline
- [x] Keep confidence infrastructure
- [ ] **Verify web API baseline recovery** (15/15, ~98%)
- [ ] Raise failure detection >90% via confidence caps only
- [ ] Dangerous failures → 0

---

## Important note

Before the regression, the system was close to production: ~98% parsing, strong holdout generalization, candidate ranking, correction loop, and confidence infrastructure. **Freeze extraction. Make confidence calibration the main metric. Use ML for ranking/calibration before touching OCR again.**
