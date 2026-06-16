# Session Changes Summary (Vercel OCR tuning → VPS path)

**Updated:** 2026-06-16 · **Production:** https://reportgen-three.vercel.app/tax

See also: `AGENT_HANDOFF_LOCAL_OCR_TESTING.md`, `AGENT_HANDOFF_ORACLE_DEPLOY.md`, `docs/KNOWN_ACCURACY.md`

---

## Reverify (2026-06-16) — Balanced IS on Vercel

**Question:** If balanced gets 100% under 5 min, why not use it on Vercel?

**Answer:** We **already do.** Default mode = `vercel-balanced`. The 100% figure is from **local simulation** (`benchmark-vercel-modes.json`), not typical prod cold starts.

| Source | `vercel-balanced` 2024 | Time |
|--------|------------------------|------|
| Local sim (2026-06-14) | **100%** | 208s |
| Live prod API (2026-06-16) | **75%** | 161s |
| Cached OCR → parser only | **100%** | 0s |

**Root cause of gap:** Tesseract output varies run-to-run. Parser is OK when OCR text is good.

**Bug fixed:** UI Thorough was remapping to `vercel-thorough-full` instead of `vercel-thorough`. Removed; all three modes now single POST with chosen `ocrMode`.

---

## Final Vercel presets (deployed)

| UI | OCR preset | Behavior |
|----|------------|----------|
| Fast | `vercel-fast` | 14 pages, no hi-DPI |
| Balanced | `vercel-balanced` | 26 pages, no hi-DPI (default) |
| Thorough | `vercel-thorough` | 26 pages + hi-DPI |

Multi-pass UI removed (`VERCEL_MULTIPASS = {}`). Dead client multipass code removed from `parse-tax-return.ts`.

---

## Production cold benchmarks (archived)

Three iterations on 2023/2024/2025 — multi-pass rejected. Latest: `scripts/benchmark-prod-cold.json`.

---

## Key commands

```powershell
cd web
npm run test:prod-api -- https://reportgen-three.vercel.app 2024
npm run benchmark:vercel-modes    # local sim
npm run benchmark:prod-cold -- https://reportgen-three.vercel.app
npm run test:upload
npx vercel deploy --prod --yes
```

---

## Do not regress

1. Never merge Vercel tuning into local `MODES.fast/balanced/thorough`.
2. Do not re-enable multi-pass UI without prod proof on 75-page returns.
3. Thorough UI must post `vercel-thorough`, not `vercel-thorough-full`.
4. Do not claim 100% on Vercel from local sim alone — run `test-prod-api`.
