/**
 * OCR / pdf-parse / undici can leave handles open; benchmark scripts must exit explicitly.
 */
export function forceExit(code: number): never {
  // Do NOT .unref() — that lets the process exit 0 before the timer fires when handles close.
  setTimeout(() => process.exit(code), 50);
}
