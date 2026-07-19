/**
 * calls/callSignaling — realtime + push signaling and privacy-safe analytics
 * for the calling system.
 *
 * - Realtime events ride the existing Telegraph SSE/broadcast bus
 *   (publishToUsers is cross-instance safe via the broadcast hook).
 * - The incoming-call push goes through NotificationService/NotificationRouter
 *   (template `call.incoming`) and respects call_preferences.
 * - Analytics are operational only: event name + call/context type. No call
 *   content, no transcripts, nothing about what was said (spec §21).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { publishToUsers } from "../telegraphEvents";
import { logger } from "../logger";
import { nameVisibleFor, presentedName } from "../publicIdentity";
import { getFullCallPreferences } from "./callGatewayAdapter";
import { makeCallStore, type StoredCallSession } from "./callStoreAdapter";
import { applyEvent, type RoomAdminPort } from "./callReconciler";
import type { CallSession } from "./callTypes";

export type CallSignalType =
  | "call.incoming"
  | "call.accepted"
  | "call.declined"
  | "call.canceled"
  | "call.ended"
  | "call.missed"
  | "call.group_started"
  | "call.group_ended";

/** Public DTO shape shared with the mobile client. */
export function sessionDto(s: CallSession): Record<string, unknown> {
  return {
    id: s.id,
    callType: s.callType,
    contextType: s.contextType,
    contextId: s.contextId,
    threadId: s.threadId,
    startedBy: s.startedBy,
    status: s.status,
    startedAt: s.startedAt,
    connectedAt: s.connectedAt,
    endedAt: s.endedAt,
  };
}

export function publishCallEvent(
  type: CallSignalType,
  userIds: string[],
  session: CallSession,
  extra: Record<string, unknown> = {},
): void {
  publishToUsers(userIds, {
    type,
    threadId: session.threadId,
    payload: { callId: session.id, session: sessionDto(session), ...extra },
  });
}

/** Caller identity for the incoming-call banner, honoring the name-privacy rule. */
export async function callerIdentity(
  sc: SupabaseClient,
  callerId: string,
): Promise<{ id: string; name: string | null; avatarUrl: string | null; handle: string | null }> {
  try {
    const { data } = await sc
      .from("profiles")
      .select("id, username, display_name, name, avatar_url")
      .eq("id", callerId)
      .maybeSingle();
    const row = data as any;
    if (!row) return { id: callerId, name: null, avatarUrl: null, handle: null };
    const allowed = await nameVisibleFor(sc, callerId);
    return {
      id: callerId,
      name: presentedName(row, allowed),
      avatarUrl: row.avatar_url ?? null,
      handle: row.username ?? null,
    };
  } catch {
    return { id: callerId, name: null, avatarUrl: null, handle: null };
  }
}

// ── Incoming-call push (testable seam) ───────────────────────────────────────

export interface IncomingPushDeps {
  getPrefs: typeof getFullCallPreferences;
  /** Creates the notification row and routes it to push channels. */
  notify: (sc: SupabaseClient, input: {
    userId: string;
    eventType: "call.incoming";
    sourceType: "call";
    sourceId: string;
    params: Record<string, string>;
  }) => Promise<void>;
}

const defaultPushDeps: IncomingPushDeps = {
  getPrefs: getFullCallPreferences,
  async notify(sc, input) {
    const { NotificationService } = await import("../../services/notifications/NotificationService.js");
    const { NotificationRouter } = await import("../../services/notifications/NotificationRouter.js");
    const ns = new NotificationService(sc);
    const nr = new NotificationRouter(sc);
    const row = await ns.create(input);
    if (row) await nr.route(row);
  },
};

let testPushDeps: IncomingPushDeps | null = null;
/** Test-only: inject fakes for the preference lookup + notification pipeline. */
export function _setTestPushDeps(d: IncomingPushDeps | null): void { testPushDeps = d; }

/**
 * Deliver the incoming-call push to the callee, respecting
 * call_preferences.incoming_call_notifications.
 * Returns true when the push was sent, false when the preference disabled it.
 */
export async function deliverIncomingCallPush(
  sc: SupabaseClient,
  calleeId: string,
  session: CallSession,
  callerLabel: string,
): Promise<boolean> {
  const deps = testPushDeps ?? defaultPushDeps;
  const prefs = await deps.getPrefs(sc, calleeId);
  if (!prefs.incomingCallNotifications) return false;
  await deps.notify(sc, {
    userId: calleeId,
    eventType: "call.incoming",
    sourceType: "call",
    sourceId: session.id,
    params: {
      actor: callerLabel,
      callKind: session.callType === "video" ? "video call" : "call",
      threadId: session.threadId ?? "",
    },
  });
  return true;
}

/**
 * Fire-and-forget incoming-call push to the callee, respecting
 * call_preferences.incoming_call_notifications. Never fails the request.
 */
export function sendIncomingCallPush(
  sc: SupabaseClient,
  calleeId: string,
  session: CallSession,
  callerLabel: string,
): void {
  void deliverIncomingCallPush(sc, calleeId, session, callerLabel).catch((err) => {
    logger.warn({ err }, "incoming-call push failed (non-critical)");
  });
}

// ── Crew (trip_crew group room) signaling ────────────────────────────────────

/** Accepted crew member ids for a trip (owner/co_host/member/viewer, accepted). */
export async function getCrewMemberIds(sc: SupabaseClient, tripId: string): Promise<string[]> {
  try {
    const { data } = await sc
      .from("trip_members")
      .select("user_id, role, status")
      .eq("trip_id", tripId);
    const acceptedRoles = new Set(["owner", "co_host", "member", "viewer"]);
    return ((data as any[]) ?? [])
      .filter((r) => acceptedRoles.has(r.role) && (r.status == null || r.status === "accepted"))
      .map((r) => r.user_id as string);
  } catch {
    return [];
  }
}

export interface CrewAnnounceDeps {
  getPrefs: typeof getFullCallPreferences;
  notify: (sc: SupabaseClient, input: {
    userId: string;
    eventType: "call.crew_started";
    sourceType: "call";
    sourceId: string;
    params: Record<string, string>;
  }) => Promise<void>;
}

const defaultCrewDeps: CrewAnnounceDeps = {
  getPrefs: getFullCallPreferences,
  async notify(sc, input) {
    const { NotificationService } = await import("../../services/notifications/NotificationService.js");
    const { NotificationRouter } = await import("../../services/notifications/NotificationRouter.js");
    const ns = new NotificationService(sc);
    const nr = new NotificationRouter(sc);
    const row = await ns.create(input);
    if (row) await nr.route(row);
  },
};

let testCrewDeps: CrewAnnounceDeps | null = null;
/** Test-only: inject fakes for the crew-start notification pipeline. */
export function _setTestCrewDeps(d: CrewAnnounceDeps | null): void { testCrewDeps = d; }

/**
 * Announce a newly opened Crew Call (spec Phase 4):
 *  - realtime `call.group_started` to every active crew member (presence is
 *    visible only inside the crew),
 *  - "«Name» started a Crew Call." system message in the trip conversation,
 *  - ONE restrained push per member (never per join, never a ring),
 *    respecting call_preferences.incoming_call_notifications.
 * Best-effort: failures are logged, never fail the start request.
 */
export async function announceCrewCallStarted(
  sc: SupabaseClient,
  session: CallSession,
  starterId: string,
): Promise<void> {
  const deps = testCrewDeps ?? defaultCrewDeps;
  const tripId = session.contextId;
  const memberIds = await getCrewMemberIds(sc, tripId);

  publishCallEvent("call.group_started", memberIds, session);

  // System message in the crew's group conversation.
  try {
    const { resolveTripThreadId } = await import("./callStoreAdapter.js");
    const threadId = await resolveTripThreadId(sc, tripId);
    if (threadId) {
      const starter = await callerIdentity(sc, starterId);
      const label = starter.name ?? (starter.handle ? `@${starter.handle}` : "A crew member");
      await sc.from("messages").insert({
        thread_id: threadId,
        sender_id: starterId,
        body: `${label} started a Crew Call.`,
        msg_type: "system",
        subtype: "call_started",
      });
    }
  } catch (err) {
    logger.warn({ err }, "crew-call start system message failed (non-critical)");
  }

  // One restrained notification per member, excluding the starter.
  let tripTitle = "";
  try {
    const { data: trip } = await sc.from("trips").select("title").eq("id", tripId).maybeSingle();
    tripTitle = (trip as any)?.title ?? "";
  } catch { /* title is cosmetic */ }

  await Promise.allSettled(
    memberIds
      .filter((uid) => uid !== starterId)
      .map(async (uid) => {
        const prefs = await deps.getPrefs(sc, uid);
        if (!prefs.incomingCallNotifications) return;
        await deps.notify(sc, {
          userId: uid,
          eventType: "call.crew_started",
          sourceType: "call",
          sourceId: session.id,
          params: { tripId, tripTitle },
        });
      }),
  );
}

/** Realtime `call.group_ended` to the crew so Start/Join surfaces refresh. */
export function announceCrewCallEnded(sc: SupabaseClient, session: CallSession): void {
  void getCrewMemberIds(sc, session.contextId)
    .then((ids) => publishCallEvent("call.group_ended", ids, session))
    .catch((err) => logger.warn({ err }, "crew-call ended announce failed (non-critical)"));
}

/** Privacy-safe operational analytics — event + type metadata only. */
export function emitCallAnalytics(
  type: "started" | "answered" | "declined" | "missed" | "ended" | "failed",
  session: Pick<CallSession, "id" | "callType" | "contextType">,
): void {
  logger.info(
    {
      event: "call_analytics",
      analyticsType: type,
      callId: session.id,
      callType: session.callType,
      contextType: session.contextType,
    },
    "call analytics",
  );
}

/**
 * Force-end any open direct call between two users (block hook). Terminates
 * the LiveKit room server-side and notifies both parties. Never throws.
 */
export async function forceEndDirectCallsBetween(
  sc: SupabaseClient,
  admin: RoomAdminPort,
  userA: string,
  userB: string,
): Promise<void> {
  try {
    const store = makeCallStore(sc);
    const sessions = await store.findOpenDirectSessionsBetween(userA, userB);
    const nowIso = new Date().toISOString();
    for (const session of sessions) {
      await applyEvent(store, admin, session, { type: "END" }, nowIso);
      const ended: StoredCallSession = { ...session, status: "ended", endedAt: nowIso };
      publishCallEvent("call.ended", [userA, userB], ended, { reason: "blocked" });
      emitCallAnalytics("ended", session);
    }
  } catch (err) {
    logger.warn({ err }, "forceEndDirectCallsBetween failed (non-critical)");
  }
}
