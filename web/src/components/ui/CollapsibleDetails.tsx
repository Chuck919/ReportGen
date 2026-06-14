import type { ReactNode } from "react";

export function CollapsibleDetails({
  summary,
  children,
  className = "",
}: {
  summary: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={`rounded-xl border border-stone-200 bg-white px-5 py-4 text-xs text-stone-600 ${className}`}>
      <summary className="cursor-pointer font-medium text-stone-700">{summary}</summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}
