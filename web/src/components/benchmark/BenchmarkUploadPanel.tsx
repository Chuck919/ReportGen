"use client";

import { FileDropzone } from "@/components/ui/FileDropzone";
import { ProgressBar } from "@/components/ui/ProgressBar";

export function BenchmarkUploadPanel({
  onFile,
  busy,
  elapsedMs,
  error,
}: {
  onFile: (file: File | null) => void;
  busy: boolean;
  elapsedMs: number;
  error?: string;
}) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-white shadow-sm px-6 py-5">
      <FileDropzone
        label="Choose industry benchmark PDF"
        hint="IBIS / na01032-style reports with financial tables"
        accept="application/pdf"
        onFiles={(files) => onFile(files?.[0] ?? null)}
      />
      {busy && (
        <div className="mt-5">
          <ProgressBar
            label="Uploading and parsing…"
            elapsedMs={elapsedMs}
            hint="Benchmark OCR uses fewer pages than full tax packets."
          />
        </div>
      )}
      {error && (
        <p className="mt-4 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
