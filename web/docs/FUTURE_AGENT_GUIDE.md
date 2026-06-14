# ReportGen — Future Agent Guide

**Purpose:** Handoff for the next agent. Covers **Vercel Hobby hosting**, **serverless-friendly speed work**, **full tax-form extraction roadmap** (do not implement yet), and **coding guidelines**.

**Related:** `web/AGENT_HANDOFF_TAX_OCR.md` (OCR matrix, benchmarks).

**Do not implement** Section 5 until explicitly requested.

---

## 1. Vercel Hobby (free) — CPU and time limits

You **will** be constrained on the free tier — by **duration**, **1 vCPU**, **memory**, **bundle size**, and **monthly CPU quota**.

| Constraint | Hobby limit | Impact |
|------------|-------------|--------|
| Max function duration | **300s (5 min)** | Balanced/thorough OCR often **4–7 min** locally → **timeouts** unless tuned or split |
| CPU | **~1 vCPU** (fixed) | Parallel Tesseract workers **do not add cores**; they fight for CPU + RAM |
| Memory | **2 GB** | Multiple workers + large page images → **OOM risk** |
| Active CPU | **4 CPU-hrs / month** | Long OCR runs burn quota quickly |
| Bundle | **250 MB** gzip | tesseract.js + pdf-parse + canvas — verify deploy |

Docs: https://vercel.com/docs/functions/limitations , https://vercel.com/docs/plans/hobby

### Current flow (problem on Hobby)

`POST /api/parse-tax-return` → synchronous `runLocalOcr()` → `free-ocr.cjs` → Tesseract on up to 26–36 pages.

- **Fast** (~2 min local) may fit 300s if embedded text is good.
- **Balanced/thorough** often **exceeds 300s**.
- **`workers: 3` (fast)** helps on multi-core **local** machines only. On Vercel use **`FREE_OCR_WORKERS=1`** (auto when `VERCEL=1`).

### Hosting recommendations

1. **Vercel for UI** + fast path when PDF has embedded text (skip OCR).
2. **Document limits** in UI: Hobby 5-min cap; suggest Fast for scans.
3. **Medium term:** async OCR (Supabase job + worker on Railway/Fly/home) with cached text by PDF hash.
4. **Long term:** client WASM preview; or Pro plan (800s max).

---

## 2. Speed — serverless-friendly priorities

**Deprioritize on Vercel:** multi-worker OCR, max hi-DPI everywhere, heavy preprocess on every page.

**Prioritize:**

| Tier | Technique | Where |
|------|-----------|--------|
| A | Embedded text → skip OCR when enough hits | API route + parser |
| A | Single worker (`VERCEL=1` → 1 worker) | `free-ocr.cjs` |
| A | Lower page caps per mode | `ocr-modes.cjs` |
| A | Baseline early-exit, critical-only hi-DPI | `free-ocr.cjs` |
| A | `maxDuration = 300` on API routes | `route.ts`, `vercel.json` |
| B | **Paged OCR** — batch pages across requests | New `/api/ocr-batch` (future) |
| B | Client merges OCR text → parse-only call | `lib/api` |
| C | Cache OCR by PDF SHA-256 | Supabase Storage (future) |
| C | Parser-only regression on `ocr-cache/` | scripts |

After OCR changes: `npm run benchmark:ocr:matrix` (local) + `quick-parser-test` on all 9 caches.

**Vercel smoke test (add later):** `VERCEL=1 FREE_OCR_WORKERS=1` fast mode must finish < 280s or show clear error.

---

## 3. UI / architecture — keep UI off workers

```
src/app/              Thin routes only
src/components/       ui/, layout/, home/, tax/, benchmark/
src/lib/api/          fetch clients ONLY (no OCR imports)
src/lib/tax-return/   Server parser (API routes only)
src/lib/tax/          Client-safe labels/helpers
src/hooks/
```

**Never** import `local-ocr`, `tax-return-parser`, `tesseract`, or `free-ocr.cjs` from components.

---

## 4. Coding guidelines

### Scope
- Minimal diff; no drive-by refactors.
- Match existing `tax-return/` module style.
- Comments only for non-obvious tax/OCR rules.
- Tests only for real regressions (matrix, quick-parser-test).

### Parser — generic only
**Allowed:** form lines, stmt numbers, structural rejection, comparison column by year.
**Forbidden:** company names in parser, fixture dollar amounts in logic, hardcoded PDF paths.

### Merge priority
form-anchors → statements → comparison → fuzzy

### OneDrive UTF-16 hazard
Cursor edits can corrupt `.ts` to UTF-16. Fix with Node `fs.writeFileSync(...,'utf8')` or PowerShell UTF8Encoding(false). Verify: `!buf.includes(0)`.

### Git
No commit/push unless user asks. Never commit `.env` or customer PDFs.

### TypeScript
`tsconfig` excludes `scripts/`. API routes: `runtime = "nodejs"`.

---

## 5. Future — full tax form extraction (DO NOT IMPLEMENT YET)

**Goal:** Structured JSON for **all forms/schedules** in a return, not only ~20 workbook fields → custom reports without re-OCR.

### Sketch schema (future `lib/tax-schema/`)

- `TaxReturnDocument`: meta (form type, year), `forms` map, `attachments[]`, OCR provenance per page.
- `FormInstance`: lineId → value + confidence + source + pageRef.
- `TableBlock`: repeating rows (K-1 shareholders, asset lists).

### Pipeline (future)
1. Ingest + hash PDF (Supabase Storage)
2. Embedded text per page; OCR only gaps
3. Page classification (which form per page)
4. Per-form extractors (generalize form-anchors, schedule-l, statement-extractors)
5. Tie-out validation (Sch L totals, M-1 bridge)
6. Report templates over JSON

### Reuse today
- `free-ocr.cjs` page finder → classification v1
- Split parser modules → per-form plugins
- `lib/api/*` + componentized UI → report builder later

### Milestones (when approved)
- M1: All 1120-S page 1 lines as JSON
- M2: Full Schedule L grid
- M3: Statements 1–6 typed
- M4: K-1 shareholder table
- M5: Summary PDF report from JSON
- M6: Supabase multi-year API

### Non-goals
No e-filing, no state returns v1, no tax advice in UI.

---

## 6. Vercel deployment checklist

- [ ] `maxDuration = 300` on parse API routes (done)
- [ ] `vercel.json` functions maxDuration 300 (done)
- [ ] `FREE_OCR_WORKERS=1` in Vercel env
- [ ] `serverExternalPackages` in next.config if bundle fails
- [ ] Smoke: text PDF (no OCR), scanned PDF fast < 280s
- [ ] UI warning for Hobby 5-min limit

---

## 7. Status snapshot (2026-06-12)

| Area | Status |
|------|--------|
| Balanced/thorough accuracy | 100% local matrix 2023–2025 |
| Fast mode | ~2× faster; slight accuracy tradeoff on some years |
| UI | Componentized; interactive homepage |
| Vercel-ready | Partial — duration/worker defaults documented |
| Full form extraction | Planned only (Section 5) |

---

## 8. Commands

```bash
cd web && npm run dev && npm run build
npm run benchmark:ocr:matrix
npx tsx scripts/quick-parser-test.ts 2024 scripts/ocr-cache/2024-balanced.txt
```