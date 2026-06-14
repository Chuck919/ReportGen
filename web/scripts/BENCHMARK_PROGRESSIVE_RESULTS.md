# Progressive OCR benchmark results

Run: `npm run benchmark:progressive:all` · `npm run benchmark:ocr`

## Why not 100% on Vercel?

**Not mainly a Vercel/progressive issue.** Fresh runs (2026-06-14):

| Year | local `fast` (workers 3) | `vercel-balanced` (workers 2) |
|------|--------------------------|-------------------------------|
| 2024 | 95% (cogs miss) | 95% (same cogs miss) |
| 2025 | **85.7%** | **85.7%** (identical misses) |

The older matrix showing 100% on 2025 local fast was from a prior OCR cache/run. Tesseract output varies between runs on scanned PDFs.

To get reliable 100%: use **Oracle/VPS** with local `balanced`/`thorough`, or re-run / use cached OCR text when a good run exists.

## Progressive tiering (preview + delta) — retired for Balanced

We tested:

1. **Preview + full rescan** — same accuracy as single pass but ~25% slower (wasted ~80s preview).
2. **Preview + delta pages only** — scanned 42 pages but **75% accuracy** (worse). Delta batches skip phase-1 keyword discovery; tier-1 bad text on un-replaced pages poisons the parser.

**Decision:** Vercel **Balanced** and **Thorough** use **one full OCR request** each. No preview overhead.

`shouldUseProgressiveOcr()` returns `false` — all Vercel modes call `/api/parse-tax-return` directly.

## Performance improvements applied

- `vercel-balanced` / `vercel-thorough`: **workers 2** (was 1) → ~136–149s vs ~240s on 2024/2025
- Delta OCR batches enable **phase 3 hi-DPI** when used (`FREE_OCR_FORCE_PHASE3=1`) — kept for future/experimental CLI
- Missing-field page hints now **re-OCR** pages already seen in tier 1 when those fields are still blank

## Recommended modes

| Deploy | Mode | Expect |
|--------|------|--------|
| Vercel Hobby | `vercel-fast` | ~1 min, ~80% preview |
| Vercel Hobby | `vercel-balanced` | ~2–3 min, best Vercel accuracy |
| VPS / local | `balanced` / `thorough` | Full matrix, re-run if OCR variance |
