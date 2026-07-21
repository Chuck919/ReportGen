import { NextRequest, NextResponse } from "next/server";
import { lookupOrgEntity } from "@/lib/valuation/filed-org-lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { entityName?: string; state?: string };
    const entityName = body.entityName?.trim() ?? "";
    const state = body.state?.trim() ?? "";
    if (!entityName || state.length !== 2) {
      return NextResponse.json({ error: "Entity name and 2-letter state required." }, { status: 400 });
    }
    const result = await lookupOrgEntity({ entityName, state });
    if (!result) {
      return NextResponse.json({
        found: false,
        message: process.env.FILED_API_KEY
          ? "No SOS record found for this name/state."
          : "Set FILED_API_KEY in .env.local for SOS lookup (~100 free/month).",
      });
    }
    return NextResponse.json({ found: true, result });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Org lookup failed." }, { status: 500 });
  }
}
