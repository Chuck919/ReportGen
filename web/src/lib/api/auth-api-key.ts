import type { NextRequest } from "next/server";

/** When PARSE_TAX_API_KEY is set, external callers must send it via Authorization or X-API-Key. */
export function verifyParseApiKey(req: NextRequest): { ok: true } | { ok: false; message: string } {
  const expected = process.env.PARSE_TAX_API_KEY?.trim();
  if (!expected) return { ok: true };

  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const headerKey = req.headers.get("x-api-key")?.trim() ?? "";
  const provided = bearer || headerKey;

  if (provided && provided === expected) return { ok: true };
  return { ok: false, message: "Invalid or missing API key. Set Authorization: Bearer <key> or X-API-Key." };
}
