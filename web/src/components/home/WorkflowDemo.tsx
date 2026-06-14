"use client";

import { useState } from "react";

const STEPS = [
  { id: "upload", title: "Upload PDF", body: "Drop a tax return or industry benchmark report. Image-only scans are supported via OCR." },
  { id: "extract", title: "Extract lines", body: "The server finds forms, schedules, and comparison tables, then maps values to your workbook rows." },
  { id: "review", title: "Review confidence", body: "Each field shows where it came from. Low-confidence cells are highlighted for a quick sanity check." },
  { id: "paste", title: "Copy to Excel", body: "One click copies a column-ready TSV. Paste into integ or tables without touching yellow formula cells." },
];

export function WorkflowDemo() {
  const [active, setActive] = useState(0);
  const step = STEPS[active];

  return (
    <section className="mt-12">
      <h2 className="text-xl font-semibold text-stone-900">How it works</h2>
      <p className="mt-1 text-sm text-stone-600">Click a step to see what happens at each stage.</p>
      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <ol className="flex flex-col gap-2 lg:col-span-2">
          {STEPS.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setActive(i)}
                className={[
                  "flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition",
                  active === i ? "border-stone-900 bg-stone-900 text-white shadow-sm" : "border-stone-200 bg-white text-stone-800 hover:border-stone-300",
                ].join(" ")}
              >
                <span className={["flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold", active === i ? "bg-white/20 text-white" : "bg-stone-100 text-stone-600"].join(" ")}>{i + 1}</span>
                <span className="font-medium">{s.title}</span>
              </button>
            </li>
          ))}
        </ol>
        <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm lg:col-span-3">
          <p className="text-xs font-medium uppercase tracking-wide text-stone-400">Step {active + 1} of {STEPS.length}</p>
          <h3 className="mt-2 text-2xl font-semibold text-stone-900">{step.title}</h3>
          <p className="mt-3 text-sm leading-relaxed text-stone-600">{step.body}</p>
          <div className="mt-6 flex gap-2">
            {STEPS.map((_, i) => (
              <div key={i} className={["h-1 flex-1 rounded-full transition", i <= active ? "bg-stone-800" : "bg-stone-200"].join(" ")} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}