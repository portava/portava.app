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
 * Account-state check is FAIL-OPEN (table missing → skip).
 *
 * ── PRIVACY SETTINGS: WHY AN UNREADABLE TABLE IS NOT "NO RESTRICTIONS" ──────
 * `profile_privacy_settings` holds the opt-OUTS. Every consumer of the row
 * reads it as `privacySettings?.show_X === false`, so a `null` row means "no
 * restriction configured" and everything is disclosed. supabase-js RESOLVES on
 * a database error, which makes an unreadable table indistinguishable from an
 * unconfigured one — so until 2026-09-08 an outage on that one table PUBLISHED
 * profiles their owners had restricted: `profile_visibility` fell back to the
 * `profiles` row (commonly "public" → "full"), and every `show_*` opt-out was
 * silently ignored.
 *
 * That is the permissive direction, so it is closed here, and closing it costs
 * the VIEWER visibility rather than costing the request: a failed read of the
 * settings table now yields RESTRICTED_PRIVACY_SETTINGS — a synthetic row with
 * every disclosure switch off and `profile_visibility: "private"`. Two
 * properties make that the right instrument:
 *
 *   • It needs no change at any of the ~10 call sites. They already ask
 *     `show_followers === false` / `profile_visibility === "private"`, and the
 *     substitute answers both correctly without a new branch to forget.
 *   • It does NOT fail the request. An approved friendship still grants
 *     "followers_only" (friendship is owner-approved at every non-public
 *     tier); a stranger gets "limited_preview" — an empty list, not a 500.
 *
 * The substitute is NEVER handed to the profile OWNER (see the self-view branch
 * below): an owner's own settings screen rendered from an all-off synthetic row
 * would show them a lie they could save back over their real settings. The
 * owner gets `privacySettings: null` plus `privacySettingsUnavailable: true`,
 * so an owner-facing caller can say "could not load" instead of "all off".
 */

import { logger } from "./logger.js";

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
   * True when `profile_privacy_settings` could not be READ (a resolved
   * PostgREST error), as opposed to the user simply having no row.
   *
   * `privacySettings` alone cannot carry that distinction: `null` is what an
   * unconfigured user looks like. A caller that renders settings back to their
   * owner MUST branch on this rather than presenting the fallback as fact.
   */
  privacySettingsUnavailable?: boolean;
}

/**
 * The privacy row assumed when `profile_privacy_settings` cannot be read for a
 * NON-OWNER viewer. Every disclosure switch is off and the tier is the
 * approval-required one, so an outage withholds rather than publishes.
 *
 * `allow_messages_from: "nobody"` is the restrictive member of the enum
 * validated at routes/profile.ts (`everyone | friends | followers | nobody`).
 * `delayed_posting_default` is not a disclosure control — it schedules the
 * owner's own posts — so it keeps the column's own default rather than being
 * flipped for the sake of symmetry.
 *
 * Frozen: it is handed out by reference to every caller of a failed read, and a
 * caller that mutated it would poison every subsequent one.
 */
export const RESTRICTED_PRIVACY_SETTINGS: Readonly<PrivacySettings> = Object.freeze({
  profile_visibility:      "private",
  show_real_name:          false,
  show_current_city:       false,
  show_home_country:       false,
  show_visited_places:     false,
  show_upcoming_trips:     false,
  show_past_trips:         false,
  show_posts:              false,
  show_stamps:             false,
  show_friends:            false,
  show_followers:          false,
  allow_messages_from:     "nobody",
  allow_friend_requests:   false,
  allow_follow:            false,
  allow_tagging:           false,
  allow_profile_discovery: false,
  delayed_posting_default: false,
  precise_location_visible: false,
});

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
  //
  // The owner's access does not depend on this read — it is "full" either way —
  // so the read's failure is not a disclosure question. It is a TRUTHFULNESS
  // question: the settings are handed back for the owner's own rendering, and
  // `null` there says "you have configured nothing", which an unreadable table
  // must not be allowed to say. Hence the explicit `privacySettingsUnavailable`
  // rather than the restricted substitute — see the module header.
  if (viewerId === targetId) {
    let ps: PrivacySettings | null = null;
    let unavailable = false;
    try {
      // `.error` is the real failure path: supabase-js RESOLVES on a database
      // error, and postgrest-js catches fetch errors itself, so a network fault
      // resolves too (measured against 2.108.2: `{ error: { message:
      // "TypeError: fetch failed", code: "" }, status: 0 }`). The surrounding
      // catch is only for a client that is not a PostgREST builder at all. It
      // is treated the same way here because the consequence — withholding one
      // profile — is proportionate either way.
      const res = await sc
        .from("profile_privacy_settings")
        .select("*")
        .eq("user_id", targetId)
        .maybeSingle();
      if (res.error && isTableMissingErr(res.error)) {
        // The table does not exist. "You have configured nothing" is then the
        // truth, not a cover story, so this is NOT reported as unavailable.
        logger.warn({ err: res.error, targetId }, "profileVisibility: profile_privacy_settings table absent (self-view)");
      } else if (res.error) {
        unavailable = true;
        logger.error(
          { err: res.error, targetId },
          "profileVisibility: owner self-view could not read profile_privacy_settings — " +
            "returning privacySettingsUnavailable rather than an empty settings row",
        );
      } else {
        ps = (res.data as PrivacySettings | null) ?? null;
      }
    } catch (err) {
      unavailable = true;
      logger.error({ err, targetId }, "profileVisibility: owner self-view privacy read threw");
    }
    return { visibility: "full", privacySettings: ps, privacySettingsUnavailable: unavailable };
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

  // ── 3. Privacy settings (FAIL-CLOSED — see module header) ─────────────────
  //
  // A read failure here used to leave `privacySettings = null`, which is the
  // shape of a user who configured nothing: the tier fell back to the profiles
  // row and every `show_*` opt-out downstream was skipped. `isTableMissingErr`
  // still distinguishes the one case where "no settings" is the honest answer —
  // the table does not exist at all (a tree without migration 0069 applied) —
  // from a table that exists and could not be read.
  let privacySettings: PrivacySettings | null = null;
  let privacySettingsUnavailable = false;
  try {
    const { data: ps, error: psErr } = await sc
      .from("profile_privacy_settings")
      .select("*")
      .eq("user_id", targetId)
      .maybeSingle();
    if (!psErr) {
      privacySettings = (ps as PrivacySettings | null) ?? null;
    } else if (isTableMissingErr(psErr)) {
      logger.warn(
        { err: psErr, targetId },
        "profileVisibility: profile_privacy_settings table absent — no privacy row exists to honour",
      );
    } else {
      privacySettingsUnavailable = true;
      privacySettings = RESTRICTED_PRIVACY_SETTINGS;
      logger.error(
        { err: psErr, targetId, viewerId },
        "profileVisibility: profile_privacy_settings unreadable — withholding under " +
          "RESTRICTED_PRIVACY_SETTINGS rather than disclosing as if unconfigured",
      );
    }
  } catch (err) {
    privacySettingsUnavailable = true;
    privacySettings = RESTRICTED_PRIVACY_SETTINGS;
    logger.error({ err, targetId, viewerId }, "profileVisibility: privacy read threw — withholding");
  }

  // ── 4. Effective visibility level ─────────────────────────────────────────
  // Derive effective visibility: privacy settings row wins; fall back to the
  // profile-level fields.  All three privacy tiers must be mapped so that
  // callers without a profile_privacy_settings row still get the correct tier.
  const profileVis =
    privacySettings?.profile_visibility ??
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
