import type { GenerateValuationRequest } from "@/lib/valuation/types";
import type { TaxYearValues } from "@/lib/tax-workbook";
import type { ValuationInputDraft } from "@/lib/valuation/defaults";
import type { CompanyProfile } from "@/lib/valuation/company-profile";
import { buildCompanyNarrativeContext } from "@/lib/valuation/company-profile";

export function buildGenerateRequest(input: {
  columns: TaxYearValues[];
  entityName?: string;
  engagingParty?: string;
  purpose?: string;
  naics?: string;
  msaLabel?: string;
  cbsaCode?: string;
  zipCode?: string;
  useGroq?: boolean;
  valuationInputs: ValuationInputDraft;
  companyProfile?: CompanyProfile;
  dateOfIssuance?: string;
}): GenerateValuationRequest {
  const { valuationInputs, companyProfile, ...rest } = input;
  const {
    normalizedEarnings,
    preTaxNetIncomeCapRate,
    assetIndicatedValue,
    workingCapitalAdjustment,
    capexAdjustment,
    equityWeight,
    costOfDebt,
    taxRate,
    companyContext,
    fieldSources,
    riskFreeRate,
    equityRiskPremium,
    sizePremium,
    companySpecificRisk,
    longTermGrowthRate,
    dlomRate,
    incomeWeight,
    assetWeight,
    marketWeight,
  } = valuationInputs;

  const profileContext = companyProfile ? buildCompanyNarrativeContext(companyProfile) : "";
  const mergedContext = [companyContext.trim(), profileContext].filter(Boolean).join("\n\n");

  return {
    ...rest,
    dateOfIssuance: rest.dateOfIssuance,
    companyContext: mergedContext || undefined,
    companyProfile,
    valuationAssumptions: {
      normalizedEarnings,
      preTaxNetIncomeCapRate,
      assetIndicatedValue,
      workingCapitalAdjustment,
      capexAdjustment,
      equityWeight,
      costOfDebt,
      taxRate,
      fieldSources,
      riskFreeRate,
      equityRiskPremium,
      sizePremium,
      companySpecificRisk,
      longTermGrowthRate,
      dlomRate,
      incomeWeight,
      assetWeight,
      marketWeight,
    },
  };
}
