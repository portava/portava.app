/**
 * Calls routes — the canonical /api/calls* endpoints (spec §10).
 *
 * Every endpoint authorizes EXCLUSIVELY through canUserStartCall /
 * canUserStartGroupCall / canUserJoinCall — there is no inline authorization
 * here. LiveKit tokens are minted only after that authorization passes, with
 * video capability enforced at the token grant. Room names are opaque and the
 * LiveKit secret never reaches the client.
 *
 * Registered at canonical paths (alias-path registrations are dead in
 * production).
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireUser } from "../lib/http";
import { checkRateLimit } from "../lib/rateLimit";
import {
  canUserJoinCall, canUserStartCall, canUserStartGroupCall,
  type CallContextGateway,
} from "../lib/calls/callPermissionEngine";
import { transition, isTerminal } from "../lib/calls/callStateMachine";
import { applyEvent, type RoomAdminPort } from "../lib/calls/callReconciler";
import {
  generateRoomName, livekitEnvStatus, makeRoomAdmin, mintCallToken, readLivekitEnv,
} from "../lib/calls/livekitService";
import { CALL_CONFIG, type CallDenyReason } from "../lib/calls/callTypes";
import { makeCallGateway, getFullCallPreferences, RAB_CALL_ELIGIBLE_STATUSES } from "../lib/calls/callGatewayAdapter";
import { makeCallStore, type CallStoreEx, type StoredCallSession } from "../lib/calls/callStoreAdapter";
import {
  callerIdentity, emitCallAnalytics, publishCallEvent, sendIncomingCallPush, sessionDto,
} from "../lib/calls/callSignaling";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── Test seams ────────────────────────────────────────────────────────────────

export interface CallRouteDeps {
  makeGateway: (sc: any) => CallContextGateway;
  makeStore: (sc: any) => CallStoreEx;
  roomAdmin: () => RoomAdminPort;
  mintToken: (opts: {
    roomName: string; userId: string; displayName?: string | null; allowVideo: boolean;
  }) => Promise<string>;
  livekitUrl: () => string;
}

function defaultDeps(): CallRouteDeps {
  return {
    makeGateway: makeCallGateway,
    makeStore: makeCallStore,
    roomAdmin: () => makeRoomAdmin(readLivekitEnv()),
    mintToken: (opts) => mintCallToken({ env: readLivekitEnv(), ...opts }),
    livekitUrl: () => readLivekitEnv().url,
  };
}

let _testDeps: CallRouteDeps | null = null;
export function _setTestCallDeps(deps: Partial<CallRouteDeps> | null): void {
  _testDeps = deps ? { ...defaultDeps(), ...deps } : null;
}
function deps(): CallRouteDeps {
  return _testDeps ?? defaultDeps();
}
function livekitReady(): boolean {
  return _testDeps != null || livekitEnvStatus().ok;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function denyStatus(reason: CallDenyReason): number {
  switch (reason) {
    case "unauthenticated": return 401;
    case "context_not_found": return 404;
    case "rate_limited":
    case "redial_cooldown": return 429;
    default: return 403;
  }
}

function sendDeny(res: any, reason: CallDenyReason): void {
  res.status(denyStatus(reason)).json({ error: "call_denied", reason });
}

/** Resolve contextId for direct calls: booking id for RAB threads, else thread. */
async function resolveDirectContextId(
  sc: any, contextType: "telegraph_dm" | "rent_a_buddy", threadId: string,
): Promise<string> {
  if (contextType !== "rent_a_buddy") return threadId;
  try {
    const { data } = await sc
      .from("rent_buddy_bookings")
      .select("id")
      .eq("telegraph_thread_id", threadId)
      .in("status", [...RAB_CALL_ELIGIBLE_STATUSES])
      .order("created_at", { ascending: false })
      .limit(1);
    return ((data as any[]) ?? [])[0]?.id ?? threadId;
  } catch {
    return threadId;
  }
}

async function grantFor(
  d: CallRouteDeps, session: StoredCallSession, userId: string, allowVideo: boolean,
): Promise<{ session: Record<string, unknown>; livekitUrl: string; token: string }> {
  const token = await d.mintToken({
    roomName: session.roomName, userId, allowVideo,
  });
  return { session: sessionDto(session) as any, livekitUrl: d.livekitUrl(), token };
}

// ── Schemas ──────────────────────────────────────────────────────────────────

const startSchema = z.union([
  z.object({
    contextType: z.enum(["telegraph_dm", "rent_a_buddy"]),
    callType: z.enum(["voice", "video"]),
    threadId: z.string().uuid(),
    calleeId: z.string().uuid(),
  }),
  z.object({
    contextType: z.enum(["trip_crew", "event"]),
    callType: z.literal("group_voice"),
    contextId: z.string().min(1),
  }),
]);

const preferencesSchema = z.object({
  whoCanCall: z.enum(["people_i_message", "rab_contacts", "nobody"]).optional(),
  allowRentABuddyCalls: z.boolean().optional(),
  allowVideoCalls: z.boolean().optional(),
  incomingCallNotifications: z.boolean().optional(),
});

// ── Preferences (registered before /:callId routes) ─────────────────────────

router.get("/calls/preferences", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const prefs = await getFullCallPreferences(auth.client, auth.user.id);
  res.json({ preferences: prefs });
});

router.put("/calls/preferences", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const parsed = preferencesSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", reason: "invalid_payload" });
  }
  const p = parsed.data;
  const update: Record<string, unknown> = { user_id: auth.user.id, updated_at: new Date().toISOString() };
  if (p.whoCanCall !== undefined) update.who_can_call = p.whoCanCall;
  if (p.allowRentABuddyCalls !== undefined) update.allow_rent_a_buddy_calls = p.allowRentABuddyCalls;
  if (p.allowVideoCalls !== undefined) update.allow_video_calls = p.allowVideoCalls;
  if (p.incomingCallNotifications !== undefined) update.incoming_call_notifications = p.incomingCallNotifications;
  const { error } = await auth.client.from("call_preferences").upsert(update, { onConflict: "user_id" });
  if (error) return res.status(500).json({ error: "db_error", reason: "db_error" });
  const prefs = await getFullCallPreferences(auth.client, auth.user.id);
  return res.json({ preferences: prefs });
});

// ── Active call (before /:callId) ────────────────────────────────────────────

router.get("/calls/active", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const store = deps().makeStore(auth.client);
  const session = await store.findActiveSessionForUser(auth.user.id);
  res.json({ session: session ? sessionDto(session) : null });
});

// ── Start ────────────────────────────────────────────────────────────────────

router.post("/calls", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const parsed = startSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", reason: "invalid_payload" });
  }
  if (!livekitReady()) {
    return res.status(503).json({ error: "call_service_unavailable", reason: "call_service_unavailable" });
  }
  const d = deps();
  const userId = auth.user.id;

  // In-memory backstop on top of the engine's DB-authoritative hourly count.
  const rl = checkRateLimit("call_start", userId, CALL_CONFIG.MAX_STARTS_PER_HOUR, 60 * 60 * 1_000);
  if (!rl.allowed) return sendDeny(res, "rate_limited");

  const gw = d.makeGateway(auth.client);
  const store = d.makeStore(auth.client);
  const nowMs = Date.now();
  const input = parsed.data;

  try {
    if (input.callType === "group_voice") {
      const verdict = await canUserStartGroupCall(gw, {
        userId, contextType: input.contextType, contextId: input.contextId, nowMs,
      });
      if (!verdict.allowed) return sendDeny(res, verdict.reason);

      const session = await store.createSession({
        callType: "group_voice",
        contextType: input.contextType,
        contextId: input.contextId,
        threadId: null,
        roomName: generateRoomName(),
        startedBy: userId,
        participants: [{ userId, role: "host", status: "invited" }],
      });
      emitCallAnalytics("started", session);
      const grant = await grantFor(d, session, userId, false);
      return res.status(201).json(grant);
    }

    // Direct call
    const verdict = await canUserStartCall(gw, {
      callerId: userId,
      calleeId: input.calleeId,
      threadId: input.threadId,
      contextType: input.contextType,
      callType: input.callType,
      nowMs,
    });
    if (!verdict.allowed) return sendDeny(res, verdict.reason);

    const contextId = await resolveDirectContextId(auth.client, input.contextType, input.threadId);
    const session = await store.createSession({
      callType: input.callType,
      contextType: input.contextType,
      contextId,
      threadId: input.threadId,
      roomName: generateRoomName(),
      startedBy: userId,
      participants: [
        { userId, role: "caller", status: "invited" },
        { userId: input.calleeId, role: "callee", status: "ringing" },
      ],
    });

    // Signal the callee: realtime event + push (preference-gated).
    const caller = await callerIdentity(auth.client, userId);
    publishCallEvent("call.incoming", [input.calleeId], session, { caller });
    const callerLabel = caller.name ?? (caller.handle ? `@${caller.handle}` : "Someone");
    sendIncomingCallPush(auth.client, input.calleeId, session, callerLabel);
    emitCallAnalytics("started", session);

    const grant = await grantFor(d, session, userId, input.callType === "video");
    return res.status(201).json(grant);
  } catch (err) {
    logger.error({ err }, "POST /api/calls failed");
    return res.status(500).json({ error: "internal_error", reason: "internal_error" });
  }
});

// ── Shared session loading ────────────────────────────────────────────────────

async function loadSessionForUser(
  store: CallStoreEx, callId: string, userId: string,
): Promise<{ session: StoredCallSession; participants: Awaited<ReturnType<CallStoreEx["getParticipants"]>>; otherIds: string[] } | null> {
  const session = await store.getSession(callId);
  if (!session) return null;
  const participants = await store.getParticipants(callId);
  if (!participants.some((p) => p.userId === userId)) return null;
  const otherIds = participants.filter((p) => p.userId !== userId).map((p) => p.userId);
  return { session, participants, otherIds };
}

// ── Accept ───────────────────────────────────────────────────────────────────

router.post("/calls/:callId/accept", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  if (!livekitReady()) {
    return res.status(503).json({ error: "call_service_unavailable", reason: "call_service_unavailable" });
  }
  const d = deps();
  const store = d.makeStore(auth.client);
  const loaded = await loadSessionForUser(store, req.params.callId, auth.user.id);
  if (!loaded) return sendDeny(res, "context_not_found");
  const { session, otherIds } = loaded;
  if (session.startedBy === auth.user.id) {
    return res.status(400).json({ error: "invalid_payload", reason: "caller_cannot_accept" });
  }
  // Single clock read for the whole handler (split-clock guard).
  const nowMsAccept = Date.now();

  const gw = d.makeGateway(auth.client);
  const verdict = await canUserJoinCall(gw, {
    userId: auth.user.id,
    callId: session.id,
    contextType: session.contextType,
    contextId: session.contextId,
    threadId: session.threadId,
    otherPartyId: session.startedBy,
    nowMs: nowMsAccept,
  });
  if (!verdict.allowed) return sendDeny(res, verdict.reason);

  const nowIso = new Date(nowMsAccept).toISOString();
  if (session.status === "ringing") {
    const result = transition(session, { type: "ACCEPT" }, nowIso);
    if (result.ok) {
      const applied = await store.applyTransition(session.id, "ringing", result.status, result.patch);
      if (applied) {
        session.status = result.status;
        session.connectedAt = result.patch.connectedAt ?? nowIso;
        emitCallAnalytics("answered", session);
        publishCallEvent("call.accepted", [auth.user.id, ...otherIds], session);
      }
    }
  }
  const fresh = await store.getSession(session.id);
  if (!fresh || isTerminal(fresh.status)) return sendDeny(res, "room_terminated");
  await store.setParticipantStatus(session.id, auth.user.id, "joined");

  const allowVideo = fresh.callType === "video";
  const grant = await grantFor(d, fresh, auth.user.id, allowVideo);
  res.json(grant);
});

// ── Decline ──────────────────────────────────────────────────────────────────

router.post("/calls/:callId/decline", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const d = deps();
  const store = d.makeStore(auth.client);
  const loaded = await loadSessionForUser(store, req.params.callId, auth.user.id);
  if (!loaded) return sendDeny(res, "context_not_found");
  const { session, otherIds } = loaded;
  if (session.startedBy === auth.user.id) {
    return res.status(400).json({ error: "invalid_payload", reason: "caller_cannot_decline" });
  }

  const nowIso = new Date().toISOString();
  await store.setParticipantStatus(session.id, auth.user.id, "declined");
  await applyEvent(store, d.roomAdmin(), session, { type: "DECLINE" }, nowIso);
  const fresh = (await store.getSession(session.id)) ?? session;
  publishCallEvent("call.declined", [auth.user.id, ...otherIds], fresh);
  emitCallAnalytics("declined", fresh);
  res.json({ status: fresh.status });
});

// ── End (hangup / cancel) ────────────────────────────────────────────────────

router.post("/calls/:callId/end", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const d = deps();
  const store = d.makeStore(auth.client);
  const loaded = await loadSessionForUser(store, req.params.callId, auth.user.id);
  if (!loaded) return sendDeny(res, "context_not_found");
  const { session, otherIds } = loaded;

  const nowIso = new Date().toISOString();
  const wasRinging = session.status === "ringing";
  await applyEvent(store, d.roomAdmin(), session, { type: "END" }, nowIso);
  await store.markParticipantLeft(session.id, auth.user.id, nowIso);
  const fresh = (await store.getSession(session.id)) ?? session;
  publishCallEvent(
    wasRinging && fresh.status === "canceled" ? "call.canceled" : "call.ended",
    [auth.user.id, ...otherIds],
    fresh,
  );
  emitCallAnalytics("ended", fresh);
  res.json({ status: fresh.status });
});

// ── Join (group rooms / rejoin) ──────────────────────────────────────────────

router.post("/calls/:callId/join", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  if (!livekitReady()) {
    return res.status(503).json({ error: "call_service_unavailable", reason: "call_service_unavailable" });
  }
  const d = deps();
  const store = d.makeStore(auth.client);
  const session = await store.getSession(req.params.callId);
  if (!session) return sendDeny(res, "context_not_found");

  const participants = await store.getParticipants(session.id);
  const isDirect = session.contextType === "telegraph_dm" || session.contextType === "rent_a_buddy";
  if (isDirect && !participants.some((p) => p.userId === auth.user.id)) {
    return sendDeny(res, "not_a_participant");
  }
  const otherParty = isDirect
    ? participants.find((p) => p.userId !== auth.user.id)?.userId ?? null
    : null;

  const gw = d.makeGateway(auth.client);
  const verdict = await canUserJoinCall(gw, {
    userId: auth.user.id,
    callId: session.id,
    contextType: session.contextType,
    contextId: session.contextId,
    threadId: session.threadId,
    otherPartyId: otherParty,
    nowMs: Date.now(),
  });
  if (!verdict.allowed) return sendDeny(res, verdict.reason);

  if (!isDirect && !participants.some((p) => p.userId === auth.user.id)) {
    await store.upsertParticipant(session.id, auth.user.id, "participant", "joined");
  }

  const grant = await grantFor(d, session, auth.user.id, session.callType === "video");
  res.json(grant);
});

// ── Leave (group rooms; direct calls should use /end) ────────────────────────

router.post("/calls/:callId/leave", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const d = deps();
  const store = d.makeStore(auth.client);
  const loaded = await loadSessionForUser(store, req.params.callId, auth.user.id);
  if (!loaded) return sendDeny(res, "context_not_found");
  const { session } = loaded;

  const nowIso = new Date().toISOString();
  await store.markParticipantLeft(session.id, auth.user.id, nowIso);

  const isDirect = session.contextType === "telegraph_dm" || session.contextType === "rent_a_buddy";
  const remaining = (await store.getParticipants(session.id)).filter((p) => p.status === "joined");
  if (isDirect || remaining.length === 0) {
    await applyEvent(store, d.roomAdmin(), session, { type: "END" }, nowIso);
    const fresh = (await store.getSession(session.id)) ?? session;
    if (isTerminal(fresh.status)) {
      publishCallEvent("call.ended", loaded.participants.map((p) => p.userId), fresh);
      emitCallAnalytics("ended", fresh);
    }
    return res.json({ status: fresh.status });
  }
  res.json({ status: session.status });
});

// ── Get one ──────────────────────────────────────────────────────────────────

router.get("/calls/:callId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const store = deps().makeStore(auth.client);
  const loaded = await loadSessionForUser(store, req.params.callId, auth.user.id);
  if (!loaded) return sendDeny(res, "context_not_found");
  res.json({
    session: sessionDto(loaded.session),
    participants: loaded.participants,
  });
});

export default router;
