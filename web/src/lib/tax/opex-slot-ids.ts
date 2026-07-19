/**
 * Integrator workbook top-8 opex paste rows. Positions, not semantic categories —
 * row 3 may hold "Repairs" while the id is still `advertising`.
 *
 * Leaf module (no imports) so formula/identity consumers can share the canonical
 * list without creating an import cycle through the extraction pipeline.
 */
export const OPERATING_EXPENSE_SLOT_IDS = [
  "officer_compensation",
  "salaries_wages",
  "advertising",
  "rent",
  "taxes_licenses",
  "bank_credit_card",
  "professional_fees",
  "utilities",
] as const;

export type OperatingExpenseSlotId = (typeof OPERATING_EXPENSE_SLOT_IDS)[number];
