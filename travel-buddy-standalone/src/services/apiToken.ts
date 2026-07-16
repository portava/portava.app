/**
 * Shared refresh-first access-token helper for all service modules.
 *
 * Every service that talks to the API server needs a current Supabase access
 * token. Reading `supabase.auth.getSession()` alone can hand back an expired
 * token when the app has been open past expiry, so this helper refreshes the
 * session when the token is expired or within a small margin of expiry, and
 * returns the cached token otherwise. All traveler and admin service modules
 * should obtain tokens through this function so token handling only needs to
 * change in one place.
 */
import { supabase } from '../lib/supabase.ts';

/** How many seconds before expiry we proactively refresh. */
const EXPIRY_MARGIN_SECONDS = 60;

/** Return a current access token, refreshing only when necessary. */
export async function freshToken(): Promise<string | null> {
  try {
    const { data: cached } = await supabase.auth.getSession();
    const session = cached?.session;

    const needsRefresh =
      !session ||
      !session.expires_at ||
      session.expires_at - EXPIRY_MARGIN_SECONDS <= Math.floor(Date.now() / 1000);

    if (needsRefresh) {
      const { data: refreshed } = await supabase.auth.refreshSession();
      return refreshed?.session?.access_token ?? null;
    }

    return session.access_token;
  } catch { return null; }
}
