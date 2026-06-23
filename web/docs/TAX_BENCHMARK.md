# Tax Benchmark — Web API Accuracy

## North star

- **≥99% all-fields** vs integrator Excel fixtures on **thorough** `POST /api/parse-tax-return` for all **16 client-years**
- **Balanced ≥95%**, **Fast ≥98%** all-fields
- Meaningful field flags; no noisy structural-mismatch flags

## Clients (16 years)

| id | years | fixture source |
|----|-------|----------------|
| kcf | 2023–2025 | `src/lib/workbook-comparison-fixtures.ts` |
| carithers | 2021–2025 | `scripts/changwen-fixtures.json` |
| sssi | 2022–2024 | `scripts/changwen-fixtures.json` |
| arizona-sun | 2022–2025 | `scripts/changwen-fixtures.json` |

## Commands

```bash
cd web
npm run dev                                    # terminal 1
npm run benchmark:web-api                      # thorough, 16 client-years
npm run benchmark:web-api:balanced
npm run benchmark:web-api:fast
npx tsx scripts/benchmark-diagnose.ts thorough http://localhost:3000
npx tsx scripts/benchmark-diagnose.ts thorough http://localhost:3000 --holdout=sssi
npx tsx scripts/benchmark-one-web-api.ts {client} {year}
npm run test:reconcile
```

Output: `scripts/benchmark-output/` (gitignored).

## LOCO validation

**Holdout client:** `sssi` (rotate each major change).

1. Tune using kcf + carithers + arizona-sun only
2. Run holdout unchanged
3. Reject changes that improve train but regress holdout

## Error buckets

| Bucket | Meaning |
|--------|---------|
| **ocr_coverage** | Required text not in embedded + OCR payload |
| **parsing_extraction** | Text present but not extracted into structured lines |
| **candidate_selection** | Better candidate existed but wrong formula won |
| **workbook_mapping** | Value correct structurally but wrong workbook field |

Run `benchmark-diagnose.ts` for per-miss JSON with `rootCause`, `coverage`, and `opexCandidates`.

## Framework (2026-06)

- **Opex candidate ranking** (`opex-candidate-ranking.ts`): all formulas scored by closure × 50 + evidence × 30 + consistency × 20
- **OCR coverage diagnostics** (`ocr-coverage-diagnostics.ts`): `stmt2Found`, `exclusionLinesFound`, `opexClosureRatio` in API `debug.coverage`
- **Cross-year consistency** (`cross-year-consistency.ts`): prior-year evidence for candidate tie-breaks — never hard override

## Status log

| Date | Change | LOCO holdout (sssi) | Bucket counts | All-fields (train) |
|------|--------|---------------------|---------------|-------------------|
| 2026-06-22 | **Opex ranking iteration** — detail-over-residual guards, wide-exclusion cap, `force-exit` on benchmarks | pending | pending | carithers 2021 thorough **100%** |

### Framework shipped (2026-06-21)

- Opex: sequential if/else replaced with ranked candidates (closure×50 + evidence×30 + consistency×20)
- Plausibility: large opex allowed when `knownLines + opex ≈ stmt2Total` (fixes Arizona-style attachments)
- API `debug.coverage` + `debug.opexCandidates` on thorough parse
- `npm run test:reconcile` — 25/25 green
- `npm run benchmark:direct` — same pipeline as API without HTTP

### Ranking guards (2026-06-22)

- Cap false closure on stmt2 residual when attachment uses document-wide exclusion heuristics
- Prefer office/supplies detail over misc-sum or inflated summed-detail when value diverges >40%
- Prefer high-evidence detail over subtractive residual when residual >1.2× detail
- `scripts/lib/force-exit.ts` — benchmarks exit cleanly (no hung terminals after OCR)

### Thorough direct-parse spot checks

| Client | Year | All-fields |
|--------|------|------------|
| carithers | 2021 | **100%** |
| carithers | 2022 | 90.5% (cash blank; ltd 695 vs 677) |
| carithers | 2023 | 95.7% (opex 10325 vs 8983) |
| carithers | 2024 | 95.5% (opex 6725 vs 7956) |
| carithers | 2025 | 95.2% (opex 8818 vs 9118) |

### Embedded opex sanity (fast, not success metric)

| Client | Opex |
|--------|------|
| carithers 2021–2023 | ✓ fixture match |
| arizona-sun 2025 | ✓ 320325 vs 320323 |
