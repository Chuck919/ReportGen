"use client";

import { TRUST_TIER_LEGEND } from "@/lib/tax/field-trust-tier";

/** Visible at top of results — swatch classes are inline here so Tailwind always includes them. */
export function TrustColorGuide() {
  return (
    <div className="rounded-2xl border border-stone-200 bg-white px-5 py-4 shadow-sm">
      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-stone-500">Trust color guide</p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {TRUST_TIER_LEGEND.map((item) => (
          <div
            key={item.tier}
            className={["flex items-center gap-3 rounded-lg px-3 py-2 text-xs", item.cellClass].join(" ")}
          >
            <span
              className={["h-4 w-4 shrink-0 rounded border border-black/10", item.swatchClass].join(" ")}
              aria-hidden
            />
            <span>
              <span className="font-semibold">{item.label}</span>
              <span className="opacity-80"> — {item.description}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
