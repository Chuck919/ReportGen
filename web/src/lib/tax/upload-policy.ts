/** Max PDF size accepted by the upload API (bytes). */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;

/** Vercel Hobby: one PDF per API request so OCR stays under 300s. */
export const VERCEL_MAX_FILES_PER_REQUEST = 1;

/** Client may queue multiple years sequentially; warn above this per drop. */
export const WARN_FILES_PER_DROP = 3;

/** Embedded text below this → likely image-only / scanned PDF. */
export const SCANNED_EMBEDDED_TEXT_THRESHOLD = 250;

/** Page count above this on Vercel → warn about timeout risk. */
export const WARN_PAGE_COUNT_VERCEL = 40;

/** Primary fields filled below this ratio → incomplete parse warning. */
export const INCOMPLETE_PRIMARY_FILL_RATIO = 0.45;

export function maxFilesPerApiRequest(isVercel: boolean): number {
  return isVercel ? VERCEL_MAX_FILES_PER_REQUEST : 10;
}
