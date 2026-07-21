"use client";

import { AssumptionSourceHint } from "@/components/valuation/AssumptionSourceHint";
import type { ValuationInputDraft } from "@/lib/valuation/defaults";
import { buildCapRateFromBuildup } from "@/lib/valuation/defaults";
import type { AssumptionFieldSource } from "@/lib/valuation/assumption-sources";

function FieldLabel({ label, source }: { label: string; source?: AssumptionFieldSource }) {
  return (
    <span className="inline-flex items-center font-medium text-stone-800">
      {label}
      <AssumptionSourceHint source={source} />
    </span>
  );
}

function pctField(
  label: string,
  value: number,
  onChange: (value: number) => void,
  source?: AssumptionFieldSource,
) {
  return (
    <label className="space-y-1 text-sm">
      <FieldLabel label={label} source={source} />
      <input
        type="number"
        step="0.001"
        min={0}
        max={1}
        className="w-full rounded-lg border border-stone-300 px-3 py-2 outline-none focus:border-stone-500"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function moneyField(
  label: string,
  value: number | undefined,
  onChange: (value: number | undefined) => void,
  source?: AssumptionFieldSource,
  placeholder?: string,
) {
  return (
    <label className="space-y-1 text-sm">
      <FieldLabel label={label} source={source} />
      <input
        type="number"
        className="w-full rounded-lg border border-stone-300 px-3 py-2 outline-none focus:border-stone-500"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value ? Number(event.target.value) : undefined)}
        placeholder={placeholder}
      />
    </label>
  );
}

export function ValuationAssumptionsPanel({
  inputs,
  onChange,
  liveReconciledValue,
  compact = false,
}: {
  inputs: ValuationInputDraft;
  onChange: <K extends keyof ValuationInputDraft>(key: K, value: ValuationInputDraft[K]) => void;
  liveReconciledValue?: number | null;
  compact?: boolean;
}) {
  const capPreview = inputs.preTaxNetIncomeCapRate ?? buildCapRateFromBuildup(inputs);
  const sources = inputs.fieldSources ?? {};

  return (
    <div className={compact ? "space-y-4" : "space-y-6 rounded-2xl border border-stone-200 bg-stone-50 p-5"}>
      {!compact && (
        <div>
          <h3 className="text-sm font-semibold text-stone-900">Valuation assumptions</h3>
          <p className="mt-1 text-xs text-stone-600">
            All fields are pre-filled from your tax return and industry references. Hover the{" "}
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-stone-300 text-[10px] font-semibold">
              i
            </span>{" "}
            icon for sources. You can upload tax PDFs and generate without editing anything.
          </p>
        </div>
      )}

      {liveReconciledValue != null && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          Live reconciled value:{" "}
          <span className="font-semibold">
            {liveReconciledValue.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}
          </span>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm sm:col-span-2">
          <FieldLabel label="Normalized earnings" source={sources.normalizedEarnings} />
          <input
            type="number"
            className="w-full rounded-lg border border-stone-300 px-3 py-2 outline-none focus:border-stone-500"
            value={inputs.normalizedEarnings}
            onChange={(event) => onChange("normalizedEarnings", Number(event.target.value))}
          />
        </label>
        {moneyField(
          "Asset indicated value",
          inputs.assetIndicatedValue,
          (v) => onChange("assetIndicatedValue", v),
          sources.assetIndicatedValue,
          "From balance sheet",
        )}
        <label className="space-y-1 text-sm">
          <FieldLabel label="Pre-tax cap rate" source={sources.preTaxNetIncomeCapRate} />
          <input
            type="number"
            step="0.0001"
            className="w-full rounded-lg border border-stone-300 px-3 py-2 outline-none focus:border-stone-500"
            value={inputs.preTaxNetIncomeCapRate ?? ""}
            onChange={(event) =>
              onChange("preTaxNetIncomeCapRate", event.target.value ? Number(event.target.value) : undefined)
            }
            placeholder={`Build-up: ${capPreview.toFixed(4)}`}
          />
        </label>
        {moneyField(
          "Working capital adjustment",
          inputs.workingCapitalAdjustment,
          (v) => onChange("workingCapitalAdjustment", v),
          sources.workingCapitalAdjustment,
        )}
        {moneyField(
          "CAPEX adjustment",
          inputs.capexAdjustment,
          (v) => onChange("capexAdjustment", v),
          sources.capexAdjustment,
        )}
      </div>

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-stone-500">Method weights</h4>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          {pctField("Income weight", inputs.incomeWeight, (v) => onChange("incomeWeight", v), sources.incomeWeight)}
          {pctField("Asset weight", inputs.assetWeight, (v) => onChange("assetWeight", v), sources.assetWeight)}
          {pctField("Market weight", inputs.marketWeight, (v) => onChange("marketWeight", v), sources.marketWeight)}
        </div>
      </div>

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-stone-500">Cost of capital build-up</h4>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {pctField("Risk-free rate", inputs.riskFreeRate, (v) => onChange("riskFreeRate", v), sources.riskFreeRate)}
          {pctField("Equity risk premium", inputs.equityRiskPremium, (v) => onChange("equityRiskPremium", v), sources.equityRiskPremium)}
          {pctField("Size premium", inputs.sizePremium, (v) => onChange("sizePremium", v), sources.sizePremium)}
          {pctField("Company-specific risk", inputs.companySpecificRisk, (v) => onChange("companySpecificRisk", v), sources.companySpecificRisk)}
          {pctField("Long-term growth", inputs.longTermGrowthRate, (v) => onChange("longTermGrowthRate", v), sources.longTermGrowthRate)}
          {pctField("DLOM", inputs.dlomRate, (v) => onChange("dlomRate", v), sources.dlomRate)}
        </div>
      </div>

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-stone-500">WACC inputs</h4>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          {pctField("Equity weight", inputs.equityWeight ?? 0.45, (v) => onChange("equityWeight", v), sources.equityWeight)}
          {pctField("Cost of debt", inputs.costOfDebt ?? 0.095, (v) => onChange("costOfDebt", v), sources.costOfDebt)}
          {pctField("Tax rate", inputs.taxRate ?? 0.26, (v) => onChange("taxRate", v), sources.taxRate)}
        </div>
      </div>

      <label className="block space-y-1 text-sm">
        <span className="font-medium text-stone-800">Company context for Groq narrative (optional)</span>
        <textarea
          className="min-h-24 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-500"
          value={inputs.companyContext}
          onChange={(event) => onChange("companyContext", event.target.value)}
          placeholder="Optional — ownership, products, customers. Groq uses this for narrative only; valuation math runs without it."
        />
      </label>
    </div>
  );
}
