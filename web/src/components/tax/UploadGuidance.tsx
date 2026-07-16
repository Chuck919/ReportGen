"use client";

import { SUPPORTED_TAX_FORMS_LABEL } from "@/lib/tax/tax-form-copy";

export function UploadGuidance() {
  return (
    <div className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-xs text-stone-600">
      <p className="font-medium text-stone-700">Upload tips</p>
      <ul className="mt-2 list-inside list-disc space-y-1">
        <li>One complete {SUPPORTED_TAX_FORMS_LABEL} PDF per tax year works best (including statements).</li>
        <li>Multiple years: Ctrl/Cmd-click several PDFs, or drop them together; results merge into the workbook table.</li>
        <li>You can add more years while a table is already open. Clear all before uploading a different company.</li>
        <li>Re-uploading the same year merges fields by confidence (higher wins).</li>
        <li>Split returns (separate PDFs for the same year) merge by confidence — prefer one combined export.</li>
        <li>Scanned/image PDFs require OCR; digital PDFs with text may skip OCR when sufficient.</li>
      </ul>
    </div>
  );
}
