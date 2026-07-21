"use client";

import { AssumptionSourceHint } from "@/components/valuation/AssumptionSourceHint";
import type { ValuationFormulaStep } from "@/lib/valuation/types";

export function ValuationFormulaTransparency({
  steps,
  title = "Formula transparency",
  compact = false,
}: {
  steps: ValuationFormulaStep[];
  title?: string;
  compact?: boolean;
}) {
  if (!steps.length) return null;

  return (
    <div className={compact ? "space-y-2" : "space-y-3 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm"}>
      {!compact && (
        <div>
          <h3 className="text-sm font-semibold text-stone-900">{title}</h3>
          <p className="mt-1 text-xs text-stone-600">
            Every calculation step is shown below with the formula, substituted numbers, and result. Hover sources for
            references.
          </p>
        </div>
      )}
      <ol className="space-y-3">
        {steps.map((step, index) => (
          <li
            key={step.id}
            className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm print:break-inside-avoid"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="font-medium text-stone-900">
                {index + 1}. {step.label}
                <AssumptionSourceHint source={step.source} />
              </p>
              <p className="font-semibold text-stone-900">{step.result}</p>
            </div>
            <p className="mt-2 font-mono text-xs text-stone-600">{step.expression}</p>
            <p className="mt-1 text-xs text-stone-500">{step.substitution}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
