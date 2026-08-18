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
  canUserJoinCall, canUserModerateCall, canUserStartCall, canUserStartGroupCall,
  type CallContextGateway,
} from "../lib/calls/callPermissionEngine";
import { transition, isTerminal } from "../lib/calls/callStateMachine";
import { applyEvent, type RoomAdminPort } from "../lib/calls/callReconciler";
import {
  generateRoomName, livekitEnvStatus, makeRoomAdmin, mintCallToken, readLivekitEnv,
} from "../lib/calls/livekitService";
import { CALL_CONFIG, type CallDenyReason } from "../lib/calls/callTypes";
import { makeCallGateway, getFullCallPreferences, isRabBookingCallEligible } from "../lib/calls/callGatewayAdapter";
import { GroupRoomConflictError, makeCallStore, type CallStoreEx, type StoredCallSession } from "../lib/calls/callStoreAdapter";

// ── Group-start serialization (per-process layer of the one-room guard) ─────
// Chains concurrent group starts for the same context so lookup+create runs
// one at a time in this instance; the DB's partial unique index covers
// cross-instance races. Entries are removed once their chain drains.
const groupStartLocks = new Map<string, Promise<unknown>>();

function withGroupStartLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = groupStartLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.then(() => undefined, () => undefined);
  groupStartLocks.set(key, settled);
  void settled.then(() => {
    if (groupStartLocks.get(key) === settled) groupStartLocks.delete(key);
  });
  return run;
}
import {
  announceCrewCallEnded, announceCrewCallStarted, announceEventRoomEnded,
  announceEventRoomStarted, callerIdentity, emitCallAnalytics,
  publishCallEvent, sendIncomingCallPush, sessionDto,
} from "../lib/calls/callSignaling";
import type { ParticipantRole } from "../lib/calls/callTypes";
import { nameVisibilitySet, presentedName } from "../lib/publicIdentity";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── Test seams ────────────────────────────────────────────────────────────────

/** Room admin surface used by moderation (superset of the reconciler port). */
export interface RoomModerationPort extends RoomAdminPort {
  removeParticipant?(roomName: string, userId: string): Promise<void>;
  muteParticipantAudio?(roomName: string, userId: string): Promise<void>;
}

export interface CallRouteDeps {
  makeGateway: (sc: any) => CallContextGateway;
  makeStore: (sc: any) => CallStoreEx;
  roomAdmin: () => RoomModerationPort;
  mintToken: (opts: {
    roomName: string; userId: string; displayName?: string | null; allowVideo: boolean;
    canPublishAudio?: boolean;
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
    case "degraded_unavailable": return 503;
    default: return 403;
  }
}

function sendDeny(res: any, reason: CallDenyReason): void {
  const retryable = reason === "degraded_unavailable" ? { retryable: true } : {};
  res.status(denyStatus(reason)).json({ error: "call_denied", reason, ...retryable });
}

/** Resolve contextId for direct calls: booking id for RAB threads, else thread. */
async function resolveDirectContextId(
  sc: any, contextType: "telegraph_dm" | "rent_a_buddy", threadId: string,
): Promise<string> {
  if (contextType !== "rent_a_buddy") return threadId;
  try {
    const { data } = await sc
      .from("rent_buddy_bookings")
      .select("id, status, stay_connected_traveler, stay_connected_buddy")
      .eq("telegraph_thread_id", threadId)
      .order("created_at", { ascending: false });
    const eligible = ((data as any[]) ?? []).find((b) => isRabBookingCallEligible(b));
    return eligible?.id ?? threadId;
  } catch {
    return threadId;
  }
}

async function grantFor(
  d: CallRouteDeps, session: StoredCallSession, userId: string, allowVideo: boolean,
  role?: ParticipantRole,
): Promise<{ session: Record<string, unknown>; livekitUrl: string; token: string }> {
  // Listener subscribe-only is enforced AT THE TOKEN GRANT (spec Phase 5) —
  // a hacked client with a listener token cannot publish audio.
  const canPublishAudio = role ? role !== "listener" : true;
  const token = await d.mintToken({
    roomName: session.roomName, userId, allowVideo, canPublishAudio,
  });
  return {
    session: sessionDto(session) as any, livekitUrl: d.livekitUrl(), token,
    ...(role ? { role, canPublishAudio } : {}),
  };
}

/**
 * Role a user takes when entering an event voice room: event host → host,
 * co-host/moderator → cohost, everyone else joins as a subscribe-only
 * listener until promoted. An existing participant row keeps its role
 * (promotions survive rejoin; so do demotions).
 */
async function eventRoomRole(
  gw: CallContextGateway, store: CallStoreEx, session: StoredCallSession, userId: string,
): Promise<ParticipantRole> {
  const existing = (await store.getParticipants(session.id)).find((p) => p.userId === userId);
  if (existing && existing.role !== "participant") return existing.role;
  const staff = await gw.eventStaffRole(session.contextId, userId);
  if (staff === "host") return "host";
  if (staff === "cohost") return "cohost";
  return "listener";
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
  if (!session) return res.json({ session: null });
  // A restored ring must look like the live call.incoming event: include the
  // caller's privacy-safe identity when the viewer is not the caller.
  const caller = session.startedBy !== auth.user.id
    ? await callerIdentity(auth.client, session.startedBy)
    : null;
  return res.json({ session: sessionDto(session), ...(caller ? { caller } : {}) });
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
  // BEST-EFFORT ONLY: this limiter is per-process, so with N instances a
  // spammer gets N× this budget and a restart clears it. The hard ceiling
  // across instances is the engine's DB-counted startsInLastHour check
  // (canUserStartCall / canUserStartGroupCall below) — every start attempt
  // reaches it regardless of which instance serves the request. Same story
  // for the redial cooldown: lastDeclineAt is read from call_sessions, so it
  // holds across instances too.
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

      // Concurrent-start resolution: if the context already has a live room,
      // this "start" lands the caller in it instead of forking a second room.
      const joinExistingRoom = async (existing: StoredCallSession) => {
        const joinVerdict = await canUserJoinCall(gw, {
          userId, callId: existing.id, contextType: existing.contextType,
          contextId: existing.contextId, threadId: existing.threadId, nowMs,
        });
        if (!joinVerdict.allowed) return sendDeny(res, joinVerdict.reason);
        const isEvent = existing.contextType === "event";
        const role = isEvent
          ? await eventRoomRole(gw, store, existing, userId)
          : "participant";
        const already = (await store.getParticipants(existing.id)).some((p) => p.userId === userId);
        if (already) {
          await store.markParticipantJoined(existing.id, userId, new Date(nowMs).toISOString());
        } else {
          await store.upsertParticipant(existing.id, userId, role, "joined");
        }
        const grant = await grantFor(d, existing, userId, false, isEvent ? role : undefined);
        return res.status(200).json(grant);
      };

      const preExisting = await store.findOpenGroupSession(input.contextType, input.contextId);
      if (preExisting) return joinExistingRoom(preExisting);

      // Atomic one-open-room-per-context guard, two layers:
      //  1. per-process lock serializes lookup+create so concurrent starts in
      //     this instance never double-create;
      //  2. the DB's partial unique index (uniq_open_group_room_per_context)
      //     rejects cross-instance races — createSession then throws
      //     GroupRoomConflictError and we join the winning room instead.
      const outcome = await withGroupStartLock(
        `${input.contextType}:${input.contextId}`,
        async (): Promise<{ kind: "existing" | "created"; session: StoredCallSession }> => {
          const again = await store.findOpenGroupSession(input.contextType, input.contextId);
          if (again) return { kind: "existing", session: again };
          try {
            return {
              kind: "created",
              session: await store.createSession({
                callType: "group_voice",
                contextType: input.contextType,
                contextId: input.contextId,
                threadId: null,
                roomName: generateRoomName(),
                startedBy: userId,
                participants: [{ userId, role: "host", status: "joined" }],
              }),
            };
          } catch (err) {
            if (err instanceof GroupRoomConflictError) {
              const winner = await store.findOpenGroupSession(input.contextType, input.contextId);
              if (winner) return { kind: "existing", session: winner };
            }
            throw err;
          }
        },
      );
      if (outcome.kind === "existing") return joinExistingRoom(outcome.session);
      const session = outcome.session;
      // Group rooms have no ring phase — the room is live the moment the
      // starter is in it (join counts stay truthful without the webhook).
      const nowIso = new Date(nowMs).toISOString();
      const live = transition(session, { type: "CONNECTED" }, nowIso);
      if (live.ok && (await store.applyTransition(session.id, session.status, live.status, live.patch))) {
        session.status = live.status;
        session.connectedAt = live.patch.connectedAt ?? nowIso;
      }
      await store.markParticipantJoined(session.id, userId, nowIso);
      emitCallAnalytics("started", session);
      if (input.contextType === "trip_crew") {
        // Fire-and-forget: system message + single restrained notification.
        void announceCrewCallStarted(auth.client, session, userId).catch((err) => {
          logger.warn({ err }, "crew-call start announce failed (non-critical)");
        });
      } else if (input.contextType === "event") {
        // Fire-and-forget: one restrained "live voice room" notification.
        void announceEventRoomStarted(auth.client, session, userId).catch((err) => {
          logger.warn({ err }, "event-room start announce failed (non-critical)");
        });
      }
      const grant = await grantFor(
        d, session, userId, false, input.contextType === "event" ? "host" : undefined,
      );
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

    // Double-tap dedupe: if this caller already has an OPEN direct session
    // with this callee in this thread, return a grant into it instead of
    // creating a duplicate session (which would ring/push the callee twice).
    const dupes = await store.findOpenDirectSessionsBetween(userId, input.calleeId);
    const dupe = dupes.find((s) => s.startedBy === userId && s.threadId === input.threadId);
    if (dupe) {
      const grant = await grantFor(d, dupe, userId, dupe.callType === "video");
      return res.status(200).json(grant);
    }

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

  const nowMs = Date.now();

  // Ending a whole EVENT room is a moderation act — listeners/speakers must
  // use /leave. Authorized through the canonical engine (one decision matrix).
  if (session.callType === "group_voice" && session.contextType === "event") {
    const verdict = await canUserModerateCall(d.makeGateway(auth.client), {
      userId: auth.user.id, callId: session.id,
      contextType: session.contextType, contextId: session.contextId, nowMs,
    });
    if (!verdict.allowed) return sendDeny(res, verdict.reason);
    await store.logModerationAction({
      callId: session.id, actorId: auth.user.id, targetId: null, action: "end_room",
    });
  }

  const nowIso = new Date(nowMs).toISOString();
  const wasRinging = session.status === "ringing";
  await applyEvent(store, d.roomAdmin(), session, { type: "END" }, nowIso);
  await store.markParticipantLeft(session.id, auth.user.id, nowIso);
  const fresh = (await store.getSession(session.id)) ?? session;
  publishCallEvent(
    wasRinging && fresh.status === "canceled" ? "call.canceled" : "call.ended",
    [auth.user.id, ...otherIds],
    fresh,
  );
  if (session.contextType === "event" && isTerminal(fresh.status)) {
    announceEventRoomEnded(auth.client, fresh);
  }
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

  const nowMs = Date.now(); // single clock read for this request
  const gw = d.makeGateway(auth.client);
  const verdict = await canUserJoinCall(gw, {
    userId: auth.user.id,
    callId: session.id,
    contextType: session.contextType,
    contextId: session.contextId,
    threadId: session.threadId,
    otherPartyId: otherParty,
    nowMs,
  });
  if (!verdict.allowed) return sendDeny(res, verdict.reason);

  const isEvent = session.contextType === "event";
  let role: ParticipantRole | undefined;
  if (!isDirect) {
    role = isEvent ? await eventRoomRole(gw, store, session, auth.user.id) : "participant";
    // Group rooms: rejoin keeps the existing row/role; first join inserts one.
    if (participants.some((p) => p.userId === auth.user.id)) {
      await store.markParticipantJoined(session.id, auth.user.id, new Date(nowMs).toISOString());
    } else {
      await store.upsertParticipant(session.id, auth.user.id, role, "joined");
    }
  }

  const grant = await grantFor(
    d, session, auth.user.id, session.callType === "video", isEvent ? role : undefined,
  );
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
      if (session.contextType === "trip_crew") announceCrewCallEnded(auth.client, fresh);
      if (session.contextType === "event") announceEventRoomEnded(auth.client, fresh);
      emitCallAnalytics("ended", fresh);
    }
    return res.json({ status: fresh.status });
  }
  res.json({ status: session.status });
});

// ── Group room presence (crew surfaces: Start vs Join · N people) ───────────

router.get("/calls/group/trip_crew/:contextId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const d = deps();
  const gw = d.makeGateway(auth.client);
  // Presence is visible ONLY to active crew members.
  if (!(await gw.isActiveCrewMember(req.params.contextId, auth.user.id))) {
    return sendDeny(res, "not_crew_member");
  }
  const store = d.makeStore(auth.client);
  const session = await store.findOpenGroupSession("trip_crew", req.params.contextId);
  if (!session) return res.json({ session: null, participantCount: 0 });
  const participants = await store.getParticipants(session.id);
  const participantCount = participants.filter((p) => p.status === "joined").length;
  return res.json({ session: sessionDto(session), participantCount });
});

// ── Event room presence (event page: no room / Live · N listening) ──────────

router.get("/calls/group/event/:contextId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const d = deps();
  const gw = d.makeGateway(auth.client);
  // Room state is visible ONLY inside the event context (attendance/privacy/
  // age/trust — the canonical event participation rules).
  const ineligible = await gw.eventRoomIneligibility(req.params.contextId, auth.user.id);
  if (ineligible) return sendDeny(res, ineligible);
  const store = d.makeStore(auth.client);
  const canStart = (await gw.eventStaffRole(req.params.contextId, auth.user.id)) != null;
  const session = await store.findOpenGroupSession("event", req.params.contextId);
  if (!session) return res.json({ session: null, participantCount: 0, canStart });
  const participants = await store.getParticipants(session.id);
  const participantCount = participants.filter((p) => p.status === "joined").length;
  return res.json({ session: sessionDto(session), participantCount, canStart });
});

// ── Raise hand (event rooms) ─────────────────────────────────────────────────

const handSchema = z.object({ raised: z.boolean() });

router.post("/calls/:callId/hand", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const parsed = handSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", reason: "invalid_payload" });
  }
  const d = deps();
  const store = d.makeStore(auth.client);
  const loaded = await loadSessionForUser(store, req.params.callId, auth.user.id);
  if (!loaded) return sendDeny(res, "context_not_found");
  const { session, participants } = loaded;
  if (session.contextType !== "event" || isTerminal(session.status)) {
    return sendDeny(res, "room_terminated");
  }
  const me = participants.find((p) => p.userId === auth.user.id);
  if (!me || me.status !== "joined") return sendDeny(res, "not_a_participant");
  await store.setHandRaised(session.id, auth.user.id, parsed.data.raised);
  publishCallEvent("call.room_updated", participants.map((p) => p.userId), session, {
    userId: auth.user.id, handRaised: parsed.data.raised,
  });
  res.json({ ok: true, handRaised: parsed.data.raised });
});

// ── Moderation (event rooms — engine-authorized, audit-logged) ──────────────

/**
 * Shared moderation guard: loads the session, requires a live EVENT group
 * room, and authorizes exclusively through canUserModerateCall.
 */
async function authorizeModeration(req: any, res: any): Promise<{
  d: CallRouteDeps; store: CallStoreEx; session: StoredCallSession; actorId: string;
  participants: Awaited<ReturnType<CallStoreEx["getParticipants"]>>;
} | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const d = deps();
  const store = d.makeStore(auth.client);
  const session = await store.getSession(req.params.callId);
  if (!session) { sendDeny(res, "context_not_found"); return null; }
  const verdict = await canUserModerateCall(d.makeGateway(auth.client), {
    userId: auth.user.id, callId: session.id,
    contextType: session.contextType, contextId: session.contextId, nowMs: Date.now(),
  });
  if (!verdict.allowed) { sendDeny(res, verdict.reason); return null; }
  const participants = await store.getParticipants(session.id);
  return { d, store, session, actorId: auth.user.id, participants };
}

const roleSchema = z.object({ role: z.enum(["speaker", "listener"]) });

/** Promote a listener to speaker / demote a speaker back to listener. */
router.post("/calls/:callId/participants/:userId/role", async (req, res) => {
  const ctx = await authorizeModeration(req, res);
  if (!ctx) return;
  const parsed = roleSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", reason: "invalid_payload" });
  }
  const targetId = req.params.userId;
  const target = ctx.participants.find((p) => p.userId === targetId);
  if (!target) return sendDeny(res, "context_not_found");
  // Hosts/co-hosts are never demoted through this surface.
  if (target.role === "host" || target.role === "cohost") {
    return res.status(400).json({ error: "invalid_payload", reason: "cannot_change_staff_role" });
  }
  const role = parsed.data.role;
  await ctx.store.setParticipantRole(ctx.session.id, targetId, role);
  await ctx.store.logModerationAction({
    callId: ctx.session.id, actorId: ctx.actorId, targetId,
    action: role === "speaker" ? "promote_speaker" : "demote_speaker",
  });
  // Demotion revokes publishing immediately — the fresh token grant on the
  // target's next join is subscribe-only, and live tracks are muted now.
  if (role === "listener") {
    await ctx.d.roomAdmin().muteParticipantAudio?.(ctx.session.roomName, targetId)
      .catch(() => { /* participant may not be publishing */ });
  }
  publishCallEvent("call.role_changed", ctx.participants.map((p) => p.userId), ctx.session, {
    userId: targetId, role,
  });
  res.json({ ok: true, role });
});

/** Server-side mute of a participant's published audio (host moderation). */
router.post("/calls/:callId/participants/:userId/mute", async (req, res) => {
  const ctx = await authorizeModeration(req, res);
  if (!ctx) return;
  const targetId = req.params.userId;
  const target = ctx.participants.find((p) => p.userId === targetId);
  if (!target) return sendDeny(res, "context_not_found");
  // Staff are never mute targets — moderation flows only downward.
  if (target.role === "host" || target.role === "cohost") {
    return res.status(400).json({ error: "invalid_payload", reason: "cannot_moderate_staff" });
  }
  await ctx.d.roomAdmin().muteParticipantAudio?.(ctx.session.roomName, targetId)
    .catch(() => { /* not publishing = already effectively muted */ });
  await ctx.store.logModerationAction({
    callId: ctx.session.id, actorId: ctx.actorId, targetId, action: "mute",
  });
  publishCallEvent("call.room_updated", ctx.participants.map((p) => p.userId), ctx.session, {
    userId: targetId, muted: true,
  });
  res.json({ ok: true });
});

/** Remove a participant from the room. Removed users can never rejoin. */
router.post("/calls/:callId/participants/:userId/remove", async (req, res) => {
  const ctx = await authorizeModeration(req, res);
  if (!ctx) return;
  const targetId = req.params.userId;
  const target = ctx.participants.find((p) => p.userId === targetId);
  if (!target) return sendDeny(res, "context_not_found");
  if (targetId === ctx.actorId) {
    return res.status(400).json({ error: "invalid_payload", reason: "cannot_remove_self" });
  }
  // Staff can never be removed — prevents a cohost locking out the host.
  if (target.role === "host" || target.role === "cohost") {
    return res.status(400).json({ error: "invalid_payload", reason: "cannot_moderate_staff" });
  }
  await ctx.store.setParticipantStatus(ctx.session.id, targetId, "removed");
  await ctx.d.roomAdmin().removeParticipant?.(ctx.session.roomName, targetId)
    .catch(() => { /* already disconnected */ });
  await ctx.store.logModerationAction({
    callId: ctx.session.id, actorId: ctx.actorId, targetId, action: "remove",
  });
  publishCallEvent("call.removed_from_room", [targetId], ctx.session);
  publishCallEvent(
    "call.room_updated",
    ctx.participants.map((p) => p.userId).filter((id) => id !== targetId),
    ctx.session,
    { userId: targetId, removed: true },
  );
  res.json({ ok: true });
});

// ── Get one ──────────────────────────────────────────────────────────────────

router.get("/calls/:callId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const store = deps().makeStore(auth.client);
  const loaded = await loadSessionForUser(store, req.params.callId, auth.user.id);
  if (!loaded) return sendDeny(res, "context_not_found");

  // Privacy-safe identities for the in-room participant list (name rule).
  const ids = loaded.participants.map((p) => p.userId);
  let profileMap = new Map<string, { name: string | null; handle: string | null; avatarUrl: string | null }>();
  try {
    const [{ data: profiles }, allowedNames] = await Promise.all([
      auth.client.from("profiles").select("id, username, display_name, name, avatar_url").in("id", ids),
      nameVisibilitySet(auth.client, ids),
    ]);
    for (const row of ((profiles as any[]) ?? [])) {
      profileMap.set(row.id, {
        name: presentedName(row, allowedNames.has(row.id)),
        handle: row.username ?? null,
        avatarUrl: row.avatar_url ?? null,
      });
    }
  } catch { /* identities are cosmetic — never fail the call fetch */ }

  res.json({
    session: sessionDto(loaded.session),
    participants: loaded.participants.map((p) => ({
      ...p,
      ...(profileMap.get(p.userId) ?? { name: null, handle: null, avatarUrl: null }),
    })),
  });
});

export default router;
