import { NextRequest, NextResponse } from "next/server";
import { buildValuationPdf, sanitizePdfFilename } from "@/lib/valuation/valuation-pdf-export";
import type { ValuationReport } from "@/lib/valuation/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { report?: ValuationReport };
    const report = body.report;
    if (!report?.entityName || !report?.sections?.length) {
      return NextResponse.json({ error: "Invalid report payload." }, { status: 400 });
    }

    const buffer = await buildValuationPdf(report);
    const filename = sanitizePdfFilename(report.entityName);

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Could not export PDF.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
