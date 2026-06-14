# Pre-deploy Vercel cleanup — agent prompt & checklist

**Copy everything below the line into a new agent session before deploying to Vercel.**  
Goal: catch bugs, edge cases, dead code, and verify the full upload → OCR → parse → table → export path.

---

## Agent prompt (paste this)

You are doing a **final pre-deploy cleanup** for ReportGen `web/` before Vercel production deploy.

### Scope

1. **No regressions** — local `fast` / `balanced` / `thorough` presets in `scripts/ocr-modes.cjs` must stay unchanged.
2. **Vercel modes** — `vercel-fast`, `vercel-balanced`, `vercel-thorough` only; `workers: 1` on Vercel (1 vCPU).
3. **Production path** — single `POST /api/parse-tax-return` per PDF from the UI. Progressive/batched client OCR is **disabled** (benchmark-only).
4. **Minimize diff** — remove dead code, fix real bugs; no unrelated refactors.

### Audit checklist

#### A. Upload & API

- [x] `validateClientFileList` rejects empty/non-PDF/oversized files; warns on multi-file Vercel upload.
- [x] `enforceFileCountLimit` = 1 file per request on Vercel (`upload-policy.ts`).
- [x] `resolveOcrModeForDeploy` maps local modes → vercel equivalents when `VERCEL=1`.
- [x] `PARSE_TAX_API_KEY` optional; when set, `Authorization: Bearer` or `X-API-Key` required.
- [x] Client timeout: `VERCEL_OCR_BUDGET_MS + 15s` on Vercel deploy (`parse-tax-return.ts`).
- [x] Server OCR subprocess: `FREE_OCR_WORKERS=1`, `FREE_OCR_TIMEOUT_MS=280000` on Vercel (`local-ocr.ts`).

#### B. OCR & parse

- [x] `processTaxPdfFile` handles corrupt PDF, empty embedded text, OCR timeout → `partial` with user message.
- [x] `parseTaxReturn` skips OCR when embedded text is sufficient; otherwise `runLocalOcr`.
- [x] `assessParseQuality` warns when primary fields incomplete.
- [x] Known accuracy gaps — see `docs/KNOWN_ACCURACY.md` (do not block deploy):
  - Cold-start benchmark 2026-06-14: all modes PASS &lt;295s; `vercel-balanced`/`thorough` **100%** on 2024/2025 fresh OCR
  - 2023: `notes_minus_short_term` on balanced/thorough; `vercel-fast` ~79%
  - Historical variance: 2024 `cogs`, 2025 `sales`/`other_income`/`notes_minus_short_term` on bad Tesseract runs

#### C. UI & persistence

- [x] `/tax` — upload, mode selector (Vercel vs local via `NEXT_PUBLIC_VERCEL`), progress, errors.
- [x] `mergeTaxYearsByYear` on re-upload same year (higher confidence wins).
- [x] `session-storage` saves columns to localStorage + sessionStorage.
- [x] TSV copy via `TaxToolbar` / `buildPasteTsv`.
- [x] Clear all wipes storage.

#### D. Dead code (benchmark-only, not prod path)

- [x] `progressive-ocr.ts` — not imported by `parse-tax-return.ts`; header marks benchmark-only.
- [x] `batched-ocr.ts` — `/api/ocr-plan`, `/api/ocr-pages`, benchmarks only.
- [x] `/api/ocr-run` — CLI/benchmark helper, not UI.

#### E. Build & encoding hazards

- [x] `npm run build` clean
- [x] `npm run lint` clean
- [x] `serverComponentsExternalPackages`: `pdf-parse`, `tesseract.js` in `next.config.mjs`.
- [x] `vercel.json` `maxDuration: 300`.

### Commands to run (in order)

```bash
cd web

npm run test:upload
npm run test:tax-ui
npm run test:pipeline -- --quick
npm run test:pipeline

npm run build
npm run lint
```

### Manual browser smoke (after deploy preview)

1. Open `/tax`.
2. Upload one 1120-S PDF (2024 recommended).
3. Mode **Balanced** (`vercel-balanced` on Vercel build).
4. Wait for table; verify sales/COGS/cash populated.
5. Copy TSV — paste into Excel, spot-check numbers.
6. Refresh page — columns should persist.
7. Re-upload same year — merge should keep higher-confidence values.
8. Upload second year — both columns appear.

### Vercel deploy steps

1. Set env: `NEXT_PUBLIC_VERCEL=1` (production).
2. Optional: `PARSE_TAX_API_KEY` for API-only access.
3. Deploy; smoke each mode under 300s:
   - `vercel-fast` (~1 min, preview coverage)
   - `vercel-balanced` (~3–4 min, default)
   - `vercel-thorough` (must finish < 300s)
4. `curl` smoke:

```bash
curl -s -X POST "https://YOUR_APP.vercel.app/api/parse-tax-return" \
  -H "Authorization: Bearer YOUR_KEY" \
  -F "file=@return.pdf" \
  -F "ocrMode=vercel-balanced" \
  -F "format=json"
```

### Definition of done

- All checklist items verified or documented in `docs/KNOWN_ACCURACY.md`.
- `test:upload`, `test:tax-ui`, `test:pipeline --quick`, `test:pipeline`, `build`, `lint` pass.
- Live `test:pipeline` ≥ 85% primary on 2024 with `vercel-balanced`.
- No progressive/batch code in the production upload path.

### Key files

| File | Role |
|------|------|
| `scripts/ocr-modes.cjs` | OCR presets (local + Vercel) |
| `scripts/free-ocr.cjs` | OCR subprocess |
| `src/lib/tax/process-tax-upload.ts` | Server file processing |
| `src/lib/tax-return-parser.ts` | Parse + OCR orchestration |
| `src/lib/api/parse-tax-return-handler.ts` | API handler |
| `src/lib/api/parse-tax-return.ts` | Client upload (single-pass) |
| `src/hooks/use-tax-upload.ts` | UI state + persistence |
| `src/lib/tax/merge-years.ts` | Same-year re-upload merge |
| `docs/KNOWN_ACCURACY.md` | Documented field misses |
| `vercel.json` | 300s function limit |

---

## Quick status (last updated: 2026-06-14)

| Check | Status |
|-------|--------|
| `test:upload` | 22 passed |
| `test:tax-ui` | 9 passed (merge / table / TSV / storage) |
| `test:pipeline --quick` 2024/2025 | 100% primary (cached OCR) |
| `test:pipeline` live 2024 vercel-balanced | 100% primary, **216s** |
| `benchmark:vercel-modes` cold start | 9/9 PASS &lt;295s — see `scripts/benchmark-vercel-modes.json` |
| `build` / `lint` | Clean |
| Progressive OCR in prod UI | Removed from `parse-tax-return.ts` |
| `workers: 1` on Vercel | Done |
| Known misses documented | `docs/KNOWN_ACCURACY.md` |
| Browser smoke on `/tax` | Manual after deploy preview |

---

## Copy-paste one-liner for next agent

> Final Vercel pre-deploy: run `web/PRE_DEPLOY_VERCEL.md` checklist, `npm run test:upload`, `npm run test:pipeline -- --quick` then `npm run test:pipeline`, `npm run build`, `npm run lint`, fix any failures, remove dead progressive/batch code from prod path only, do not retune local OCR modes, document known 2024/2025 field misses, then confirm `/tax` upload→table→TSV→persistence works.
