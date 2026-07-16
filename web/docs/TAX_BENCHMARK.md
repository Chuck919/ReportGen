# Tax Benchmark

Canonical product gate and iteration rules: repo-root [`AGENTS.md`](../../AGENTS.md).

## Primary commands

```powershell
cd web
npx tsx scripts/benchmark-ui-session.ts balanced          # all 4 clients, cached OCR
npx tsx scripts/benchmark-ui-session.ts balanced carithers
npx tsx scripts/benchmark-ui-upload-routes.ts balanced    # progressive / startParse / restore parity
```

## Scoring (Jul 2026)

- **Exact dollars** — `Math.round(actual) === Math.round(expected)` (no $500 / 0.5% / 1% slack).
- **Opex** — multiset of top-8 **amounts** (+ readable labels). Do **not** score by semantic slot id (`insurance` must not be required to sit in `bank_credit_card`).
- **other_opex** — exact preferred; secondary to top-8 amount coverage.
- **Green-danger** — wrong value + trusted tier must be 0.
- **UI routes** — upload-routes bench must match batch UI-session on top-8, other_opex, form OI/GP anchors, and P&L flags.

## Hosting

Production is **OVH VPS** (`https://reportgen.duckdns.org`). No Vercel / Hetzner / Oracle deploy paths.

## Clients

| id | years | fixtures |
|----|-------|----------|
| kcf | 2023–2025 | `src/lib/workbook-comparison-fixtures.ts` |
| carithers | 2021–2025 | `scripts/changwen-fixtures.json` |
| sssi | 2022–2024 | `scripts/changwen-fixtures.json` |
| arizona-sun | 2022–2025 | `scripts/changwen-fixtures.json` |
