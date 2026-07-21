import { NextRequest, NextResponse } from "next/server";
import { buildNaicsBenchmarkProfile } from "@/lib/valuation/benchmark-naics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { naics?: string };
    const profile = buildNaicsBenchmarkProfile(body.naics);
    return NextResponse.json(profile);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not build benchmark profile.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
