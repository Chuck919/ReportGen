"use client";

import { useState } from "react";
import { useAppSession } from "@/components/providers/AppSessionProvider";
import { useElapsedTimer } from "@/hooks/use-elapsed-timer";
import { SUPPORTED_TAX_FORMS_LABEL } from "@/lib/tax/tax-form-copy";
import { Container } from "@/components/ui/Container";
import { Button } from "@/components/ui/Button";
import { TaxUploadPanel } from "./TaxUploadPanel";
import { TaxWorkbookTable } from "./TaxWorkbookTable";
import { TaxWorkbookCopyBar } from "./TaxWorkbookCopyBar";
import { UploadResultSummary } from "./UploadResultSummary";
import { TrustColorGuide } from "./TrustColorGuide";

export function TaxPage() {
  const { tax: upload } = useAppSession();
  const elapsedMs = useElapsedTimer(upload.busy);
  const [reverseYears, setReverseYears] = useState(false);

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
        uploadNotice={upload.uploadNotice}
      />

      {!upload.busy && (
        <UploadResultSummary
          batchWarnings={upload.batchWarnings}
          fileErrors={upload.fileErrors}
          partial={upload.partial}
        />
      )}

      {/* Hide partial years / color guide until the full batch finishes. */}
      {upload.hasData && !upload.busy && (
        <div className="mt-8 space-y-8">
          <TrustColorGuide />
          <TaxWorkbookCopyBar columns={upload.columns} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            {upload.columns.length > 1 && (
              <Button variant="secondary" onClick={() => setReverseYears((r) => !r)}>
                Reverse years{reverseYears ? " ✓" : ""}
              </Button>
            )}
            <Button variant="ghost" className="ml-auto text-stone-500" onClick={upload.clearAll}>
              Clear all
            </Button>
          </div>
          <TaxWorkbookTable
            columns={upload.columns}
            section="Income Statement Data"
            reverseYears={reverseYears}
            onFieldEdit={upload.updateField}
            onFieldVerify={upload.verifyField}
            onOpexLabelEdit={upload.updateOpexSlotLabel}
          />
          <TaxWorkbookTable
            columns={upload.columns}
            section="Balance Sheet Data"
            reverseYears={reverseYears}
            onFieldEdit={upload.updateField}
            onFieldVerify={upload.verifyField}
          />
        </div>
      )}
    </Container>
  );
}
