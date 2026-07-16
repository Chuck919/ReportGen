import { NextRequest, NextResponse } from "next/server";
import { parseOcrMode } from "@/lib/api/types";
import { runLocalOcr } from "@/lib/tax-return/local-ocr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Full single-pass OCR for one tier (used when escalating from a fast preview pass). */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Expected a PDF file" }, { status: 400 });
    }
    const ocrMode = parseOcrMode(form.get("ocrMode"));
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await runLocalOcr(buffer, { profile: "tax", mode: ocrMode });
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "OCR failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
