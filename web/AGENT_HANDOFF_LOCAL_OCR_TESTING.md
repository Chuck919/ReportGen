# Agent Handoff — Local OCR Testing (fast vs balanced vs thorough)

**Copy this entire doc into the next agent session.**

Also read: `AGENT_HANDOFF_CHANGES_SUMMARY.md`, `scripts/BENCHMARK_PROGRESSIVE_RESULTS.md`, `docs/KNOWN_ACCURACY.md`, `scripts/ocr-modes.cjs`

---

## Mission

1. **Prove which local/VPS mode is best** on diverse 1120-S returns — not only KCF fixtures.
2. **Explain why `fast` sometimes beats `balanced`/`thorough`** on a single cold run when presets are “more accurate.”
3. **Recommend final VPS mode lineup** (Oracle/Hetzner) with evidence — target: **`thorough` wins on median accuracy** across a **holdout set**, not just KCF.
4. **Do not change Vercel presets** unless asked; focus on local `fast` / `balanced` / `thorough` in `MODES` (not `VERCEL_MODES`).

**Iterate until:** multi-run benchmarks show sensible tier ordering (`thorough` ≥ `balanced` ≥ `fast` on **median** primary %) on **KCF + at least 2 holdout returns** you did not tune presets on.

---

## Generalization policy (do not overfit KCF)

KCF 2023/2024/2025 are **regression fixtures only** — good for catching regressions, bad as the only tuning target.

| Layer | Overfit risk | Why |
|-------|--------------|-----|
| **Parser** (`parse-from-text`, form anchors) | Low if form-generic | Uses 1120-S / Schedule L / statement patterns, not KCF names or dollar amounts |
| **Page discovery** (`ocr-targets.cjs`) | Low | Heuristics scale with page count (% of doc, head/tail); keyword phase-1 for form labels |
| **Local `fast`/`balanced`/`thorough`** | Medium | Presets are **capability tiers** (pages, hi-DPI depth, workers) — stable since matrix work; re-validate on holdouts |
| **`vercel-*` presets** | **High** | Capped pages/workers/timeout tuned on KCF cold prod runs — expect **lower accuracy on other firms’ scans** |

**Rules for preset changes:**

1. **Never tune on KCF alone** — use KCF for regression; tune on a **holdout corpus** (other LLCs, different preparers, 30–100 pg scans).
2. **Modes = capabilities, not scores** — Fast = fewer pages / skip heavy hi-DPI; Balanced = standard full pass; Thorough = max hi-DPI + more pages. Order should hold on **median** across uploads, not every single PDF.
3. **No fixture values in code** — forbidden per `AGENT_HANDOFF_TAX_OCR.md` (no KCF dollar thresholds in parser).
4. **If holdout lags KCF** — prefer **broader** local presets on VPS (full `balanced`/`thorough`) over shrinking Vercel caps further.
5. **Collect real failures** — anonymized OCR caches from user misses > another round of KCF-only grid search.

**Holdout corpus (agent must add):**

- At least **2 other Form 1120-S** PDFs (different entity, scanner, page count).
- Ground truth: manual Excel or labeled field sheet per return (add to `workbook-comparison-fixtures.ts` with neutral keys, e.g. `holdout-acme-2024`).
- Run matrix on holdouts **before** merging any preset change.

**Production recommendation until holdouts exist:**

- **Vercel:** treat as **preview tier** (Fast/Balanced) — not guaranteed production accuracy for arbitrary uploads.
- **Oracle/VPS:** ship **local tiers unchanged**; they optimize for **generic** deep OCR, not KCF-specific caps.

---

## Why “fast” beat “balanced/thorough” (2024 cold run, 2026-06-15)

Single-run results on the **75-page 2024 PDF**:

| Mode | Primary | Time | Pages OCR’d |
|------|---------|------|-------------|
| `fast` | **100%** (20/20) | 177s | 26 |
| `balanced` | 80% (16/20) | 500s | 30 |
| `thorough` | 80% (16/20) | 708s | 34 |

**Same misses on balanced/thorough:** `advertising` (got 116), `rent` (got 111), `notes_minus_short_term`, `unclassified_equity`.

### Hypotheses (test these)

1. **Tesseract non-determinism** — One run is not representative. Historical `scripts/benchmark-matrix.json` (2026-06-12) shows **100% for all three modes** on all years. Need **N repeated cold runs** per mode.

2. **More pages ≠ better text** — `balanced` scans 30 pages, `thorough` up to 36 + more hi-DPI. Extra low-quality pages add **garbage tokens** (`116`, `111`) that confuse label matching and tail scans. `fast` caps phase-2 at 26 pages with `skipPhase3UnlessCritical: true` (only critical pages get hi-DPI).

3. **Variant selection** — `balanced`/`thorough` try more image variants (`maxVariantsNormal` 4–6 vs `fast` 3). A wrong variant can “win” on confidence score but produce worse digits.

4. **Parser reads combined OCR blob** — All pages merge into one text block. Bad OCR from page 47 can affect regexes that scan the full document (not per-page isolation).

5. **Not a preset misconfiguration** — Local presets are intentional (`ocr-modes.cjs` header: “100% matrix presets; do not retune for Vercel”). Problem may be **scoring/variant logic** in `scripts/free-ocr.cjs`, not page count alone.

6. **Environment timeout** — If `VERCEL=1` is set in the shell, local OCR uses **280s timeout** and may SIGTERM mid-run. Always unset before local benchmarks:

   ```powershell
   $env:VERCEL=''
   $env:FREE_OCR_TIMEOUT_MS='1200000'
   ```

---

## Preset differences (local modes, 2026-06-15 restructure)

From `scripts/ocr-modes.cjs` → `MODES` (all **workers: 1** for Oracle/Hetzner):

| Setting | `fast` (quick) | `balanced` (default) | `thorough` |
|---------|----------------|----------------------|------------|
| Intent | ~2 min preview | ~4 min, 100% KCF target | ~6–12 min max depth |
| maxPhase2Pages | 18 | 26 | 36 |
| maxHiDpiPages | 0 | 5 | 12 |
| maxVariantsNormal | 2 | 3 | 4 |
| skipPhase3 / skipPhase3UnlessCritical | skipPhase3 | skipPhase3UnlessCritical | skipPhase3UnlessCritical |
| minScoreGain | 1.75 | 1.75 | 2.0 |

**2026-06-15 fix:** `balanced` promoted from old `fast` (proven 100% on KCF). New `fast` is lighter preview. Root cause of regression: variant OCR corrupted line numbers (`111 Rents`, `116 Advertising`) — fixed in `free-ocr.cjs`.

**Expected behavior:** `thorough` ≥ `balanced` ≥ `fast` on **median** primary % across holdouts. `fast` is fastest, not most accurate.

---

## Test fixtures

| Asset | Path |
|-------|------|
| 2023 return | `Documents/KC Fudge LLC_2023 Business Tax Return_2023-12-31.pdf` (78 pg) |
| 2024 return | `Documents/KC Fudge LLC_2024 Business Tax Return_2024-12-31.pdf` (**75 pg**) |
| 2025 return | `Documents/KC Fudge LLC_2025 Business Tax Return_2025-12-31.pdf` (56 pg) |
| Expected values | `src/lib/workbook-comparison-fixtures.ts` → `KCF MAIN CURRENT EXCEL.xlsx / {year}` |

**Primary field scoring:** same as `scripts/benchmark-ocr.ts` — excludes attachment-only IDs, 1% numeric tolerance.

---

## Commands (run from `web/`)

### Single cold run (one mode, one year)

```powershell
cd "c:\Users\chang\OneDrive\Desktop\Blue Folder\saas\ReportGen\web"
$env:VERCEL=''
$env:FREE_OCR_TIMEOUT_MS='1200000'
npx tsx scripts/benchmark-ocr.ts 2024 fast
npx tsx scripts/benchmark-ocr.ts 2024 balanced
npx tsx scripts/benchmark-ocr.ts 2024 thorough
```

OCR text saved to `scripts/ocr-cache/{year}-{mode}.txt` — **delete cache files before each cold run** or use fresh filenames.

### Full matrix (3 years × 3 modes, ~30–90 min)

```powershell
$env:VERCEL=''; $env:FREE_OCR_TIMEOUT_MS='1200000'
npm run benchmark:ocr:matrix
# Output: scripts/benchmark-matrix.json
```

**Note:** Matrix failed once when `VERCEL` was set (SIGTERM @ ~300s on 2023 `fast`). Always unset `VERCEL`.

### Parse-only on existing OCR (isolates parser vs OCR)

```powershell
npm run eval:tax:cached
# Uses scripts/ocr-cache/{year}-balanced.txt by default; set mode via -- --mode fast
```

If cached text parses at 100% but fresh OCR does not → **OCR problem**, not parser.

### Compare OCR text between modes (same year)

After three runs on 2024:

```powershell
# Diff caches — look for garbage on balanced/thorough pages not in fast
fc scripts\ocr-cache\2024-fast.txt scripts\ocr-cache\2024-balanced.txt
```

Search for missed field labels: `rent`, `Advertising`, `Notes`, line 20 Schedule L.

---

### Recommended multi-run benchmark

```powershell
npm run benchmark:ocr:repeated -- --year 2024 --runs 5
npm run benchmark:ocr:repeated -- --year 2024 --mode thorough --runs 5
```

Script: `scripts/benchmark-ocr-repeated.ts` — deletes cache each run, outputs median/mean/std to `scripts/benchmark-repeated-{year}.json`.

---

## Investigation checklist

- [ ] Run **5 cold runs** each for fast/balanced/thorough on **2024**; tabulate median primary %
- [ ] Run same on 2023 and 2025
- [ ] For a “bad” balanced run, run `eval:tax:cached` on that cache — confirm parser score matches
- [ ] Compare `ocr-cache/2024-fast.txt` vs `2024-balanced.txt` around missed fields
- [ ] Read `free-ocr.cjs` variant scoring when `advertising` → `116`, `rent` → `111` (partial line?)
- [ ] Check if `skipPhase3UnlessCritical` on fast avoids bad hi-DPI that balanced/thorough apply
- [ ] Test `FREE_OCR_WORKERS=1` vs `3` on fast (variance vs speed)
- [ ] Document whether **dual-run pick-best-parse** is needed for production

---

## Known reference results

| Source | fast 2024 | balanced 2024 | thorough 2024 |
|--------|-----------|---------------|---------------|
| `benchmark-matrix.json` (2026-06-12) | 100% / 243s | 100% / 255s | 100% / 431s |
| Cold run (2026-06-15) | **100% / 177s** | 80% / 500s | 80% / 708s |
| Vercel prod cold iter2 | 70% / 114s (`vercel-fast`) | 75% / 161s | 85% / 178s (`vercel-thorough`) |

---

## If thorough still loses after 5 runs

Consider (benchmark before changing defaults):

1. **Tighten variant selection** — require `minScoreGain` before replacing baseline OCR on a page
2. **Page quality filter** — drop phase-2 pages below confidence threshold from merged text
3. **Field-targeted hi-DPI** — thorough hi-DPI only on Schedule L / statement pages (like gap-analysis hints)
4. **Production strategy:** run `fast` then re-run `thorough` only if primary fields missing (VPS has time for 2-pass)

---

## Files to touch (if fixing root cause)

| File | Purpose |
|------|---------|
| `scripts/ocr-modes.cjs` | Local presets only — document any change with benchmark |
| `scripts/free-ocr.cjs` | Variant scoring, phase 2/3 logic |
| `scripts/benchmark-ocr.ts` | Single-run benchmark |
| `scripts/eval-tax-cached.ts` | Parser-only eval |
| `src/lib/tax-return/parse-from-text.ts` | Parser (only if OCR text is good) |

---

## Do not

- Retune `VERCEL_MODES` while working this mission
- Trust a **single** OCR run to rank modes
- Commit secrets or `.env.production` with real keys
- Assume 100% is guaranteed — document variance bands instead
