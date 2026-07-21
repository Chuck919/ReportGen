# Valuation: Excel → Web mapping

This project’s goal is for the web report generator (`/valuation`) to match the **Blue Owl Excel integrator** as closely as practical.

## What “Kroll premia” means in this app

In Blue Owl workbooks, the “Kroll” / “Duff & Phelps” / “Ibbotson” section is the **build‑up method** that produces a required return:

- **risk‑free rate**
- **equity risk premium**
- **size premium**
- **industry / company‑specific risk premia**
- minus **long‑term growth**

Those inputs determine the **discount / capitalization rate** used by the income method. A higher rate produces a lower value and vice versa.

## Current web valuation math (where it lives)

- `web/src/lib/valuation/math.ts` (`buildValuationMath`)
- `web/src/lib/valuation/report.ts` (`buildValuationReport`)

The web model uses:

- **Normalized earnings**: weighted average of per‑year `adjusted_net_profit_before_taxes` (preferred) or `net_profit_before_taxes`.
- **Cap rate** (default): build‑up rate \((R_f + ERP + Size + CSR - g)\), floored at 6%.
- **DLOM**: applied as \(\times (1 - dlomRate)\) to income and asset values.
- **Reconciliation weights**: Blue Owl template defaults are **100% income / 0% asset / 0% market** for KCF; editable in wizard.

> **Planned:** two modes (see [Two-mode product plan](#two-mode-product-plan-simple-vs-thorough)) — Simple uses tax-only approximations; Thorough replicates the Excel chain above.

## Two-mode product plan (Simple vs Thorough)

Mirrors the tax-return OCR pattern (`fast` / `balanced` / `thorough`):

### Simple mode (default) — upload tax PDF only

**Goal:** defensible draft with minimal user input.

| Input | Source |
|-------|--------|
| Earnings base | Weighted avg `adjusted_net_profit_before_taxes` or `net_profit_before_taxes` from parsed tax |
| Cap rate | Build-up defaults (risk-free from FRED + template ERP/size/CSR/growth) |
| DLOM | Template default **10%** |
| Weights | **100% income / 0% asset / 0% market** (KCF-style) |
| Asset value | Latest `total_equity` from balance sheet (or user override) |

**User provides:** tax PDFs only (optional: NAICS, MSA, engaging party for narrative).

**Known limitations:** will not match Excel dollar-for-dollar (no WACC, no owner normalization, no WC/CAPEX adjustments).

### Thorough mode — Excel-parity

**Goal:** replicate `4 weight!P8` → `6 reconciliation!F5` chain.

| Input | Source |
|-------|--------|
| Net income, officer comp, D&A, interest | Parsed tax workbook (`integ` equivalent) |
| Other owner benefit | **Auto:** `9.5% × officer compensation` (Excel formula) |
| Market wage | **BLS API** (occupation + geography) or user override; apply `× 1.22` multiplier per KCF |
| Year weights | Default equal weights on years with data; user can edit |
| WC adjustment | Default **$15,000** (editable) |
| CAPEX adjustment | Default **$10,000** for small deals, **$60,000** template default for larger — user picks or auto by revenue tier |
| Cap structure | Default **45/55** equity/debt (KCF) vs **30/70** (template) — user picks preset |
| Cost of debt | Default **9.5%** (KCF) / **8.5%** (template) — editable |
| Tax rate | **26%** |
| Build-up premia | Template defaults + user override for industry/company-specific risk |
| Asset indicated | User override required for “sale of assets” deals (KCF uses **$5,000**, not book equity) |
| Negative earnings years | Exclude or down-weight (SSSI 2025 is negative) — user confirms |

**User provides (minimum):** tax PDFs + confirm 5–8 pre-filled assumptions in Advanced panel.

## Free APIs — what we can auto-fetch vs what we cannot

| Input | Free API? | Notes |
|-------|-----------|-------|
| Risk-free rate | **Yes — FRED** | 10Y Treasury; already wired |
| Long-term growth proxy | **Yes — FRED** | CPI / GDP trend as default |
| Market wage (owner replacement) | **Yes — BLS** | By SOC + state/MSA; needs occupation mapping from NAICS |
| Industry risk premium | **Partial** | No single free “Kroll premium” API; use NAICS benchmark data + analyst override |
| ERP / size premium | **No direct free API** | Use template constants (5% / 4.37%) unless user uploads build-up |
| Cost of debt | **No reliable free API** | Template default + user override |
| Capital structure (45/55) | **No** | Template/KCF preset + user override |
| WC / CAPEX adjustments | **No** | Template constants + revenue-tier heuristic |
| Asset manual adjustment | **No** | User must specify for asset-sale transactions |
| Market multiples | **Yes — ExitValue** | Already wired |
| Macro / MSA context | **Yes — Census / BEA / FRED** | Narrative + sanity checks |

## What the user must provide (by mode)

| Field | Simple | Thorough |
|-------|--------|----------|
| Tax PDFs | **Required** | **Required** |
| NAICS / geography | Optional (better narrative + BLS wage) | Recommended |
| Owner market wage | Not needed | Auto (BLS) or **confirm override** |
| WC / CAPEX adjustments | Not needed | **Confirm** defaults |
| Capital structure + cost of debt | Not needed | **Confirm** preset |
| Industry / company-specific risk | Not needed | Optional override |
| Asset indicated value | Auto from equity | **Often required** (KCF-style manual adj) |
| Negative / loss years | Included as-is | **Confirm** exclusion/weighting |
| Method weights | Fixed 100% income | Editable |

## Excel workbook mapping (KCF example)

KCF workbook: `Documents/KCF MAIN CURRENT EXCEL.xlsx`

We extract the following **assumption values** from the workbook so the web app can use the same inputs:

## Integrator files vs full valuation workbooks

### What exists in this repo

| Client | Tax integrator (paste ground truth) | Full valuation workbook |
|--------|-------------------------------------|-------------------------|
| **KCF** | inside `KCF MAIN CURRENT EXCEL.xlsx` (`integ` sheet) | `Documents/KCF MAIN CURRENT EXCEL.xlsx` |
| **Carithers** | `Documents/For Changwen/carithers-liquor/integrator.xls` | **not present** |
| **Arizona Sun** | `Documents/For Changwen/arizona-sun-supply/integrator.xls` | **not present** |
| **SSSI** | `Documents/For Changwen/strategic-solution-services/integrator.xls` | **not present** |
| **Template** | — | `Documents/MAIN CURRENT EXCEL.xlsx` |

The three `integrator.xls` files are **tax-only** workbooks (`Sheet1` = income/balance paste, `Sheet2`/`Sheet3` = processing instructions). They contain **no valuation sheets, no WACC, no DLOM, no cap-rate build-up, and no reconciliation weights**.

Each integrator file has a **different MD5 hash** (different pasted tax data), but **identical structure**. Valuation defaults for Carithers/Arizona/SSSI are **not stored** in those files — they would live in a full `MAIN CURRENT EXCEL`-style workbook when an analyst builds the engagement.

### Per-client tax inputs (from integrator.xls) — what would feed normalization

These are the values that get pasted into `integ!Bxx` when building a full valuation workbook:

| Field (latest year) | Carithers 2025 | Arizona 2025 | SSSI 2025 | KCF 2025 (integ) |
|---------------------|----------------|--------------|-----------|------------------|
| Sales | 1,670,033 | 10,628,551 | 5,862,473 | 1,027,658 |
| Net income | 56,667 | 1,063,631 | **-191,859** | 125,439 |
| Officer compensation | 60,374 | 470,741 | *(missing)* | 91,000 |
| Depreciation | — | 3,035 | — | 12,860 |
| Interest expense | — | — | 83,094 | 12,097 |
| Total equity (B/S) | 230,459 | 4,749,322 | 518,983 | *(plug)* |

**Implications:**
- **Carithers**: has officer comp but no D&A/interest in integrator → normalization would rely mostly on net income + owner wage adjustments.
- **Arizona**: large company, high officer comp, small depreciation → very different benefit stream than KCF.
- **SSSI**: **negative net income** in 2025, missing officer comp → thorough mode needs explicit handling (exclude negative years, use weighted prior years, or require analyst override).
- **KCF asset approach** uses **$5,000** adjusted net assets (manual adjustment in `1 adj assets`), not parsed total equity (~$230k+ for others).

## What the Excel valuation actually computes (formulas + sources)

Full valuation logic lives in `MAIN CURRENT EXCEL.xlsx` (template) and client copies like `KCF MAIN CURRENT EXCEL.xlsx`. **KCF is a customized copy — defaults and weighting differ from the blank template** (see comparison table below).

### Income approach: capitalization of earnings (the chain that produces $891,032 → $801,929)

**Step 1 — Build the per-year “Normalized SDE” benefit stream**

Sheet: `2 cf to inv. cap`

For the latest year (2025), the sheet computes:

- `Net Income` = `integ!B32` → `2 cf to inv. cap!F6`
- `Owner Wage` = `integ!B11` → `2 cf to inv. cap!F8`
- `Other Owner Benefit` = `0.095 * Owner Wage` → `2 cf to inv. cap!F9`
- `Less: Market Wage for Owner` = `J16 * 1.22 * -1` → `2 cf to inv. cap!F10`
  - `J16` is a constant (KCF: `78,360`) and is the *base* market wage before the 1.22 multiplier.
- `Amortization` = `integ!B9` → `2 cf to inv. cap!F13`
- `Depreciation` = `integ!B8` → `2 cf to inv. cap!F14`
- `Interest Expense` = `integ!B23` → `2 cf to inv. cap!F15`
- `Total Normalized Adjustments` = `SUM(F8:F15)` → `2 cf to inv. cap!F16`
- `Normalized Income Before Tax` = `F6 + F16` → `2 cf to inv. cap!F18`
- `Market Wage for Owner` = `-1 * F10` → `2 cf to inv. cap!F19`
- **`Normalized SDE`** = `F18 + F19` → `2 cf to inv. cap!F20`

Then the workbook computes a weighted average benefit stream using weights from the same sheet:

- `SDE weight` row: `2 cf to inv. cap!F30` (KCF is `1` for 2023/2024/2025)
- `Weighted normalized SDE` = `F20 * F30` → `2 cf to inv. cap!F37`

**Step 2 — Convert the “cap rate” into WACC**

Sheet: `4 weight`

Excel’s “Cost of Equity” is taken from `3 D&P`:

- `Cost of Equity` = `3 D&P!E23` → `4 weight!M7`

Then Excel uses template constants to compute WACC:

- `Total Equity` (equity weight) = `4 weight!M8` = **0.45**
- `Cost of Debt` = `4 weight!M9` = **0.095**
- `Tax Rate` = `4 weight!M11` = **0.26**
- `Total Debt` (debt weight) = `4 weight!M10` = `1 - M8` = **0.55**
- **`WACC`** = `(M8*M7) + ((M10*M9) * (1 - M11))` → `4 weight!M12`

**Step 3 — Apply two more template adjustments (WC + CAPEX)**

Sheet: `4 weight`

- Weighted average benefit stream: `4 weight!I15` = `I13/I14` (where `I13` sums weighted years; `I14` is the sum of weights)
- Working capital adjustment: `4 weight!I16` = **15,000**
- CAPEX: `4 weight!I17` = **10,000**
- **Cash flows to invested capital** = `I15 - (I16 + I17)` → `4 weight!I18`

**Step 4 — Compute the indicated value**

- **Indicated income value** = `I18 / WACC` → `4 weight!P8`

For KCF this produces:
- `P8` = **891,032.000975...**

**Step 5 — Apply DLOM and reconcile**

Sheet: `6 reconciliation`

- Income indicated = `6 reconciliation!D5` = `4 weight!P8`
- DLOM% = `6 reconciliation!E5` = **0.10**
- Income adjusted (after DLOM) = `6 reconciliation!F5` = `D5 * 0.9`
  - KCF: `801,928.800877...`, displayed as **$801,929**

### Asset approach (KCF uses $5,000 with weight 0)

Sheet: `1 adj assets`

- `1 adj assets!D36` = `B36 + C36` (KCF: 166,582 + (-161,582) = 5,000)

Sheet: `6 reconciliation`

- Asset indicated = `6 reconciliation!D3` = `1 adj assets!D36`
- Asset adjusted = `6 reconciliation!F3` = `0.9 * D3`

### Where “integ!Bxx” numbers come from

Sheet: `integ`

This sheet is the bridge from the integrator tax workbook (your tax-return paste) into the valuation model.
For KCF (2025), the cells used above resolve to:

- `integ!B32` = `125,439` (net income)
- `integ!B11` = `91,000` (owner wage)
- `integ!B8` = `12,860` (depreciation)
- `integ!B9` = `0` (amortization)
- `integ!B23` = `12,097` (interest expense)

### KCF vs template: which defaults/constants differ

| Constant / assumption | KCF (`KCF MAIN CURRENT EXCEL.xlsx`) | Template (`MAIN CURRENT EXCEL.xlsx`) | Same across clients? |
|----------------------|---------------------------------------|--------------------------------------|----------------------|
| **DLOM** | 10% (`DLOM!D14`) | 10% (`DLOM!E16` fallback) | Yes (template default) |
| **Reconciliation income weight** | 1 (100% income) | 1 | Yes for these two |
| **Reconciliation asset weight** | 0 | 0 | Yes |
| **Reconciliation market weight** | 0 | 0 | Yes |
| **Other owner benefit rule** | `9.5% × owner wage` (`F9 = 0.095*F8`) | Same formula | Yes (formula) |
| **Market wage rule** | `J16 × 1.22 × -1` (`F10`); `J16 = 78,360` | **Hardcoded 0** (`F10 = 0`) — no market wage adjustment | **Per engagement** (KCF customized) |
| **Year weighting** (`4 weight!D8:D12`) | Equal **1,1,1** for 2023–2025; uses **Normalized Income Before Tax** (`F18`) | **2,1,0** for TTM/2024/2023; uses **Normalized Income Before Tax** (`F19` — different row offset) | **Per engagement** |
| **Working capital adj** (`I16`) | **$15,000** | **$15,000** | Same |
| **CAPEX adj** (`I17`) | **$10,000** | **$60,000** | **Per engagement** (KCF lowered) |
| **Equity weight** (`M8`) | **45%** | **30%** | **Per engagement** |
| **Debt weight** (`M10`) | **55%** | **70%** | **Per engagement** |
| **Cost of debt** (`M9`) | **9.5%** | **8.5%** | **Per engagement** |
| **Tax rate** (`M11`) | **26%** | **26%** | Same |
| **Risk-free rate** (`3 D&P!E6`) | **3.5%** | **3.5%** | Same |
| **ERP** (`C7`) | **5.0%** | **5.0%** | Same |
| **Size premium** (`C8`) | **4.37%** | **4.47%** | Slight template diff |
| **Industry risk** (`E10`) | **-1.3%** | **+0.9%** | **Per engagement** |
| **Company-specific risk** (`E16` sum) | **11.01%** | **11.1%** | Slight diff |
| **Long-term growth** (`E18`) | **2.0%** | **2.0%** | Same |
| **Pre-tax cap rate** (`E23`) | **27.27%** | **30.43%** | **Per engagement** (build-up output) |
| **WACC** (`M12`) | **16.14%** | **13.53%** | Derived from above |
| **Asset indicated** (`1 adj assets!D36`) | **$5,000** (manual adj: +166,582 / -161,582) | **$1,729,275** (book assets) | **Per engagement** |

**Takeaway:** Carithers/Arizona/SSSI integrator files tell us **tax inputs only**. Valuation constants like cap structure, CAPEX, market wage base, industry risk, asset adjustments, and year weights are **analyst choices** made in the full workbook — KCF is one worked example, not a universal default.

### Normalization structure note (KCF vs template)

Both workbooks share the same *concept* (net income + owner adjustments + D&A + interest), but row layout and weighting targets differ:

- **KCF** (owner-operator normalization active):
  - Row 18 = Normalized Income Before Tax
  - Row 20 = Normalized SDE (= row 18 + market wage add-back)
  - `4 weight` averages **row 18** (not SDE) with equal year weights
- **Template** (sample company, zero owner wage):
  - Row 19 = Normalized Income Before Tax
  - Row 21 = Normalized SDE (equals row 19 when market wage = 0)
  - `4 weight` averages **row 19** with TTM-weighted years (2× latest)

For web **Thorough mode**, follow the **KCF pattern** when officer compensation is present; fall back to template-style (no market wage) when it is zero/missing.

### Build‑up / capitalization inputs

Source sheet: `3 D&P`

- **Risk‑free rate**: `3 D&P!E6`
- **Return in excess of risk‑free**: `3 D&P!E9` (already combines ERP + size + other premia)
- **Long‑term growth**: `3 D&P!E18`
- **Pre‑tax net income cap rate (current year)**: `3 D&P!E23`

> Note: some intermediate premium components are present as labels but may not have cached numeric values in the `.xlsx`. In that case, we use the combined values that are available (e.g. “return in excess” and/or pre‑tax cap rate).

### DLOM

Source sheet: `DLOM`

- **DLOM (selected)**: `DLOM!D14` (fallback `DLOM!E16`)

### How we use these in the web app

When the user provides an Excel integrator workbook, the web app will:

1. Use **Excel’s cap rate** if available (`preTaxNetIncomeCapRate`).
2. Otherwise approximate using the build‑up components that are available.
3. Use **Excel’s DLOM**.
4. Use **Excel’s adjusted earnings** when the workbook provides them (otherwise default to tax‑parsed NPBT).

### Web wizard flow (`/valuation`)

1. **Upload** — tax PDFs parsed once.
2. **Review tax data** — editable workbook table (same as Tax tab).
3. **Assumptions** — Blue Owl default build-up, weights, DLOM, normalized earnings (auto-inferred), company context for Groq.
4. **Report** — full draft with live recalculation when assumptions change in the sidebar.

Code: `web/src/hooks/use-valuation-workflow.ts`, `web/src/lib/valuation/defaults.ts`, `web/src/lib/valuation/math.ts`.

### Reconciliation (sheet `6 reconciliation`)

Each method produces an **indicated** value, applies **DLOM**, then multiplies by **weight**:

| Method | KCF example |
|--------|-------------|
| Asset | Indicated $5,000 → adjusted $4,500, weight **0** |
| Income | Indicated $891,032 → adjusted **$801,929**, weight **1** |
| Market | Indicated $877,639 → adjusted $789,875, weight **0** |

Reconciled = weighted average of adjusted values.

- `web/scripts/extract-kcf-excel-assumptions.py`: extracts cached values from KCF workbook and writes:
  - `web/scripts/benchmark-output/kcf-excel-assumptions.json`

This file is for debugging and for confirming what the workbook currently provides as cached values.

