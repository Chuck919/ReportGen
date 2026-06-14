# Agent Handoff — Vercel OCR, Progressive Pipeline, UI Split

**Copy this entire doc into the next agent session.** Goal: iterate until OCR pipeline + Vercel deploy are production-ready; preserve component/code guidelines.

Also read: `AGENT_HANDOFF_TAX_OCR.md`, `docs/DEPLOY_ORACLE.md`, `scripts/BENCHMARK_PROGRESSIVE_RESULTS.md`

---

## Mission (still open)

1. **Primary-field accuracy ≥ 95%** on 2023/2024/2025 for deploy targets (Vercel: `vercel-balanced`; VPS: `fast`/`balanced`/`thorough`).
2. **Each Vercel API call < 300s** (Hobby `maxDuration`).
3. **No company-specific hardcoding** in parser/OCR.
4. **Split, testable modules** — parser independent of full OCR runs.
5. **UI separate from backend** — thin routes, components under `src/components/`, API client under `src/lib/api/`.

**Iterate until complete.** Re-run benchmarks after every OCR/parser change.

---

## Vercel “workers” — important clarification

**Vercel Hobby does NOT give you 2 CPUs.** Each serverless invocation gets **~1 vCPU**, **2 GB RAM**, **300s max**.

`workers: 2` in `scripts/ocr-modes.cjs` is **NOT** Vercel concurrency. It means **parallel Tesseract.js worker instances inside the same Node process** (`processPagesParallel` in `free-ocr.cjs` → `FREE_OCR_WORKERS`).

| Setting | Meaning |
|---------|---------|
| `workers: 3` (local `fast`) | 3 Tesseract workers in one process on multi-core machine |
| `workers: 2` (`vercel-balanced` today) | 2 Tesseract workers on **same 1 vCPU** — may help overlap I/O vs CPU, or may **OOM / contend** |
| `workers: 1` | Safer for Vercel memory; was original Vercel default |

**Recommended fix for next agent:** On Vercel, force `FREE_OCR_WORKERS=1` when `VERCEL=1` (in `local-ocr.ts` env or `resolveOcrMode`), **unless** benchmark proves workers:2 is consistently faster *and* under memory limit on deployed Hobby. Do not assume 2 workers = 2 Vercel CPUs.

---

## Architecture summary (current state)

### OCR modes (`scripts/ocr-modes.cjs`)

| Mode | Where | Notes |
|------|-------|-------|
| `fast` / `balanced` / `thorough` | Local / VPS | **100% matrix presets — do not retune for Vercel** |
| `vercel-fast` | Vercel UI “Fast” | 14 heuristic pages, skip phase-1/3, ~1 min preview |
| `vercel-balanced` | Vercel UI “Balanced” | Clone of local `fast` preset, `workers: 2` (see above) |
| `vercel-thorough` | Vercel UI “Thorough” | Clone of local `thorough`, `workers: 2` |

UI mode labels: `src/lib/tax/ocr-modes.ts` (`LOCAL_OCR_MODE_OPTIONS` vs `VERCEL_OCR_MODE_OPTIONS`, `NEXT_PUBLIC_VERCEL`).

### OCR pipeline (`scripts/free-ocr.cjs`)

- Phase 1: quick-scan pages for keywords (skipped on `vercel-fast`)
- Phase 2: full-res OCR on target pages (bulk of time)
- Phase 3: hi-DPI on Schedule L / attachments
- `FREE_OCR_FORCE_PAGES` — OCR only listed pages (batched API)
- `FREE_OCR_FORCE_PHASE3=1` — allow phase 3 even on forced-page batches
- Shared planning: `scripts/ocr-targets.cjs`, `scripts/ocr-plan.cjs`

### API routes

| Route | Purpose |
|-------|---------|
| `POST /api/parse-tax-return` | Main: PDF → embedded text + OCR → parse |
| `POST /api/ocr-plan` | Page target list (full or delta) |
| `POST /api/ocr-pages` | OCR subset of pages (`forcePhase3` optional) |
| `POST /api/ocr-run` | Full single-pass OCR for one mode |

`maxDuration = 300` on OCR/parse routes; `vercel.json` aligned.

### Client upload flow (`src/lib/api/parse-tax-return.ts`)

- **`shouldUseProgressiveOcr()` returns `false`** — all modes use **single** `POST /api/parse-tax-return` (no preview+delta in production).
- Progressive code kept in `progressive-ocr.ts`, `progressive-ocr-core.ts` for CLI experiments only.
- Field merge on re-upload: `src/lib/tax/merge-years.ts` (confidence-based per field).
- Persistence: `src/lib/tax/session-storage.ts` (localStorage + sessionStorage).

### Parser (split modules — do not monolith)

```
src/lib/tax-return/
  parse-from-text.ts      # entry: embedded + OCR text → TaxYearValues
  parse-pipeline.ts
  form-anchors.ts         # authoritative form line values
  schedule-l.ts
  statement-extractors.ts
  line-hits.ts            # fuzzy OCR label matching
  merge.ts                # field-level merge helpers
  infer-year.ts
  local-ocr.ts            # subprocess wrapper for free-ocr.cjs
  resolve-pdf.ts
src/lib/tax-return-parser.ts  # orchestration, embedded-text fast path
```

### UI (componentized — keep thin routes)

```
src/app/*/page.tsx              # thin wrappers only
src/components/ui/              # Button, Card, FileDropzone, ProgressBar, …
src/components/home/            # HomePage, Hero, WorkflowDemo, …
src/components/tax/             # TaxPage, TaxUploadPanel, TaxWorkbookTable, …
src/components/benchmark/
src/lib/api/                    # parse-tax-return.ts, types.ts, batched-ocr.ts
src/lib/tax/                    # ocr-modes.ts, merge-years.ts, gap-analysis.ts
```

**Rules:** Components must not import `free-ocr.cjs` or spawn OCR. Use `src/lib/api/*` fetch clients only.

---

## What was tried (progressive / batching)

### 1. Blind page batching (7 pages per request)
- **Pro:** Each request < 5 min.
- **Con:** Client re-uploads full PDF every batch; total work ≥ single pass.

### 2. Progressive: fast preview → full rescan on tier 2
- **Pro:** Same accuracy as single pass when tier 2 runs.
- **Con:** ~25% slower (wasted ~80s preview before full OCR).

### 3. Progressive: fast preview → delta pages only (no rescan)
- **Pro:** Fewer pages OCR’d in theory.
- **Con:** **75% accuracy on 2024** (worse than 95%). Delta batches skip phase-1 discovery; tier-1 bad text on untouched pages poisons parser; merging page blocks is fragile.

### 4. Current production choice
- **Single full OCR per mode** on Vercel Balanced/Thorough.
- `vercel-fast` remains 14-page preview only.

---

## Benchmark results (fresh runs, 2026-06-14)

Ground truth: `workbook-comparison-fixtures.ts` (KCF MAIN CURRENT EXCEL / year).  
PDFs: `ReportGen/Documents/KC Fudge LLC_{year} Business Tax Return_*.pdf`

### Historical matrix (2026-06-12, cached OCR — may be stale)

| Year | fast | balanced | thorough |
|------|------|----------|----------|
| 2023 | 100% ~187s | 100% ~247s | 100% ~357s |
| 2024 | 100% ~243s | 100% ~255s | 100% ~431s |
| 2025 | 100% ~213s | 100% ~233s | 100% ~407s |

### Fresh runs (2026-06-14 — Tesseract variance matters)

| Year | local `fast` | `vercel-balanced` workers:2 | Notes |
|------|-------------|----------------------------|-------|
| 2024 | 95% ~158s | 95% ~136s | Same miss: `cogs` (exp 313334, got 2) |
| 2025 | **85.7%** ~137s | **85.7%** ~149s | Same misses: `sales`, `other_income`, `notes_minus_short_term` |

**Key insight:** 2025 “100%” regression is **not Vercel-specific** — fresh local `fast` also gets 85.7%. OCR output is non-deterministic on scanned PDFs.

### Progressive (retired for prod)

| Year | progressive vercel-balanced | vs single |
|------|----------------------------|-----------|
| 2023 | 100% ~262s (preview+delta/full) | tier 2 helped |
| 2024 | 95% full fallback ~280s; delta-only **75%** | slower or worse |
| 2025 | 85.7% | same as single |

Commands:
```bash
cd web
npm run benchmark:ocr:matrix          # local 3x3 (~60-90 min)
npm run benchmark:progressive:all       # progressive experiment
npx tsx scripts/benchmark-ocr.ts 2024 vercel-balanced
npm run eval:tax:cached -- --mode balanced
npm run eval:tax:refresh -- --mode balanced
```

---

## Open issues / fixes needed (prioritized)

### P0 — Accuracy
- [ ] **2024 `cogs`**: OCR reads `2` instead of `313334` — investigate page/variant (form line 2 vs COGS attachment).
- [ ] **2025 primary misses** (`sales`, `other_income`, `notes_minus_short_term`) — reproduce with `npm run eval:tax:refresh`; compare `scripts/ocr-cache/{year}-fast.txt` good vs bad runs.
- [ ] **Tesseract variance** — document that matrix 100% may require cache from a good run or multiple retries; consider deterministic seeding if possible.
- [ ] Re-run full `npm run benchmark:ocr:matrix` and update `benchmark-matrix.json` with fresh numbers.

### P0 — Vercel deploy
- [ ] **Set `workers: 1` on Vercel** via env (`FREE_OCR_WORKERS=1` when `VERCEL=1`) unless prod benchmarks justify workers:2 without OOM.
- [ ] Smoke test on deployed Hobby: `vercel-fast` < 300s, `vercel-balanced` < 300s.
- [ ] Confirm `serverExternalPackages` / bundle size for `tesseract.js` + `pdf-parse` in `next.config.mjs`.

### P1 — Progressive / batching (optional future)
- [ ] If revisiting delta OCR: must run **phase-1 on full doc once** (cheap), store page map, then batch only **new** pages at tier 2+ with phase 3 — never merge bad tier-1 text for pages not re-OCR’d.
- [ ] Or: external OCR queue (Supabase job + Oracle VM worker) — see `docs/DEPLOY_ORACLE.md`.

### P1 — Code health
- [ ] **OneDrive UTF-16 corruption**: Cursor `StrReplace` on `.ts` files can corrupt to UTF-16 → build fails. Fix: Node `fs.writeFileSync(path, content, 'utf8')` or scan `b[1]===0`. Never commit UTF-16 `.ts`.
- [ ] **`docs/FUTURE_AGENT_GUIDE.md` corrupted** (UTF-16/garbled) — rewrite from this handoff + `AGENT_HANDOFF_TAX_OCR.md`.
- [ ] Remove or gate dead code: `progressive-ocr.ts` client path disabled; `fetchFullOcr` unused; CLI-only `progressive-ocr-core.ts`.
- [ ] `batched-ocr.ts` `shouldUseBatchedOcr` stale — align with `shouldUseProgressiveOcr`.

### P2 — UX
- [ ] Show tier/progress only if progressive re-enabled.
- [ ] Warn when `vercel-fast` used: incomplete coverage by design.
- [ ] Oracle deploy path for users who need local 100% modes on a URL (`docs/DEPLOY_ORACLE.md`, `push-to-vm.ps1`).

### P2 — Full form extraction (do NOT implement yet)
- See original `FUTURE_AGENT_GUIDE.md` Section 5 — structured 1120-S JSON, Supabase, etc. Out of scope until workbook OCR stable.

---

## Coding guidelines (enforce)

1. **Minimize scope** — smallest correct diff; don’t retune local `fast`/`balanced`/`thorough` for Vercel.
2. **Never merge Vercel tuning into local presets** — separate `VERCEL_MODES` in `ocr-modes.cjs`.
3. **Parser vs OCR** — parser changes testable via `quick-parser-test.ts` + cached `ocr-cache/*.txt` without re-OCR.
4. **No hardcoding** — no KC Fudge filenames in code; use `resolveTaxReturnPdf(docsDir, year)`.
5. **Comments** — only non-obvious business logic.
6. **Tests** — matrix + `eval:tax:cached` after OCR changes; `npm run build` before done.
7. **UI** — new features = new component under `components/`; API = `lib/api/`; no OCR in components.
8. **Git** — don’t commit unless user asks; never commit `.env`, credentials.

---

## Key files reference

| File | Role |
|------|------|
| `scripts/ocr-modes.cjs` | All OCR presets |
| `scripts/free-ocr.cjs` | OCR pipeline |
| `scripts/ocr-targets.cjs` | Page planning, delta, missing-field hints |
| `scripts/benchmark-ocr.ts` | Accuracy + speed matrix |
| `scripts/benchmark-progressive-ocr.ts` | Progressive experiments |
| `src/lib/tax-return-parser.ts` | Parse entry, embedded skip |
| `src/lib/tax/gap-analysis.ts` | Missing fields for tier gating |
| `src/lib/tax/merge-years.ts` | Year column + confidence merge |
| `src/lib/api/parse-tax-return.ts` | Client upload orchestration |
| `src/components/tax/TaxPage.tsx` | Main tax UI |
| `vercel.json` / `next.config.mjs` | Deploy limits |

---

## Suggested next-agent iteration loop

1. Fix Vercel workers → `FREE_OCR_WORKERS=1` when `VERCEL=1`; benchmark on 2024/2025.
2. Debug 2024 `cogs` + 2025 misses with `ocr:debug` and parser logs.
3. Refresh `benchmark-matrix.json`; compare to fixtures.
4. Deploy smoke test on Vercel Hobby.
5. Rewrite corrupted `FUTURE_AGENT_GUIDE.md`.
6. If still < 95% on Vercel: document Oracle path OR async OCR worker — don’t chase delta-merge without phase-1.

---

## Definition of done (this workstream)

- [ ] `vercel-balanced` ≥ 95% primary on 2023/2024/2025 **or** documented why not + Oracle alternative
- [ ] Every Vercel OCR request < 300s on Hobby
- [ ] `workers` policy documented and enforced for 1 vCPU
- [ ] `npm run build` clean
- [ ] Handoff docs accurate (this file + benchmark results)
- [ ] No progressive regression in prod (single-pass default)
