/**
 * Debug a single OCR preprocessing variant on one PDF page.
 * Usage: node scripts/ocr-debug-variant.cjs <pdf> <pageNumber> [variantName]
 */
const { readFile, writeFile, mkdir } = require("node:fs/promises");
const path = require("node:path");
const { PDFParse } = require("pdf-parse");
const { createWorker } = require("tesseract.js");
const { preprocessPageImage, buildTaxVariants } = require("./ocr-preprocess.cjs");

async function main() {
  const pdfPath = process.argv[2];
  const pageNumber = Number(process.argv[3] ?? 1);
  const variantName = process.argv[4] ?? "auto-deskew";
  if (!pdfPath) throw new Error("Usage: node scripts/ocr-debug-variant.cjs <pdf> <page> [variant]");

  const scale = Number(process.env.OCR_DEBUG_SCALE ?? 4.2);
  const buffer = await readFile(pdfPath);
  const parser = new PDFParse({ data: buffer });
  const shot = await parser.getScreenshot({
    scale,
    imageDataUrl: false,
    imageBuffer: true,
    partial: [pageNumber],
  });
  await parser.destroy?.();

  const page = shot.pages[0];
  if (!page) throw new Error(`Page ${pageNumber} not rendered`);

  const variants = buildTaxVariants({ heavy: true, hiDpi: true, scheduleL: true });
  const variant = variants.find((v) => v.name === variantName) ?? variants[0];
  const outDir = path.join("scripts", "ocr-debug", `page-${pageNumber}`);
  await mkdir(outDir, { recursive: true });

  await writeFile(path.join(outDir, "raw.png"), Buffer.from(page.data));
  const preprocessed = await preprocessPageImage(page.data, variant);
  await writeFile(path.join(outDir, `${variant.name}.png`), preprocessed);

  const worker = await createWorker("eng");
  try {
    await worker.setParameters({ tessedit_pageseg_mode: "6", preserve_interword_spaces: "1" });
    const rawOcr = await worker.recognize(Buffer.from(page.data));
    const preOcr = await worker.recognize(preprocessed);
    await writeFile(path.join(outDir, "raw.txt"), rawOcr.data.text || "", "utf8");
    await writeFile(path.join(outDir, `${variant.name}.txt`), preOcr.data.text || "", "utf8");
    const preText = preOcr.data.text || "";
    console.log(JSON.stringify({
      page: pageNumber,
      variant: variant.name,
      rawConfidence: rawOcr.data.confidence,
      preConfidence: preOcr.data.confidence,
      outDir,
      intangibleSnippet: (preText.match(/13a\s+intangible[\s\S]{0,220}/i) || [])[0],
    }, null, 2));
  } finally {
    await worker.terminate();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });