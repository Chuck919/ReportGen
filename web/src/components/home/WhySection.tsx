const REASONS = [
  {
    title: "Built for valuation models",
    body: "Output matches your workbook layout. Input rows only, with formula rows clearly marked.",
  },
  {
    title: "Handles real-world PDFs",
    body: "Scanned returns use multi-phase OCR: find relevant pages first, then full resolution where needed.",
  },
  {
    title: "Transparent extraction",
    body: "Every number has a source label and confidence score so you know what to double-check.",
  },
  {
    title: "Runs on your stack",
    body: "Parsing runs in Next.js API routes locally or on your deploy. No external doc API required.",
  },
];

export function WhySection() {
  return (
    <section className="mt-14">
      <h2 className="text-xl font-semibold text-stone-900">Why use ReportGen?</h2>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {REASONS.map((r) => (
          <article
            key={r.title}
            className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm transition hover:border-stone-300"
          >
            <h3 className="font-medium text-stone-900">{r.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-stone-600">{r.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}