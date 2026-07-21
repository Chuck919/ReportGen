import Link from "next/link";

export function Hero() {
  return (
    <section className="relative overflow-hidden rounded-3xl border border-stone-200 bg-gradient-to-br from-stone-900 via-stone-800 to-amber-950 px-8 py-14 text-white shadow-lg sm:px-12">
      <div className="relative z-10 max-w-2xl">
        <p className="text-sm font-medium uppercase tracking-widest text-amber-200/90">Valuation workflow</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">From tax PDFs to valuation drafts</h1>
        <p className="mt-4 text-base leading-relaxed text-stone-300">
          ReportGen reads business tax returns, adds free macro and industry context, and generates an
          editable valuation draft or Excel-ready tax output without retyping.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/valuation" className="inline-flex items-center rounded-lg border border-white bg-white px-4 py-2 text-sm font-medium text-stone-900 shadow-sm transition hover:bg-stone-100">Generate valuation draft</Link>
          <Link href="/tax" className="inline-flex items-center rounded-lg border border-white bg-white px-4 py-2 text-sm font-medium text-stone-900 shadow-sm transition hover:bg-stone-100">Parse tax returns</Link>
          <Link href="/benchmark" className="inline-flex items-center rounded-lg border border-stone-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10">Parse benchmark PDF</Link>
        </div>
      </div>
      <div className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-amber-500/20 blur-3xl" aria-hidden />
    </section>
  );
}