import { NextRequest, NextResponse } from "next/server";
import { verifyParseApiKey } from "@/lib/api/auth-api-key";
import { apiDocsJson, handleParseTaxReturnPost } from "@/lib/api/parse-tax-return-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function GET() {
  return NextResponse.json(apiDocsJson());
}

export async function POST(req: NextRequest) {
  const auth = verifyParseApiKey(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: 401 });
  }
  return handleParseTaxReturnPost(req);
}
