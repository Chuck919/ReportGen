/** Max PDF size accepted by the upload API (bytes). */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;

/** Max PDFs accepted per API request (multi-year upload). */
export const MAX_FILES_PER_REQUEST = 10;

/** Client may queue multiple years sequentially; warn above this per drop. */
export const WARN_FILES_PER_DROP = 3;

/** Embedded text below this → likely image-only / scanned PDF. */
export const SCANNED_EMBEDDED_TEXT_THRESHOLD = 250;

/** Page count above this → warn about long OCR time. */
export const WARN_PAGE_COUNT = 80;

export function maxFilesPerApiRequest(): number {
  return MAX_FILES_PER_REQUEST;
}
