import { NextRequest, NextResponse } from "next/server";
import { buildMsaMacroSnapshot } from "@/lib/valuation/macro-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { msaLabel?: string; cbsaCode?: string };
    const snapshot = await buildMsaMacroSnapshot(body);
    return NextResponse.json(snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not fetch local macro data.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
