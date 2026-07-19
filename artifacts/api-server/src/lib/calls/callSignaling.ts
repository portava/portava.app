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
  | "call.missed";

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
  void (async () => {
    try {
      const prefs = await getFullCallPreferences(sc, calleeId);
      if (!prefs.incomingCallNotifications) return;
      const { NotificationService } = await import("../../services/notifications/NotificationService.js");
      const { NotificationRouter } = await import("../../services/notifications/NotificationRouter.js");
      const ns = new NotificationService(sc);
      const nr = new NotificationRouter(sc);
      const row = await ns.create({
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
      if (row) await nr.route(row);
    } catch (err) {
      logger.warn({ err }, "incoming-call push failed (non-critical)");
    }
  })();
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
