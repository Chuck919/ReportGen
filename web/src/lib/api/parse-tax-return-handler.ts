import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { parseOcrMode, type ParseTaxReturnResponse } from "@/lib/api/types";
import { buildTaxTable, formatTableAsMarkdown } from "@/lib/tax/export-table";
import { enforceFileCountLimit, processTaxPdfFile } from "@/lib/tax/process-tax-upload";
import { SUPPORTED_TAX_FORMS_LABEL } from "@/lib/tax/tax-form-copy";

export type ParseFormat = "json" | "table" | "tsv" | "markdown";

export function parseResponseFormat(raw: unknown): ParseFormat {
  const f = typeof raw === "string" ? raw.toLowerCase() : "json";
  if (f === "table" || f === "tsv" || f === "markdown") return f;
  return "json";
}

export async function handleParseTaxReturnPost(req: NextRequest): Promise<NextResponse> {
  const logs: string[] = [];
  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    logs.push(line);
    console.log(line);
  };

  try {
    const t0 = Date.now();
    const url = new URL(req.url);
    const form = await req.formData();
    const files = form.getAll("files").filter((file): file is File => file instanceof File);
    const single = form.get("file");
    if (single instanceof File) files.push(single);

    const targetYearRaw = form.get("targetYear") ?? form.get("year");
    let yearOverride: number | undefined;
    if (typeof targetYearRaw === "string" && /^20\d{2}$/.test(targetYearRaw)) {
      yearOverride = Number(targetYearRaw);
    }

    if (!files.length) {
      return NextResponse.json({ error: "Expected one or more PDF files" }, { status: 400 });
    }

    const limitError = enforceFileCountLimit(files.length);
    if (limitError) {
      return NextResponse.json({ error: limitError, serverLogs: logs }, { status: 400 });
    }

    const ocrMode = parseOcrMode(form.get("ocrMode") ?? url.searchParams.get("ocrMode"));
    const format = parseResponseFormat(form.get("format") ?? url.searchParams.get("format"));

    log(`parse-tax-return: ${files.length} file(s) ocrMode=${ocrMode} format=${format}`);

    const preOcrRaw = form.get("ocrText");
    const preOcrText = typeof preOcrRaw === "string" && preOcrRaw.trim().length > 0 ? preOcrRaw : undefined;
    const includeOcrText = form.get("includeOcrText") === "1";

    const parsed = [];
    const fileErrors: Array<{ filename: string; message: string }> = [];
    let partial = false;
    let responseOcrText: string | undefined;

    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      log(`  [${i + 1}/${files.length}] ${file.name}`);
      const outcome = await processTaxPdfFile(file, ocrMode, {
        yearOverride,
        preOcrText: i === 0 ? preOcrText : undefined,
        log,
      });

      if (outcome.status === "error") {
        fileErrors.push({ filename: outcome.filename, message: outcome.message });
        continue;
      }
      if (outcome.status === "partial") {
        partial = true;
        fileErrors.push({ filename: file.name, message: outcome.message });
      }

      const { debug, ...rest } = outcome.parsed;
      parsed.push({ ...rest, debug });
      if (includeOcrText && outcome.ocrText) responseOcrText = outcome.ocrText;
    }

    log(`parse-tax-return complete ${Date.now() - t0}ms total`);

    if (!parsed.length && fileErrors.length) {
      return NextResponse.json(
        { error: fileErrors[0]!.message, fileErrors, serverLogs: logs },
        { status: 422 },
      );
    }

    const body: ParseTaxReturnResponse & { table?: ReturnType<typeof buildTaxTable> } = {
      parsed,
      fileErrors: fileErrors.length ? fileErrors : undefined,
      partial,
      serverLogs: logs,
      ocrText: responseOcrText,
    };

    if (format === "table" || format === "json") {
      body.table = buildTaxTable(parsed);
    }

    if (format === "tsv") {
      const tsv = buildTaxTable(parsed).tsv;
      return new NextResponse(tsv, {
        status: 200,
        headers: { "Content-Type": "text/tab-separated-values; charset=utf-8" },
      });
    }

    if (format === "markdown") {
      const md = formatTableAsMarkdown(buildTaxTable(parsed));
      return new NextResponse(md, {
        status: 200,
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      });
    }

    return NextResponse.json(body);
  } catch (e) {
    console.error(e);
    const message = e instanceof Error ? e.message : "Parse failed";
    return NextResponse.json({ error: message, serverLogs: logs }, { status: 500 });
  }
}

export function apiDocsJson() {
  return {
    endpoint: "/api/parse-tax-return",
    methods: ["GET", "POST"],
    description: `Upload a ${SUPPORTED_TAX_FORMS_LABEL} PDF, run OCR, return extracted workbook values as JSON table.`,
    auth: process.env.PARSE_TAX_API_KEY
      ? "Required: Authorization: Bearer <PARSE_TAX_API_KEY> or X-API-Key header"
      : "Optional: set PARSE_TAX_API_KEY on the OVH VPS to require a key",
    limits: { maxFilesPerRequest: 10, maxPdfMb: 50 },
    post: {
      contentType: "multipart/form-data",
      fields: {
        file: "PDF (required) — alias: files[] for multi-file upload",
        ocrMode: "fast | balanced | thorough (default: balanced)",
        targetYear: "optional 20xx override for two-year comparison worksheets",
        format: "json (default) | table | tsv | markdown",
      },
      example: `curl -X POST "https://reportgen.duckdns.org/api/parse-tax-return?format=json" \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -F "file=@return.pdf" \\
  -F "ocrMode=balanced"`,
    },
    response: {
      parsed: "array of { year, values, confidence, fieldSources, warnings, filename }",
      table: "{ columns: number[], rows: [{ id, label, section, values }], tsv }",
    },
  };
}
