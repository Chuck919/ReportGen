import type { SourceTag } from "@/lib/valuation/types";
import { draftReportNarrativeBatched, type BatchedNarrativeInput } from "@/lib/valuation/ai-narrative";

type GroqDraftInput = {
  entityName: string;
  naicsTitle?: string;
  msaLabel?: string;
  companyContext?: string;
  bullets: string[];
  sources: SourceTag[];
};

/** @deprecated Use draftReportNarrativeBatched — kept for /api/valuation/narrative compatibility. */
export async function draftNarrativeWithGroq(input: GroqDraftInput): Promise<string | null> {
  const batchInput: BatchedNarrativeInput = {
    entityName: input.entityName,
    purpose: "valuation support",
    engagingParty: "To be confirmed",
    naicsTitle: input.naicsTitle,
    msaLabel: input.msaLabel,
    companyContext: input.companyContext,
    valuationDate: new Date().toISOString().slice(0, 10),
    issuanceDate: new Date().toISOString().slice(0, 10),
    taxYears: [],
    reconciledValue: "",
    capitalizationRate: "",
    normalizedEarnings: "",
    tangibleAssetValue: "",
    intangibleValue: "",
    implicationBullets: input.bullets,
    financialBullets: [],
    sources: input.sources,
    columns: [],
  };
  const { draft } = await draftReportNarrativeBatched(batchInput, { useAi: true });
  return [draft.company_description, ...draft.economic_implications].filter(Boolean).join("\n\n") || null;
}
