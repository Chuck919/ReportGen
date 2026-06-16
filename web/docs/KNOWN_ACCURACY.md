# Known OCR / parse accuracy limits

**Last verified:** 2026-06-16 (live prod API + cached OCR eval)

## We already use `vercel-balanced` on Vercel

Balanced is the **default** UI mode and posts `ocrMode=vercel-balanced` (26-page single pass, no hi-DPI). There is no separate “better balanced” preset sitting unused.

The **100% @ ~208s** figure in `benchmark-vercel-modes.json` is from **local OCR simulation** (`VERCEL=1`, `workers=1`, same preset) — not a guarantee on deployed Vercel cold starts.

## Live production reverify (2026-06-16, 75-page 2024 PDF)

`npx tsx scripts/test-prod-api.ts https://reportgen-three.vercel.app 2024`

| Mode | Time | Primary | Notes |
|------|------|---------|-------|
| `vercel-fast` | 121s | 70% (14/20) | Preview tier |
| `vercel-balanced` | 161s | **75%** (15/20) | **Default — already in use** |
| `vercel-thorough` | 177s | **85%** (17/20) | 26 pg + hi-DPI |

All under 300s. TSV export: 58 lines ✓

## Parser vs OCR

Cached OCR from a good run parses at **100%**:

```bash
npx tsx scripts/eval-tax-cached.ts -- --mode vercel-balanced
# 2024: 20/20 primary, 2025: 21/21 primary
```

When production OCR quality is good, the parser is fine. Low prod scores are **Tesseract variance** on fresh scans, not missing presets.

## Local simulation reference (`benchmark-vercel-modes.json`, 2026-06-14)

| Mode | 2024 primary | Time | Pages |
|------|--------------|------|-------|
| `vercel-fast` | 80% | 72s | 14 |
| `vercel-balanced` | **100%** | 208s | 26 |
| `vercel-thorough` | **100%** | 208s | 26 |

Local sim can hit 100% while prod cold start on the same preset gets 75% — same code path, different runtime luck.

## Vercel UI presets (current)

| UI | Preset | Role |
|----|--------|------|
| Fast | `vercel-fast` | 14 pages, ~2 min preview |
| Balanced | `vercel-balanced` | 26 pages, default, ~2.7 min |
| Thorough | `vercel-thorough` | 26 pages + hi-DPI, ~3 min, best prod accuracy |

**Bug fixed 2026-06-16:** UI Thorough had been remapping to `vercel-thorough-full` (20 pg + phase-1). Now uses `vercel-thorough` directly like the API test.

## For reliable 100%

- **Oracle/VPS** with local `fast` / `balanced` / `thorough` (no 300s cap) — see `AGENT_HANDOFF_ORACLE_DEPLOY.md`
- Or reuse OCR cache from a successful run (`scripts/ocr-cache/`)

## Benchmark artifacts

| File | Purpose |
|------|---------|
| `scripts/benchmark-vercel-modes.json` | Local sim, all modes/years |
| `scripts/benchmark-prod-cold.json` | Latest live HTTP cold benchmark |
| `scripts/benchmark-matrix.json` | Local VPS presets (fast/balanced/thorough) |

Run prod check: `npm run test:prod-api -- https://reportgen-three.vercel.app 2024`
