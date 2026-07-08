"use client";

import { useState } from "react";

/** Copy text — works on localhost (HTTPS) and plain HTTP deploys (OVH IP, etc.). */
async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!ok) {
    throw new Error("Copy failed — browser blocked clipboard access on this connection.");
  }
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <button
      type="button"
      className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-800 shadow-sm hover:bg-stone-50"
      title={error ?? undefined}
      onClick={async () => {
        setError(null);
        try {
          await copyTextToClipboard(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          setError("Copy failed");
          setTimeout(() => setError(null), 2500);
        }
      }}
    >
      {error ? error : done ? "Copied" : label}
    </button>
  );
}
