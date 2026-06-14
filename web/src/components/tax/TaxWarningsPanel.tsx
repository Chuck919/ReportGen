import type { TaxYearValues } from "@/lib/tax-workbook";

export function TaxWarningsPanel({ columns }: { columns: TaxYearValues[] }) {
  const withWarnings = columns.filter((c) => c.warnings?.length);
  if (!withWarnings.length) return null;

  return (
    <section className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-950">
      <h2 className="font-medium">Review suggested</h2>
      <div className="mt-3 space-y-3">
        {withWarnings.map((column) => (
          <div key={column.year}>
            <div className="text-xs font-medium uppercase tracking-wide text-amber-800">{column.year}</div>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-amber-900">
              {column.warnings!.slice(0, 12).map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
              {column.warnings!.length > 12 && (
                <li className="list-none pl-0 text-amber-700">+{column.warnings!.length - 12} more</li>
              )}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
