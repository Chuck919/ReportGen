import { NextRequest, NextResponse } from "next/server";
import { buildMarketMultiplesProfile } from "@/lib/valuation/market-multiples";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      naics?: string;
      sales?: number;
      ebitda?: number;
      sde?: number;
    };
    const profile = await buildMarketMultiplesProfile({
      naics: body.naics,
      sales: body.sales ?? 0,
      ebitda: body.ebitda,
      sde: body.sde,
    });
    return NextResponse.json(profile);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load market multiples.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
