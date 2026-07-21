import { NextRequest, NextResponse } from "next/server";
import { fredSeries } from "@/lib/valuation/macro-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { seriesId?: string; label?: string };
    if (!body.seriesId) {
      return NextResponse.json({ error: "Expected seriesId" }, { status: 400 });
    }
    const series = await fredSeries(body.seriesId, body.label || body.seriesId);
    return NextResponse.json(series);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not fetch FRED series.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
