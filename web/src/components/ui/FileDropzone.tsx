"use client";

import { useRef, type ReactNode } from "react";

export function FileDropzone({
  label,
  hint,
  accept,
  multiple,
  onFiles,
  children,
}: {
  label: string;
  hint?: string;
  accept?: string;
  multiple?: boolean;
  onFiles: (files: FileList | null) => void;
  children?: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-stone-300 bg-stone-50/50 px-6 py-10 text-center transition hover:border-stone-400 hover:bg-stone-50"
      >
        <span className="text-base font-medium text-stone-800">{label}</span>
        {hint && <span className="mt-1 text-sm text-stone-500">{hint}</span>}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="sr-only"
        onChange={(e) => onFiles(e.target.files)}
      />
      {children}
    </div>
  );
}
