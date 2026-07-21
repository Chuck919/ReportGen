import { NextRequest, NextResponse } from "next/server";
import { exportValuationDocx, type ValuationDocxExportMode } from "@/lib/valuation/docx-export";
import type { ValuationInputDraft } from "@/lib/valuation/defaults";
import type { WordMergeEngagement } from "@/lib/valuation/premerge-merge-data";
import type { ValuationReport } from "@/lib/valuation/types";
import type { TaxYearValues } from "@/lib/tax-workbook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ExportDocxPayload = {
  report: ValuationReport;
  columns?: TaxYearValues[];
  valuationInputs?: Partial<ValuationInputDraft>;
  engagement?: WordMergeEngagement;
};

function parseMode(modeRaw: FormDataEntryValue | null): ValuationDocxExportMode {
  if (modeRaw === "uploaded") return "uploaded";
  if (modeRaw === "builtin") return "builtin";
  return "firm";
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const reportRaw = form.get("report");
    const contextRaw = form.get("context");
    const mode = parseMode(form.get("mode"));
    const templateFile = form.get("template");

    if (typeof reportRaw !== "string" || !reportRaw.trim()) {
      return NextResponse.json({ error: "Missing report payload." }, { status: 400 });
    }

    const report = JSON.parse(reportRaw) as ValuationReport;
    if (!report?.entityName || !report?.valuation) {
      return NextResponse.json({ error: "Invalid report payload." }, { status: 400 });
    }

    let mergeContext: ExportDocxPayload | undefined;
    if (typeof contextRaw === "string" && contextRaw.trim()) {
      mergeContext = JSON.parse(contextRaw) as ExportDocxPayload;
    }

    let templateBuffer: Buffer | undefined;
    if (mode === "uploaded") {
      if (!(templateFile instanceof File) || templateFile.size === 0) {
        return NextResponse.json(
          { error: "Upload a Word template (.docx) or use the Main Current firm template." },
          { status: 400 },
        );
      }
      const arrayBuffer = await templateFile.arrayBuffer();
      templateBuffer = Buffer.from(arrayBuffer);
    }

    const { buffer, filename } = await exportValuationDocx({
      report,
      mode,
      templateBuffer,
      mergeContext: {
        columns: mergeContext?.columns ?? [],
        valuationInputs: mergeContext?.valuationInputs,
        engagement: mergeContext?.engagement,
      },
    });

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Could not export Word document.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
