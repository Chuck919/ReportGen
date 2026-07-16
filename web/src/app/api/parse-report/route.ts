import { NextRequest, NextResponse } from "next/server";
import "@/lib/tax/pdf-server-polyfill";
import { PDFParse } from "pdf-parse";
import { parseFinancialTablesFromText } from "@/lib/financial-text-parser";
import { buildBenchmarkEntryRows } from "@/lib/benchmark-entry";
import { runLocalOcr } from "@/lib/tax-return-parser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Expected file field" }, { status: 400 });
    }

    const master = Buffer.from(await file.arrayBuffer());
    const forParse = Buffer.from(master);
    const forOcr = Buffer.from(master);

    const parser = new PDFParse({ data: forParse });
    const { text: embedded } = await parser.getText();
    await parser.destroy?.();

    let combinedText = embedded;
    let parsed = parseFinancialTablesFromText(combinedText);

    const factKeys = Object.keys(parsed.facts);
    const icsKeys = Object.keys(parsed.industryCommonSize ?? {});
    const needsOcr = factKeys.length < 4 || icsKeys.length < 3;

    let ocr: { pages: number; confidence: number } | undefined;
    if (needsOcr) {
      const ocrResult = await runLocalOcr(forOcr, { profile: "benchmark" });
      ocr = { pages: ocrResult.pages, confidence: ocrResult.confidence };
      combinedText = `${embedded}\n${ocrResult.text}`;
      parsed = parseFinancialTablesFromText(combinedText);
    }

    const benchmarkRows = buildBenchmarkEntryRows(parsed);

    return NextResponse.json({
      filename: file.name,
      parsed: {
        industry: parsed.industry,
        naics: parsed.naics,
        yearLabels: parsed.yearLabels,
        scorecard: parsed.scorecard,
        factKeys: Object.keys(parsed.facts).sort(),
        facts: parsed.facts,
        industryCommonSizeColumn: parsed.industryCommonSizeColumn,
        industryCommonSizeKeys: Object.keys(parsed.industryCommonSize ?? {}).sort(),
      },
      benchmarkRows,
      ocrUsed: ocr !== undefined,
      ocr,
    });
  } catch (e) {
    console.error(e);
    const message = e instanceof Error ? e.message : "Parse failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
