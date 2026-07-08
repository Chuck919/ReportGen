"use client";

import type { OcrMode } from "@/lib/api/types";
import { isVercelDeploy } from "@/lib/tax/ocr-modes";
import { getOcrModeOptions } from "@/lib/tax/ocr-modes";
import {
  SUPPORTED_TAX_FORMS_LABEL,
  TAX_MULTI_YEAR_HINT,
  TAX_UPLOAD_HINT,
} from "@/lib/tax/tax-form-copy";
import { FileDropzone } from "@/components/ui/FileDropzone";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Button } from "@/components/ui/Button";
import { OcrModeSelector } from "./OcrModeSelector";
import { formatElapsed } from "@/lib/ui/format-elapsed";

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function TaxUploadPanel({
  hasData,
  ocrMode,
  onOcrModeChange,
  queuedFiles,
  onAddFiles,
  onRemoveFile,
  onClearQueue,
  onStart,
  canStart,
  busy,
  progressLabel,
  progressHint,
  elapsedMs,
  progressPercent,
  error,
  queueError,
}: {
  hasData: boolean;
  ocrMode: OcrMode;
  onOcrModeChange: (mode: OcrMode) => void;
  queuedFiles: File[];
  onAddFiles: (files: FileList | null) => void;
  onRemoveFile: (index: number) => void;
  onClearQueue: () => void;
  onStart: () => void;
  canStart: boolean;
  busy: boolean;
  progressLabel?: string;
  progressHint?: string;
  elapsedMs: number;
  progressPercent?: number;
  error?: string;
  queueError?: string;
}) {
  const modeDetail = getOcrModeOptions().find((m) => m.id === ocrMode)?.detail;

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
      <FileDropzone
        label={`Add ${SUPPORTED_TAX_FORMS_LABEL} tax return PDF`}
        hint={
          hasData
            ? "Clear all results above before uploading another return."
            : isVercelDeploy()
              ? "Add a PDF, then click Start"
              : TAX_UPLOAD_HINT
        }
        accept="application/pdf"
        multiple={false}
        disabled={busy || hasData}
        onFiles={onAddFiles}
      />

      {!hasData && <p className="mt-3 text-xs text-stone-500">{TAX_MULTI_YEAR_HINT}</p>}

      {queuedFiles.length > 0 && (
        <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50/80 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-stone-800">
              Ready to process ({queuedFiles.length} PDF{queuedFiles.length === 1 ? "" : "s"})
            </p>
            {!busy && (
              <button
                type="button"
                onClick={onClearQueue}
                className="text-xs text-stone-500 hover:text-stone-800"
              >
                Clear list
              </button>
            )}
          </div>
          <ul className="mt-2 space-y-1">
            {queuedFiles.map((file, index) => (
              <li
                key={`${file.name}-${file.size}-${index}`}
                className="flex items-center justify-between gap-3 text-sm text-stone-700"
              >
                <span className="truncate">{file.name}</span>
                <span className="flex shrink-0 items-center gap-2 tabular-nums text-stone-500">
                  {formatFileSize(file.size)}
                  {!busy && (
                    <button
                      type="button"
                      onClick={() => onRemoveFile(index)}
                      className="text-stone-400 hover:text-red-600"
                      aria-label={`Remove ${file.name}`}
                    >
                      ×
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
        <OcrModeSelector value={ocrMode} onChange={onOcrModeChange} disabled={busy} />
        <Button
          variant="primary"
          onClick={onStart}
          disabled={!canStart}
          className={!canStart ? "cursor-not-allowed opacity-40" : ""}
        >
          {busy ? "Processing…" : "Start extraction"}
        </Button>
      </div>

      {modeDetail && (
        <p className="mt-2 text-xs text-stone-500">{modeDetail}</p>
      )}

      {busy && progressLabel && (
        <div className="mt-5">
          <ProgressBar label={progressLabel} elapsedMs={elapsedMs} percent={progressPercent} hint={progressHint} />
        </div>
      )}

      {!busy && elapsedMs > 0 && (
        <p className="mt-4 text-sm text-stone-600">
          Last extraction finished in{" "}
          <span className="font-medium tabular-nums text-stone-900">
            {formatElapsed(elapsedMs)}
          </span>
        </p>
      )}

      {(queueError || error) && (
        <p className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
          {queueError || error}
        </p>
      )}
    </div>
  );
}
