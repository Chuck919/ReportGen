import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import type { TaxFieldCorrection } from "@/lib/tax/correction-storage";

const DATA_DIR = path.join(process.cwd(), "data");
const CORRECTIONS_FILE = path.join(DATA_DIR, "tax-corrections.jsonl");

export async function POST(req: Request) {
  let body: TaxFieldCorrection;
  try {
    body = (await req.json()) as TaxFieldCorrection;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.fieldId || !body.year || body.correctedValue === undefined) {
    return NextResponse.json({ error: "fieldId, year, and correctedValue required" }, { status: 400 });
  }

  try {
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(CORRECTIONS_FILE, `${JSON.stringify(body)}\n`, "utf8");
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Write failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 503 });
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    hint: "Corrections are appended via POST. Training reads data/tax-corrections.jsonl locally.",
  });
}
