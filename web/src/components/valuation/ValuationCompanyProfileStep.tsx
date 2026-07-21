"use client";

import { useState } from "react";
import {
  COMPANY_PROFILE_SUB_STEPS,
  type CompanyProfile,
  type CompanyProfileSubStep,
} from "@/lib/valuation/company-profile";

type Props = {
  profile: CompanyProfile;
  entityName: string;
  onChange: (key: keyof CompanyProfile, value: string) => void;
  onLookupOrg: () => Promise<void>;
  orgLookupBusy: boolean;
  orgLookupMessage: string;
};

function Field({
  label,
  hint,
  value,
  onChange,
  rows = 3,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
}) {
  const Input = rows > 1 ? "textarea" : "input";
  return (
    <label className="block space-y-1 text-sm">
      <span className="font-medium text-stone-900">{label}</span>
      {hint && <span className="block text-xs text-stone-500">{hint}</span>}
      <Input
        className="w-full rounded-lg border border-stone-300 px-3 py-2 text-stone-800"
        rows={rows > 1 ? rows : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function ValuationCompanyProfileStep({
  profile,
  entityName,
  onChange,
  onLookupOrg,
  orgLookupBusy,
  orgLookupMessage,
}: Props) {
  const [subStep, setSubStep] = useState<CompanyProfileSubStep>("business");
  const subIndex = COMPANY_PROFILE_SUB_STEPS.findIndex((s) => s.id === subStep);

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-stone-900">Step 3 — Company profile</h2>
        <p className="mt-2 text-sm text-stone-600">
          Describe the business and normalization adjustments. Groq uses this context to draft company-specific narrative
          for the Word report — without inventing facts beyond what you provide and the tax data.
        </p>
        <nav className="mt-4 flex flex-wrap gap-2">
          {COMPANY_PROFILE_SUB_STEPS.map((item, index) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSubStep(item.id)}
              className={[
                "rounded-full px-3 py-1 text-xs font-medium",
                item.id === subStep ? "bg-stone-900 text-white" : "bg-stone-100 text-stone-600",
              ].join(" ")}
            >
              {index + 1}. {item.label}
            </button>
          ))}
        </nav>
      </div>

      {subStep === "business" && (
        <div className="grid gap-4 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
          <Field
            label="Business description"
            hint="What does the company do? How long has it operated?"
            value={profile.businessDescription}
            onChange={(v) => onChange("businessDescription", v)}
            rows={4}
          />
          <Field
            label="Products & services"
            value={profile.productsServices}
            onChange={(v) => onChange("productsServices", v)}
            rows={3}
          />
          <Field
            label="Customers & markets"
            hint="Geography, customer type, concentration"
            value={profile.customersMarkets}
            onChange={(v) => onChange("customersMarkets", v)}
            rows={3}
          />
        </div>
      )}

      {subStep === "ownership" && (
        <div className="grid gap-4 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm sm:grid-cols-2">
          <Field
            label="Primary owner name"
            value={profile.ownerName}
            onChange={(v) => onChange("ownerName", v)}
            rows={1}
          />
          <Field
            label="Ownership summary"
            hint="Percent ownership, family involvement, key managers"
            value={profile.ownershipSummary}
            onChange={(v) => onChange("ownershipSummary", v)}
            rows={3}
          />
          <label className="space-y-1 text-sm sm:col-span-2">
            <span className="font-medium">State of organization</span>
            <span className="block text-xs text-stone-500">2-letter code — used for SOS lookup (Filed.dev, optional)</span>
            <div className="flex flex-wrap gap-2">
              <input
                className="w-24 rounded-lg border border-stone-300 px-3 py-2 uppercase"
                maxLength={2}
                value={profile.entityState}
                onChange={(e) => onChange("entityState", e.target.value.toUpperCase())}
                placeholder="KY"
              />
              <button
                type="button"
                disabled={orgLookupBusy || !profile.entityState.trim() || !entityName.trim()}
                onClick={() => void onLookupOrg()}
                className="rounded-lg border border-stone-300 px-3 py-2 text-sm disabled:opacity-50"
              >
                {orgLookupBusy ? "Looking up…" : "Lookup SOS record"}
              </button>
            </div>
            {orgLookupMessage && <p className="text-xs text-stone-600">{orgLookupMessage}</p>}
          </label>
          <Field
            label="File / charter number"
            value={profile.entityFileNumber}
            onChange={(v) => onChange("entityFileNumber", v)}
            rows={1}
          />
          <Field
            label="Formation date"
            value={profile.entityFormationDate}
            onChange={(v) => onChange("entityFormationDate", v)}
            rows={1}
          />
        </div>
      )}

      {subStep === "normalization" && (
        <div className="grid gap-4 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
          <Field
            label="Normalization overview"
            hint="Summary of adjustments applied to arrive at normalized earnings"
            value={profile.normalizationNotes}
            onChange={(v) => onChange("normalizationNotes", v)}
            rows={3}
          />
          <Field
            label="Related-party rent"
            value={profile.relatedPartyRent}
            onChange={(v) => onChange("relatedPartyRent", v)}
            rows={2}
          />
          <Field
            label="Owner compensation adjustment"
            value={profile.ownerCompAdjustment}
            onChange={(v) => onChange("ownerCompAdjustment", v)}
            rows={2}
          />
          <Field
            label="One-time / non-recurring items"
            value={profile.oneTimeItems}
            onChange={(v) => onChange("oneTimeItems", v)}
            rows={2}
          />
          <Field
            label="Discretionary expenses"
            value={profile.discretionaryExpenses}
            onChange={(v) => onChange("discretionaryExpenses", v)}
            rows={2}
          />
        </div>
      )}

      <div className="flex flex-wrap justify-between gap-3">
        <button
          type="button"
          disabled={subIndex <= 0}
          onClick={() => setSubStep(COMPANY_PROFILE_SUB_STEPS[subIndex - 1]!.id)}
          className="rounded-lg border border-stone-300 px-4 py-2 text-sm disabled:opacity-40"
        >
          Previous section
        </button>
        {subIndex < COMPANY_PROFILE_SUB_STEPS.length - 1 ? (
          <button
            type="button"
            onClick={() => setSubStep(COMPANY_PROFILE_SUB_STEPS[subIndex + 1]!.id)}
            className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white"
          >
            Next section
          </button>
        ) : null}
      </div>
    </div>
  );
}
