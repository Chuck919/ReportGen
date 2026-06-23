"use client";

import { useAppSession } from "@/components/providers/AppSessionProvider";
import { useElapsedTimer } from "@/hooks/use-elapsed-timer";
import { SUPPORTED_TAX_FORMS_LABEL } from "@/lib/tax/tax-form-copy";
import { Container } from "@/components/ui/Container";
import { Button } from "@/components/ui/Button";
import { TaxUploadPanel } from "./TaxUploadPanel";
import { TaxWorkbookTable } from "./TaxWorkbookTable";
import { UploadResultSummary } from "./UploadResultSummary";
import { TrustColorGuide } from "./TrustColorGuide";

export function TaxPage() {
  const { tax: upload } = useAppSession();
  const elapsedMs = useElapsedTimer(upload.busy);

  return (
    <Container className="py-12">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-stone-900">Tax returns</h1>
        <p className="mt-1 text-sm text-stone-500">
          Upload {SUPPORTED_TAX_FORMS_LABEL} PDFs to extract workbook values. Data stays in this browser tab only.
        </p>
      </header>

      <TaxUploadPanel
        ocrMode={upload.ocrMode}
        onOcrModeChange={upload.setOcrMode}
        queuedFiles={upload.queuedFiles}
        onAddFiles={upload.addFiles}
        onRemoveFile={upload.removeQueuedFile}
        onClearQueue={upload.clearQueue}
        onStart={upload.startParse}
        canStart={upload.canStart}
        busy={upload.busy}
        progressLabel={upload.progressLabel}
        progressHint={upload.progressHint}
        elapsedMs={elapsedMs}
        progressPercent={upload.progressPercent}
        error={upload.error}
        queueError={upload.queueError}
      />

      <UploadResultSummary
        batchWarnings={upload.batchWarnings}
        fileErrors={upload.fileErrors}
        partial={upload.partial}
      />

      {upload.hasData && (
        <div className="mt-8 space-y-8">
          {upload.clientName && (
            <p className="text-sm text-stone-600">
              Company: <span className="font-medium text-stone-900">{upload.clientName}</span>
            </p>
          )}
          <TrustColorGuide />
          <div className="flex justify-end">
            <Button variant="ghost" className="text-stone-500" onClick={upload.clearAll}>
              Clear all
            </Button>
          </div>
          <TaxWorkbookTable
            columns={upload.columns}
            section="Income Statement Data"
            onFieldEdit={upload.updateField}
          />
          <TaxWorkbookTable
            columns={upload.columns}
            section="Balance Sheet Data"
            onFieldEdit={upload.updateField}
          />
        </div>
      )}
    </Container>
  );
}
