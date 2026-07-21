/** Cited references for valuation assumption tooltips (all links are public). */
export type AssumptionFieldSource = {
  label: string;
  url?: string;
  detail: string;
};

export const VALUATION_REFERENCES = {
  fredTreasury10y: {
    label: "FRED — 10-Year Treasury",
    url: "https://fred.stlouisfed.org/series/DGS10",
    detail: "Risk-free rate proxy. U.S. Treasury constant maturity yields are the standard starting point for build-up cost of capital (Duff & Phelps / Kroll methodology).",
  },
  fredTreasury20y: {
    label: "FRED — 20-Year Treasury",
    url: "https://fred.stlouisfed.org/series/DGS20",
    detail: "Long-term risk-free rate used in many business valuation models when matching duration of cash flows.",
  },
  damodaranErp: {
    label: "Damodaran — Implied ERP",
    url: "https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/ctryprem.html",
    detail: "Equity risk premium (~5% for U.S.) from NYU Stern published implied ERP tables. Widely cited in appraisal build-up models.",
  },
  krollSizePremium: {
    label: "Kroll — Size premium concept",
    url: "https://www.kroll.com/en/insights/publications/cost-of-capital",
    detail: "Size premia increase required return for smaller companies. We approximate decile premia from trailing revenue (revenue-tier lookup).",
  },
  irs5960: {
    label: "IRS Rev. Ruling 59-60",
    url: "https://www.irs.gov/pub/irs-utl/rr_59-60.pdf",
    detail: "Foundational guidance on fair market value of closely held stock. Company-specific risk reflects qualitative factors in §5.",
  },
  asaBvs: {
    label: "ASA Business Valuation Standards",
    url: "https://www.appraisers.org/standards/business-valuation-standards",
    detail: "Professional standards for income approach, normalization adjustments, and discount rates in closely held business appraisal.",
  },
  mandelbaumDlom: {
    label: "Mandelbaum factors (DLOM)",
    url: "https://www.law.cornell.edu/wex/discount_for_lack_of_marketability",
    detail: "Courts weigh controlling interest, dividends, transfer restrictions, and holding period when estimating DLOM. Our checklist mirrors Excel DLOM factors.",
  },
  blsOes: {
    label: "BLS Occupational Employment Statistics",
    url: "https://www.bls.gov/oes/",
    detail: "Market replacement wage for owner-managers by occupation and geography when normalizing officer compensation.",
  },
  sbaSop: {
    label: "SBA SOP 50 10",
    url: "https://www.sba.gov/document/sop-50-10-lender-development-company-loan-programs",
    detail: "SBA 7(a) loans often rely on income approach with 100% income weight for operating companies. Default method weights follow this convention.",
  },
  valuationTemplate: {
    label: "Valuation template defaults",
    url: undefined,
    detail: "Standard appraisal conventions (26% tax rate, WC/CAPEX adjustments) used when tax data alone is insufficient.",
  },
  /** @deprecated */
  blueOwlExcel: {
    label: "Valuation template defaults",
    url: undefined,
    detail: "Standard appraisal conventions (26% tax rate, WC/CAPEX adjustments) used when tax data alone is insufficient.",
  },
  taxReturn: {
    label: "Parsed tax return",
    url: undefined,
    detail: "Computed directly from uploaded Form 1120/1120-S workbook fields extracted by ReportGen.",
  },
  exitValue: {
    label: "ExitValue market multiples",
    url: "https://exitvalue.app",
    detail: "Completed transaction multiples by industry and size bracket for market approach cross-check.",
  },
} as const satisfies Record<string, AssumptionFieldSource>;

export function sourceFor(
  key: keyof typeof VALUATION_REFERENCES,
  extra?: Partial<AssumptionFieldSource>,
): AssumptionFieldSource {
  return { ...VALUATION_REFERENCES[key], ...extra };
}
