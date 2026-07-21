# Valuation Data Sources

## Free stack (recommended)

| Key | Cost | Purpose |
|-----|------|---------|
| `FRED_API_KEY` | Free signup | Treasury yields, unemployment, macro charts |
| `BEA_API_KEY` | Free signup | Regional GDP / income (when available) |
| `CENSUS_API_KEY` | Free signup | MSA demographics |
| `GROQ_API_KEY` | Free tier | Batched report prose (one JSON call per generation) |
| `GROQ_MODEL` | — | Default `openai/gpt-oss-120b` (Groq’s replacement for deprecated llama-3.3-70b) |

**Do not set `OPENAI_API_KEY` unless you want to pay** — OpenAI charges per token. ReportGen works fully without it: Groq → rule-based fallback.

## No-signup sources

- ExitValue.ai multiples JSON (market method hints)
- Treasury Fiscal Data API / Treasury yield CSVs
- IRS SOI Corporation Source Book downloads (NAICS benchmark seeds in code)
- FRED CSV fallback for known series when API key missing

## Narrative policy

- **Numbers and benchmark %** (`IS_*` bullets, valuation math): always **rule-based** from parsed tax + NAICS seeds — never invented by AI.
- **Prose sections** (company, economy, conclusion, etc.): one **batched** Groq call returning JSON; falls back to rule-based text if Groq is off or rate-limited.
- Model chain: `GROQ_MODEL` (default `openai/gpt-oss-120b`) → `llama-3.1-8b-instant` on same key → rule-based.

## Data we do *not* have (gaps vs finished integrator reports)

| Gap | Workaround today |
|-----|------------------|
| Proprietary **IBIS** industry reports | IRS SOI / Census CBP **seed ratios** in `benchmark-naics.ts` — directionally right, not client-specific IBIS PDFs |
| **Kroll** cost-of-capital tables | Manual analyst inputs in assumptions step |
| Secretary of State **org lookup** (`org_state`, file number, etc.) | Empty merge fields — analyst fills in Word |
| B/S **footnote narratives** (`Acct_rec_note`, etc.) | Empty — analyst fills |
| Management / ownership / customer detail | Optional `companyContext` text box → Groq; otherwise generic |
| Finished-report **legal boilerplate** edits | Static text in `reportgen.docx` — edit template copy as needed |

## Runtime policy

- Cache FRED for roughly 24 hours.
- Cache BEA and Census for 7–30 days.
- Use Groq only after deterministic math and source facts are assembled.
- Treat Kroll as manual paste only; no scraping or hidden API assumptions.
