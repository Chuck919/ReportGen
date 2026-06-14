"use client";

import { isVercelDeploy } from "@/lib/tax/ocr-modes";

export function UploadGuidance() {
  const onVercel = isVercelDeploy();
  return (
    <div className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-xs text-stone-600">
      <p className="font-medium text-stone-700">Upload tips</p>
      <ul className="mt-2 list-inside list-disc space-y-1">
        <li>One complete Form 1120-S PDF per tax year works best (including statements).</li>
        {onVercel ? (
          <li>On Vercel: one file is processed per request (~3–5 min). You can upload multiple years sequentially.</li>
        ) : (
          <li>Multiple years: each file is processed in order; results merge into the workbook table.</li>
        )}
        <li>Re-uploading the same year merges fields by confidence (higher wins).</li>
        <li>Split returns (separate PDFs for the same year) merge by confidence — prefer one combined export.</li>
        <li>Scanned/image PDFs require OCR; digital PDFs with text may skip OCR when sufficient.</li>
      </ul>
    </div>
  );
}
