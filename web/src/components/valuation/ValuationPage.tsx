"use client";

import { useMemo } from "react";
import { Container } from "@/components/ui/Container";
import { PageHeader } from "@/components/ui/PageHeader";
import { FileDropzone } from "@/components/ui/FileDropzone";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { OcrModeSelector } from "@/components/tax/OcrModeSelector";
import { TaxWorkbookTable } from "@/components/tax/TaxWorkbookTable";
import { useElapsedTimer } from "@/hooks/use-elapsed-timer";
import { useValuationWorkflow, type ValuationWizardStep } from "@/hooks/use-valuation-workflow";
import { ValuationAssumptionsPanel } from "@/components/valuation/ValuationAssumptionsPanel";
import { ValuationCompanyProfileStep } from "@/components/valuation/ValuationCompanyProfileStep";
import { ValuationFormulaTransparency } from "@/components/valuation/ValuationFormulaTransparency";
import { sectionIconSvg } from "@/lib/valuation/valuation-charts";
import type { ReportBlock } from "@/lib/valuation/types";

const STEPS: Array<{ id: ValuationWizardStep; label: string }> = [
  { id: "upload", label: "Upload" },
  { id: "review", label: "Review tax data" },
  { id: "company", label: "Company profile" },
  { id: "assumptions", label: "Assumptions" },
  { id: "report", label: "Report" },
];

function stepIndex(step: ValuationWizardStep): number {
  return STEPS.findIndex((item) => item.id === step);
}

function SectionEditor({
  sectionId,
  block,
  onChange,
}: {
  sectionId: string;
  block: ReportBlock;
  onChange: (sectionId: string, blockId: string, content: string) => void;
}) {
  if (block.kind === "cover") {
    return (
      <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm print:break-after-page">
        <div dangerouslySetInnerHTML={{ __html: block.svg }} className="w-full [&>svg]:h-auto [&>svg]:w-full" />
        {block.subtitle && <p className="border-t border-stone-200 px-6 py-3 text-sm text-stone-600">{block.subtitle}</p>}
      </div>
    );
  }
  if (block.kind === "formula") {
    return <ValuationFormulaTransparency steps={block.steps} title={block.title} />;
  }
  if (block.kind === "paragraph") {
    return (
      <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
        {block.title && <h4 className="text-sm font-semibold text-stone-900">{block.title}</h4>}
        <p className="mt-3 hidden whitespace-pre-wrap text-sm leading-relaxed text-stone-700 print:block">{block.content}</p>
        <textarea
          className="mt-3 min-h-28 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm leading-relaxed text-stone-700 outline-none focus:border-stone-400 print:hidden"
          value={block.content}
          onChange={(event) => onChange(sectionId, block.id, event.target.value)}
        />
      </div>
    );
  }
  if (block.kind === "list") {
    return (
      <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
        {block.title && <h4 className="text-sm font-semibold text-stone-900">{block.title}</h4>}
        <ul className="mt-3 hidden list-disc space-y-1 pl-5 text-sm text-stone-700 print:block">
          {block.items.map((item) => (
            <li key={item.slice(0, 40)}>{item}</li>
          ))}
        </ul>
        <textarea
          className="mt-3 min-h-28 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm leading-relaxed text-stone-700 outline-none focus:border-stone-400 print:hidden"
          value={block.items.join("\n")}
          onChange={(event) => onChange(sectionId, block.id, event.target.value)}
        />
      </div>
    );
  }
  if (block.kind === "table") {
    return (
      <div className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
        <div className="border-b border-stone-200 px-4 py-3">
          <h4 className="text-sm font-semibold text-stone-900">{block.title}</h4>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-stone-200 text-sm">
            <thead className="bg-stone-50">
              <tr>
                {block.columns.map((column) => (
                  <th key={column} className="px-4 py-2 text-left font-medium text-stone-600">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {block.rows.map((row, index) => (
                <tr key={`${block.id}-${index}`}>
                  {row.map((cell, cellIndex) => (
                    <td key={`${block.id}-${index}-${cellIndex}`} className="px-4 py-2 text-stone-700">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <h4 className="text-sm font-semibold text-stone-900">{block.title}</h4>
      <div
        className="mt-3 overflow-hidden rounded-lg border border-stone-200 bg-stone-50"
        dangerouslySetInnerHTML={{ __html: block.svg }}
      />
    </div>
  );
}

export function ValuationPage() {
  const workflow = useValuationWorkflow();
  const elapsedMs = useElapsedTimer(workflow.busy);
  const currentStep = stepIndex(workflow.step);
  const displayValuation = workflow.liveValuation ?? workflow.report?.report.valuation;
  const checklist = useMemo(() => workflow.report?.report.checklist ?? [], [workflow.report]);

  return (
    <Container className="py-10 pb-16">
      <PageHeader
        title="Valuation Draft"
        description="Upload tax returns, describe the company, and generate a Main Current valuation report — live FRED data, Groq narrative, and rule-based B/S footnotes."
      />

      <nav className="mb-8 flex flex-wrap gap-2">
        {STEPS.map((item, index) => {
          const done = index < currentStep;
          const active = item.id === workflow.step;
          return (
            <div
              key={item.id}
              className={[
                "rounded-full px-4 py-1.5 text-sm font-medium",
                active ? "bg-stone-900 text-white" : done ? "bg-stone-200 text-stone-800" : "bg-stone-100 text-stone-500",
              ].join(" ")}
            >
              {index + 1}. {item.label}
            </div>
          );
        })}
      </nav>

      {workflow.step === "upload" && (
        <section className="space-y-4 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-stone-900">Step 1 — Upload tax returns</h2>
          <FileDropzone
            label="Drop business tax returns here"
            hint="PDF only. Upload all years for the same company."
            accept=".pdf,application/pdf"
            multiple
            disabled={workflow.busy}
            onFiles={workflow.addFiles}
          />
          {!!workflow.queuedFiles.length && (
            <ul className="space-y-2 text-sm text-stone-700">
              {workflow.queuedFiles.map((file, index) => (
                <li key={`${file.name}-${file.size}`} className="flex justify-between gap-3">
                  <span className="truncate">{file.name}</span>
                  <button type="button" onClick={() => workflow.removeQueuedFile(index)} className="text-xs text-stone-500">
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <OcrModeSelector value={workflow.ocrMode} onChange={workflow.setOcrMode} disabled={workflow.busy} />
          {workflow.busy && workflow.stageLabel && (
            <ProgressBar label={workflow.stageLabel} elapsedMs={elapsedMs} percent={workflow.progressPercent} />
          )}
          {(workflow.queueError || workflow.error) && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              {workflow.queueError || workflow.error}
            </div>
          )}
          <button
            type="button"
            disabled={workflow.busy || workflow.queuedFiles.length === 0}
            onClick={workflow.parseTaxReturns}
            className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Parse tax returns
          </button>
        </section>
      )}

      {workflow.step === "review" && (
        <section className="space-y-6">
          <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-stone-900">Step 2 — Review extracted tax data</h2>
            <p className="mt-1 text-sm text-stone-600">
              Confirm sales, profit, and balance sheet lines. Edits here update normalized earnings suggestions on the next step.
            </p>
          </div>
          <TaxWorkbookTable
            columns={workflow.columns}
            section="Income Statement Data"
            onFieldEdit={workflow.updateTaxField}
            onFieldVerify={workflow.verifyTaxField}
          />
          <TaxWorkbookTable
            columns={workflow.columns}
            section="Balance Sheet Data"
            onFieldEdit={workflow.updateTaxField}
            onFieldVerify={workflow.verifyTaxField}
          />
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={() => workflow.goToStep("upload")} className="rounded-lg border border-stone-300 px-4 py-2 text-sm">
              Back
            </button>
            <button
              type="button"
              onClick={() => workflow.goToStep("company")}
              className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white"
            >
              Continue to company profile
            </button>
          </div>
        </section>
      )}

      {workflow.step === "company" && (
        <section className="space-y-6">
          <ValuationCompanyProfileStep
            profile={workflow.companyProfile}
            entityName={workflow.engagement.entityName || workflow.columns[0]?.clientName || ""}
            onChange={workflow.updateCompanyProfile}
            onLookupOrg={workflow.lookupOrgRecord}
            orgLookupBusy={workflow.orgLookupBusy}
            orgLookupMessage={workflow.orgLookupMessage}
          />
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={() => workflow.goToStep("review")} className="rounded-lg border border-stone-300 px-4 py-2 text-sm">
              Back
            </button>
            <button
              type="button"
              disabled={workflow.busy}
              onClick={() => void workflow.goToAssumptions()}
              className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Continue to assumptions
            </button>
          </div>
          {workflow.busy && workflow.stageLabel && (
            <ProgressBar label={workflow.stageLabel} elapsedMs={elapsedMs} percent={workflow.progressPercent} />
          )}
        </section>
      )}

      {workflow.step === "assumptions" && (
        <section className="space-y-6">
          <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-stone-900">Step 4 — Engagement &amp; valuation assumptions</h2>
            <p className="mt-2 text-sm text-stone-600">
              Assumptions are pre-filled from your tax return and cited industry references. You can generate the report
              without changing anything — hover the <span className="font-medium">i</span> icons to see sources.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span className="font-medium">Entity name</span>
                <input
                  className="w-full rounded-lg border border-stone-300 px-3 py-2"
                  value={workflow.engagement.entityName}
                  onChange={(e) => workflow.updateEngagement("entityName", e.target.value)}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="font-medium">Engaging party</span>
                <input
                  className="w-full rounded-lg border border-stone-300 px-3 py-2"
                  value={workflow.engagement.engagingParty}
                  onChange={(e) => workflow.updateEngagement("engagingParty", e.target.value)}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="font-medium">Bank / company name (cover)</span>
                <input
                  className="w-full rounded-lg border border-stone-300 px-3 py-2"
                  value={workflow.engagement.company}
                  onChange={(e) => workflow.updateEngagement("company", e.target.value)}
                  placeholder="Defaults to engaging party"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="font-medium">Officer title (cover)</span>
                <input
                  className="w-full rounded-lg border border-stone-300 px-3 py-2"
                  value={workflow.engagement.title}
                  onChange={(e) => workflow.updateEngagement("title", e.target.value)}
                  placeholder="VP, Commercial Loan Officer"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="font-medium">City (cover)</span>
                <input
                  className="w-full rounded-lg border border-stone-300 px-3 py-2"
                  value={workflow.engagement.city}
                  onChange={(e) => workflow.updateEngagement("city", e.target.value)}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="font-medium">Purpose</span>
                <input
                  className="w-full rounded-lg border border-stone-300 px-3 py-2"
                  value={workflow.engagement.purpose}
                  onChange={(e) => workflow.updateEngagement("purpose", e.target.value)}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="font-medium">NAICS</span>
                <input
                  className="w-full rounded-lg border border-stone-300 px-3 py-2"
                  value={workflow.engagement.naics}
                  onChange={(e) => workflow.updateEngagement("naics", e.target.value)}
                  placeholder="445292"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="font-medium">MSA label</span>
                <input
                  className="w-full rounded-lg border border-stone-300 px-3 py-2"
                  value={workflow.engagement.msaLabel}
                  onChange={(e) => workflow.updateEngagement("msaLabel", e.target.value)}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="font-medium">CBSA code</span>
                <input
                  className="w-full rounded-lg border border-stone-300 px-3 py-2"
                  value={workflow.engagement.cbsaCode}
                  onChange={(e) => workflow.updateEngagement("cbsaCode", e.target.value)}
                />
              </label>
            </div>
            <label className="mt-4 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={workflow.engagement.useGroq}
                onChange={(e) => workflow.updateEngagement("useGroq", e.target.checked)}
              />
              Draft narrative with Groq (fills company, economic, and conclusion sections in the Word report)
            </label>
          </div>

          <ValuationAssumptionsPanel
            inputs={workflow.valuationInputs}
            onChange={workflow.updateValuationInput}
            liveReconciledValue={workflow.liveValuation?.reconciledValue}
          />

          {workflow.liveValuation?.formulas && (
            <ValuationFormulaTransparency steps={workflow.liveValuation.formulas} title="Live formula audit (preview)" />
          )}

          {workflow.busy && workflow.stageLabel && (
            <ProgressBar label={workflow.stageLabel} elapsedMs={elapsedMs} percent={workflow.progressPercent} />
          )}
          {workflow.error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{workflow.error}</div>
          )}

          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={() => workflow.goToStep("company")} className="rounded-lg border border-stone-300 px-4 py-2 text-sm">
              Back
            </button>
            <button
              type="button"
              disabled={workflow.busy || !workflow.columns.length}
              onClick={workflow.generateReport}
              className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Generate valuation report
            </button>
          </div>
        </section>
      )}

      {workflow.step === "report" && workflow.report && (
        <div className="grid gap-8 lg:grid-cols-[320px,1fr] print:block">
          <aside className="no-print space-y-4 lg:sticky lg:top-6 lg:self-start">
            <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
              <p className="text-sm font-semibold text-stone-900">{workflow.report.report.entityName}</p>
              <p className="mt-2 text-2xl font-semibold text-stone-900">
                {displayValuation?.reconciledValue.toLocaleString("en-US", {
                  style: "currency",
                  currency: "USD",
                  maximumFractionDigits: 0,
                })}
              </p>
              <p className="mt-1 text-xs text-stone-500">Updates live when you change assumptions below.</p>
              <button
                type="button"
                disabled={workflow.docxBusy}
                onClick={workflow.downloadDocx}
                className="mt-4 w-full rounded-lg bg-stone-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {workflow.docxBusy ? "Building report…" : "Download Word report (.docx)"}
              </button>
              <p className="mt-2 text-xs text-stone-500">
                Main Current template with your data, Groq narrative, live charts, and B/S footnotes.
              </p>
              <button
                type="button"
                disabled={workflow.pdfBusy}
                onClick={workflow.downloadPdf}
                className="mt-2 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm disabled:opacity-50"
              >
                {workflow.pdfBusy ? "Building PDF…" : "Download PDF preview"}
              </button>
              <button type="button" onClick={workflow.printReport} className="mt-2 w-full rounded-lg px-3 py-2 text-xs text-stone-500">
                Print preview
              </button>
              <button type="button" onClick={workflow.resetWorkflow} className="mt-2 w-full rounded-lg px-3 py-2 text-xs text-stone-500">
                Start over
              </button>
            </div>
            <ValuationAssumptionsPanel
              compact
              inputs={workflow.valuationInputs}
              onChange={workflow.updateValuationInput}
              liveReconciledValue={displayValuation?.reconciledValue}
            />
            <ul className="space-y-2">
              {checklist.map((item) => (
                <li
                  key={item.id}
                  className={[
                    "rounded-lg border px-3 py-2 text-xs",
                    item.pass ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900",
                  ].join(" ")}
                >
                  {item.label}
                </li>
              ))}
            </ul>
          </aside>

          <section className="valuation-report-print space-y-6 print:w-full">
            {workflow.report.report.sections.map((section) => (
              <section key={section.id} className="space-y-4 print:break-inside-avoid">
                {section.id !== "cover" && (
                  <div className="print-break-inside-avoid flex items-center gap-3 rounded-2xl border border-stone-200 bg-stone-50 px-5 py-4">
                    <span
                      className="text-stone-600"
                      dangerouslySetInnerHTML={{ __html: sectionIconSvg(section.id) }}
                    />
                    <h3 className="text-xl font-semibold text-stone-900">{section.title}</h3>
                  </div>
                )}
                <div className="grid gap-4">
                  {section.blocks.map((block) => (
                    <SectionEditor
                      key={block.id}
                      sectionId={section.id}
                      block={block}
                      onChange={workflow.updateSectionContent}
                    />
                  ))}
                </div>
              </section>
            ))}
          </section>
        </div>
      )}
    </Container>
  );
}
