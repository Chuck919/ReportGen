# Valuation graphic replacement map

Maps every embedded image in **MAIN CURRENT REPORT premerge.docx** (23 body images + footer logo) to ReportGen’s live-generated charts/tables (Option B: **tables rendered as images** where the integrator used static screenshots).

**Template slots:** `«GRAPHIC_slot_XX_*»` in `main-current-reportgen.docx`  
**Injection:** docxtemplater fills slots with `[[CHART:chart-id]]` → `injectChartsAtMarkers()` rasterizes SVG → PNG in-place.

Regenerate template after slot changes:

```bash
cd web
npx tsx scripts/prepare-reportgen-template.ts
```

Visual QA (PNG export + label checks):

```bash
cd web
npx tsx scripts/qa-valuation-charts.ts
```

---

## Full replacement table

| # | Premerge section (context) | Original integrator asset | ReportGen slot | Live chart / table ID | Data source | Status |
|---|---------------------------|---------------------------|----------------|----------------------|-------------|--------|
| 1 | Cover (decorative header) | Static cover graphic | `GRAPHIC_slot_01_cover` | `cover-graphic` | Session entity + reconciled value | **Generated** |
| 2 | Conclusion / signature block | Firm signature banner | `GRAPHIC_slot_02_conclusion` | `firm-logo` | User firm branding (future upload) | **Placeholder** — analyst fills |
| 3 | Purpose & Use | IRS 59-60 illustration | `GRAPHIC_slot_03_purpose` | `purpose-summary` | Engagement + purpose from wizard | **Generated** |
| 4 | National economy — GDP projections | BLS / integrator projection chart | `GRAPHIC_slot_04_national_1` | `national-unemployment` | FRED `UNRATE` | **Generated** |
| 5 | National economy | Treasury / rates graphic | `GRAPHIC_slot_05_national_2` | `national-treasury` | FRED `DGS20` | **Generated** |
| 6 | National economy | CPI / inflation graphic | `GRAPHIC_slot_06_national_3` | `national-cpi` | FRED `CPIAUCSL` | **Generated** |
| 7 | National economy | GDP trend graphic | `GRAPHIC_slot_07_national_4` | `national-gdp` | FRED `GDPC1` | **Generated** |
| 8 | National economy | Households / demographics | `GRAPHIC_slot_08_national_5` | `national-households` | Census ACS (US) | **Generated** (needs `CENSUS_API_KEY`) |
| 9 | National economy | Income snapshot | `GRAPHIC_slot_09_national_6` | `national-income` | Census ACS + FRED unemployment | **Generated** |
| 10 | National → local transition | MSA population chart | `GRAPHIC_slot_10_national_7` | `msa-population` | Census ACS (CBSA) | **Generated** (needs CBSA + key) |
| 11 | End of national section | Local unemployment | `GRAPHIC_slot_11_national_8` | `msa-unemployment` | FRED (proxy until CBSA wired) | **Generated** |
| 12 | Industry — after IBISWorld text | **IBIS industry overview** screenshot | `GRAPHIC_slot_12_industry_1` | `benchmark-entry-table` | `benchmark-naics.ts` / IRS SOI ratios | **Generated** (replaces IBIS) |
| 13 | Industry — performance / risks | **IBIS** performance chart | `GRAPHIC_slot_13_industry_2` | `benchmark-is-compare` | Subject tax columns vs NAICS benchmark | **Generated** |
| 14 | Industry — regulations / trends | **IBIS** secondary chart | `GRAPHIC_slot_14_industry_3` | `benchmark-bs-compare` | Subject B/S % vs benchmark | **Generated** |
| 15 | Normalized balance sheet | Integrator BS normalization table image | `GRAPHIC_slot_15_normalized_bs` | `benchmark-bs-compare` | Parsed tax + benchmark | **Generated** |
| 16 | Benefit-stream income statement | Multi-year IS chart | `GRAPHIC_slot_16_normalized_is` | `sales-trend` | Parsed tax workbook | **Generated** |
| 17 | Income method — capex note | Cap rate / earnings graphic | `GRAPHIC_slot_17_income_method` | `buildup-waterfall` | Valuation assumptions (build-up) | **Generated** |
| 18 | Build-up — other risk factors | Risk factor table graphic | `GRAPHIC_slot_18_buildup_risk` | `benchmark-metrics-compare` | Subject ratios vs benchmark | **Generated** |
| 19 | Duff & Phelps / WACC stack | Cost-of-equity waterfall | `GRAPHIC_slot_19_wacc` | `buildup-waterfall` | Same build-up components | **Generated** (Duff tables → assumptions UI) |
| 20 | Market method — DealStats intro | **DealStats** transaction table screenshot | `GRAPHIC_slot_20_market_dealstats` | `market-multiples-table` | ExitValue.ai multiples (cached) | **Partial** — summary only |
| 21 | Market — percentile interpolation | DealStats comp scatter / bands | `GRAPHIC_slot_21_market_percentiles` | `market-comps-scatter` | DealStats / BVR private DB | **Empty** — user/analyst |
| 22 | Market indicated value | Completed transaction chart | `GRAPHIC_slot_22_market_indicated` | `market-multiples-table` | ExitValue implied values | **Partial** |
| 23 | Reconciliation of values | Method reconciliation graphic | `GRAPHIC_slot_23_reconciliation` | `reconciliation-summary` | Session valuation math | **Generated** |
| — | Footer | **Blue Owl logo** | `GRAPHIC_firm_logo` | `firm-logo` | User upload / firm profile | **Placeholder** |

---

## What we deliberately leave empty / user-filled

| Item | Why |
|------|-----|
| Firm logo & signature artwork | Branding is firm-specific; no API |
| DealStats transaction-level tables & scatter comps | Proprietary BVR/DealStats dataset |
| IBIS narrative prose | Replaced by Groq + `benchmark-naics` industry copy (not the old PDF screenshots) |
| Duff & Phelps published size-premium tables | Analyst enters size premium in assumptions; we chart the **applied** build-up |
| Analyst workpaper detail (individual transactions) | “See work papers” — paste from Excel |
| Company-specific qualitative factors | Company profile form + Groq narratives |

---

## Recommended additional charts (not in premerge)

| Chart ID (proposed) | Purpose | Data |
|---------------------|---------|------|
| `opex-mix-donut` | Top-8 operating expense mix vs benchmark SG&A | Tax parser top-8 |
| `working-capital-bridge` | NWC adjustment waterfall | Normalization inputs |
| `benefit-stream-bars` | Normalized earnings by year | Valuation math |
| `dlom-sensitivity` | Value vs DLOM % | Assumptions slider |
| `cap-rate-sensitivity` | Value vs capitalization rate | Assumptions |
| `tax-parse-confidence` | OCR field confidence heatmap | Tax benchmark scanner |
| `msa-home-value-trend` | Local housing affordability | Census ACS + FRED HPI |
| `industry-revenue-per-employee` | NAICS productivity proxy | Census + subject headcount (user) |

---

## KCF finished report note

The integrator **KCF valuation.docx** has **26** body images (adds 3 MSA “Observation” charts in § Local Economy). Those map to the same national/MSA chart IDs above when CBSA `28140` (Kansas City) is supplied.

---

## Code references

| File | Role |
|------|------|
| `word-chart-markers.ts` | Slot → chart ID map |
| `valuation-benchmark-visuals.ts` | Benchmark Entry table + subject vs benchmark bars |
| `valuation-charts.ts` | Financial trends + census snapshot cards |
| `macro-data.ts` | FRED time-series SVGs |
| `word-chart-inject.ts` | In-place PNG injection |
| `prepare-reportgen-template.ts` | Strip legacy `word/media/*`, insert `«GRAPHIC_*»` |
