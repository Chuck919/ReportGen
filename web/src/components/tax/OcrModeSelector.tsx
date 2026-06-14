"use client";

import type { OcrMode } from "@/lib/api/types";
import { getOcrModeOptions } from "@/lib/tax/ocr-modes";

/** Compact mode picker — label + timing only. */
export function OcrModeSelector({
  value,
  onChange,
  disabled,
}: {
  value: OcrMode;
  onChange: (mode: OcrMode) => void;
  disabled?: boolean;
}) {
  const options = getOcrModeOptions();
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="OCR depth">
      {options.map((mode) => {
        const selected = value === mode.id;
        return (
          <button
            key={mode.id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(mode.id)}
            className={[
              "rounded-full px-4 py-2 text-sm font-medium transition disabled:opacity-50",
              selected
                ? "bg-stone-900 text-white shadow-sm"
                : "bg-stone-100 text-stone-600 hover:bg-stone-200",
            ].join(" ")}
          >
            {mode.label}
            <span className={selected ? "text-stone-400" : "text-stone-400"}> · {mode.hint}</span>
          </button>
        );
      })}
    </div>
  );
}
