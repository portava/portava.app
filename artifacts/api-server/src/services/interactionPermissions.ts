/**
 * interactionPermissions — canonical permission engine for all social actions.
 *
 * Priority order (highest wins):
 *   1. deleted / banned / deactivated account state
 *   2. block (either direction)          ← FAIL-CLOSED
 *   3. safety / trust restriction        ← FAIL-CLOSED
 *   4. age restriction
 *   5. location / privacy settings (user_privacy_settings)
 *   6. target's profile visibility (is_private)
 *   7. context (shared trip / event / circle)
 *   8. friendship
 *   9. follow
 *  10. message request
 *  11. discovery (public fallback)
 *
 * SAFETY GUARANTEES:
 *   - Block check is FAIL-CLOSED: any DB error on the blocks query is re-thrown.
 *     We never assume "no block" when the query fails.
 *   - Trust restriction check is FAIL-CLOSED for the same reason.
 *   - Phase 2 tables that may not be migrated yet use optQuery() which silences
 *     only "table does not exist" errors; all other errors propagate.
 *   - Paid boosts NEVER override any safety-level gate.
 *   - canViewProfile=false → all downstream action capabilities are false.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getRestrictionState, DegradedPermissionCheckError } from "./trust/TrustRestrictionService.js";
import { logger as rootLogger } from "../lib/logger.js";

const log = rootLogger.child({ service: "interactionPermissions" });

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RelationshipLabel =
  | "self"
  | "blocked"
  | "blocks_you"
  | "mutual_block"
  | "friend"
  | "outgoing_request"
  | "incoming_request"
  | "following"
  | "follower"
  | "mutual_follow"
  | "same_event"
  | "same_trip"
  | "same_circle"
  | "stranger"
  | "unavailable";

export interface InteractionContext {
  sharedTrip: boolean;
  sharedCircle: boolean;
  sharedEvent: boolean;
  rabPreBooking: boolean;
  readReceiptsHidden: boolean;
  sourceType: string | null;
  sourceId: string | null;
}

export interface InteractionPermissions {
  targetUserId: string;
  viewerId: string;
  relationshipLabel: RelationshipLabel;
  profileVisibility: "public" | "friends_only" | "private" | "unavailable";

  canViewProfile: boolean;
  canViewFullProfile: boolean;

  canMessage: boolean;
  canSendMessageRequest: boolean;
  canAcceptMessageRequest: boolean;
  canDeclineMessageRequest: boolean;

  canAddFriend: boolean;
  canAcceptFriendRequest: boolean;
  canDeclineFriendRequest: boolean;
  canCancelFriendRequest: boolean;

  canFollow: boolean;
  canUnfollow: boolean;

  canSaveProfile: boolean;
  canUnsaveProfile: boolean;

  canInviteToEvent: boolean;
  canInviteToCircle: boolean;
  canInviteToTripCrew: boolean;

  canTag: boolean;
  canTagPending: boolean;  // true when tag_permission='approval_required'; insert with status='pending'
  canMention: boolean;
  canBookBuddy: boolean;
  canReview: boolean;

  canMute: boolean;
  canRestrict: boolean;
  canBlock: boolean;
  canUnblock: boolean;  // true when viewer is the blocker; false in ALL_FALSE suspension path
  canReport: boolean;
  canShareProfile: boolean;

  canSeeMutuals: boolean;
  canSeeAvailability: boolean;
  canSeeTrips: boolean;
  canSeePublicPosts: boolean;
  canSeeFriendOnlyPosts: boolean;
  canSeeLocationContext: boolean;

  safetyWarnings: string[];
  reasonCodes: string[];
  context: InteractionContext;

  /**
   * At least one read this verdict rests on FAILED, so parts of the answer are
   * a floor rather than the truth.
   *
   * The relationship reads (`user_friendships`, `friend_requests`,
   * `user_follows`) are INCLUSION signals: a failed one yields `data: null`,
   * reads as "no such relationship", and can only ever make the verdict MORE
   * restrictive — so permission itself stays safe. What is NOT safe is the
   * `relationshipLabel` and the capability set, which callers render to people
   * ("you are not connected to this user", a greyed-out Message button). Saying
   * that on the strength of a read that failed is a fabrication. The same shape
   * was fixed in lib/messagingPermissions.ts (`degraded` there); this is that
   * fix for the engine 15+ routes actually call.
   *
   * A caller may choose to say nothing, or to offer a retry, instead of saying
   * something false. It must NOT treat `degraded` as permission to widen
   * anything — the verdict is already the restrictive one.
   */
  degraded?: boolean;
  /**
   * Which reads failed, by table (plus the direction where a table is read
   * twice). Present only when `degraded` is true. Diagnostic, not a contract:
   * do not branch on the strings.
   */
  degradedReads?: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isTableMissingError(error: any): boolean {
  if (!error) return false;
  return (
    error.code === "42P01" ||
    error.code === "PGRST204" ||
    String(error.message ?? "").toLowerCase().includes("does not exist")
  );
}

/**
 * CRITICAL query — throws on ANY error. Use for blocks / trust restrictions.
 * Returns the data array (never null).
 */
async function critList<T>(result: Promise<{ data: T[] | null; error: any }>): Promise<T[]> {
  const { data, error } = await result;
  if (error) throw new Error(`Critical safety query failed: ${error.message ?? error.code ?? "db_error"}`);
  return data ?? [];
}

/**
 * OPTIONAL table query — silences "table does not exist" errors (Phase 2 tables
 * that may not be migrated yet), but re-throws all other errors.
 * Returns null (or provided fallback) when the table is missing.
 */
async function optQuery<T>(
  result: Promise<{ data: T | null; error: any }>,
  fallback: T | null = null,
): Promise<T | null> {
  const { data, error } = await result;
  if (error) {
    if (isTableMissingError(error)) return fallback;
    throw new Error(`DB query failed: ${error.message ?? error.code ?? "db_error"}`);
  }
  return data ?? fallback;
}

/**
 * OPTIONAL list query — same as optQuery but for list results.
 */
async function optList<T>(
  result: Promise<{ data: T[] | null; error: any }>,
): Promise<T[]> {
  const { data, error } = await result;
  if (error) {
    if (isTableMissingError(error)) return [];
    throw new Error(`DB query failed: ${error.message ?? error.code ?? "db_error"}`);
  }
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Blank deny template
// ---------------------------------------------------------------------------

const ALL_FALSE: Omit<
  InteractionPermissions,
  "targetUserId" | "viewerId" | "relationshipLabel" | "profileVisibility" | "safetyWarnings" | "reasonCodes" | "context"
> = {
  canViewProfile: false,
  canViewFullProfile: false,
  canMessage: false,
  canSendMessageRequest: false,
  canAcceptMessageRequest: false,
  canDeclineMessageRequest: false,
  canAddFriend: false,
  canAcceptFriendRequest: false,
  canDeclineFriendRequest: false,
  canCancelFriendRequest: false,
  canFollow: false,
  canUnfollow: false,
  canSaveProfile: false,
  canUnsaveProfile: false,
  canInviteToEvent: false,
  canInviteToCircle: false,
  canInviteToTripCrew: false,
  canTag: false,
  canMention: false,
  canBookBuddy: false,
  canReview: false,
  canMute: false,
  canRestrict: false,
  canBlock: true,    // can always block unless already blocked
  canUnblock: false, // set per-context based on whether viewer is the blocker
  canReport: true,   // can always report
  canTagPending: false,
  canShareProfile: false,
  canSeeMutuals: false,
  canSeeAvailability: false,
  canSeeTrips: false,
  canSeePublicPosts: false,
  canSeeFriendOnlyPosts: false,
  canSeeLocationContext: false,
};

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  sourceType?: string | null;
  sourceId?: string | null;
}

export async function resolveInteractionPermissions(
  sc: SupabaseClient,
  viewerId: string,
  targetUserId: string,
  opts: ResolveOptions = {},
): Promise<InteractionPermissions> {
  const safetyWarnings: string[] = [];
  const reasonCodes: string[] = [];
  const ctx: InteractionContext = {
    sharedTrip: false,
    sharedCircle: false,
    sharedEvent: false,
    rabPreBooking: false,
    readReceiptsHidden: false,
    sourceType: opts.sourceType ?? null,
    sourceId: opts.sourceId ?? null,
  };

  // ── Self ──────────────────────────────────────────────────────────────────
  if (viewerId === targetUserId) {
    return {
      ...ALL_FALSE,
      targetUserId,
      viewerId,
      relationshipLabel: "self",
      profileVisibility: "public",
      canViewProfile: true,
      canViewFullProfile: true,
      canSeePublicPosts: true,
      canSeeFriendOnlyPosts: true,
      canSeeTrips: true,
      canSeeAvailability: true,
      canSeeMutuals: true,
      canSeeLocationContext: true,
      canMute: false,
      canRestrict: false,
      canBlock: false,
      canReport: false,
      safetyWarnings,
      reasonCodes,
      context: ctx,
    };
  }

  // ── PRIORITY 1: Target account state ──────────────────────────────────────
  // Phase 2 table — silences table-missing errors; throws on real DB errors.
  const targetState = await optQuery<{ state: string }>(
    sc.from("user_account_states")
      .select("state")
      .eq("user_id", targetUserId)
      .in("state", ["deleted", "deactivated", "banned"])
      .maybeSingle() as unknown as Promise<{ data: { state: string } | null; error: any }>,
  );
  if (targetState?.state) {
    reasonCodes.push(`target_${targetState.state}`);
    return { ...ALL_FALSE, targetUserId, viewerId, relationshipLabel: "unavailable", profileVisibility: "unavailable", canBlock: false, canReport: true, safetyWarnings, reasonCodes, context: ctx };
  }

  // ── PRIORITY 1b: Viewer account state ────────────────────────────────────
  const viewerState = await optQuery<{ state: string }>(
    sc.from("user_account_states")
      .select("state")
      .eq("user_id", viewerId)
      .in("state", ["suspended", "limited"])
      .maybeSingle() as unknown as Promise<{ data: { state: string } | null; error: any }>,
  );
  const viewerSuspended = viewerState?.state === "suspended";

  // ── PRIORITY 2: Block check (FAIL-CLOSED) ─────────────────────────────────
  // blocks is a pre-existing table. Any error is re-thrown — we never assume "no block".
  const blockRows = await critList<{ blocker_id: string }>(
    sc.from("blocks")
      .select("blocker_id")
      .or(`and(blocker_id.eq.${viewerId},blocked_id.eq.${targetUserId}),and(blocker_id.eq.${targetUserId},blocked_id.eq.${viewerId})`) as unknown as Promise<{ data: { blocker_id: string }[] | null; error: any }>,
  );
  const iBlocked   = blockRows.some((r) => r.blocker_id === viewerId);
  const theyBlocked = blockRows.some((r) => r.blocker_id === targetUserId);

  if (iBlocked || theyBlocked) {
    const label: RelationshipLabel = iBlocked && theyBlocked ? "mutual_block" : iBlocked ? "blocked" : "blocks_you";
    reasonCodes.push("blocked");
    // Undo-own-action capabilities survive a block: the blocker/blockee can still
    // remove their own restrictions (unsave, unmute, unrestrict) and their own block.
    return { ...ALL_FALSE, targetUserId, viewerId, relationshipLabel: label, profileVisibility: "private", canBlock: !iBlocked, canUnblock: iBlocked, canUnsaveProfile: true, canReport: true, safetyWarnings, reasonCodes, context: ctx };
  }

  // ── PRIORITY 3: Trust restriction on viewer (FAIL-CLOSED) ────────────────
  // Delegates to TrustRestrictionService.getRestrictionState rather than
  // querying trust_restrictions inline (as this used to) — that inline query
  // had its own independent, duplicate fail-open/fail-closed handling
  // (byte-for-byte the same isTableMissingError classifier as
  // TrustRestrictionService, which is what let it drift out of sync: a real
  // query error here threw a bare Error with no way for a caller to tell "the
  // check failed" from "the check ran and found something", so a caller could
  // only ever show a generic, non-retryable failure — never the honest
  // "try again" message TrustRestrictionService's own callers now show for
  // the same failure. Delegating fixes that at the source, for every caller
  // of resolveInteractionPermissions, not just the one that surfaced it.
  //
  // Incidental correction, not the point of this change but worth recording:
  // the inline query never filtered on expires_at, so an EXPIRED messaging
  // restriction was enforced here forever. getRestrictionState excludes
  // expired restrictions, matching every other consumer.
  const restrictionState = await getRestrictionState(sc, viewerId);
  if (restrictionState.degradedReason === "fail_closed") {
    // Fail-OPEN is handled by getRestrictionState itself (canMessage stays
    // true, logged there at WARN) and needs no special case here — it falls
    // through to the normal computation below like a clean, unrestricted read.
    // Fail-CLOSED must not read as "the viewer is trust-restricted": throw a
    // discriminated error so the caller can show a retryable "try again"
    // message instead of a real-restriction message.
    throw new DegradedPermissionCheckError(
      "Trust restriction check could not be completed",
      "fail_closed",
    );
  }
  const viewerMessagingRestricted = !restrictionState.canMessage;
  if (viewerMessagingRestricted) safetyWarnings.push("viewer_messaging_restricted");

  // ── PRIORITY 3b: Admin moderation actions against target ──────────────────
  const modRows = await optList<{ action_type: string }>(
    sc.from("moderation_actions")
      .select("action_type")
      .eq("target_user_id", targetUserId)
      .limit(1) as unknown as Promise<{ data: { action_type: string }[] | null; error: any }>,
  );
  if (modRows.length > 0) safetyWarnings.push("target_under_moderation");

  // ── PRIORITY 4: Age restriction (Phase 2 table) ───────────────────────────
  const privSettings = await optQuery<{
    age_restriction_enabled: boolean;
    profile_visibility: string | null;
    who_can_tag: string | null;
  }>(
    sc.from("user_privacy_settings")
      .select("age_restriction_enabled, profile_visibility, who_can_tag")
      .eq("user_id", targetUserId)
      .maybeSingle() as unknown as Promise<{ data: any; error: any }>,
  );

  const ageRestricted = Boolean(privSettings?.age_restriction_enabled);
  if (ageRestricted) {
    safetyWarnings.push("age_restriction");
    reasonCodes.push("age_restricted");
  }

  // ── Interaction opt-outs (audit PRIV-3) ───────────────────────────────────
  // PATCH /me/privacy writes allow_follow / allow_friend_requests /
  // allow_tagging into profile_privacy_settings, but only profile_visibility is
  // synced across to user_privacy_settings — so these three opt-outs were
  // advisory-only (the passport hint hid the button, but a direct
  // POST /users/:id/follow|friend-request bypassed it). Read them from the table
  // the settings UI writes and enforce them below. Absent row / null = allowed.
  const ppSettings = await optQuery<{
    allow_follow: boolean | null;
    allow_friend_requests: boolean | null;
    allow_tagging: boolean | null;
  }>(
    sc.from("profile_privacy_settings")
      .select("allow_follow, allow_friend_requests, allow_tagging")
      .eq("user_id", targetUserId)
      .maybeSingle() as unknown as Promise<{ data: any; error: any }>,
  );
  const allowFollow = ppSettings?.allow_follow !== false;
  const allowFriendRequests = ppSettings?.allow_friend_requests !== false;
  const allowTagging = ppSettings?.allow_tagging !== false;

  // ── Parallel relationship + profile queries ───────────────────────────────
  const ua = viewerId < targetUserId ? viewerId : targetUserId;
  const ub = viewerId < targetUserId ? targetUserId : viewerId;

  const [
    profileRes,
    friendshipRes,
    outReqRes,
    inReqRes,
    vFollowsTRes,
    tFollowsVRes,
    msgSettingsRes,
    msgCooldownRes,
    nudgeCooldownRes,
    friendReqCooldownRes,
    followCooldownRes,
    muteRes,
    restrictionRes,
  ] = (await Promise.allSettled([
    sc.from("profiles").select("id, is_private, tag_permission").eq("id", targetUserId).maybeSingle(),
    sc.from("user_friendships").select("user_a").eq("user_a", ua).eq("user_b", ub).maybeSingle(),
    sc.from("friend_requests").select("id").eq("requester_id", viewerId).eq("recipient_id", targetUserId).eq("status", "pending").maybeSingle(),
    sc.from("friend_requests").select("id").eq("requester_id", targetUserId).eq("recipient_id", viewerId).eq("status", "pending").maybeSingle(),
    sc.from("user_follows").select("follower_id").eq("follower_id", viewerId).eq("following_id", targetUserId).maybeSingle(),
    sc.from("user_follows").select("follower_id").eq("follower_id", targetUserId).eq("following_id", viewerId).maybeSingle(),
    sc.from("user_message_settings").select("message_privacy, allow_message_requests").eq("user_id", targetUserId).maybeSingle(),
    // message_request cooldown (Phase 2 table — optional)
    sc.from("user_interaction_cooldowns").select("expires_at").eq("user_id", viewerId).eq("target_user_id", targetUserId).eq("cooldown_type", "message_request").maybeSingle(),
    // nudge cooldown (Phase 2 table — optional; uses cooldown_type='nudge')
    sc.from("user_interaction_cooldowns").select("expires_at").eq("user_id", viewerId).eq("target_user_id", targetUserId).eq("cooldown_type", "nudge").maybeSingle(),
    // friend_request cooldown — set after a decline (24 h) or block (90 days)
    sc.from("user_interaction_cooldowns").select("expires_at").eq("user_id", viewerId).eq("target_user_id", targetUserId).eq("cooldown_type", "friend_request").maybeSingle(),
    // follow cooldown — set after a block (90 days) to prevent follow churn
    sc.from("user_interaction_cooldowns").select("expires_at").eq("user_id", viewerId).eq("target_user_id", targetUserId).eq("cooldown_type", "follow").maybeSingle(),
    // viewer mutes target (Phase 2 table — optional)
    sc.from("user_mutes").select("muter_id").eq("muter_id", viewerId).eq("muted_id", targetUserId).maybeSingle(),
    // target restricts viewer (Phase 2 table — optional)
    sc.from("user_restrictions").select("restrictor_id").eq("restrictor_id", targetUserId).eq("restricted_id", viewerId).maybeSingle(),
  ])).map((r) =>
    r.status === "fulfilled"
      ? r.value
      : { data: null, error: (r.reason && (r.reason as any).code) ? r.reason : { code: "42P01", message: String((r.reason as any)?.message ?? r.reason) } },
  ) as any;

  // Extract values — for optional Phase 2 tables, ignore table-missing errors
  const targetProfile = (profileRes as any).data as { id: string; is_private: boolean; tag_permission: string } | null;

  // ── Read failures are OBSERVED, not inferred from an empty result ─────────
  // supabase-js RESOLVES on a database error, and `Promise.allSettled` above
  // normalises a rejection into the same `{ data: null, error }` shape. So for
  // every one of these reads `data: null` means EITHER "no such row" OR "the
  // read failed", and nothing downstream could tell them apart because `.error`
  // was never bound. `realError` is the only failure signal there is.
  //
  // A "table missing" error is NOT a failure here: several of these are Phase 2
  // tables that may not be migrated yet, and their absence genuinely means
  // "nobody has one of these".
  const degradedReads: string[] = [];
  const realError = (res: any): any =>
    res && res.error && !isTableMissingError(res.error) ? res.error : null;

  /**
   * The relationship reads are INCLUSION signals: a failed one reads as "no
   * such relationship" and can only ever make the verdict MORE restrictive, so
   * permission stays safe. What was missing is any signal at all — a friend
   * losing access to a friends-only profile during a bad database minute looked
   * exactly like the privacy setting working. Each failure is now named, and
   * the verdict is marked `degraded` for the caller.
   *
   * `user_interaction_cooldowns` and `user_mutes` are listed for observation
   * only; their direction is unchanged by this commit and is discussed below.
   */
  const observedReads: Array<[label: string, res: any]> = [
    ["profiles", profileRes],
    ["user_friendships", friendshipRes],
    ["friend_requests(viewer→target)", outReqRes],
    ["friend_requests(target→viewer)", inReqRes],
    ["user_follows(viewer→target)", vFollowsTRes],
    ["user_follows(target→viewer)", tFollowsVRes],
    ["user_interaction_cooldowns(message_request)", msgCooldownRes],
    ["user_interaction_cooldowns(nudge)", nudgeCooldownRes],
    ["user_interaction_cooldowns(friend_request)", friendReqCooldownRes],
    ["user_interaction_cooldowns(follow)", followCooldownRes],
    ["user_mutes", muteRes],
    ["user_restrictions", restrictionRes],
  ];
  for (const [label, res] of observedReads) {
    const err = realError(res);
    if (!err) continue;
    degradedReads.push(label);
    log.error(
      { err, read: label, viewerId, targetUserId },
      "resolveInteractionPermissions: read failed; the verdict below is a floor, not the truth",
    );
  }
  // NOT captured as a const here: the context queries below push to
  // `degradedReads` too, and `mark()` is called after them. Reading the length
  // at mark-time is the whole point — a snapshot taken here would silently drop
  // every context-read failure from the contract it is meant to report.

  const isFriend = Boolean((friendshipRes as any).data);
  const hasOutgoingFriendReq = Boolean((outReqRes as any).data);
  const hasIncomingFriendReq = Boolean((inReqRes as any).data);
  const viewerFollowsTarget = Boolean((vFollowsTRes as any).data);
  const targetFollowsViewer = Boolean((tFollowsVRes as any).data);

  const msgSettingsData = (msgSettingsRes as any).error && !isTableMissingError((msgSettingsRes as any).error)
    ? (() => { throw new Error(`msg settings query failed: ${(msgSettingsRes as any).error.message}`); })()
    : ((msgSettingsRes as any).data as { message_privacy: string; allow_message_requests: boolean } | null);

  // Cooldown: active if row exists and not expired (or no expiry = permanent)
  //
  // DIRECTION UNCHANGED, and recorded rather than quietly kept: a cooldown row
  // is a DENY signal (the follow cooldown is set for 90 days after a block), so
  // `return false` on error is fail-OPEN — an unreadable
  // `user_interaction_cooldowns` lets a previously-blocked viewer follow again.
  // Flipping it to fail-CLOSED would block a legitimate pair's friend request
  // and follow for the duration of an outage, which is a behaviour change for
  // 15+ routes and belongs to whoever owns the cooldown policy, not to a
  // read-hygiene pass. What this commit does supply is the signal that was
  // missing entirely: the failure is logged and named in `degradedReads` above,
  // so the fail-open is now observable instead of silent.
  function isActiveCooldown(res: { data: { expires_at: string | null } | null; error: any } | any): boolean {
    if ((res as any).error && !isTableMissingError((res as any).error)) return false; // skip on error — see note above
    if (!(res as any).data) return false;
    const exp = (res as any).data.expires_at as string | null;
    return !exp || new Date(exp) > new Date();
  }

  const msgCooldownActive = isActiveCooldown(msgCooldownRes);
  const nudgeCooldownActive = isActiveCooldown(nudgeCooldownRes);
  const friendReqCooldownActive = isActiveCooldown(friendReqCooldownRes);
  if (nudgeCooldownActive) safetyWarnings.push("nudge_cooldown");
  const followCooldownActive = isActiveCooldown(followCooldownRes);

  // `isMuted` is currently CONSUMED BY NOTHING — `canMute` is unconditionally
  // true in every return below. Left in place (deleting it would also delete
  // the only record that the mute read happens at all) but named here so the
  // next reader does not mistake it for a live decision.
  const isMuted = (muteRes as any).error && !isTableMissingError((muteRes as any).error)
    ? false
    : Boolean((muteRes as any).data);
  void isMuted;

  // ── user_restrictions — FAIL-CLOSED ──────────────────────────────────────
  // A row here means the target has RESTRICTED the viewer, so an empty result
  // is the permissive answer and this read was fail-open by construction:
  // `? false` said "not restricted" about a table that could not be read,
  // which is the same class of defect as the `blocks` read two branches up —
  // and that one re-throws (`critList`) precisely so "no block" is never said
  // on the strength of a failed query.
  //
  // Why this does NOT re-throw like `blocks`: `blocks` is a pre-existing table
  // whose absence is impossible and whose verdict gates every interaction, so
  // aborting is proportionate. `user_restrictions` is an optional Phase 2 table
  // feeding one context flag; throwing would take down profile resolution for
  // 15+ routes because a read-receipt hint blinked. So it fails closed IN ITS
  // OWN DIRECTION — assume the restriction is in force — and marks the verdict
  // degraded so the caller knows the flag is a precaution, not an observation.
  //
  // A missing table (42P01 — Phase 2 not migrated) still means "no restrictions
  // exist", which is a real answer and stays `false`.
  const restrictionErr = realError(restrictionRes);
  const readReceiptsHidden = restrictionErr
    ? true
    : Boolean((restrictionRes as any).data);
  if (restrictionErr) {
    log.error(
      { err: restrictionErr, viewerId, targetUserId },
      "resolveInteractionPermissions: user_restrictions unreadable — assuming the viewer IS restricted " +
        "rather than reporting 'not restricted' from a read that failed",
    );
  }

  if (readReceiptsHidden) safetyWarnings.push("read_receipts_hidden");

  // ── Context queries ───────────────────────────────────────────────────────
  //
  // These three used to be the LAST reads in this function that could change
  // the verdict without anyone knowing they had failed, and they were failing
  // in three distinct ways at once:
  //
  //   1. DATA-ONLY. `const { data: vTrips } = await …` never bound `.error`, so
  //      an unreadable `trip_members` produced `data: null`, `ids.length === 0`
  //      and the answer "you share no trip" — indistinguishable from the truth.
  //   2. `.catch(() => false)` IS DEAD CODE for a database error. supabase-js
  //      RESOLVES on one; postgrest-js even catches fetch failures itself and
  //      resolves `{ error: { message: "TypeError: fetch failed" }, status: 0 }`
  //      (measured against supabase-js 2.108.2). So the catch only ever fires
  //      on a WIRING bug — `sc` not being a query builder — and answered `false`
  //      silently for that too. It is kept, because a wiring bug must not take
  //      down profile resolution, but it now says what happened.
  //   3. Their results feed the same verdict every read above is now careful to
  //      mark `degraded`, so they could quietly downgrade an answer while the
  //      contract on that answer said nothing was wrong. The file's own promise
  //      was inconsistent with itself.
  //
  // DIRECTION IS UNCHANGED for the two membership reads, deliberately:
  // `sharedTrip` and `sharedCircle` are permission-ELEVATING inclusion signals
  // (`if (!directMsgOk && sharedTrip) directMsgOk = true`), so a failed read
  // resolving to `false` can only ever make the verdict MORE restrictive. The
  // defect was never the direction — it was that nothing was told. The fix is
  // the SIGNAL.
  const noteContextFailure = (label: string, err: unknown, wiring = false): void => {
    degradedReads.push(label);
    log.error(
      { err, read: label, viewerId, targetUserId, wiringBug: wiring },
      wiring
        ? "resolveInteractionPermissions: context query THREW — supabase-js resolves on db errors, so this is a wiring bug, not an unhealthy database"
        : "resolveInteractionPermissions: context read failed; treated as 'no shared context', which withholds reach the pair may be entitled to",
    );
  };

  const [sharedTrip, sharedCircle, rabPreBooking] = await Promise.all([
    // shared trip: two-step (viewer's trips → check if target is also member)
    (async (): Promise<boolean> => {
      const { data: vTrips, error: vTripsErr } = await sc.from("trip_members").select("trip_id").eq("user_id", viewerId).in("role", ["owner", "member"]);
      if (vTripsErr) { noteContextFailure("trip_members(viewer)", vTripsErr); return false; }
      const ids = (vTrips ?? []).map((m: any) => m.trip_id as string);
      if (ids.length === 0) return false;
      const { data: shared, error: sharedErr } = await sc.from("trip_members").select("trip_id").eq("user_id", targetUserId).in("role", ["owner", "member"]).in("trip_id", ids).limit(1).maybeSingle();
      if (sharedErr) { noteContextFailure("trip_members(target)", sharedErr); return false; }
      return Boolean(shared);
    })().catch((err) => { noteContextFailure("trip_members", err, true); return false; }),

    // shared circle
    Promise.resolve(
      sc.from("circle_memberships")
        .select("user_id")
        .or(`and(user_id.eq.${targetUserId},other_id.eq.${viewerId}),and(user_id.eq.${viewerId},other_id.eq.${targetUserId})`)
        .limit(1)
        .maybeSingle(),
    ).then((r: any) => {
      if (r?.error) { noteContextFailure("circle_memberships", r.error); return false; }
      return Boolean(r?.data);
    }).catch((err) => { noteContextFailure("circle_memberships", err, true); return false; }),

    // RaB pre-booking — the window in which the off-app-payment warning applies.
    //
    // This read was dead twice over and both failures were swallowed by the
    // `.catch(() => false)` below, so `ctx.rabPreBooking` has always been false
    // and `rab_off_app_payment_risk` has never once been emitted, from any of
    // its callers:
    //   1. `client_id` is not a column of rent_buddy_bookings (the traveller
    //      side is `traveler_id` — see rentABuddy.ts and
    //      CompassAbuseDefenseEngine.ts) → 42703, the whole query rejected.
    //   2. `pre_booking` is not a label of the `rent_buddy_booking_status`
    //      enum → 22P02, the whole query rejected.
    // The status set below is the pre-session lifecycle in real labels:
    // requested → pending → confirmed → scheduled. Erring wide is the
    // fail-closed direction for a safety warning.
    //
    // DIRECTION CHANGED here, and only here. Unlike the two reads above, this
    // one does not elevate permission — it raises a safety WARNING, so `false`
    // is the permissive answer and an unreadable table suppressing the warning
    // is fail-OPEN. The comment directly above already records this file's
    // ruling that "erring wide is the fail-closed direction for a safety
    // warning"; that ruling is now applied to the error path too. The cost of
    // erring wide is an off-app-payment caution shown to a pair who may have no
    // booking; the cost of erring narrow is withholding it from a pair who do.
    Promise.resolve(
      sc.from("rent_buddy_bookings")
        .select("id")
        .or(`and(traveler_id.eq.${viewerId},buddy_id.eq.${targetUserId}),and(traveler_id.eq.${targetUserId},buddy_id.eq.${viewerId})`)
        .in("status", ["requested", "pending", "confirmed", "scheduled"])
        .limit(1)
        .maybeSingle(),
    ).then((r: any) => {
      if (r?.error) { noteContextFailure("rent_buddy_bookings", r.error); return true; }
      return Boolean(r?.data);
    }).catch((err) => { noteContextFailure("rent_buddy_bookings", err, true); return true; }),
  ]);

  ctx.sharedTrip = sharedTrip;
  ctx.sharedCircle = sharedCircle;
  ctx.rabPreBooking = rabPreBooking;
  ctx.readReceiptsHidden = readReceiptsHidden;

  if (rabPreBooking) safetyWarnings.push("rab_off_app_payment_risk");

  /**
   * Stamp the degraded marker onto a verdict. Every return AFTER the batch of
   * reads above goes through this; the earlier returns (self, account state,
   * block, trust restriction) are decided before any of those reads and cannot
   * be degraded by them.
   */
  const mark = (v: InteractionPermissions): InteractionPermissions =>
    degradedReads.length > 0 ? { ...v, degraded: true, degradedReads: [...degradedReads] } : v;

  // ── PRIORITY 5: Target profile must exist ────────────────────────────────
  if (!targetProfile) {
    // "not found" is a claim about the target. When the `profiles` read itself
    // failed, that claim is a fabrication — the profile may well exist — so the
    // reason code says which of the two actually happened. The verdict is
    // ALL_FALSE either way, so nothing is widened by telling the truth here.
    reasonCodes.push(realError(profileRes) ? "target_lookup_failed" : "target_not_found");
    return mark({ ...ALL_FALSE, targetUserId, viewerId, relationshipLabel: "unavailable", profileVisibility: "unavailable", canBlock: false, canReport: false, safetyWarnings, reasonCodes, context: ctx });
  }

  // Privacy: privacy_settings overrides profiles.is_private when present
  const isPrivate: boolean =
    privSettings?.profile_visibility === "private" ||
    (privSettings === null && Boolean(targetProfile.is_private));

  // ── Relationship label ────────────────────────────────────────────────────
  let relationshipLabel: RelationshipLabel;
  if (isFriend)                               relationshipLabel = "friend";
  else if (hasOutgoingFriendReq)              relationshipLabel = "outgoing_request";
  else if (hasIncomingFriendReq)              relationshipLabel = "incoming_request";
  else if (viewerFollowsTarget && targetFollowsViewer) relationshipLabel = "mutual_follow";
  else if (viewerFollowsTarget)               relationshipLabel = "following";
  else if (targetFollowsViewer)               relationshipLabel = "follower";
  else if (sharedTrip)                        relationshipLabel = "same_trip";
  else if (sharedCircle)                      relationshipLabel = "same_circle";
  else                                        relationshipLabel = "stranger";

  if (opts.sourceType === "event" && opts.sourceId) {
    ctx.sharedEvent = true;
    if (relationshipLabel === "stranger") relationshipLabel = "same_event";
  }

  // ── PRIORITY 6: Profile visibility gate ──────────────────────────────────
  const canViewProfile = !isPrivate || isFriend;
  if (!canViewProfile) {
    reasonCodes.push("private_profile");
    // Surface friend-request capabilities even when the profile content is not
    // visible. This lets the follow route (and any future surface) transparently
    // redirect a follow-of-private-profile into a friend request while still
    // enforcing suspension/cooldown/existing-request guards.
    return mark({
      ...ALL_FALSE,
      targetUserId,
      viewerId,
      relationshipLabel,
      profileVisibility: "private",
      canBlock: true,
      canUnblock: true,
      canUnsaveProfile: true,
      canReport: true,
      // Allow friend-request writes iff the viewer is not suspended, no cooldown,
      // and no request already exists in this direction.
      canAddFriend: !isFriend && !hasOutgoingFriendReq && !hasIncomingFriendReq && !viewerSuspended && !friendReqCooldownActive,
      canAcceptFriendRequest: hasIncomingFriendReq && !viewerSuspended,
      safetyWarnings,
      reasonCodes,
      context: ctx,
    });
  }

  // ── Messaging ─────────────────────────────────────────────────────────────
  const msgPrivacy     = msgSettingsData?.message_privacy ?? "everyone";
  const allowMsgReqs   = msgSettingsData?.allow_message_requests ?? true;

  let directMsgOk = false;
  switch (msgPrivacy) {
    case "everyone":     directMsgOk = true; break;
    case "friends":      directMsgOk = isFriend; break;
    case "followers":    directMsgOk = viewerFollowsTarget; break;
    case "following":    directMsgOk = targetFollowsViewer; break;
    case "trip_members": directMsgOk = sharedTrip; break;
    case "no_one":       directMsgOk = false; break;
  }
  // Shared context can elevate to direct
  if (!directMsgOk && sharedTrip)   directMsgOk = true;
  if (!directMsgOk && sharedCircle) directMsgOk = true;
  // Safety overrides (always last)
  if (viewerSuspended || viewerMessagingRestricted) directMsgOk = false;

  const canMessage = directMsgOk;
  const canSendMessageRequest =
    !canMessage &&
    allowMsgReqs &&
    !viewerSuspended &&
    !viewerMessagingRestricted &&
    msgPrivacy !== "no_one" &&
    !msgCooldownActive;

  // ── Tag permission ────────────────────────────────────────────────────────
  const whoCanTag = privSettings?.who_can_tag ?? targetProfile.tag_permission ?? "everyone";
  let canTag = false;
  let canTagPending = false;  // true when tag_permission='approval_required' → insert with status='pending'
  switch (whoCanTag) {
    case "everyone":            canTag = true; break;
    case "friends":
    case "friends_only":        canTag = isFriend; break;
    case "followers":           canTag = viewerFollowsTarget; break;
    case "no_one":              canTag = false; break;
    case "approval_required":   canTagPending = true; canTag = false; break;
    default:                    canTag = true;
  }
  // allow_tagging=false is a hard opt-out that overrides who_can_tag (PRIV-3).
  if (!allowTagging) { canTag = false; canTagPending = false; }

  // ── Final permissions ─────────────────────────────────────────────────────
  return mark({
    targetUserId,
    viewerId,
    relationshipLabel,
    profileVisibility: isFriend || !isPrivate ? "public" : "friends_only",

    canViewProfile:     true,
    canViewFullProfile: true,

    canMessage,
    canSendMessageRequest,
    canAcceptMessageRequest: false,
    canDeclineMessageRequest: false,

    canAddFriend:          allowFriendRequests && !isFriend && !hasOutgoingFriendReq && !hasIncomingFriendReq && !viewerSuspended && !friendReqCooldownActive,
    canAcceptFriendRequest: hasIncomingFriendReq && !viewerSuspended,
    canDeclineFriendRequest: hasIncomingFriendReq && !viewerSuspended,
    canCancelFriendRequest: hasOutgoingFriendReq,

    canFollow:   allowFollow && !viewerFollowsTarget && !viewerSuspended && !followCooldownActive,
    canUnfollow: viewerFollowsTarget,

    canSaveProfile:   true,
    canUnsaveProfile: true,

    canInviteToEvent:   !ageRestricted && !viewerSuspended,
    canInviteToCircle:  !ageRestricted && !viewerSuspended,
    canInviteToTripCrew: !ageRestricted && !viewerSuspended,

    canTag:        canTag && !viewerSuspended,
    canTagPending: canTagPending && !viewerSuspended,
    canMention:    !viewerSuspended,
    canBookBuddy: !viewerSuspended,
    canReview:   !viewerSuspended,

    canMute:     true,  // always allow mute/update; blocked/suspended handled by early ALL_FALSE return
    canRestrict: true,
    canBlock:    true,
    canUnblock:  true,  // in normal path (no block active), unblock is a no-op but allowed
    canReport:   true,
    canShareProfile: true,

    canSeeMutuals:         isFriend || viewerFollowsTarget,
    canSeeAvailability:    isFriend || sharedTrip || sharedCircle,
    canSeeTrips:           isFriend || !isPrivate,
    canSeePublicPosts:     true,
    canSeeFriendOnlyPosts: isFriend,
    canSeeLocationContext: isFriend || sharedTrip,

    safetyWarnings,
    reasonCodes,
    context: ctx,
  });
}
