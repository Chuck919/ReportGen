"use client";

import type { AssumptionFieldSource } from "@/lib/valuation/assumption-sources";

export function AssumptionSourceHint({
  source,
  className = "",
}: {
  source?: AssumptionFieldSource;
  className?: string;
}) {
  if (!source) return null;

  const tooltip = `${source.label}\n\n${source.detail}${source.url ? `\n\n${source.url}` : ""}`;

  return (
    <span className={`group relative inline-flex align-middle ${className}`}>
      <button
        type="button"
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-stone-300 bg-white text-[10px] font-semibold leading-none text-stone-500 hover:border-stone-400 hover:text-stone-700"
        aria-label={`Source: ${source.label}`}
        title={tooltip}
      >
        i
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden w-64 -translate-x-1/2 rounded-lg border border-stone-200 bg-white p-3 text-left text-xs font-normal normal-case tracking-normal text-stone-700 shadow-lg group-hover:block group-focus-within:block"
      >
        <span className="block font-semibold text-stone-900">{source.label}</span>
        <span className="mt-1 block leading-relaxed">{source.detail}</span>
        {source.url ? (
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="pointer-events-auto mt-2 inline-block text-blue-700 underline hover:text-blue-900"
            onClick={(event) => event.stopPropagation()}
          >
            View reference
          </a>
        ) : null}
      </span>
    </span>
  );
}
