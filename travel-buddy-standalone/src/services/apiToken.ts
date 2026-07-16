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
import { supabase as _realSupabase } from '../lib/supabase.ts';

/** How many seconds before expiry we proactively refresh. */
const EXPIRY_MARGIN_SECONDS = 60;

// ---------------------------------------------------------------------------
// Test seam — replaced only in node:test runs via _setTestSupabase().
// ---------------------------------------------------------------------------

type SupabaseAuthLike = {
  auth: {
    getSession(): Promise<{ data: { session: { access_token: string; expires_at?: number } | null } }>;
    refreshSession(): Promise<{ data: { session: { access_token: string } | null } }>;
  };
};

let _client: SupabaseAuthLike = _realSupabase as unknown as SupabaseAuthLike;

/** For tests only — inject a fake Supabase client. */
export function _setTestSupabase(fake: SupabaseAuthLike): void {
  _client = fake;
}

/** Reset to the real Supabase client (call in afterEach). */
export function _resetTestSupabase(): void {
  _client = _realSupabase as unknown as SupabaseAuthLike;
}

// ---------------------------------------------------------------------------

/** Return a current access token, refreshing only when necessary. */
export async function freshToken(): Promise<string | null> {
  try {
    const { data: cached } = await _client.auth.getSession();
    const session = cached?.session;

    const needsRefresh =
      !session ||
      !session.access_token ||
      !session.expires_at ||
      session.expires_at - EXPIRY_MARGIN_SECONDS <= Math.floor(Date.now() / 1000);

    if (needsRefresh) {
      const { data: refreshed } = await _client.auth.refreshSession();
      return refreshed?.session?.access_token || null;
    }

    return session.access_token;
  } catch { return null; }
}
