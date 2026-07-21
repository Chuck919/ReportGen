/** User-provided company details for normalization narrative and Word merge fields. */
export type CompanyProfile = {
  businessDescription: string;
  productsServices: string;
  customersMarkets: string;
  ownershipSummary: string;
  ownerName: string;
  entityState: string;
  entityFileNumber: string;
  entityFormationDate: string;
  normalizationNotes: string;
  relatedPartyRent: string;
  ownerCompAdjustment: string;
  oneTimeItems: string;
  discretionaryExpenses: string;
};

export const EMPTY_COMPANY_PROFILE: CompanyProfile = {
  businessDescription: "",
  productsServices: "",
  customersMarkets: "",
  ownershipSummary: "",
  ownerName: "",
  entityState: "",
  entityFileNumber: "",
  entityFormationDate: "",
  normalizationNotes: "",
  relatedPartyRent: "",
  ownerCompAdjustment: "",
  oneTimeItems: "",
  discretionaryExpenses: "",
};

export type CompanyProfileSubStep = "business" | "ownership" | "normalization";

export const COMPANY_PROFILE_SUB_STEPS: Array<{ id: CompanyProfileSubStep; label: string }> = [
  { id: "business", label: "Business & market" },
  { id: "ownership", label: "Ownership & entity" },
  { id: "normalization", label: "Normalization" },
];

/** Flatten profile into Groq / narrative context. */
export function buildCompanyNarrativeContext(profile: CompanyProfile): string {
  return [
    profile.businessDescription.trim() && `Business overview: ${profile.businessDescription.trim()}`,
    profile.productsServices.trim() && `Products/services: ${profile.productsServices.trim()}`,
    profile.customersMarkets.trim() && `Customers/markets: ${profile.customersMarkets.trim()}`,
    profile.ownershipSummary.trim() && `Ownership: ${profile.ownershipSummary.trim()}`,
    profile.ownerName.trim() && `Key owner: ${profile.ownerName.trim()}`,
    profile.normalizationNotes.trim() && `Normalization notes: ${profile.normalizationNotes.trim()}`,
    profile.relatedPartyRent.trim() && `Related-party rent: ${profile.relatedPartyRent.trim()}`,
    profile.ownerCompAdjustment.trim() && `Owner compensation adjustment: ${profile.ownerCompAdjustment.trim()}`,
    profile.oneTimeItems.trim() && `One-time/non-recurring items: ${profile.oneTimeItems.trim()}`,
    profile.discretionaryExpenses.trim() && `Discretionary expenses: ${profile.discretionaryExpenses.trim()}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function companyProfileComplete(profile: CompanyProfile): boolean {
  return Boolean(profile.businessDescription.trim() && profile.ownerName.trim());
}
