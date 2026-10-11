/**
 * deviceSessionGate — the REFUSAL half of §30A.7 device revocation (census-
 * telegraph T401). A leaf module (type-only dependencies) because lib/http.ts
 * and lib/accountStateGate.ts call it from every getUser site, and whatever
 * they load, every route loads. The revocation half is lib/deviceRevocation.ts.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";

/** The `app_metadata` key that lists revoked device sessions. */
export const REVOKED_SESSIONS_METADATA_KEY = "revoked_device_sessions";

/**
 * How many revoked session ids are kept. `app_metadata` is copied into every
 * access token the account mints, so the list must stay short. A revoked
 * session is ALSO ended in GoTrue the first time it calls in, after which the
 * entry is no longer what refuses it.
 */
export const REVOKED_SESSIONS_CAP = 20;

/** The 401 message a revoked device's request receives. */
export const REVOKED_DEVICE_MESSAGE = "This device has been signed out";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `session_id` claim of a Supabase access token, or null.
 *
 * Only ever called on a token `auth.getUser` has ALREADY verified (or, on the
 * revocation path, on the caller's own verified token) — so decoding without
 * checking the signature reads a claim the auth service vouched for.
 */
export function sessionIdFromAccessToken(token: string | null | undefined): string | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    const sid = claims?.session_id;
    return typeof sid === "string" && UUID_RE.test(sid) ? sid.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The revoked session ids recorded on a user, normalised. */
export function revokedSessionIds(user: Pick<User, "app_metadata"> | null | undefined): string[] {
  const raw = (user?.app_metadata as Record<string, unknown> | undefined)?.[REVOKED_SESSIONS_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === "string").map((s) => s.toLowerCase());
}

/** Is this verified token a session of a revoked device? */
export function isRevokedDeviceSession(user: Pick<User, "app_metadata"> | null | undefined, token: string): boolean {
  const sid = sessionIdFromAccessToken(token);
  if (!sid) return false;
  return revokedSessionIds(user).includes(sid);
}

/**
 * End a revoked token's session in GoTrue (its refresh token stops working).
 * Best effort: the app_metadata entry refuses the session either way.
 */
export async function endRevokedSession(client: SupabaseClient, token: string): Promise<void> {
  try {
    await (client as any).auth?.admin?.signOut?.(token, "local");
  } catch {
    /* the listed session id is what refuses this token; GoTrue's copy is belt and braces */
  }
}
