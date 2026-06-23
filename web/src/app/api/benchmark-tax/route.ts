/**
 * Dev-only: score parsed tax values vs Excel fixtures through the same API path as the Tax tab.
 * POST /api/benchmark-tax { clientId, year, ocrMode? }
 */
import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "../../../../scripts/lib/pdf-embedded-text";
import { parseTaxReturn } from "@/lib/tax-return-parser";
import { scoreAllFields, scorePrimary } from "../../../../scripts/lib/tax-benchmark-score";
import { TAX_BENCHMARK_CLIENTS, fixtureKey } from "../../../../scripts/lib/tax-benchmark-clients";
import { resolveTaxReturnPdf } from "@/lib/tax-return/resolve-pdf";
import type { OcrMode } from "@/lib/tax-return/local-ocr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "benchmark-tax is dev-only" }, { status: 403 });
  }

  const body = (await req.json()) as { clientId?: string; year?: number; ocrMode?: OcrMode };
  const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === body.clientId);
  if (!client || !body.year) {
    return NextResponse.json({ error: "clientId and year required" }, { status: 400 });
  }

  const mode: OcrMode = body.ocrMode ?? "thorough";
  const docsDir = path.resolve(process.cwd(), client.docsDir);
  const pdfPath = await resolveTaxReturnPdf(docsDir, body.year);
  const bytes = await readFile(pdfPath);
  const embedded = await getEmbeddedPdfText(bytes);
  const t0 = Date.now();
  const parsed = await parseTaxReturn(path.basename(pdfPath), bytes, embedded, body.year, mode);
  const fk = fixtureKey(client, body.year);
  const primary = scorePrimary(fk, parsed.values);
  const all = scoreAllFields(fk, parsed.values);

  return NextResponse.json({
    clientId: client.id,
    year: body.year,
    ocrMode: mode,
    elapsedMs: Date.now() - t0,
    primaryPct: primary.pct,
    allPct: all.pct,
    primaryMisses: primary.misses,
    allMisses: all.misses,
    values: parsed.values,
    fieldSources: parsed.fieldSources,
    source: parsed.source,
  });
}
