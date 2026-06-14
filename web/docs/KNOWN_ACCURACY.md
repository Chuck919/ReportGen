# Known OCR / parse accuracy limits

**Do not block Vercel deploy for these.** Tesseract output varies on scanned 1120-S PDFs; parser fixes are in place but fresh OCR can still miss fields.

## Cold-start benchmark (2026-06-14)

Fresh OCR, no cache reads, `workers=1`, limit 295s. Full results: `scripts/benchmark-vercel-modes.json`.

| Mode | 2023 | 2024 | 2025 | Time range |
|------|------|------|------|------------|
| `vercel-fast` | 78.9% (15/19) | 80.0% (16/20) | 85.7% (18/21) | 72–87s |
| `vercel-balanced` | 94.7% (18/19) | **100%** (20/20) | **100%** (21/21) | 190–236s |
| `vercel-thorough` | 94.7% (18/19) | **100%** (20/20) | **100%** (21/21) | 186–235s |

All 9 runs **PASS** under 295s.

### Fresh-run misses (this benchmark)

| Year | Mode | Misses |
|------|------|--------|
| 2023 | `vercel-fast` | `sales`, `rent`, `other_current_liabilities`, `unclassified_equity` |
| 2023 | `vercel-balanced` / `thorough` | `notes_minus_short_term` |
| 2024 | `vercel-fast` | `advertising`, `rent`, `taxes_licenses`, `other_current_liabilities` |
| 2025 | `vercel-fast` | `rent`, `other_assets`, `other_current_liabilities` |

`vercel-balanced` and `vercel-thorough` scored **100%** on 2024 and 2025 in this run.

## Fresh-run variance (Tesseract)

Re-running OCR on the same PDF can produce different text. Historical occasional misses on **fresh** runs:

| Year | Typical `vercel-balanced` | Occasional misses |
|------|---------------------------|-------------------|
| 2023 | ~95% primary | `notes_minus_short_term` (Schedule L line 20) |
| 2024 | ~95–100% primary | `cogs` — OCR reads `2` or wrong line vs `313334` |
| 2025 | ~85–100% primary | `sales`, `other_income`, `notes_minus_short_term` when OCR garbles Form 1c / Stmt 1 / Schedule L line 20 |

**Cached good runs** (`scripts/ocr-cache/{year}-vercel-balanced.txt`) parse at **100%** with current parser.

## Not Vercel-specific

Same misses appear on **local `fast`** with the **same OCR text**. Fix parser when text is good; re-run OCR or use cache when Tesseract variance hurts.

## Production expectations (Vercel Hobby)

| Mode | Time | Accuracy |
|------|------|----------|
| `vercel-fast` | ~1 min | ~79–86% preview |
| `vercel-balanced` | ~3–4 min | **Best default** — fast pipeline, critical-only hi-DPI |
| `vercel-thorough` | ~5–8 min (2+ API calls) | Balanced pass + hi-DPI delta on blank fields via `/api/ocr-pages` |

## For reliable 100%

- Oracle/VPS with local `balanced` / `thorough`, or  
- Keep OCR cache from a successful run (`scripts/ocr-cache/`)

See `docs/DEPLOY_ORACLE.md`, `web/AGENT_HANDOFF_VERCEL_OCR.md`.
