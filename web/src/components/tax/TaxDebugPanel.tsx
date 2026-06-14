import type { ParsedTaxYear } from "@/lib/api/types";
import { CollapsibleDetails } from "@/components/ui/CollapsibleDetails";

export function TaxDebugPanel({
  items,
  serverLogs,
}: {
  items: ParsedTaxYear[];
  serverLogs: string[];
}) {
  if (!items.some((d) => d.debug) && !serverLogs.length) return null;

  return (
    <CollapsibleDetails summary="Technical details">
      <div className="space-y-4 font-mono">
        {items.map((item) => (
          <div key={`${item.filename}-${item.year}`} className="border-t border-stone-100 pt-3">
            <div className="text-stone-800">
              {item.filename} · {item.year}
            </div>
            {item.debug && (
              <ul className="mt-1 list-disc pl-5">
                {item.debug.ocrPageCount !== undefined && <li>ocrPages: {item.debug.ocrPageCount}</li>}
                {item.debug.ocrTimingMs?.total != null && (
                  <li>ocrTotal: {(item.debug.ocrTimingMs.total / 1000).toFixed(1)}s</li>
                )}
                {item.debug.resolvedFieldCount !== undefined && (
                  <li>fields: {item.debug.resolvedFieldCount}</li>
                )}
                {item.debug.ocrLogs?.slice(0, 8).map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </CollapsibleDetails>
  );
}
