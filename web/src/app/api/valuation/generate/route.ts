import { NextRequest, NextResponse } from "next/server";
import { buildValuationReport } from "@/lib/valuation/report";
import type { GenerateValuationRequest } from "@/lib/valuation/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as GenerateValuationRequest;
    if (!body.columns?.length) {
      return NextResponse.json({ error: "Expected parsed tax columns." }, { status: 400 });
    }
    const json = await buildValuationReport(body);
    return NextResponse.json(json);
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Could not generate valuation draft.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
