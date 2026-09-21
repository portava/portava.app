/**
 * Find Your Circle — access guard.
 *
 * canViewCirclePresence enforces every privacy rule before a presence row is
 * returned to a viewer. Callers must pass the service-role Supabase client.
 *
 * Guard order (fail-fast):
 *   1. Admin kill switch (fail-CLOSED on DB error → an unreadable stop engages)
 *   2. Viewer is an accepted trip/event member (trip_members or event_rsvps)
 *   3. Target is an accepted trip/event member
 *   4. Target has global_enabled + valid consent
 *   5. Target context settings: not off, not paused
 *   6. Mutual block check
 *   7. Target not banned / suspended / deleted
 *   8. Presence row: expired → blocked; stale → allowed but flagged
 *
 * Telegraph-only membership does NOT satisfy the check — only rows in
 * trip_members / event_rsvps (going) qualify.
 * Follow relationship alone does NOT satisfy the check.
 *
 * THREE ANSWERS, NOT TWO. Every step above denies on a database error, and that
 * has not changed. What changed is what the denial SAYS. A failed read used to
 * be folded into the verdict an empty read produces — `viewer_not_member`,
 * `target_not_member`, `target_sharing_off` — so an outage was reported to the
 * caller as a fact about who the user is and what they chose. Those are now
 * `reason: "unavailable"`, the state this file already used for a failed
 * target-side read in canBeSeenByViewersBatch, and every one is logged. Callers
 * that only read `.allowed` are unaffected; a caller that wants to say "try
 * again" instead of "you are not on this trip" now has something to read.
 */

import { isKillSwitchEngaged } from "./featureFlags.js";
import { isBlockedBetween } from "./blockGuard.js";
import { logger as rootLogger } from "./logger.js";

const log = rootLogger.child({ lib: "circleAccessGuard" });

export const CURRENT_CONSENT_VERSION = "v1";

export type ContextType = "trip" | "event";

export interface CircleAccessResult {
  allowed: boolean;
  reason?: string;
  isStale?: boolean;
  presenceRow?: Record<string, any> | null;
  visibilityMode?: string;
}

/** Accepted roles for trip membership (excludes 'invited'). */
const ACCEPTED_TRIP_ROLES = new Set(["owner", "co_host", "member", "viewer"]);

/**
 * Three states, because there are three answers.
 *
 * This used to be a bare `boolean`, and a failed read produced `false` — the
 * SAME value a genuine non-member produces. The error was observed
 * (`if (error || !data) return false`) and then folded into the absence answer,
 * which is why no unchecked-read checker could see it: the shape is
 * ERROR-INERT, not error-unchecked. The user-visible consequence was that "we
 * could not look" was served as "you are not on this trip".
 *
 * routes/circle.ts hit the identical defect in its own copy of this rule and
 * had to THROW, for a structural reason stated in its own docblock: its
 * `isAcceptedMember` returns a bare boolean and `getAcceptedMemberIds` a bare
 * array, with nowhere to put a third state. Here there IS somewhere. Every
 * caller of this function is already returning a `CircleAccessResult`, and this
 * file already spells that third state `reason: "unavailable"` — the
 * target-side read failure in canBeSeenByViewersBatch. So the third state is
 * RETURNED rather than thrown, and the answer stays a deny: fail-CLOSED is
 * unchanged, only its truthfulness is.
 */
type MembershipVerdict = "member" | "not_member" | "unavailable";

function describeReadError(error: any): string {
  return String(error?.message ?? error?.code ?? "db_error");
}

async function isAcceptedContextMember(
  sc: any,
  userId: string,
  contextType: ContextType,
  contextId: string,
): Promise<MembershipVerdict> {
  if (contextType === "trip") {
    const { data, error } = await sc
      .from("trip_members")
      .select("role, status")
      .eq("trip_id", contextId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      log.error(
        { table: "trip_members", contextType, contextId, err: describeReadError(error) },
        "membership read failed; answering unavailable rather than not_member",
      );
      return "unavailable";
    }
    if (!data) return "not_member";
    const row = data as { role: string; status?: string | null };
    if (!ACCEPTED_TRIP_ROLES.has(row.role)) return "not_member";
    if (row.status != null && row.status !== "accepted") return "not_member";
    return "member";
  }

  // Event: require both RSVP going AND a confirmed event_attendees row.
  // event_attendees is upserted on going/maybe/interested RSVPs and deleted on
  // cant_go/remove, so checking both ensures the user is a confirmed participant.
  const [rsvpResult, attendeeResult] = await Promise.all([
    sc.from("event_rsvps").select("status").eq("event_id", contextId).eq("user_id", userId).maybeSingle(),
    sc.from("event_attendees").select("user_id").eq("event_id", contextId).eq("user_id", userId).maybeSingle(),
  ]);

  // Order matters, and it is not "check both errors first". A READABLE RSVP that
  // is absent or not 'going' SETTLES the question — the attendee read could not
  // have changed the answer, so its failure must not downgrade a verdict we
  // actually hold. Only the read that would have decided is allowed to make the
  // answer unavailable.
  if (!rsvpResult.error) {
    if (!rsvpResult.data) return "not_member";
    if ((rsvpResult.data as { status: string }).status !== "going") return "not_member";
  } else {
    log.error(
      { table: "event_rsvps", contextType, contextId, err: describeReadError(rsvpResult.error) },
      "membership read failed; answering unavailable rather than not_member",
    );
    return "unavailable";
  }

  if (attendeeResult.error) {
    log.error(
      { table: "event_attendees", contextType, contextId, err: describeReadError(attendeeResult.error) },
      "membership read failed; answering unavailable rather than not_member",
    );
    return "unavailable";
  }
  return attendeeResult.data ? "member" : "not_member";
}

async function isUserBannedOrSuspended(sc: any, userId: string): Promise<boolean> {
  try {
    const { data, error } = await sc
      .from("user_account_states")
      .select("state, expires_at")
      .eq("user_id", userId)
      .in("state", ["banned", "suspended", "deleted"]);
    // Fail-CLOSED: an unreadable account-state table treats the target as
    // restricted, consistent with the rest of this guard (a DB error denies
    // presence rather than leaking a possibly-banned user's location).
    if (error) return true;
    const rows = (data ?? []) as Array<{ state: string; expires_at: string | null }>;
    const now = new Date();
    return rows.some((r) => r.expires_at == null || new Date(r.expires_at) > now);
  } catch {
    return true;
  }
}

export async function canViewCirclePresence(
  sc: any,
  viewerId: string,
  targetUserId: string,
  contextType: ContextType,
  contextId: string,
): Promise<CircleAccessResult> {
  // 1. Admin kill switch — fail-CLOSED: an unreadable stop engages. Consistent
  //    with the rest of this guard, whose membership checks already deny on a
  //    DB error. A missing flag row is not an error and does not engage.
  const killSwitchActive = await isKillSwitchEngaged(sc, "find_your_circle_disabled");
  if (killSwitchActive) {
    return { allowed: false, reason: "kill_switch" };
  }

  // 2. Viewer must be an accepted member
  const viewerMembership = await isAcceptedContextMember(sc, viewerId, contextType, contextId);
  if (viewerMembership === "unavailable") {
    return { allowed: false, reason: "unavailable" };
  }
  if (viewerMembership !== "member") {
    return { allowed: false, reason: "viewer_not_member" };
  }

  // 3. Target must be an accepted member
  const targetMembership = await isAcceptedContextMember(sc, targetUserId, contextType, contextId);
  if (targetMembership === "unavailable") {
    return { allowed: false, reason: "unavailable" };
  }
  if (targetMembership !== "member") {
    return { allowed: false, reason: "target_not_member" };
  }

  // 4. Target global settings + consent.
  //     The error was previously unbound, so an unreadable settings row became
  //     `null` and was reported as `target_sharing_off` — a statement about what
  //     the target CHOSE, made when we could not read their choice. The deny is
  //     the same; the reason is now the truthful one.
  const { data: globalSettings, error: settingsErr } = await sc
    .from("circle_visibility_settings")
    .select("global_enabled, visibility_mode, trip_sharing_default, event_sharing_default, is_paused, consent_version, consented_at")
    .eq("user_id", targetUserId)
    .maybeSingle();
  if (settingsErr) {
    log.error(
      { table: "circle_visibility_settings", contextType, contextId, err: describeReadError(settingsErr) },
      "target settings read failed; answering unavailable rather than target_sharing_off",
    );
    return { allowed: false, reason: "unavailable" };
  }

  const settings = globalSettings as {
    global_enabled: boolean;
    visibility_mode: string | null;
    trip_sharing_default: string | null;
    event_sharing_default: string | null;
    is_paused: boolean;
    consent_version: string | null;
    consented_at: string | null;
  } | null;

  if (!settings || !settings.global_enabled) {
    return { allowed: false, reason: "target_sharing_off" };
  }
  if (!settings.consented_at) {
    return { allowed: false, reason: "target_not_consented" };
  }
  // Enforce the CURRENT consent version. The write path (routes/circle.ts) only
  // ever stores consent_version = CURRENT_CONSENT_VERSION when enabling, so an
  // enabled row with a stale/null version consented under a superseded policy
  // (or an incomplete flow) — presence must not be shared under it. This guard
  // previously ignored the version entirely.
  if (settings.consent_version !== CURRENT_CONSENT_VERSION) {
    return { allowed: false, reason: "consent_version_stale" };
  }

  // 4a. Global pause check — immediate, overrides everything
  if (settings.is_paused) {
    return { allowed: false, reason: "global_paused" };
  }

  // Resolve effective visibility mode: per-type default → legacy visibility_mode → fallback
  const perTypeDefault =
    contextType === "trip"
      ? (settings.trip_sharing_default ?? null)
      : (settings.event_sharing_default ?? null);

  // Per-type default explicitly set to "off" means no sharing for this context type
  if (perTypeDefault === "off") {
    return { allowed: false, reason: "type_sharing_off" };
  }

  let effectiveVisibilityMode = perTypeDefault ?? settings.visibility_mode ?? "status_only";

  // 5. Context-level override / pause check
  const { data: ctxSettings, error: ctxErr } = await sc
    .from("circle_context_settings")
    .select("enabled, visibility_mode_override, paused, paused_until")
    .eq("user_id", targetUserId)
    .eq("context_type", contextType)
    .eq("context_id", contextId)
    .maybeSingle();

  // Fail-CLOSED: if the per-context override row is unreadable we cannot know
  // whether the target disabled/paused sharing for THIS trip/event, so deny.
  // Reading only `data` previously skipped the whole override block on error and
  // fell through to the (more permissive) global mode.
  if (ctxErr) {
    return { allowed: false, reason: "context_settings_unreadable" };
  }

  if (ctxSettings) {
    const ctx = ctxSettings as {
      enabled: boolean;
      visibility_mode_override: string | null;
      paused: boolean;
      paused_until: string | null;
    };
    if (!ctx.enabled) {
      return { allowed: false, reason: "context_sharing_off" };
    }
    if (ctx.paused) {
      const resumesAt = ctx.paused_until ? new Date(ctx.paused_until) : null;
      if (!resumesAt || resumesAt > new Date()) {
        return { allowed: false, reason: "context_paused" };
      }
    }
    if (ctx.visibility_mode_override) {
      effectiveVisibilityMode = ctx.visibility_mode_override;
    }
  }

  // 6. Block check (either direction) — fail-CLOSED shared helper. The previous
  // inline read ignored the query error, so a blocks-table blip yielded an empty
  // list and presence leaked to a blocked user.
  if (await isBlockedBetween(sc, viewerId, targetUserId)) {
    return { allowed: false, reason: "blocked" };
  }

  // 7. Target not banned / suspended / deleted
  const targetRestricted = await isUserBannedOrSuspended(sc, targetUserId);
  if (targetRestricted) {
    return { allowed: false, reason: "target_restricted" };
  }

  // 8. Load presence row and check expiry / staleness.
  //     This one did not merely mislabel: with the error unbound, an unreadable
  //     `circle_presence` produced `presenceRow = null` and fell through to the
  //     bottom `return { allowed: true, presenceRow: null }` — "a member with
  //     sharing on who has not published yet". No location leaked, but the
  //     caller was told a fact about the target that had not been established.
  //     The allowlist line for this read called it FAIL-CLOSED; it was not.
  const { data: presenceRow, error: presenceErr } = await sc
    .from("circle_presence")
    .select(
      "id, status, status_label, approximate_label, venue_label, checked_in, last_seen_at, expires_at, stale_after_secs, is_stale, needs_help, updated_at",
    )
    .eq("user_id", targetUserId)
    .eq("context_type", contextType)
    .eq("context_id", contextId)
    .maybeSingle();

  if (presenceErr) {
    log.error(
      { table: "circle_presence", contextType, contextId, err: describeReadError(presenceErr) },
      "presence read failed; answering unavailable rather than allowing with a null presence row",
    );
    return { allowed: false, reason: "unavailable" };
  }

  if (presenceRow) {
    const row = presenceRow as {
      expires_at: string | null;
      last_seen_at: string;
      stale_after_secs: number;
      is_stale: boolean;
    };

    // Hard expiry
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return { allowed: false, reason: "presence_expired" };
    }

    // Staleness (soft — still visible, but flagged)
    const staleThreshold = new Date(
      new Date(row.last_seen_at).getTime() + row.stale_after_secs * 1000,
    );
    const isStale = staleThreshold < new Date();

    return {
      allowed: true,
      isStale,
      presenceRow: presenceRow as Record<string, any>,
      visibilityMode: effectiveVisibilityMode,
    };
  }

  // Target is a member with sharing on, but hasn't published presence yet — allow
  // so the caller can show a "not yet shared" state.
  return {
    allowed: true,
    isStale: false,
    presenceRow: null,
    visibilityMode: effectiveVisibilityMode,
  };
}

/**
 * Batched variant of canViewCirclePresence for MANY targets in ONE context.
 *
 * Enforces exactly the same guard order and privacy rules, but with one query
 * per table (membership, visibility settings, context overrides, blocks,
 * account states, presence) instead of several round-trips per target — so
 * "who's around" stays fast on large trips and events.
 *
 * Returns a Map keyed by target user id. Targets missing from the map were
 * never evaluated (empty input). Fail-closed per target on any anomaly.
 */
/**
 * Inverse-shape batched variant: MANY viewers, ONE target, one context.
 *
 * Answers "which of these viewers can see the target's presence?" — the
 * who-can-see-me screen. Enforces exactly the same guard order and privacy
 * rules as canViewCirclePresence, but the target-side checks (settings,
 * consent, pause, context overrides, account state, presence expiry) are
 * evaluated ONCE, and the viewer-side checks (membership, mutual block) are
 * batched with one query per table.
 *
 * Returns a Map keyed by viewer user id. Fail-closed per viewer on any anomaly.
 */
export async function canBeSeenByViewersBatch(
  sc: any,
  targetUserId: string,
  viewerIds: string[],
  contextType: ContextType,
  contextId: string,
): Promise<Map<string, CircleAccessResult>> {
  const out = new Map<string, CircleAccessResult>();
  const viewers = [...new Set(viewerIds)].filter((id) => id && id !== targetUserId);
  if (viewers.length === 0) return out;

  const denyAll = (reason: string) => {
    for (const id of viewers) out.set(id, { allowed: false, reason });
    return out;
  };

  // 1. Admin kill switch — fail-CLOSED: an unreadable stop engages. Consistent
  //    with the rest of this guard, whose membership checks already deny on a
  //    DB error. A missing flag row is not an error and does not engage.
  const killSwitchActive = await isKillSwitchEngaged(sc, "find_your_circle_disabled");
  if (killSwitchActive) return denyAll("kill_switch");

  // 2. Viewer membership — one query per table (per-viewer gate).
  //
  //    A membership table here is an INCLUSION table: a viewer is a member
  //    because a row says so. Reading only `data` meant an unreadable table read
  //    as "no rows", so EVERY viewer in the batch came out a non-member and was
  //    told `viewer_not_member`. Same defect as the single-row path above, in
  //    the shape the batch takes: the deny was right, the reason was invented.
  const memberViewers = new Set<string>();
  if (contextType === "trip") {
    const { data, error } = await sc
      .from("trip_members")
      .select("user_id, role, status")
      .eq("trip_id", contextId)
      .in("user_id", viewers);
    if (error) {
      log.error(
        { table: "trip_members", contextType, contextId, err: describeReadError(error) },
        "batched viewer membership read failed; denying every viewer as unavailable, not as non-members",
      );
      return denyAll("unavailable");
    }
    for (const r of (data ?? []) as Array<{ user_id: string; role: string; status?: string | null }>) {
      if (!ACCEPTED_TRIP_ROLES.has(r.role)) continue;
      if (r.status != null && r.status !== "accepted") continue;
      memberViewers.add(r.user_id);
    }
  } else {
    // Event: require both RSVP going AND a confirmed event_attendees row. Both
    // are required, so either one failing loses the answer for every viewer.
    const [rsvpResult, attendeeResult] = await Promise.all([
      sc.from("event_rsvps").select("user_id, status").eq("event_id", contextId).in("user_id", viewers),
      sc.from("event_attendees").select("user_id").eq("event_id", contextId).in("user_id", viewers),
    ]);
    const failed = [
      ["event_rsvps", rsvpResult.error],
      ["event_attendees", attendeeResult.error],
    ].filter(([, e]) => Boolean(e));
    if (failed.length > 0) {
      log.error(
        { failed: failed.map(([n]) => n), contextType, contextId },
        "batched viewer membership read failed; denying every viewer as unavailable, not as non-members",
      );
      return denyAll("unavailable");
    }
    const going = new Set(
      ((rsvpResult.data ?? []) as Array<{ user_id: string; status: string }>)
        .filter((r) => r.status === "going")
        .map((r) => r.user_id),
    );
    for (const r of (attendeeResult.data ?? []) as Array<{ user_id: string }>) {
      if (going.has(r.user_id)) memberViewers.add(r.user_id);
    }
  }

  // 3. Target must be an accepted member (checked ONCE for the whole batch).
  const targetMembership = await isAcceptedContextMember(sc, targetUserId, contextType, contextId);
  if (targetMembership === "unavailable") return denyAll("unavailable");
  if (targetMembership !== "member") {
    for (const id of viewers) {
      out.set(id, {
        allowed: false,
        reason: memberViewers.has(id) ? "target_not_member" : "viewer_not_member",
      });
    }
    return out;
  }

  // 4–8. Target-side rows (fetched once) + viewer-side blocks (one query).
  const [settingsRes, ctxRes, blocksRes, statesRes, presenceRes] = await Promise.all([
    sc
      .from("circle_visibility_settings")
      .select("global_enabled, visibility_mode, trip_sharing_default, event_sharing_default, is_paused, consent_version, consented_at")
      .eq("user_id", targetUserId)
      .maybeSingle(),
    sc
      .from("circle_context_settings")
      .select("enabled, visibility_mode_override, paused, paused_until")
      .eq("user_id", targetUserId)
      .eq("context_type", contextType)
      .eq("context_id", contextId)
      .maybeSingle(),
    sc
      .from("blocks")
      .select("blocker_id, blocked_id")
      .or(`blocker_id.eq.${targetUserId},blocked_id.eq.${targetUserId}`),
    sc
      .from("user_account_states")
      .select("state, expires_at")
      .eq("user_id", targetUserId)
      .in("state", ["banned", "suspended", "deleted"]),
    sc
      .from("circle_presence")
      .select(
        "id, status, status_label, approximate_label, venue_label, checked_in, last_seen_at, expires_at, stale_after_secs, is_stale, needs_help, updated_at",
      )
      .eq("user_id", targetUserId)
      .eq("context_type", contextType)
      .eq("context_id", contextId)
      .maybeSingle(),
  ]);

  // Fail-CLOSED on ANY of the five target-side reads, matching the rule order
  // and the posture of the single-target canViewCirclePresence above.
  //
  // supabase-js resolves on a database error, so each of these returns
  // `data: null` (or an empty array) in two different situations, and for three
  // of the five the empty reading is the PERMISSIVE one:
  //
  //   circle_context_settings  an unreadable per-context row means the override
  //                            is ignored and the GLOBAL default applies -- so a
  //                            trip or event the target explicitly paused is
  //                            shown anyway.
  //   blocks                   an EXCLUSION table: a row means deny. Unreadable
  //                            reads as "no rows", so nobody is blocked.
  //   user_account_states      likewise: nobody is banned, suspended or deleted.
  //
  // (circle_visibility_settings already denies via `!settings` below, and
  // circle_presence denies by having nothing to show; both are included so the
  // failure is reported rather than inferred from a downstream symptom.)
  //
  // One target, one verdict: if we cannot establish the target's exclusions we
  // cannot safely show them to ANY viewer in this batch.
  const failedTargetReads = (
    [
      ["circle_visibility_settings", (settingsRes as any).error],
      ["circle_context_settings", (ctxRes as any).error],
      ["blocks", (blocksRes as any).error],
      ["user_account_states", (statesRes as any).error],
      ["circle_presence", (presenceRes as any).error],
    ] as Array<[string, unknown]>
  )
    .filter(([, e]) => Boolean(e))
    .map(([name]) => name);

  if (failedTargetReads.length > 0) {
    log.error(
      { failed: failedTargetReads, targetUserId, contextType, contextId },
      "canBeSeenByViewersBatch: target-side read failed; denying every viewer rather than showing presence with unknown exclusions",
    );
    for (const id of viewers) {
      out.set(id, { allowed: false, reason: "unavailable" });
    }
    return out;
  }

  // Target-side evaluation (once) — identical rule order to canViewCirclePresence.
  let targetDenyReason: string | null = null;
  let effectiveVisibilityMode = "status_only";

  const settings = settingsRes.data as {
    global_enabled: boolean;
    visibility_mode: string | null;
    trip_sharing_default: string | null;
    event_sharing_default: string | null;
    is_paused: boolean;
    consent_version: string | null;
    consented_at: string | null;
  } | null;

  if (!settings || !settings.global_enabled) {
    targetDenyReason = "target_sharing_off";
  } else if (!settings.consented_at) {
    targetDenyReason = "target_not_consented";
  } else if (settings.consent_version !== CURRENT_CONSENT_VERSION) {
    // Stale/null consent version → presence must not be shared under a superseded
    // (or pre-migration) policy. The single-shot canViewCirclePresence enforced
    // this; the live batch guards ignored it entirely (audit CIRCLE-1).
    targetDenyReason = "consent_version_stale";
  } else if (settings.is_paused) {
    targetDenyReason = "global_paused";
  } else {
    const perTypeDefault =
      contextType === "trip"
        ? (settings.trip_sharing_default ?? null)
        : (settings.event_sharing_default ?? null);
    if (perTypeDefault === "off") {
      targetDenyReason = "type_sharing_off";
    } else {
      effectiveVisibilityMode = perTypeDefault ?? settings.visibility_mode ?? "status_only";
      const ctx = ctxRes.data as {
        enabled: boolean;
        visibility_mode_override: string | null;
        paused: boolean;
        paused_until: string | null;
      } | null;
      if (ctx) {
        if (!ctx.enabled) {
          targetDenyReason = "context_sharing_off";
        } else if (ctx.paused) {
          const resumesAt = ctx.paused_until ? new Date(ctx.paused_until) : null;
          if (!resumesAt || resumesAt > new Date()) {
            targetDenyReason = "context_paused";
          }
        }
        if (!targetDenyReason && ctx.visibility_mode_override) {
          effectiveVisibilityMode = ctx.visibility_mode_override;
        }
      }
    }
  }

  const blocks = (blocksRes.data ?? []) as Array<{ blocker_id: string; blocked_id: string }>;
  const blockedWithTarget = new Set<string>();
  for (const b of blocks) {
    if (b.blocker_id === targetUserId) blockedWithTarget.add(b.blocked_id);
    if (b.blocked_id === targetUserId) blockedWithTarget.add(b.blocker_id);
  }

  let targetRestricted = false;
  {
    const rows = (statesRes.data ?? []) as Array<{ state: string; expires_at: string | null }>;
    const now = new Date();
    targetRestricted = rows.some((r) => r.expires_at == null || new Date(r.expires_at) > now);
  }

  // Presence expiry / staleness — evaluated once for the single target row.
  const presenceRow = (presenceRes.data as Record<string, any> | null) ?? null;
  let presenceExpired = false;
  let isStale = false;
  if (presenceRow) {
    const row = presenceRow as {
      expires_at: string | null;
      last_seen_at: string;
      stale_after_secs: number;
    };
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      presenceExpired = true;
    } else {
      const staleThreshold = new Date(
        new Date(row.last_seen_at).getTime() + row.stale_after_secs * 1000,
      );
      isStale = staleThreshold < new Date();
    }
  }

  for (const viewerId of viewers) {
    // Rule order matches canViewCirclePresence: viewer membership (2), target
    // settings (4–5), mutual block (6), target restricted (7), presence (8).
    if (!memberViewers.has(viewerId)) {
      out.set(viewerId, { allowed: false, reason: "viewer_not_member" });
      continue;
    }
    if (targetDenyReason) {
      out.set(viewerId, { allowed: false, reason: targetDenyReason });
      continue;
    }
    if (blockedWithTarget.has(viewerId)) {
      out.set(viewerId, { allowed: false, reason: "blocked" });
      continue;
    }
    if (targetRestricted) {
      out.set(viewerId, { allowed: false, reason: "target_restricted" });
      continue;
    }
    if (presenceExpired) {
      out.set(viewerId, { allowed: false, reason: "presence_expired" });
      continue;
    }
    out.set(viewerId, {
      allowed: true,
      isStale,
      presenceRow,
      visibilityMode: effectiveVisibilityMode,
    });
  }

  return out;
}

export async function canViewCirclePresenceBatch(
  sc: any,
  viewerId: string,
  targetUserIds: string[],
  contextType: ContextType,
  contextId: string,
): Promise<Map<string, CircleAccessResult>> {
  const out = new Map<string, CircleAccessResult>();
  const targets = [...new Set(targetUserIds)].filter((id) => id && id !== viewerId);
  if (targets.length === 0) return out;

  const denyAll = (reason: string) => {
    for (const id of targets) out.set(id, { allowed: false, reason });
    return out;
  };

  // 1. Admin kill switch — fail-CLOSED: an unreadable stop engages. Consistent
  //    with the rest of this guard, whose membership checks already deny on a
  //    DB error. A missing flag row is not an error and does not engage.
  const killSwitchActive = await isKillSwitchEngaged(sc, "find_your_circle_disabled");
  if (killSwitchActive) return denyAll("kill_switch");

  // 2. Viewer must be an accepted member (checked ONCE for the whole batch).
  const viewerMembership = await isAcceptedContextMember(sc, viewerId, contextType, contextId);
  if (viewerMembership === "unavailable") return denyAll("unavailable");
  if (viewerMembership !== "member") return denyAll("viewer_not_member");

  // 3. Target membership — one query per table. Inclusion tables again: an
  //    unreadable one read as "no rows", so every target came back
  //    `target_not_member`. Deny all as `unavailable` instead of asserting a
  //    membership fact about people we could not look up.
  const acceptedTargets = new Set<string>();
  if (contextType === "trip") {
    const { data, error } = await sc
      .from("trip_members")
      .select("user_id, role, status")
      .eq("trip_id", contextId)
      .in("user_id", targets);
    if (error) {
      log.error(
        { table: "trip_members", contextType, contextId, err: describeReadError(error) },
        "batched target membership read failed; denying every target as unavailable, not as non-members",
      );
      return denyAll("unavailable");
    }
    for (const r of (data ?? []) as Array<{ user_id: string; role: string; status?: string | null }>) {
      if (!ACCEPTED_TRIP_ROLES.has(r.role)) continue;
      if (r.status != null && r.status !== "accepted") continue;
      acceptedTargets.add(r.user_id);
    }
  } else {
    // Event: require both RSVP going AND a confirmed event_attendees row.
    const [rsvpResult, attendeeResult] = await Promise.all([
      sc.from("event_rsvps").select("user_id, status").eq("event_id", contextId).in("user_id", targets),
      sc.from("event_attendees").select("user_id").eq("event_id", contextId).in("user_id", targets),
    ]);
    const failed = [
      ["event_rsvps", rsvpResult.error],
      ["event_attendees", attendeeResult.error],
    ].filter(([, e]) => Boolean(e));
    if (failed.length > 0) {
      log.error(
        { failed: failed.map(([n]) => n), contextType, contextId },
        "batched target membership read failed; denying every target as unavailable, not as non-members",
      );
      return denyAll("unavailable");
    }
    const going = new Set(
      ((rsvpResult.data ?? []) as Array<{ user_id: string; status: string }>)
        .filter((r) => r.status === "going")
        .map((r) => r.user_id),
    );
    for (const r of (attendeeResult.data ?? []) as Array<{ user_id: string }>) {
      if (going.has(r.user_id)) acceptedTargets.add(r.user_id);
    }
  }

  // 4–8. Batched prefetch of every remaining table (one query each).
  const memberTargets = targets.filter((id) => acceptedTargets.has(id));
  const [settingsRes, ctxRes, blocksRes, statesRes, presenceRes] = await Promise.all([
    memberTargets.length > 0
      ? sc
          .from("circle_visibility_settings")
          .select("user_id, global_enabled, visibility_mode, trip_sharing_default, event_sharing_default, is_paused, consent_version, consented_at")
          .in("user_id", memberTargets)
      : Promise.resolve({ data: [] }),
    memberTargets.length > 0
      ? sc
          .from("circle_context_settings")
          .select("user_id, enabled, visibility_mode_override, paused, paused_until")
          .eq("context_type", contextType)
          .eq("context_id", contextId)
          .in("user_id", memberTargets)
      : Promise.resolve({ data: [] }),
    memberTargets.length > 0
      ? sc
          .from("blocks")
          .select("blocker_id, blocked_id")
          .or(`blocker_id.eq.${viewerId},blocked_id.eq.${viewerId}`)
      : Promise.resolve({ data: [] }),
    memberTargets.length > 0
      ? sc
          .from("user_account_states")
          .select("user_id, state, expires_at")
          .in("user_id", memberTargets)
          .in("state", ["banned", "suspended", "deleted"])
      : Promise.resolve({ data: [] }),
    memberTargets.length > 0
      ? sc
          .from("circle_presence")
          .select(
            "user_id, id, status, status_label, approximate_label, venue_label, checked_in, last_seen_at, expires_at, stale_after_secs, is_stale, needs_help, updated_at",
          )
          .eq("context_type", contextType)
          .eq("context_id", contextId)
          .in("user_id", memberTargets)
      : Promise.resolve({ data: [] }),
  ]);

  const settingsById = new Map<string, any>();
  for (const s of (settingsRes.data ?? []) as any[]) settingsById.set(s.user_id as string, s);
  const ctxById = new Map<string, any>();
  for (const c of (ctxRes.data ?? []) as any[]) ctxById.set(c.user_id as string, c);
  const blocks = (blocksRes.data ?? []) as Array<{ blocker_id: string; blocked_id: string }>;
  const now = new Date();
  const restricted = new Set<string>();
  for (const r of (statesRes.data ?? []) as Array<{ user_id: string; state: string; expires_at: string | null }>) {
    if (r.expires_at == null || new Date(r.expires_at) > now) restricted.add(r.user_id);
  }
  const presenceById = new Map<string, Record<string, any>>();
  for (const p of (presenceRes.data ?? []) as any[]) presenceById.set(p.user_id as string, p);

  // In-memory gating — identical rule order to canViewCirclePresence.
  for (const targetUserId of targets) {
    if (!acceptedTargets.has(targetUserId)) {
      out.set(targetUserId, { allowed: false, reason: "target_not_member" });
      continue;
    }

    const settings = settingsById.get(targetUserId) as {
      global_enabled: boolean;
      visibility_mode: string | null;
      trip_sharing_default: string | null;
      event_sharing_default: string | null;
      is_paused: boolean;
      consent_version: string | null;
      consented_at: string | null;
    } | undefined;

    if (!settings || !settings.global_enabled) {
      out.set(targetUserId, { allowed: false, reason: "target_sharing_off" });
      continue;
    }
    if (!settings.consented_at) {
      out.set(targetUserId, { allowed: false, reason: "target_not_consented" });
      continue;
    }
    if (settings.consent_version !== CURRENT_CONSENT_VERSION) {
      // Stale/null consent version → deny, matching the single-shot guard the
      // live batch path ignored (audit CIRCLE-1).
      out.set(targetUserId, { allowed: false, reason: "consent_version_stale" });
      continue;
    }
    if (settings.is_paused) {
      out.set(targetUserId, { allowed: false, reason: "global_paused" });
      continue;
    }

    const perTypeDefault =
      contextType === "trip"
        ? (settings.trip_sharing_default ?? null)
        : (settings.event_sharing_default ?? null);
    if (perTypeDefault === "off") {
      out.set(targetUserId, { allowed: false, reason: "type_sharing_off" });
      continue;
    }
    let effectiveVisibilityMode = perTypeDefault ?? settings.visibility_mode ?? "status_only";

    const ctx = ctxById.get(targetUserId) as {
      enabled: boolean;
      visibility_mode_override: string | null;
      paused: boolean;
      paused_until: string | null;
    } | undefined;
    if (ctx) {
      if (!ctx.enabled) {
        out.set(targetUserId, { allowed: false, reason: "context_sharing_off" });
        continue;
      }
      if (ctx.paused) {
        const resumesAt = ctx.paused_until ? new Date(ctx.paused_until) : null;
        if (!resumesAt || resumesAt > new Date()) {
          out.set(targetUserId, { allowed: false, reason: "context_paused" });
          continue;
        }
      }
      if (ctx.visibility_mode_override) {
        effectiveVisibilityMode = ctx.visibility_mode_override;
      }
    }

    const mutualBlock = blocks.some(
      (b) =>
        (b.blocker_id === viewerId && b.blocked_id === targetUserId) ||
        (b.blocker_id === targetUserId && b.blocked_id === viewerId),
    );
    if (mutualBlock) {
      out.set(targetUserId, { allowed: false, reason: "blocked" });
      continue;
    }

    if (restricted.has(targetUserId)) {
      out.set(targetUserId, { allowed: false, reason: "target_restricted" });
      continue;
    }

    const presenceRow = presenceById.get(targetUserId) ?? null;
    if (presenceRow) {
      const row = presenceRow as {
        expires_at: string | null;
        last_seen_at: string;
        stale_after_secs: number;
      };
      if (row.expires_at && new Date(row.expires_at) < new Date()) {
        out.set(targetUserId, { allowed: false, reason: "presence_expired" });
        continue;
      }
      const staleThreshold = new Date(
        new Date(row.last_seen_at).getTime() + row.stale_after_secs * 1000,
      );
      out.set(targetUserId, {
        allowed: true,
        isStale: staleThreshold < new Date(),
        presenceRow,
        visibilityMode: effectiveVisibilityMode,
      });
      continue;
    }

    out.set(targetUserId, {
      allowed: true,
      isStale: false,
      presenceRow: null,
      visibilityMode: effectiveVisibilityMode,
    });
  }

  return out;
}
