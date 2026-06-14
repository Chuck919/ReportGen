"use client";

import { useMemo } from "react";
import { useTaxUpload } from "@/hooks/use-tax-upload";
import { useElapsedTimer } from "@/hooks/use-elapsed-timer";
import { buildPasteTsv } from "@/lib/tax-workbook";
import { Container } from "@/components/ui/Container";
import { TaxUploadPanel } from "./TaxUploadPanel";
import { TaxToolbar } from "./TaxToolbar";
import { TaxWorkbookTable } from "./TaxWorkbookTable";
import { UploadResultSummary } from "./UploadResultSummary";

export function TaxPage() {
  const upload = useTaxUpload();
  const elapsedMs = useElapsedTimer(upload.busy);
  const pasteTsv = useMemo(() => buildPasteTsv(upload.columns), [upload.columns]);

  return (
    <Container className="py-12">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-stone-900">Tax returns</h1>
        <p className="mt-1 text-sm text-stone-500">
          Upload a 1120-S PDF to extract workbook values. Results save in your browser.
        </p>
      </header>

      <TaxUploadPanel
        ocrMode={upload.ocrMode}
        onOcrModeChange={upload.setOcrMode}
        onFiles={upload.onFiles}
        busy={upload.busy}
        progressLabel={upload.progressLabel}
        elapsedMs={elapsedMs}
        progressPercent={upload.progressPercent}
        error={upload.error}
      />

      <UploadResultSummary
        batchWarnings={upload.batchWarnings}
        fileErrors={upload.fileErrors}
        partial={upload.partial}
      />

      {upload.hasData && (
        <div className="mt-8 space-y-4">
          <TaxToolbar pasteTsv={pasteTsv} onClear={upload.clearAll} />
          <TaxWorkbookTable columns={upload.columns} />
        </div>
      )}
    </Container>
  );
}
