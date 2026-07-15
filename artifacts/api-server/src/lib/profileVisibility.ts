/**
 * resolveProfileVisibility — shared helper for passport and profile-tab routes.
 *
 * Returns one of:
 *   "full"           — public profile or viewer is owner; all privacy-respecting content visible
 *   "followers_only" — private/followers-only profile, viewer IS a follower or friend
 *   "limited_preview"— private/followers-only profile, viewer is NOT follower/friend or unauthenticated
 *   "blocked"        — block relationship exists between viewer and target (either direction)
 *   "unavailable"    — account is deactivated, suspended, or deleted
 *
 * SAFETY: block check is FAIL-CLOSED (throws on DB error, not on missing table).
 * Account-state and privacy-settings checks are FAIL-OPEN (table missing → skip).
 */

export type VisibilityLevel = "full" | "followers_only" | "limited_preview" | "blocked" | "unavailable";

export interface PrivacySettings {
  profile_visibility: string;
  /** Opt-in: when false (default), other users only ever see @handle. */
  show_real_name?: boolean;
  show_current_city: boolean;
  show_home_country: boolean;
  show_visited_places: boolean;
  show_upcoming_trips: boolean;
  show_past_trips: boolean;
  show_posts: boolean;
  show_stamps: boolean;
  show_friends: boolean;
  show_followers: boolean;
  allow_messages_from: string;
  allow_friend_requests: boolean;
  allow_follow: boolean;
  allow_tagging: boolean;
  allow_profile_discovery: boolean;
  delayed_posting_default: boolean;
  precise_location_visible: boolean;
}

export interface ProfileVisibilityResult {
  visibility: VisibilityLevel;
  privacySettings: PrivacySettings | null;
}

function isTableMissingErr(e: any): boolean {
  if (!e) return false;
  return e.code === "42P01" || e.code === "PGRST204" || e.code === "PGRST205" ||
    String(e.message ?? "").toLowerCase().includes("does not exist");
}

/**
 * Determine how much of a profile a given viewer is allowed to see.
 *
 * @param sc         Service-role Supabase client (never null at call site)
 * @param viewerId   Authenticated viewer UUID, or null for unauthenticated requests
 * @param targetId   The profile being viewed
 * @param targetProfileRow  Already-fetched profiles row (must include is_private, passport_visibility)
 */
export async function resolveProfileVisibility(
  sc: any,
  viewerId: string | null,
  targetId: string,
  targetProfileRow: { is_private?: boolean | null; passport_visibility?: string | null; account_status?: string | null },
): Promise<ProfileVisibilityResult> {
  // ── Owner always gets full access ─────────────────────────────────────────
  if (viewerId === targetId) {
    const { data: ps } = await sc
      .from("profile_privacy_settings")
      .select("*")
      .eq("user_id", targetId)
      .maybeSingle()
      .catch(() => ({ data: null }));
    return { visibility: "full", privacySettings: ps ?? null };
  }

  // ── 1. Account status — profile row first (fast path), then state table ───
  const profileAccountStatus = targetProfileRow.account_status ?? null;
  if (profileAccountStatus && profileAccountStatus !== "active") {
    return { visibility: "unavailable", privacySettings: null };
  }

  // Fallback: query user_account_states (fail-open on missing table)
  try {
    const { data: acct, error: acctErr } = await sc
      .from("user_account_states")
      .select("state")
      .eq("user_id", targetId)
      .in("state", ["deleted", "deactivated", "banned", "suspended"])
      .maybeSingle();
    if (!acctErr && acct?.state) {
      return { visibility: "unavailable", privacySettings: null };
    }
  } catch { /* table missing → no restriction */ }

  // ── 2. Block check (FAIL-CLOSED) ───────────────────────────────────────────
  if (viewerId) {
    const { data: blockRows, error: blockErr } = await sc
      .from("blocks")
      .select("blocker_id")
      .or(`and(blocker_id.eq.${viewerId},blocked_id.eq.${targetId}),and(blocker_id.eq.${targetId},blocked_id.eq.${viewerId})`);
    if (blockErr) throw new Error(`Block check failed: ${blockErr.message}`);
    if ((blockRows ?? []).length > 0) {
      return { visibility: "blocked", privacySettings: null };
    }
  }

  // ── 3. Privacy settings ────────────────────────────────────────────────────
  let privacySettings: PrivacySettings | null = null;
  try {
    const { data: ps, error: psErr } = await sc
      .from("profile_privacy_settings")
      .select("*")
      .eq("user_id", targetId)
      .maybeSingle();
    if (!psErr) privacySettings = ps ?? null;
  } catch { /* table missing → null */ }

  // ── 4. Effective visibility level ─────────────────────────────────────────
  const profileVis =
    privacySettings?.profile_visibility ??
    (targetProfileRow.passport_visibility === "private" || targetProfileRow.is_private
      ? "private"
      : "public");

  if (profileVis === "public") {
    return { visibility: "full", privacySettings };
  }

  // followers_only or private: check if viewer is a follower or friend
  if (viewerId) {
    const ua = viewerId < targetId ? viewerId : targetId;
    const ub = viewerId < targetId ? targetId : viewerId;
    const [friendRes, followRes] = await Promise.all([
      sc.from("user_friendships").select("user_a").eq("user_a", ua).eq("user_b", ub).maybeSingle(),
      sc.from("user_follows").select("follower_id").eq("follower_id", viewerId).eq("following_id", targetId).maybeSingle(),
    ]);
    if (friendRes.data || followRes.data) {
      return { visibility: "followers_only", privacySettings };
    }
  }

  return { visibility: "limited_preview", privacySettings };
}

/**
 * Extract the viewer's auth token from an Express request, return null if absent.
 */
export function extractBearerToken(req: { headers: { authorization?: string } }): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const token = h.replace(/^bearer\s+/i, "").trim();
  return token || null;
}
