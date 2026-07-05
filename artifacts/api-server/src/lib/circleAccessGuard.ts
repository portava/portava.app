/**
 * Find Your Circle — access guard.
 *
 * canViewCirclePresence enforces every privacy rule before a presence row is
 * returned to a viewer. Callers must pass the service-role Supabase client.
 *
 * Guard order (fail-fast):
 *   1. Admin kill switch (fail-open on DB error → do NOT block)
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
 */

import { isFlagEnabled } from "./featureFlags.js";

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

async function isAcceptedContextMember(
  sc: any,
  userId: string,
  contextType: ContextType,
  contextId: string,
): Promise<boolean> {
  if (contextType === "trip") {
    const { data, error } = await sc
      .from("trip_members")
      .select("role, status")
      .eq("trip_id", contextId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return false;
    const row = data as { role: string; status?: string | null };
    if (!ACCEPTED_TRIP_ROLES.has(row.role)) return false;
    if (row.status != null && row.status !== "accepted") return false;
    return true;
  }

  // Event: require both RSVP going AND a confirmed event_attendees row.
  // event_attendees is upserted on going/maybe/interested RSVPs and deleted on
  // cant_go/remove, so checking both ensures the user is a confirmed participant.
  const [rsvpResult, attendeeResult] = await Promise.all([
    sc.from("event_rsvps").select("status").eq("event_id", contextId).eq("user_id", userId).maybeSingle(),
    sc.from("event_attendees").select("user_id").eq("event_id", contextId).eq("user_id", userId).maybeSingle(),
  ]);
  if (rsvpResult.error || !rsvpResult.data) return false;
  if ((rsvpResult.data as { status: string }).status !== "going") return false;
  if (attendeeResult.error || !attendeeResult.data) return false;
  return true;
}

async function isUserBannedOrSuspended(sc: any, userId: string): Promise<boolean> {
  try {
    const { data } = await sc
      .from("user_account_states")
      .select("state, expires_at")
      .eq("user_id", userId)
      .in("state", ["banned", "suspended", "deleted"]);
    const rows = (data ?? []) as Array<{ state: string; expires_at: string | null }>;
    const now = new Date();
    return rows.some((r) => r.expires_at == null || new Date(r.expires_at) > now);
  } catch {
    return false;
  }
}

export async function canViewCirclePresence(
  sc: any,
  viewerId: string,
  targetUserId: string,
  contextType: ContextType,
  contextId: string,
): Promise<CircleAccessResult> {
  // 1. Admin kill switch — fail-open: if DB is down, do NOT block users.
  const killSwitchActive = await isFlagEnabled(sc, "find_your_circle_disabled");
  if (killSwitchActive) {
    return { allowed: false, reason: "kill_switch" };
  }

  // 2. Viewer must be an accepted member
  const viewerIsMember = await isAcceptedContextMember(sc, viewerId, contextType, contextId);
  if (!viewerIsMember) {
    return { allowed: false, reason: "viewer_not_member" };
  }

  // 3. Target must be an accepted member
  const targetIsMember = await isAcceptedContextMember(sc, targetUserId, contextType, contextId);
  if (!targetIsMember) {
    return { allowed: false, reason: "target_not_member" };
  }

  // 4. Target global settings + consent
  const { data: globalSettings } = await sc
    .from("circle_visibility_settings")
    .select("global_enabled, visibility_mode, consent_version, consented_at")
    .eq("user_id", targetUserId)
    .maybeSingle();

  const settings = globalSettings as {
    global_enabled: boolean;
    visibility_mode: string;
    consent_version: string | null;
    consented_at: string | null;
  } | null;

  if (!settings || !settings.global_enabled) {
    return { allowed: false, reason: "target_sharing_off" };
  }
  if (!settings.consented_at) {
    return { allowed: false, reason: "target_not_consented" };
  }

  // Resolve effective visibility mode
  let effectiveVisibilityMode = settings.visibility_mode ?? "status_only";

  // 5. Context-level override / pause check
  const { data: ctxSettings } = await sc
    .from("circle_context_settings")
    .select("enabled, visibility_mode_override, paused, paused_until")
    .eq("user_id", targetUserId)
    .eq("context_type", contextType)
    .eq("context_id", contextId)
    .maybeSingle();

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

  // 6. Mutual block check
  const { data: blockRows } = await sc
    .from("blocks")
    .select("blocker_id, blocked_id")
    .or(`blocker_id.eq.${viewerId},blocked_id.eq.${viewerId}`)
    .or(`blocker_id.eq.${targetUserId},blocked_id.eq.${targetUserId}`);

  const blocks = (blockRows ?? []) as Array<{ blocker_id: string; blocked_id: string }>;
  const mutualBlock = blocks.some(
    (b) =>
      (b.blocker_id === viewerId && b.blocked_id === targetUserId) ||
      (b.blocker_id === targetUserId && b.blocked_id === viewerId),
  );
  if (mutualBlock) {
    return { allowed: false, reason: "blocked" };
  }

  // 7. Target not banned / suspended / deleted
  const targetRestricted = await isUserBannedOrSuspended(sc, targetUserId);
  if (targetRestricted) {
    return { allowed: false, reason: "target_restricted" };
  }

  // 8. Load presence row and check expiry / staleness
  const { data: presenceRow } = await sc
    .from("circle_presence")
    .select(
      "id, status, status_label, approximate_label, venue_label, checked_in, last_seen_at, expires_at, stale_after_secs, is_stale, needs_help, updated_at",
    )
    .eq("user_id", targetUserId)
    .eq("context_type", contextType)
    .eq("context_id", contextId)
    .maybeSingle();

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
