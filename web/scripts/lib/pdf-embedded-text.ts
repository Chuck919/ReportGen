import { PDFParse } from "pdf-parse";

const DEFAULT_EMBEDDED_TEXT_TIMEOUT_MS = 90_000;

/** Extract embedded PDF text with a hard timeout (large scans can hang pdf-parse). */
export async function getEmbeddedPdfText(
  bytes: Uint8Array,
  timeoutMs = DEFAULT_EMBEDDED_TEXT_TIMEOUT_MS,
): Promise<string> {
  let parser: PDFParse | undefined;
  const work = (async () => {
    parser = new PDFParse({ data: Buffer.from(bytes) });
    const t = await parser.getText();
    return t.text ?? "";
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<string>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`PDF embedded text timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await parser?.destroy?.();
    } catch {
      // ignore cleanup errors
    }
  }
}
