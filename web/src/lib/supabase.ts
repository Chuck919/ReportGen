import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * Use the Supabase client only when env vars are set.
 * The app runs end‑to‑end without a project (parse + copy/paste UX).
 */
export function getSupabaseBrowser(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}
