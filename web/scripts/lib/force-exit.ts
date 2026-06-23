/**
 * OCR / pdf-parse / undici can leave handles open; benchmark scripts must exit explicitly.
 */
export function forceExit(code: number): never {
  setImmediate(() => process.exit(code));
}
