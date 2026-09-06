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
 * SAFETY: every privacy input is FAIL-CLOSED.
 *   • block check       — throws on any DB error.
 *   • account state     — a genuinely ABSENT table (42P01 / PGRST205) is skipped;
 *                         any OTHER error (RLS denial, connection failure,
 *                         PGRST204 missing-column) yields "unavailable". It used
 *                         to test `if (!acctErr && acct?.state)`, so a failed read
 *                         read as "no restriction" and a deactivated / banned /
 *                         deleted profile stayed fully visible.
 *   • privacy settings  — a failed read no longer collapses to `null` (which every
 *                         caller's `?.show_x === false` test read as "opted in").
 *                         `privacySettingsUnavailable` is raised so callers can
 *                         withhold, and the profile is treated as non-public.
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
  /**
   * TRUE when profile_privacy_settings could not be READ (as distinct from
   * "the owner has no row", which is a successful read and leaves this false).
   * A caller that gates content on `privacySettings?.show_x === false` MUST
   * withhold that content when this is true — the flags are unknown, not false.
   */
  privacySettingsUnavailable: boolean;
}

/**
 * TRUE only for a genuinely ABSENT TABLE. PGRST204 ("column not found") is
 * deliberately NOT here: column drift is not a missing table, and treating it as
 * one turns a schema mismatch into a silent privacy fail-open. The message probe
 * likewise requires "relation" so that `column "x" does not exist` does not
 * sneak through it.
 */
function isTableMissingErr(e: any): boolean {
  if (!e) return false;
  if (e.code === "42P01" || e.code === "PGRST205") return true;
  const msg = String(e.message ?? "").toLowerCase();
  return msg.includes("relation") && msg.includes("does not exist");
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
    let ps: any = null;
    try {
      const res = await sc
        .from("profile_privacy_settings")
        .select("*")
        .eq("user_id", targetId)
        .maybeSingle();
      ps = res.data ?? null;
    } catch {
      ps = null;
    }
    // The owner is never gated by their own flags, so an unreadable row cannot
    // leak anything here.
    return { visibility: "full", privacySettings: ps, privacySettingsUnavailable: false };
  }

  // ── 1. Account status — profile row first (fast path), then state table ───
  const profileAccountStatus = targetProfileRow.account_status ?? null;
  if (profileAccountStatus && profileAccountStatus !== "active") {
    return { visibility: "unavailable", privacySettings: null, privacySettingsUnavailable: false };
  }

  // Fallback: query user_account_states. FAIL-CLOSED on any error other than a
  // genuinely absent table — an RLS denial or a connection failure tells us
  // NOTHING about the account's state, and must not be read as "still active".
  try {
    const { data: acct, error: acctErr } = await sc
      .from("user_account_states")
      .select("state")
      .eq("user_id", targetId)
      .in("state", ["deleted", "deactivated", "banned", "suspended"])
      .maybeSingle();
    if (acctErr) {
      if (!isTableMissingErr(acctErr)) {
        return { visibility: "unavailable", privacySettings: null, privacySettingsUnavailable: false };
      }
      // table genuinely absent → no restriction to read
    } else if (acct?.state) {
      return { visibility: "unavailable", privacySettings: null, privacySettingsUnavailable: false };
    }
  } catch (e: any) {
    if (!isTableMissingErr(e)) {
      return { visibility: "unavailable", privacySettings: null, privacySettingsUnavailable: false };
    }
    /* table missing → no restriction */
  }

  // ── 2. Block check (FAIL-CLOSED) ───────────────────────────────────────────
  if (viewerId) {
    const { data: blockRows, error: blockErr } = await sc
      .from("blocks")
      .select("blocker_id")
      .or(`and(blocker_id.eq.${viewerId},blocked_id.eq.${targetId}),and(blocker_id.eq.${targetId},blocked_id.eq.${viewerId})`);
    if (blockErr) throw new Error(`Block check failed: ${blockErr.message}`);
    if ((blockRows ?? []).length > 0) {
      return { visibility: "blocked", privacySettings: null, privacySettingsUnavailable: false };
    }
  }

  // ── 3. Privacy settings ────────────────────────────────────────────────────
  let privacySettings: PrivacySettings | null = null;
  let privacySettingsUnavailable = false;
  try {
    const { data: ps, error: psErr } = await sc
      .from("profile_privacy_settings")
      .select("*")
      .eq("user_id", targetId)
      .maybeSingle();
    if (psErr) {
      // A genuinely absent table is the pre-launch case this used to cover; any
      // other error means the flags are UNKNOWN, and `null` is indistinguishable
      // from "no row / all defaults on" at every call site.
      if (!isTableMissingErr(psErr)) privacySettingsUnavailable = true;
    } else {
      privacySettings = ps ?? null;
    }
  } catch (e: any) {
    if (!isTableMissingErr(e)) privacySettingsUnavailable = true;
  }

  // ── 4. Effective visibility level ─────────────────────────────────────────
  // Derive effective visibility: privacy settings row wins; fall back to the
  // profile-level fields.  All three privacy tiers must be mapped so that
  // callers without a profile_privacy_settings row still get the correct tier.
  //
  // When the settings row was UNREADABLE we cannot know the canonical tier, so
  // the profiles-row fallback is not trustworthy either: treat the profile as
  // approval-required ("private") rather than inferring "public" from a source
  // the owner may have overridden.
  const profileVis = privacySettingsUnavailable
    ? "private"
    : privacySettings?.profile_visibility ??
      (targetProfileRow.passport_visibility === "private" || targetProfileRow.is_private
        ? "private"
        : targetProfileRow.passport_visibility === "followers_only"
        ? "followers_only"
        : "public");

  if (profileVis === "public") {
    return { visibility: "full", privacySettings, privacySettingsUnavailable };
  }

  // Non-public tiers — decide what grants access:
  //   • "followers_only": an accepted friendship OR a follow grants access
  //     (following is an open action for this softer tier).
  //   • "private" (is_private / passport_visibility=private / any other
  //     non-public value): APPROVAL-REQUIRED. Only an accepted friendship
  //     (user_friendships, created when the owner accepts a request) grants
  //     access. A raw user_follows edge is UNAPPROVED — POST /follow inserts it
  //     with no owner approval — so it must NOT unlock private content.
  //     (Audit SEC-01: a stranger could self-follow a private account and read
  //     its followers-only posts/stamps/trips.) Fail-closed: anything that isn't
  //     the explicit "followers_only" tier is treated as approval-required.
  if (viewerId) {
    const ua = viewerId < targetId ? viewerId : targetId;
    const ub = viewerId < targetId ? targetId : viewerId;
    const followTierGrantsAccess = profileVis === "followers_only";
    const [friendRes, followRes] = await Promise.all([
      sc.from("user_friendships").select("user_a").eq("user_a", ua).eq("user_b", ub).maybeSingle(),
      followTierGrantsAccess
        ? sc.from("user_follows").select("follower_id").eq("follower_id", viewerId).eq("following_id", targetId).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const grantedByFriend = Boolean(friendRes.data);
    const grantedByFollow = followTierGrantsAccess && Boolean(followRes.data);
    if (grantedByFriend || grantedByFollow) {
      return { visibility: "followers_only", privacySettings, privacySettingsUnavailable };
    }
  }

  return { visibility: "limited_preview", privacySettings, privacySettingsUnavailable };
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
