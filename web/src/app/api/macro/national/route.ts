import { NextResponse } from "next/server";
import { buildNationalMacroSnapshot } from "@/lib/valuation/macro-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const snapshot = await buildNationalMacroSnapshot();
    return NextResponse.json(snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not fetch national macro data.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
