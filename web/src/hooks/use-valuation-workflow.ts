import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseTaxReturnFiles } from "@/lib/api/parse-tax-return";
import type { OcrMode } from "@/lib/api/types";
import { applyUserFieldCorrection, applyUserFieldVerification, enrichParsedTaxYear } from "@/lib/tax/apply-user-correction";
import { finalizeTaxColumns } from "@/lib/tax/merge-years";
import { defaultOcrMode } from "@/lib/tax/ocr-modes";
import { buildGenerateRequest } from "@/lib/valuation/build-request";
import { inferValuationInputs, type ValuationInputDraft } from "@/lib/valuation/defaults";
import { applyIntegratorWorkbookDefaults } from "@/lib/valuation/integrator-workbook";
import { enrichValuationInputsFromLiveData } from "@/lib/valuation/enrich-valuation-inputs";
import { EMPTY_COMPANY_PROFILE, type CompanyProfile } from "@/lib/valuation/company-profile";
import { buildValuationMath } from "@/lib/valuation/math";
import type { GenerateValuationResponse, MarketMultiplesProfile } from "@/lib/valuation/types";
import type { TaxYearValues } from "@/lib/tax-workbook";
import { validateClientFileList } from "@/lib/tax/validate-upload";

export type ValuationWizardStep = "upload" | "review" | "company" | "assumptions" | "report";

type EngagementFields = {
  entityName: string;
  engagingParty: string;
  purpose: string;
  naics: string;
  msaLabel: string;
  cbsaCode: string;
  zipCode: string;
  useGroq: boolean;
  city: string;
  title: string;
  company: string;
};

const EMPTY_ENGAGEMENT: EngagementFields = {
  entityName: "",
  engagingParty: "",
  purpose: "SBA lending support",
  naics: "",
  msaLabel: "",
  cbsaCode: "",
  zipCode: "",
  useGroq: true,
  city: "",
  title: "",
  company: "",
};

const EMPTY_MARKET: MarketMultiplesProfile = {
  vertical: "unknown",
  bracket: "unknown",
  metrics: [],
  source: { label: "Market data pending" },
};

export function useValuationWorkflow() {
  const [step, setStep] = useState<ValuationWizardStep>("upload");
  const [queuedFiles, setQueuedFiles] = useState<File[]>([]);
  const [queueError, setQueueError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [stageLabel, setStageLabel] = useState("");
  const [progressPercent, setProgressPercent] = useState<number | undefined>();
  const [columns, setColumns] = useState<TaxYearValues[]>([]);
  const [ocrMode, setOcrMode] = useState<OcrMode>(defaultOcrMode());
  const [engagement, setEngagement] = useState<EngagementFields>(EMPTY_ENGAGEMENT);
  const [companyProfile, setCompanyProfile] = useState<CompanyProfile>(EMPTY_COMPANY_PROFILE);
  const [orgLookupBusy, setOrgLookupBusy] = useState(false);
  const [orgLookupMessage, setOrgLookupMessage] = useState("");
  const [valuationInputs, setValuationInputs] = useState<ValuationInputDraft>(() =>
    applyIntegratorWorkbookDefaults([]),
  );
  const [report, setReport] = useState<GenerateValuationResponse | null>(null);
  const [marketProfile, setMarketProfile] = useState<MarketMultiplesProfile>(EMPTY_MARKET);
  const [docxBusy, setDocxBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const regenerateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextAutoRegen = useRef(false);

  const addFiles = useCallback(
    (list: FileList | null) => {
      if (!list?.length || busy) return;
      const files = Array.from(list);
      const validation = validateClientFileList(files);
      if (!validation.ok) {
        const message = validation.checks.flatMap((check) => check.errors.map((errorText) => `${check.filename}: ${errorText}`)).join(" ");
        setQueueError(message || "Invalid upload");
        return;
      }
      setQueueError("");
      setQueuedFiles((prev) => [...prev, ...files.filter((file) => !prev.some((existing) => existing.name === file.name && existing.size === file.size))]);
    },
    [busy],
  );

  const removeQueuedFile = useCallback((index: number) => {
    setQueuedFiles((prev) => prev.filter((_, fileIndex) => fileIndex !== index));
  }, []);

  const updateEngagement = useCallback((key: keyof EngagementFields, value: string | boolean) => {
    setEngagement((prev) => ({ ...prev, [key]: value }));
  }, []);

  const updateCompanyProfile = useCallback((key: keyof CompanyProfile, value: string) => {
    setCompanyProfile((prev) => ({ ...prev, [key]: value }));
  }, []);

  const enrichInputsFromLiveData = useCallback(async (cols: TaxYearValues[], base?: ValuationInputDraft) => {
    try {
      const seeded = applyIntegratorWorkbookDefaults(cols, base);
      const enriched = await enrichValuationInputsFromLiveData(cols, seeded);
      setValuationInputs(applyIntegratorWorkbookDefaults(cols, enriched));
    } catch {
      setValuationInputs(applyIntegratorWorkbookDefaults(cols, base));
    }
  }, []);

  const lookupOrgRecord = useCallback(async () => {
    const entityName = engagement.entityName.trim() || columns[0]?.clientName || "";
    const state = companyProfile.entityState.trim();
    if (!entityName || state.length !== 2) return;
    setOrgLookupBusy(true);
    setOrgLookupMessage("");
    try {
      const res = await fetch("/api/valuation/org-lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entityName, state }),
      });
      const json = (await res.json()) as {
        found?: boolean;
        result?: { fileNumber: string; formationDate: string; entityName: string; status: string };
        message?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error || "Lookup failed");
      if (json.found && json.result) {
        setCompanyProfile((prev) => ({
          ...prev,
          entityFileNumber: json.result!.fileNumber || prev.entityFileNumber,
          entityFormationDate: json.result!.formationDate || prev.entityFormationDate,
        }));
        setOrgLookupMessage(`Found: ${json.result.entityName} (${json.result.status})`);
      } else {
        setOrgLookupMessage(json.message ?? "No record found.");
      }
    } catch (e) {
      setOrgLookupMessage(e instanceof Error ? e.message : "Lookup failed.");
    } finally {
      setOrgLookupBusy(false);
    }
  }, [columns, companyProfile.entityState, engagement.entityName]);

  const goToAssumptions = useCallback(async () => {
    if (columns.length) {
      setBusy(true);
      setStageLabel("Loading live capital market data (FRED)…");
      await enrichInputsFromLiveData(columns, valuationInputs);
      setBusy(false);
      setStageLabel("");
    }
    setStep("assumptions");
  }, [columns, enrichInputsFromLiveData, valuationInputs]);

  const updateValuationInput = useCallback(<K extends keyof ValuationInputDraft>(key: K, value: ValuationInputDraft[K]) => {
    setValuationInputs((prev) => ({ ...prev, [key]: value }));
  }, []);

  const updateTaxField = useCallback((year: number, fieldId: string, value: number, source?: string) => {
    setColumns((prev) => {
      const next = finalizeTaxColumns(
        prev.map((col) => (col.year === year ? applyUserFieldCorrection(col, fieldId, value, source) : col)),
      );
      setValuationInputs((inputs) => applyIntegratorWorkbookDefaults(next, inputs));
      return next;
    });
  }, []);

  const verifyTaxField = useCallback((year: number, fieldId: string, verified: boolean) => {
    setColumns((prev) =>
      finalizeTaxColumns(
        prev.map((col) => (col.year === year ? applyUserFieldVerification(col, fieldId, verified) : col)),
      ),
    );
  }, []);

  const parseTaxReturns = useCallback(async () => {
    if (!queuedFiles.length || busy) return;
    setBusy(true);
    setError("");
    setReport(null);
    setStageLabel("Parsing tax returns…");
    setProgressPercent(5);
    try {
      const json = await parseTaxReturnFiles(
        queuedFiles,
        { ocrMode },
        (progress) => {
          setStageLabel(progress.label);
          setProgressPercent(progress.percent);
        },
      );
      const parsed = json.parsed.map(enrichParsedTaxYear);
      setColumns(finalizeTaxColumns(parsed));
      const inferredEntity = parsed[0]?.clientName ?? "";
      setEngagement((prev) => ({
        ...prev,
        entityName: prev.entityName.trim() || inferredEntity,
      }));
      setValuationInputs(applyIntegratorWorkbookDefaults(parsed));
      setQueuedFiles([]);
      setStep("review");
      setStageLabel("Tax data ready for review");
      setProgressPercent(100);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not parse tax returns.");
    } finally {
      setBusy(false);
    }
  }, [busy, ocrMode, queuedFiles]);

  const fetchReport = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!columns.length) return;
      if (!options?.silent) {
        setBusy(true);
        setError("");
        setStageLabel("Generating valuation draft…");
        setProgressPercent(15);
      }
      try {
        const body = buildGenerateRequest({
          columns,
          entityName: engagement.entityName,
          engagingParty: engagement.engagingParty,
          purpose: engagement.purpose,
          naics: engagement.naics,
          msaLabel: engagement.msaLabel,
          cbsaCode: engagement.cbsaCode,
          zipCode: engagement.zipCode,
          useGroq: engagement.useGroq,
          valuationInputs,
          companyProfile,
        });
        const res = await fetch("/api/valuation/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await res.json()) as GenerateValuationResponse & { error?: string };
        if (!res.ok) throw new Error(json.error || "Could not generate valuation draft.");
        setReport(json);
        setMarketProfile(json.market);
        skipNextAutoRegen.current = true;
        setStep("report");
        if (!options?.silent) {
          setStageLabel("Draft ready");
          setProgressPercent(100);
        }
      } catch (e) {
        if (!options?.silent) {
          setError(e instanceof Error ? e.message : "Could not generate valuation draft.");
        }
      } finally {
        if (!options?.silent) setBusy(false);
      }
    },
    [columns, engagement, valuationInputs, companyProfile],
  );

  const generateReport = useCallback(async () => {
    await fetchReport();
  }, [fetchReport]);

  const liveValuation = useMemo(() => {
    if (!columns.length) return null;
    const market =
      marketProfile.metrics.length > 0
        ? marketProfile
        : report?.market?.metrics?.length
          ? report.market
          : EMPTY_MARKET;
    return buildValuationMath({
      columns,
      market,
      valuationAssumptions: buildGenerateRequest({ columns, valuationInputs, companyProfile }).valuationAssumptions,
    });
  }, [columns, marketProfile, report?.market, valuationInputs, companyProfile]);

  useEffect(() => {
    if (step !== "report" || !columns.length) return;
    if (skipNextAutoRegen.current) {
      skipNextAutoRegen.current = false;
      return;
    }
    if (regenerateTimer.current) clearTimeout(regenerateTimer.current);
    regenerateTimer.current = setTimeout(() => {
      void fetchReport({ silent: true });
    }, 1200);
    return () => {
      if (regenerateTimer.current) clearTimeout(regenerateTimer.current);
    };
  }, [valuationInputs, engagement, companyProfile, columns, step, fetchReport]);

  const updateSectionContent = useCallback((sectionId: string, blockId: string, content: string) => {
    setReport((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        report: {
          ...prev.report,
          sections: prev.report.sections.map((section) =>
            section.id === sectionId
              ? {
                  ...section,
                  blocks: section.blocks.map((block) =>
                    block.id === blockId && (block.kind === "paragraph" || block.kind === "list")
                      ? block.kind === "paragraph"
                        ? { ...block, content }
                        : { ...block, items: content.split(/\n+/).map((item) => item.trim()).filter(Boolean) }
                      : block,
                  ),
                }
              : section,
          ),
        },
      };
    });
  }, []);

  const goToStep = useCallback((next: ValuationWizardStep) => {
    setError("");
    setStep(next);
  }, []);

  const resetWorkflow = useCallback(() => {
    setStep("upload");
    setQueuedFiles([]);
    setColumns([]);
    setReport(null);
    setEngagement(EMPTY_ENGAGEMENT);
    setCompanyProfile(EMPTY_COMPANY_PROFILE);
    setOrgLookupMessage("");
    setValuationInputs(applyIntegratorWorkbookDefaults([]));
    setError("");
    setQueueError("");
  }, []);

  const printReport = useCallback(() => {
    if (typeof window !== "undefined") window.print();
  }, []);

  const downloadDocx = useCallback(async () => {
    if (!report?.report || docxBusy) return;
    setDocxBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("report", JSON.stringify(report.report));
      form.append("mode", "firm");
      form.append(
        "context",
        JSON.stringify({
          columns,
          valuationInputs,
          engagement: {
            city: engagement.city,
            title: engagement.title,
            company: engagement.company || engagement.engagingParty,
            owner: companyProfile.ownerName,
            companyProfile,
          },
        }),
      );
      const res = await fetch("/api/valuation/export-docx", { method: "POST", body: form });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error || "Could not export Word document.");
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match?.[1] ?? "valuation-report.docx";
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not export Word document.");
    } finally {
      setDocxBusy(false);
    }
  }, [columns, companyProfile, docxBusy, engagement, report?.report, valuationInputs]);

  const downloadPdf = useCallback(async () => {
    if (!report?.report || pdfBusy) return;
    setPdfBusy(true);
    setError("");
    try {
      const res = await fetch("/api/valuation/export-pdf", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ report: report.report }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error || "Could not export PDF.");
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match?.[1] ?? "valuation-report.pdf";
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not export PDF.");
    } finally {
      setPdfBusy(false);
    }
  }, [pdfBusy, report?.report]);

  return useMemo(
    () => ({
      step,
      goToStep,
      resetWorkflow,
      queuedFiles,
      queueError,
      error,
      busy,
      stageLabel,
      progressPercent,
      columns,
      ocrMode,
      setOcrMode,
      engagement,
      companyProfile,
      orgLookupBusy,
      orgLookupMessage,
      valuationInputs,
      report,
      liveValuation,
      docxBusy,
      pdfBusy,
      addFiles,
      removeQueuedFile,
      updateEngagement,
      updateCompanyProfile,
      lookupOrgRecord,
      goToAssumptions,
      updateValuationInput,
      updateTaxField,
      verifyTaxField,
      parseTaxReturns,
      generateReport,
      updateSectionContent,
      printReport,
      downloadPdf,
      downloadDocx,
    }),
    [
      step,
      goToStep,
      resetWorkflow,
      queuedFiles,
      queueError,
      error,
      busy,
      stageLabel,
      progressPercent,
      columns,
      ocrMode,
      engagement,
      companyProfile,
      orgLookupBusy,
      orgLookupMessage,
      valuationInputs,
      report,
      liveValuation,
      docxBusy,
      pdfBusy,
      addFiles,
      removeQueuedFile,
      updateEngagement,
      updateCompanyProfile,
      lookupOrgRecord,
      goToAssumptions,
      updateValuationInput,
      updateTaxField,
      verifyTaxField,
      parseTaxReturns,
      generateReport,
      updateSectionContent,
      printReport,
      downloadPdf,
      downloadDocx,
    ],
  );
}
