# Tax Return OCR + Parser — Agent Handoff

## Mission

Build a **generic, production-grade** business tax return (Form 1120-S) OCR + parser for ReportGen.

**Done when ALL of the following are true:**

1. **Primary-field accuracy >= 95%** for each year **2023, 2024, 2025** and each OCR mode **fast, balanced, thorough** (9 cells in the 3x3 matrix).
2. **Thorough >= balanced >= fast** on primary accuracy for every year (thorough must not regress vs balanced).
3. Every resolved primary field has **confidence score + source label** in parse output (UI displays these).
4. **No company-specific hardcoding** (no KC Fudge filenames in code, no dollar thresholds tied to this company amounts).
5. Parser components remain **split and testable** independently of full OCR runs.

**Iterate until complete.** Do not stop at partial wins on one year or one mode.

---

**Also read:** `docs/FUTURE_AGENT_GUIDE.md` — Vercel limits, serverless strategy.  
**Deploy (shareable URL):** `docs/DEPLOY_ORACLE.md` — Oracle free VM + one-command deploy.

---

## Repository layout

```
ReportGen/
  Documents/                          # PDFs + Excel ground truth
  web/src/lib/tax-return/             # Parser modules (split by concern)
  web/scripts/benchmark-ocr.ts        # Single year or --all matrix
  web/scripts/eval-tax-cached.ts
  web/scripts/quick-parser-test.ts
  web/scripts/ocr-cache/{year}-{mode}.txt
  web/scripts/benchmark-matrix.json
```

---

## Ground truth

- Fixtures: `web/src/lib/workbook-comparison-fixtures.ts` keys `KCF MAIN CURRENT EXCEL.xlsx / {year}`
- Primary fields = `excelBehavior: "input"` minus `TAX_ATTACHMENT_FIELD_IDS`
- Expected zero: fixture `0` + parser `undefined` = pass

---

## Commands (from web/)

```bash
npm run benchmark:ocr:matrix                    # full 3x3 (~60-90 min)
npm run benchmark:ocr -- 2024 balanced
npx tsx scripts/quick-parser-test.ts 2024 scripts/ocr-cache/2024-balanced.txt
npm run eval:tax:refresh -- --mode balanced
npm run eval:tax:cached -- --mode balanced
npm run ocr:debug -- "<pdf>" <page> [variant]
```

---

## Current results (2026-06-12, post speed pass)

### End-to-end OCR + parse (benchmark-matrix.json)

| Year | Fast | Balanced | Thorough |
|------|------|----------|----------|
| 2023 | **100%** ~187s | **100%** ~247s | **100%** ~357s |
| 2024 | **100%** ~243s | **100%** ~255s | **100%** ~431s |
| 2025 | **100%** ~213s | **100%** ~233s | **100%** ~407s |

**DONE:** All 9 cells at **100%** primary accuracy. ~28–55% faster vs prior matrix (phase-2 tesseract was ~85% of wall time).

### Speed optimizations (2026-06-12)

- **Parallel workers** (`workers: 2` in `ocr-modes.cjs`) for phase 2/3 tesseract
- **Baseline early-exit** — skip variant passes when baseline OCR is already strong (non–Schedule L / non-statement pages)
- **Smarter phase-1 scan** — OCR only head + heuristic pages (~34) instead of all low-DPI pages
- **Tuned presets** — fewer variants, aggressive hi-DPI skip (`skipHiDpiMinConf`), lower hi-DPI page caps on fast/balanced
- **`timingMs`** in OCR JSON output + benchmark logs phase breakdown

### Recurring miss patterns

- other_current_liabilities: Schedule L line 18 OCR + Stmt 4/6 totals; Schedule K false positives
- other_assets: Stmt 4 vs line 14; fuzzy Total assets bleed
- intangibles 13a: missing amounts in OCR; hi-DPI + schedl-bin needed
- other_income: Stmt 1 detail vs summary zero; comparison/fuzzy noise
- 2023: two-year comparison worksheet often missing from OCR cache

---

## Architecture (keep split)

| Module | Role |
|--------|------|
| money.ts | Money parse, isForm1120Line, form-reference filter |
| form-anchors.ts | Form 1120-S page 1 + Schedule L anchors |
| schedule-l.ts | Schedule L, Stmt totals, intangibles |
| statement-extractors.ts | Stmt 1/2, countStatement1DetailLines |
| line-hits.ts | Fuzzy hits + structural rejection |
| parse-pipeline.ts / merge.ts | Tiered merge; form-anchors authoritative |
| parse-from-text.ts | Parser entry + post-process |
| local-ocr.ts | OCR wrapper (fast/balanced/thorough) |
| resolve-pdf.ts | Generic PDF by year |

---

## Hard rules

**Allowed:** form line numbers, see-stmt patterns, gross-profit math, OCR digit heuristics, statement header routing.

**Forbidden:** company names in parser (except fixtures), hardcoded PDF paths, company-specific dollar floors/ceilings, encoding fixture expected values in logic.

---

## Regression workflow (required each iteration)

1. quick-parser-test on all 9 ocr-cache files
2. Fix misses; grep cache; check fieldSources
3. Re-OCR only affected year/mode if OCR changed
4. npm run benchmark:ocr:matrix
5. No regressions across years/modes

---

## Priority fixes

1. Fix thorough preset (must beat balanced): ocr-modes.cjs maxVariantsHeavy, hi-DPI caps
2. Schedule L line 14 other_assets + line 18 OCL
3. Intangibles 13a: schedl-bin on critical pages even in fast
4. Force Two Year Comparison pages into OCR phase-2
5. Other income: Stmt1 multi-line zero vs 2025 comparison value
6. Per-field confidence + source for every primary field

---

## OneDrive UTF-16 hazard

StrReplace/Write can corrupt .ts to UTF-16. Fix with PowerShell UTF8Encoding(false) or verify before benchmark.

---

## Iteration loop

```
WHILE any matrix cell < 95% OR thorough < balanced:
  parser-test all 9 caches -> fix -> regression -> re-OCR if needed -> full matrix
```

Transcript: agent-transcripts/03905d5d-5bd9-460b-9a0a-257ba08ac375.jsonl