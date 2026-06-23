import Link from "next/link";
import { SUPPORTED_TAX_FORMS_LABEL } from "@/lib/tax/tax-form-copy";

const TOOLS = [
  { href: "/tax", title: "Tax returns", subtitle: SUPPORTED_TAX_FORMS_LABEL, description: "Extract income statement and balance sheet lines for paste into your tax entry table.", cta: "Open tax tool" },
  { href: "/benchmark", title: "Benchmark PDF", subtitle: "Industry reports", description: "Pull financial ratios and common-size percentages from IBIS-style narrative PDFs.", cta: "Open benchmark tool" },
];

export function ToolCards() {
  return (
    <section className="mt-14">
      <h2 className="text-xl font-semibold text-stone-900">Tools</h2>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {TOOLS.map((tool) => (
          <Link key={tool.href} href={tool.href} className="group rounded-2xl border border-stone-200 bg-white p-6 shadow-sm transition hover:border-stone-400 hover:shadow-md">
            <p className="text-xs font-medium uppercase tracking-wide text-stone-500">{tool.subtitle}</p>
            <h3 className="mt-1 text-lg font-semibold text-stone-900 group-hover:text-amber-950">{tool.title}</h3>
            <p className="mt-2 text-sm text-stone-600">{tool.description}</p>
            <span className="mt-4 inline-block text-sm font-medium text-stone-800 group-hover:underline">{tool.cta}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}