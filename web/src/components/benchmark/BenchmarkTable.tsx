import { CopyButton } from "@/components/CopyButton";
import type { BenchmarkEntryRow } from "@/lib/benchmark-entry";

export function BenchmarkTable({ rows }: { rows: BenchmarkEntryRow[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
      <table className="min-w-full text-left text-sm">
        <thead>
          <tr className="border-b border-stone-200 bg-stone-50 text-stone-600">
            <th className="px-4 py-3 font-medium">Section</th>
            <th className="px-4 py-3 font-medium">Label</th>
            <th className="px-4 py-3 font-medium">Value</th>
            <th className="px-4 py-3 font-medium">Source</th>
            <th className="px-4 py-3 font-medium" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={`${row.section}-${row.label}-${idx}`} className="border-t border-stone-100">
              <td className="whitespace-nowrap px-4 py-2 text-stone-600">{row.section}</td>
              <td className="px-4 py-2 font-medium text-stone-900">{row.label}</td>
              <td className="px-4 py-2 font-mono text-stone-800">{row.value || "—"}</td>
              <td className="px-4 py-2 text-xs text-stone-500">{row.source}</td>
              <td className="px-4 py-2">
                <CopyButton text={row.value} label="Copy" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
