"use client";

import type { OcrMode } from "@/lib/api/types";
import { isVercelDeploy } from "@/lib/tax/ocr-modes";
import { FileDropzone } from "@/components/ui/FileDropzone";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { OcrModeSelector } from "./OcrModeSelector";

export function TaxUploadPanel({
  ocrMode,
  onOcrModeChange,
  onFiles,
  busy,
  progressLabel,
  elapsedMs,
  progressPercent,
  error,
}: {
  ocrMode: OcrMode;
  onOcrModeChange: (mode: OcrMode) => void;
  onFiles: (files: FileList | null) => void;
  busy: boolean;
  progressLabel?: string;
  elapsedMs: number;
  progressPercent?: number;
  error?: string;
}) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
      <FileDropzone
        label="Drop 1120-S tax return PDF"
        hint={
          isVercelDeploy()
            ? "One PDF at a time · ~3 min on Balanced"
            : "PDF with statements included · multiple years OK"
        }
        accept="application/pdf"
        multiple
        onFiles={onFiles}
      />

      <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
        <OcrModeSelector value={ocrMode} onChange={onOcrModeChange} disabled={busy} />
      </div>

      {busy && progressLabel && (
        <div className="mt-5">
          <ProgressBar label={progressLabel} elapsedMs={elapsedMs} percent={progressPercent} />
        </div>
      )}

      {error && (
        <p className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
