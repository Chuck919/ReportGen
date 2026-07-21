/**
 * Maps session report blocks → Word merge field names.
 * Works with Main Current «guillemet» fields and {brace} custom templates.
 */
export const PROSE_MERGE_FIELDS = [
  {
    mergeKeys: ["comp_description", "company_description", "companyDescription"],
    reportBlock: "company-description",
    reportKind: "paragraph" as const,
    source: "Batched AI (Groq gpt-oss-120b / rule-based fallback)",
    description: "Company / industry overview narrative",
  },
  {
    mergeKeys: ["Transaction_Language", "economic_implications", "economicImplications"],
    reportBlock: "implications",
    reportKind: "list" as const,
    source: "Batched AI economic implications or editable list in report",
    description: "Economic conditions / market implications",
  },
  {
    mergeKeys: ["ahead_behind", "financial_observations", "financialObservations"],
    reportBlock: "financial-observations",
    reportKind: "list" as const,
    source: "Financial observations from report (tax-derived bullets)",
    description: "Financial performance commentary",
  },
  {
    mergeKeys: ["MVIC_Verbiage", "conclusion"],
    reportBlock: "conclusion",
    reportKind: "paragraph" as const,
    source: "Conclusion paragraph (editable in report step)",
    description: "Valuation conclusion / MVIC summary",
  },
  {
    mergeKeys: ["Transaction_Type_Language", "assignment_summary", "assignmentSummary"],
    reportBlock: "assignment-summary",
    reportKind: "paragraph" as const,
    source: "Assignment summary from report",
    description: "Purpose and scope of engagement",
  },
  {
    mergeKeys: ["Ideal_Rate_Lang"],
    reportBlock: "ideal-rate-language",
    reportKind: "paragraph" as const,
    source: "Batched AI or rule-based cap-rate sentence",
    description: "Capitalization rate / normalized earnings language",
  },
] as const;

/** IS_* list fields are filled by rule-based benchmark narrative (see financial-narrative-merge.ts), not Groq. */
export const RULE_BASED_IS_MERGE_FIELDS = [
  "IS_Annualized",
  "IS_Rev",
  "IS_COGS",
  "IS_GA_Wages",
  "IS_COGS__GA_Wages",
  "IS_COGS__GA_CY",
  "IS_COGS__GA_Y1",
  "IS_COGS__GA_Y2",
  "IS_COGS__GA_Y3",
  "IS_COGS__GA_Y4",
  "IS_Rent_Expenses",
  "IS_Other_Overhead",
  "IS_Net_IncomeEBITDA",
  "IS_NIEBITDA_CY",
  "IS_NIEBITDA_Y1",
  "IS_NIEBITDA_Y2",
  "IS_NIEBITDA_Y3",
  "IS_NIEBITDA_Y4",
  "IS_Earnings_Generation",
] as const;

/** Placeholder syntax examples for UI / docs. */
export function prosePlaceholderHelp(style: "guillemet" | "brace"): string[] {
  return PROSE_MERGE_FIELDS.flatMap((field) =>
    field.mergeKeys.map((key) => (style === "guillemet" ? `«${key}»` : `{${key}}`)),
  );
}
