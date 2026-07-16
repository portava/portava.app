/**
 * Shared refresh-first access-token helper for all service modules.
 *
 * Every service that talks to the API server needs a current Supabase access
 * token. Reading `supabase.auth.getSession()` alone can hand back an expired
 * token when the app has been open past expiry, so this helper refreshes the
 * session first (best effort) and falls back to the cached session. All
 * traveler and admin service modules should obtain tokens through this
 * function so token handling only needs to change in one place.
 */
import { supabase } from '../lib/supabase.ts';

/** Refresh the session (best effort) and return a current access token. */
export async function freshToken(): Promise<string | null> {
  try {
    const { data: refreshed } = await supabase.auth.refreshSession();
    const s = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
    return s?.access_token ?? null;
  } catch { return null; }
}
