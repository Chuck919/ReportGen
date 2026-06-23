"use client";

import { useCallback, useRef, useState, type DragEvent, type ReactNode } from "react";

function filterAccepted(files: FileList | File[], accept?: string): File[] {
  const list = Array.from(files);
  if (!accept) return list;
  const types = accept.split(",").map((t) => t.trim().toLowerCase());
  return list.filter((file) => {
    const name = file.name.toLowerCase();
    return types.some((t) => {
      if (t.startsWith(".")) return name.endsWith(t);
      if (t.includes("/")) return file.type.toLowerCase() === t;
      return false;
    });
  });
}

export function FileDropzone({
  label,
  hint,
  accept,
  multiple,
  onFiles,
  disabled,
  children,
}: {
  label: string;
  hint?: string;
  accept?: string;
  multiple?: boolean;
  onFiles: (files: FileList | null) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);

  const emitFiles = useCallback(
    (raw: FileList | File[]) => {
      if (disabled) return;
      const accepted = filterAccepted(raw, accept);
      if (!accepted.length) return;
      const dt = new DataTransfer();
      for (const file of accepted) dt.items.add(file);
      onFiles(dt.files);
    },
    [accept, disabled, onFiles],
  );

  const onDragEnter = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    dragDepth.current += 1;
    setDragActive(true);
  };

  const onDragLeave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragActive(false);
    }
  };

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) e.dataTransfer.dropEffect = "copy";
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setDragActive(false);
    if (disabled || !e.dataTransfer.files.length) return;
    emitFiles(e.dataTransfer.files);
  };

  return (
    <div
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && inputRef.current?.click()}
        className={[
          "flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition",
          disabled
            ? "cursor-not-allowed border-stone-200 bg-stone-50 text-stone-400"
            : dragActive
              ? "border-stone-500 bg-stone-100"
              : "border-stone-300 bg-stone-50/50 hover:border-stone-400 hover:bg-stone-50",
        ].join(" ")}
      >
        <span className="text-base font-medium text-stone-800">{label}</span>
        {hint && <span className="mt-1 text-sm text-stone-500">{hint}</span>}
        {dragActive && !disabled && (
          <span className="mt-2 text-sm font-medium text-stone-700">Drop PDFs here</span>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="sr-only"
        disabled={disabled}
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {children}
    </div>
  );
}
