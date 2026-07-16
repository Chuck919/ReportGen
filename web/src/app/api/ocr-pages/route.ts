import { NextRequest, NextResponse } from "next/server";
import { parseOcrMode } from "@/lib/api/types";
import { runLocalOcrPages } from "@/lib/tax-return/local-ocr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Expected a PDF file" }, { status: 400 });
    }
    const pagesRaw = form.get("pages");
    if (typeof pagesRaw !== "string" || !pagesRaw.trim()) {
      return NextResponse.json({ error: "Expected pages=1,2,3" }, { status: 400 });
    }
    const pages = pagesRaw
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!pages.length) {
      return NextResponse.json({ error: "No valid page numbers" }, { status: 400 });
    }

    const ocrMode = parseOcrMode(form.get("ocrMode"));
    const forcePhase3 = form.get("forcePhase3") === "1";
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await runLocalOcrPages(buffer, pages, {
      profile: "tax",
      mode: ocrMode,
      forcePhase3,
    });
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "OCR batch failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
