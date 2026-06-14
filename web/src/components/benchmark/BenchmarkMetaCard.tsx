import { CopyButton } from "@/components/CopyButton";
import { Card } from "@/components/ui/Card";
import type { ParseBenchmarkResponse } from "@/lib/api/types";

export function BenchmarkMetaCard({
  data,
  clipboardPayloads,
}: {
  data: ParseBenchmarkResponse;
  clipboardPayloads: {
    fullTable: string;
    valuesColumn: string;
    headerValueCol: string;
  } | null;
}) {
  return (
    <Card>
      <p className="text-sm text-stone-600">
        <span className="font-medium text-stone-900">{data.filename}</span>
        {data.parsed.industry && (
          <>
            {" "}
            · <span className="text-stone-800">{data.parsed.industry}</span>
          </>
        )}
      </p>
      <p className="mt-1 text-xs text-stone-500">
        Years: {data.parsed.yearLabels.join(", ") || "unknown"} · OCR:{" "}
        {data.ocrUsed
          ? `${data.ocr?.pages ?? 0} page(s), ~${Math.round(data.ocr?.confidence ?? 0)}% avg`
          : "not needed"}
      </p>
      {clipboardPayloads && (
        <div className="mt-4 flex flex-wrap gap-2">
          <CopyButton label="Copy Excel table" text={clipboardPayloads.fullTable} />
          <CopyButton label="Copy values column" text={clipboardPayloads.valuesColumn} />
          <CopyButton label="Copy header + values" text={clipboardPayloads.headerValueCol} />
        </div>
      )}
    </Card>
  );
}
