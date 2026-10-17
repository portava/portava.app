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

/**
 * Owner binding for a token this module already handed out: true only when the
 * CURRENT session is still `ownerId`'s and its access token is exactly `token`.
 *
 * Callers that must not send one person's request under another person's
 * session (a sign-out/sign-in between `freshToken()` and the fetch) used to
 * re-read `getSession()` themselves and compare `access_token` — the very
 * pattern `getSession.bypassGuard.test.ts` forbids outside this file, because a
 * second token-reading site is where an unrefreshed token leaks out. The check
 * lives here so the token still only ever comes from `freshToken()`; this
 * function answers a yes/no and never returns a token. Any read failure is a
 * "no" (fail closed).
 */
export async function isCurrentSessionToken(ownerId: string, token: string): Promise<boolean> {
  if (!ownerId || !token) return false;
  try {
    const { data } = await _client.auth.getSession();
    const session = data?.session as { access_token?: string; user?: { id?: string } } | null | undefined;
    return session?.user?.id === ownerId && session.access_token === token;
  } catch { return false; }
}
