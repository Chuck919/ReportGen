import { NextRequest, NextResponse } from "next/server";
import { parseOcrMode } from "@/lib/api/types";
import { runOcrPlan } from "@/lib/tax-return/local-ocr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Expected a PDF file" }, { status: 400 });
    }
    const ocrMode = parseOcrMode(form.get("ocrMode"));
    const deltaFromRaw = form.get("deltaFrom");
    const deltaFrom =
      typeof deltaFromRaw === "string" && deltaFromRaw ? parseOcrMode(deltaFromRaw) : undefined;
    const alreadyRaw = form.get("alreadyPages");
    const alreadyPages =
      typeof alreadyRaw === "string"
        ? alreadyRaw
            .split(",")
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => Number.isFinite(n) && n > 0)
        : undefined;
    const missingRaw = form.get("missingFields");
    const missingFields =
      typeof missingRaw === "string"
        ? missingRaw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;

    const buffer = Buffer.from(await file.arrayBuffer());
    const plan = await runOcrPlan(buffer, ocrMode, { deltaFrom, alreadyPages, missingFields });
    return NextResponse.json(plan);
  } catch (e) {
    const message = e instanceof Error ? e.message : "OCR plan failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
