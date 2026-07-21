import { NextRequest, NextResponse } from "next/server";
import { draftNarrativeWithGroq } from "@/lib/valuation/groq";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      entityName: string;
      naicsTitle?: string;
      msaLabel?: string;
      bullets: string[];
      sources: Array<{ label: string; url?: string; detail?: string }>;
    };
    const draft = await draftNarrativeWithGroq(body);
    return NextResponse.json({ draft });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not draft narrative.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
