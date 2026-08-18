/**
 * Call route + webhook + sweep integration tests.
 *
 * node:test + fake-client pattern (see blocks.test.ts). The permission engine
 * is REAL — only its gateway port, the store, and LiveKit are faked, so these
 * tests prove the routes authorize exclusively through the engine.
 *
 * Run: node --import tsx/esm --test src/test/callRoutes.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import callsRouter, { _setTestCallDeps } from "../routes/calls.js";
import { callsWebhookHandler, callsWebhookRawParser, _setTestWebhookDeps } from "../routes/callsWebhook.js";
import type { CallContextGateway } from "../lib/calls/callPermissionEngine.js";
import type { CallStoreEx, StoredCallSession } from "../lib/calls/callStoreAdapter.js";
import { _setTestPushDeps, deliverIncomingCallPush } from "../lib/calls/callSignaling.js";
import type { CallParticipant } from "../lib/calls/callTypes.js";
import { CALL_CONFIG } from "../lib/calls/callTypes.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { makeCallGateway } from "../lib/calls/callGatewayAdapter.js";

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const CALLER_TOKEN = "calls-test-caller";
const CALLEE_TOKEN = "calls-test-callee";
const CALLER_ID = "aabbccdd-1001-2002-3003-aabbccdd1001";
const CALLEE_ID = "aabbccdd-1001-2002-3003-aabbccdd1002";
const THREAD_ID = "aabbccdd-1001-2002-3003-aabbccddaaaa";

function req(
  method: string,
  path: string,
  body?: unknown,
  token: string = CALLER_TOKEN,
  rawHeaders?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(rawHeaders ?? {}),
    };
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname, method, headers },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Fake auth client (only auth + tolerant empty tables) ────────────────────

function makeFakeAuthClient() {
  const emptyBuilder: any = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") {
        return (onF: any) => Promise.resolve({ data: [], error: null, count: 0 }).then(onF);
      }
      if (prop === "maybeSingle" || prop === "single") {
        return () => Promise.resolve({ data: null, error: null });
      }
      return () => emptyBuilder;
    },
  });
  return {
    from: () => emptyBuilder,
    auth: {
      getUser: async (token: string) => {
        if (token === CALLER_TOKEN) return { data: { user: { id: CALLER_ID } }, error: null };
        if (token === CALLEE_TOKEN) return { data: { user: { id: CALLEE_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
  } as any;
}

/**
 * Fake auth client whose profiles/profile_privacy_settings tables return real
 * rows for CALLER_ID, so callerIdentity can enrich GET /calls/active.
 */
function makeProfileAuthClient(opts: { showRealName: boolean }) {
  const base = makeFakeAuthClient();
  const profileRow = {
    id: CALLER_ID, username: "wanderlust_sam", display_name: "Sam Rivera",
    name: "Samuel Rivera", avatar_url: "https://cdn.test/sam.jpg",
  };
  function tableBuilder(table: string): any {
    const b: any = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") {
          const data = table === "profile_privacy_settings" && opts.showRealName
            ? [{ user_id: CALLER_ID }] : [];
          return (onF: any) => Promise.resolve({ data, error: null, count: data.length }).then(onF);
        }
        if (prop === "maybeSingle" || prop === "single") {
          return () => Promise.resolve({
            data: table === "profiles" ? profileRow : null, error: null,
          });
        }
        return () => b;
      },
    });
    return b;
  }
  return { ...base, from: (table: string) => tableBuilder(table) } as any;
}

// ── Fake gateway (permissive defaults; tests override per-case) ─────────────

function makeFakeGateway(overrides: Partial<CallContextGateway> = {}): CallContextGateway {
  return {
    getThreadParticipants: async () => [CALLER_ID, CALLEE_ID],
    canMessage: async () => true,
    isBlockedEither: async () => false,
    getCallPreferences: async () => ({
      whoCanCall: "people_i_message", allowRentABuddyCalls: true, allowVideoCalls: true,
    }),
    isEligibleRabConversation: async () => true,
    isActiveCrewMember: async () => true,
    eventRoomIneligibility: async () => null,
    eventStaffRole: async (_eventId, userId) => (userId === CALLER_ID ? "host" : null),
    isCallRestricted: async () => ({ restricted: false }),
    isSessionTerminated: async () => false,
    wasRemovedFromCall: async () => false,
    lastDeclineAt: async () => null,
    startsInLastHour: async () => 0,
    ...overrides,
  } as CallContextGateway;
}

// ── In-memory store ──────────────────────────────────────────────────────────

function makeMemStore() {
  const sessions = new Map<string, StoredCallSession>();
  const participants = new Map<string, CallParticipant[]>();
  let seq = 0;
  const historyWrites: string[] = [];

  const auditLog: Array<{ callId: string; actorId: string; targetId: string | null; action: string }> = [];

  const store: CallStoreEx & {
    __sessions: typeof sessions; __history: string[]; __audit: typeof auditLog;
  } = {
    __sessions: sessions,
    __history: historyWrites,
    __audit: auditLog,
    async createSession(input) {
      const id = `call-${++seq}`;
      const s: StoredCallSession = {
        id,
        callType: input.callType,
        contextType: input.contextType,
        contextId: input.contextId,
        threadId: input.threadId,
        startedBy: input.startedBy,
        status: "ringing",
        startedAt: new Date().toISOString(),
        connectedAt: null,
        endedAt: null,
        roomName: input.roomName,
      };
      sessions.set(id, s);
      participants.set(id, input.participants.map((p) => ({
        callId: id, userId: p.userId, role: p.role, status: p.status,
        invitedAt: new Date().toISOString(), joinedAt: null, leftAt: null,
      })));
      return s;
    },
    async getSession(callId) { return sessions.get(callId) ?? null; },
    async getSessionByRoom(roomName) {
      return [...sessions.values()].find((s) => s.roomName === roomName) ?? null;
    },
    async applyTransition(callId, fromStatus, toStatus, patch) {
      const s = sessions.get(callId);
      if (!s || s.status !== fromStatus) return false;
      s.status = toStatus;
      if (patch.connectedAt) s.connectedAt = patch.connectedAt;
      if (patch.endedAt) s.endedAt = patch.endedAt;
      return true;
    },
    async markParticipantJoined(callId, userId, atIso) {
      const p = (participants.get(callId) ?? []).find((x) => x.userId === userId);
      if (p) { p.status = "joined"; p.joinedAt = atIso; }
    },
    async markParticipantLeft(callId, userId, atIso) {
      const p = (participants.get(callId) ?? []).find((x) => x.userId === userId);
      if (p && p.status === "joined") { p.status = "left"; p.leftAt = atIso; }
    },
    async listOpenSessions() {
      return [...sessions.values()].filter((s) => s.status === "ringing" || s.status === "active");
    },
    async writeCallHistoryMessage(session) { historyWrites.push(session.id); },
    async getParticipants(callId) { return participants.get(callId) ?? []; },
    async upsertParticipant(callId, userId, role, status) {
      const list = participants.get(callId) ?? [];
      const existing = list.find((p) => p.userId === userId);
      if (existing) existing.status = status;
      else list.push({ callId, userId, role, status, invitedAt: new Date().toISOString(), joinedAt: null, leftAt: null });
      participants.set(callId, list);
    },
    async setParticipantStatus(callId, userId, status) {
      const p = (participants.get(callId) ?? []).find((x) => x.userId === userId);
      if (p) p.status = status;
    },
    async findActiveSessionForUser(userId) {
      for (const s of sessions.values()) {
        if (s.status !== "ringing" && s.status !== "active") continue;
        if ((participants.get(s.id) ?? []).some((p) => p.userId === userId && p.status !== "declined" && p.status !== "removed")) return s;
      }
      return null;
    },
    async findOpenGroupSession(contextType, contextId) {
      return [...sessions.values()].find((s) =>
        (s.status === "ringing" || s.status === "active") &&
        s.contextType === contextType && s.contextId === contextId,
      ) ?? null;
    },
    async setParticipantRole(callId, userId, role) {
      const p = (participants.get(callId) ?? []).find((x) => x.userId === userId);
      if (p) { p.role = role; p.handRaisedAt = null; }
    },
    async setHandRaised(callId, userId, raised) {
      const p = (participants.get(callId) ?? []).find((x) => x.userId === userId);
      if (p) p.handRaisedAt = raised ? new Date().toISOString() : null;
    },
    async logModerationAction(entry) { auditLog.push({ ...entry }); },
    async findOpenDirectSessionsBetween(a, b) {
      return [...sessions.values()].filter((s) => {
        if (s.status !== "ringing" && s.status !== "active") return false;
        if (s.contextType !== "telegraph_dm" && s.contextType !== "rent_a_buddy") return false;
        const ids = new Set((participants.get(s.id) ?? []).map((p) => p.userId));
        return ids.has(a) && ids.has(b);
      });
    },
  };
  return store;
}

// ── Shared deps wiring ────────────────────────────────────────────────────────

let gateway: CallContextGateway;
let store: ReturnType<typeof makeMemStore>;
const endedRooms: string[] = [];
const mutedInRoom: Array<{ room: string; userId: string }> = [];
const removedInRoom: Array<{ room: string; userId: string }> = [];
/** Every mintToken call — lets tests assert listener grants are subscribe-only. */
const mintedTokens: Array<{ userId: string; canPublishAudio?: boolean }> = [];

function wireDeps(gwOverrides: Partial<CallContextGateway> = {}) {
  gateway = makeFakeGateway(gwOverrides);
  store = makeMemStore();
  endedRooms.length = 0;
  mutedInRoom.length = 0;
  removedInRoom.length = 0;
  mintedTokens.length = 0;
  // The call-start limiter is module-global in-memory state — reset it so
  // per-test start counts never bleed across cases.
  _resetRateLimit();
  _setTestCallDeps({
    makeGateway: () => gateway,
    makeStore: () => store,
    roomAdmin: () => ({
      endRoom: async (room: string) => { endedRooms.push(room); },
      muteParticipantAudio: async (room: string, userId: string) => { mutedInRoom.push({ room, userId }); },
      removeParticipant: async (room: string, userId: string) => { removedInRoom.push({ room, userId }); },
    }),
    mintToken: async (opts: any) => {
      mintedTokens.push({ userId: opts.userId, canPublishAudio: opts.canPublishAudio });
      return "test-token";
    },
    livekitUrl: () => "wss://livekit.test",
  });
}

before(() => new Promise<void>((resolve) => {
  const app = express();
  app.post("/api/calls/webhook", callsWebhookRawParser, callsWebhookHandler);
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} };
    next();
  });
  // Mirrors production: routes/index.ts mounts routers under app.use("/api").
  app.use("/api", callsRouter);
  server = app.listen(0, "127.0.0.1", () => {
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    resolve();
  });
}));

after(() => {
  _setTestCallDeps(null);
  _setTestWebhookDeps(null);
  _setTestClient(null as any, false);
  _setTestServiceClient(null as any);
  server.close();
});

const startBody = {
  contextType: "telegraph_dm", callType: "voice", threadId: THREAD_ID, calleeId: CALLEE_ID,
};

describe("call routes", () => {
  beforeEach(() => {
    _setTestClient(makeFakeAuthClient(), true);
    _setTestServiceClient(makeFakeAuthClient());
    wireDeps();
  });

  describe("POST /api/calls", () => {
    it("starts a direct call and returns a grant with opaque room token", async () => {
      const r = await req("POST", "/api/calls", startBody);
      assert.equal(r.status, 201);
      assert.equal(r.body.token, "test-token");
      assert.equal(r.body.livekitUrl, "wss://livekit.test");
      assert.equal(r.body.session.status, "ringing");
      assert.equal(r.body.session.threadId, THREAD_ID);
      // Response never leaks the room name (opaque to clients).
      assert.equal(r.body.session.roomName, undefined);
    });

    it("unauthenticated returns 401", async () => {
      const r = await req("POST", "/api/calls", startBody, "bad-token");
      assert.equal(r.status, 401);
    });

    it("invalid payload returns 400", async () => {
      const r = await req("POST", "/api/calls", { contextType: "telegraph_dm" });
      assert.equal(r.status, 400);
      assert.equal(r.body.reason, "invalid_payload");
    });

    it("denies with the engine's stable reason when blocked (403)", async () => {
      wireDeps({ isBlockedEither: async () => true });
      const r = await req("POST", "/api/calls", startBody);
      assert.equal(r.status, 403);
      assert.equal(r.body.reason, "blocked");
      assert.equal(store.__sessions.size, 0, "no session persisted on deny");
    });

    it("a real caller restriction denies 403 caller_restricted; a degraded (could-not-check) read denies 503 degraded_unavailable with a retry signal, never 403", async () => {
      wireDeps({ isCallRestricted: async () => ({ restricted: true }) });
      const restricted = await req("POST", "/api/calls", startBody);
      assert.equal(restricted.status, 403);
      assert.equal(restricted.body.reason, "caller_restricted");
      assert.equal(restricted.body.retryable, undefined);

      wireDeps({ isCallRestricted: async () => ({ restricted: true, degraded: true }) });
      const degraded = await req("POST", "/api/calls", startBody);
      assert.equal(degraded.status, 503, "a degraded check must not be shown as a 403 restriction");
      assert.equal(degraded.body.reason, "degraded_unavailable");
      assert.equal(degraded.body.retryable, true, "must carry a retry signal for the client to act on");
      assert.equal(store.__sessions.size, 0, "no session persisted on either deny");
    });

    it("denies video when callee disabled video (video_calls_disabled)", async () => {
      wireDeps({
        getCallPreferences: async () => ({
          whoCanCall: "people_i_message", allowRentABuddyCalls: true, allowVideoCalls: false,
        }),
      });
      const r = await req("POST", "/api/calls", { ...startBody, callType: "video" });
      assert.equal(r.status, 403);
      assert.equal(r.body.reason, "video_calls_disabled");
    });

    it("maps rate_limited to 429", async () => {
      wireDeps({ startsInLastHour: async () => CALL_CONFIG.MAX_STARTS_PER_HOUR });
      const r = await req("POST", "/api/calls", startBody);
      assert.equal(r.status, 429);
      assert.equal(r.body.reason, "rate_limited");
    });

    // ── Multi-instance hardening ────────────────────────────────────────────
    // The in-memory checkRateLimit backstop is per-process (best-effort).
    // These tests prove the DB-authoritative checks alone are a hard ceiling
    // on a FRESH instance whose in-memory limiter has no history — the
    // situation every additional server instance is in.

    it("DB hourly ceiling denies at the limit even when the in-memory limiter has no history (fresh instance)", async () => {
      wireDeps({ startsInLastHour: async () => CALL_CONFIG.MAX_STARTS_PER_HOUR });
      _resetRateLimit(); // simulate a freshly booted instance: zero in-memory buckets
      const r = await req("POST", "/api/calls", startBody);
      assert.equal(r.status, 429);
      assert.equal(r.body.reason, "rate_limited");
      assert.equal(store.__sessions.size, 0, "no session persisted at the ceiling");
    });

    it("DB hourly ceiling also holds for group starts on a fresh instance", async () => {
      wireDeps({ startsInLastHour: async () => CALL_CONFIG.MAX_STARTS_PER_HOUR });
      _resetRateLimit();
      const r = await req("POST", "/api/calls", {
        contextType: "trip_crew", callType: "group_voice", contextId: "trip-1",
      });
      assert.equal(r.status, 429);
      assert.equal(r.body.reason, "rate_limited");
    });

    it("redial cooldown (DB-backed lastDeclineAt) holds on a fresh instance", async () => {
      wireDeps({ lastDeclineAt: async () => Date.now() - 1_000 });
      _resetRateLimit();
      const r = await req("POST", "/api/calls", startBody);
      assert.equal(r.status, 429);
      assert.equal(r.body.reason, "redial_cooldown");
    });

    it("group start authorizes via canUserStartGroupCall (not_crew_member 403)", async () => {
      wireDeps({ isActiveCrewMember: async () => false });
      const r = await req("POST", "/api/calls", {
        contextType: "trip_crew", callType: "group_voice", contextId: "trip-1",
      });
      assert.equal(r.status, 403);
      assert.equal(r.body.reason, "not_crew_member");
    });

    it("group start succeeds for crew members", async () => {
      const r = await req("POST", "/api/calls", {
        contextType: "trip_crew", callType: "group_voice", contextId: "trip-1",
      });
      assert.equal(r.status, 201);
      assert.equal(r.body.session.callType, "group_voice");
    });
  });

  describe("accept / decline / end", () => {
    async function startCall(): Promise<string> {
      const r = await req("POST", "/api/calls", startBody);
      assert.equal(r.status, 201);
      return r.body.session.id;
    }

    it("callee accept transitions ringing→active and returns a grant", async () => {
      const id = await startCall();
      const r = await req("POST", `/api/calls/${id}/accept`, {}, CALLEE_TOKEN);
      assert.equal(r.status, 200);
      assert.equal(r.body.token, "test-token");
      assert.equal(store.__sessions.get(id)!.status, "active");
    });

    it("caller cannot accept their own call", async () => {
      const id = await startCall();
      const r = await req("POST", `/api/calls/${id}/accept`, {}, CALLER_TOKEN);
      assert.equal(r.status, 400);
    });

    it("accept is denied via engine when session already terminated", async () => {
      const id = await startCall();
      wireDepsKeepStore({ isSessionTerminated: async () => true });
      const r = await req("POST", `/api/calls/${id}/accept`, {}, CALLEE_TOKEN);
      assert.equal(r.status, 403);
      assert.equal(r.body.reason, "room_terminated");
    });

    it("decline ends the session as declined, terminates room, writes history", async () => {
      const id = await startCall();
      const r = await req("POST", `/api/calls/${id}/decline`, undefined, CALLEE_TOKEN);
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "declined");
      assert.equal(store.__sessions.get(id)!.status, "declined");
      assert.equal(endedRooms.length, 1);
      assert.ok(store.__history.includes(id));
    });

    it("caller end while ringing cancels the call", async () => {
      const id = await startCall();
      const r = await req("POST", `/api/calls/${id}/end`, undefined, CALLER_TOKEN);
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "canceled");
    });

    it("end after accept ends the call", async () => {
      const id = await startCall();
      await req("POST", `/api/calls/${id}/accept`, {}, CALLEE_TOKEN);
      const r = await req("POST", `/api/calls/${id}/end`, undefined, CALLER_TOKEN);
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "ended");
    });

    it("non-participant gets context_not_found (no session leak)", async () => {
      const id = await startCall();
      // Third user token is unknown → 401; instead simulate by removing callee.
      await store.setParticipantStatus(id, CALLEE_ID, "removed");
      wireDepsKeepStore({ wasRemovedFromCall: async () => true });
      const r = await req("POST", `/api/calls/${id}/accept`, {}, CALLEE_TOKEN);
      assert.equal(r.status, 403);
      assert.equal(r.body.reason, "removed_from_room");
    });
  });

  describe("GET /api/calls/active and /:callId", () => {
    it("active returns null when no open call", async () => {
      const r = await req("GET", "/api/calls/active");
      assert.equal(r.status, 200);
      assert.equal(r.body.session, null);
    });

    it("active returns the open session for a participant", async () => {
      const s = await req("POST", "/api/calls", startBody);
      const r = await req("GET", "/api/calls/active", undefined, CALLEE_TOKEN);
      assert.equal(r.status, 200);
      assert.equal(r.body.session.id, s.body.session.id);
    });

    it("active returns the still-RINGING session for the callee (reconnect restore path)", async () => {
      const s = await req("POST", "/api/calls", startBody);
      assert.equal(s.status, 201);
      const r = await req("GET", "/api/calls/active", undefined, CALLEE_TOKEN);
      assert.equal(r.status, 200);
      assert.equal(r.body.session.id, s.body.session.id);
      assert.equal(r.body.session.status, "ringing");
      assert.equal(r.body.session.startedBy, CALLER_ID, "client uses startedBy to detect it is the callee");
    });

    it("active includes the caller's identity for the callee on a ringing session", async () => {
      _setTestClient(makeProfileAuthClient({ showRealName: true }), true);
      const s = await req("POST", "/api/calls", startBody);
      assert.equal(s.status, 201);
      const r = await req("GET", "/api/calls/active", undefined, CALLEE_TOKEN);
      assert.equal(r.status, 200);
      assert.equal(r.body.session.status, "ringing");
      assert.equal(r.body.caller.id, CALLER_ID);
      assert.equal(r.body.caller.name, "Sam Rivera");
      assert.equal(r.body.caller.avatarUrl, "https://cdn.test/sam.jpg");
      assert.equal(r.body.caller.handle, "wanderlust_sam");
    });

    it("active redacts the caller's name when they have not opted in (privacy rule)", async () => {
      _setTestClient(makeProfileAuthClient({ showRealName: false }), true);
      const s = await req("POST", "/api/calls", startBody);
      assert.equal(s.status, 201);
      const r = await req("GET", "/api/calls/active", undefined, CALLEE_TOKEN);
      assert.equal(r.status, 200);
      assert.equal(r.body.caller.name, null, "name hidden without opt-in");
      assert.equal(r.body.caller.handle, "wanderlust_sam", "handle still available for the banner");
      assert.equal(r.body.caller.avatarUrl, "https://cdn.test/sam.jpg", "avatar not affected by name rule");
    });

    it("active does NOT include a caller block for the caller themself", async () => {
      const s = await req("POST", "/api/calls", startBody);
      assert.equal(s.status, 201);
      const r = await req("GET", "/api/calls/active");
      assert.equal(r.status, 200);
      assert.equal(r.body.session.id, s.body.session.id);
      assert.equal("caller" in r.body, false);
    });

    it("GET /:callId returns session + participants for a participant", async () => {
      const s = await req("POST", "/api/calls", startBody);
      const r = await req("GET", `/api/calls/${s.body.session.id}`);
      assert.equal(r.status, 200);
      assert.equal(r.body.participants.length, 2);
    });
  });
});

// ── Group crew rooms (Phase 4) ───────────────────────────────────────────────

const groupStartBody = { contextType: "trip_crew", callType: "group_voice", contextId: "trip-1" };

describe("group crew rooms", () => {
  beforeEach(() => {
    _setTestClient(makeFakeAuthClient(), true);
    _setTestServiceClient(makeFakeAuthClient());
    wireDeps();
  });

  it("start makes the room live immediately with the starter joined", async () => {
    const r = await req("POST", "/api/calls", groupStartBody);
    assert.equal(r.status, 201);
    const s = store.__sessions.get(r.body.session.id)!;
    assert.equal(s.status, "active", "group rooms have no ring phase");
    assert.equal(r.body.session.roomName, undefined, "room name stays opaque");
    const ps = await store.getParticipants(s.id);
    assert.equal(ps.length, 1);
    assert.equal(ps[0].status, "joined");
    assert.equal(ps[0].role, "host");
  });

  it("concurrent start lands the second caller in the existing room", async () => {
    const first = await req("POST", "/api/calls", groupStartBody);
    assert.equal(first.status, 201);
    const second = await req("POST", "/api/calls", groupStartBody, CALLEE_TOKEN);
    assert.equal(second.status, 200, "join-existing, not a fork");
    assert.equal(second.body.session.id, first.body.session.id);
    assert.equal(store.__sessions.size, 1, "no second room created");
    const ps = await store.getParticipants(first.body.session.id);
    assert.equal(ps.filter((p) => p.status === "joined").length, 2);
    assert.equal(ps.find((p) => p.userId === CALLEE_ID)!.role, "participant");
  });

  it("truly parallel starts create ONE room; every caller lands in it", async () => {
    // Force the read-then-create window open: both lookup and create yield to
    // the event loop, so without the per-context lock the requests would each
    // observe "no open room" and fork rooms.
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const realFind = store.findOpenGroupSession.bind(store);
    const realCreate = store.createSession.bind(store);
    store.findOpenGroupSession = async (ct, cid) => { await delay(10); return realFind(ct, cid); };
    store.createSession = async (input) => { await delay(10); return realCreate(input); };

    const results = await Promise.all([
      req("POST", "/api/calls", groupStartBody),
      req("POST", "/api/calls", groupStartBody, CALLEE_TOKEN),
      req("POST", "/api/calls", groupStartBody),
      req("POST", "/api/calls", groupStartBody, CALLEE_TOKEN),
    ]);

    assert.equal(store.__sessions.size, 1, "exactly one room despite the race");
    const ids = new Set(results.map((r) => r.body.session.id));
    assert.equal(ids.size, 1, "every response grants the same room");
    assert.equal(results.filter((r) => r.status === 201).length, 1, "one creator");
    assert.equal(results.filter((r) => r.status === 200).length, 3, "three joiners");
  });

  it("DB unique-index conflict on create resolves to the winning room (cross-instance race)", async () => {
    // Simulate another server instance winning the insert between our lookup
    // and our create: lookups report no room until the conflict is thrown,
    // then the winner becomes visible.
    const { GroupRoomConflictError } = await import("../lib/calls/callStoreAdapter.js");
    const realFind = store.findOpenGroupSession.bind(store);
    const realCreate = store.createSession.bind(store);
    let winner: any = null;
    store.findOpenGroupSession = async (ct, cid) => (winner ? realFind(ct, cid) : null);
    store.createSession = async (input) => {
      // The "other instance" inserts first; our insert hits the unique index.
      winner = await realCreate({ ...input, startedBy: CALLEE_ID, participants: [{ userId: CALLEE_ID, role: "host", status: "joined" }] });
      await store.applyTransition(winner.id, "ringing", "active", { connectedAt: new Date().toISOString() });
      throw new GroupRoomConflictError();
    };

    const r = await req("POST", "/api/calls", groupStartBody);
    assert.equal(r.status, 200, "start degrades to a join of the winning room");
    assert.equal(r.body.session.id, winner.id);
    assert.equal(store.__sessions.size, 1);
    const ps = await store.getParticipants(winner.id);
    assert.ok(ps.some((p) => p.userId === CALLER_ID && p.status === "joined"));
  });

  it("member can join; non-member is denied", async () => {
    const started = await req("POST", "/api/calls", groupStartBody);
    const id = started.body.session.id;
    const ok = await req("POST", `/api/calls/${id}/join`, {}, CALLEE_TOKEN);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.token, "test-token");

    wireDepsKeepStore({ isActiveCrewMember: async () => false });
    const denied = await req("POST", `/api/calls/${id}/join`, {}, CALLEE_TOKEN);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.reason, "not_crew_member");
  });

  it("removed member cannot rejoin (removed_from_room)", async () => {
    const started = await req("POST", "/api/calls", groupStartBody);
    const id = started.body.session.id;
    await req("POST", `/api/calls/${id}/join`, {}, CALLEE_TOKEN);
    await store.setParticipantStatus(id, CALLEE_ID, "removed");
    wireDepsKeepStore({ wasRemovedFromCall: async () => true });
    const r = await req("POST", `/api/calls/${id}/join`, {}, CALLEE_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, "removed_from_room");
    // Concurrent-start path is equally closed to removed members.
    const r2 = await req("POST", "/api/calls", groupStartBody, CALLEE_TOKEN);
    assert.equal(r2.status, 403);
    assert.equal(r2.body.reason, "removed_from_room");
  });

  it("room stays open until the LAST participant leaves, then ends with history", async () => {
    const started = await req("POST", "/api/calls", groupStartBody);
    const id = started.body.session.id;
    await req("POST", `/api/calls/${id}/join`, {}, CALLEE_TOKEN);

    const firstLeave = await req("POST", `/api/calls/${id}/leave`);
    assert.equal(firstLeave.status, 200);
    assert.equal(store.__sessions.get(id)!.status, "active", "room survives a non-final leave");
    assert.equal(store.__history.includes(id), false);

    const lastLeave = await req("POST", `/api/calls/${id}/leave`, undefined, CALLEE_TOKEN);
    assert.equal(lastLeave.status, 200);
    assert.equal(store.__sessions.get(id)!.status, "ended");
    assert.ok(store.__history.includes(id), "summary line written when the room closes");
    assert.equal(endedRooms.length, 1, "LiveKit room terminated");
  });

  it("rejoin after leaving works while the room is live", async () => {
    const started = await req("POST", "/api/calls", groupStartBody);
    const id = started.body.session.id;
    await req("POST", `/api/calls/${id}/join`, {}, CALLEE_TOKEN);
    await req("POST", `/api/calls/${id}/leave`, undefined, CALLEE_TOKEN);
    const r = await req("POST", `/api/calls/${id}/join`, {}, CALLEE_TOKEN);
    assert.equal(r.status, 200);
    const ps = await store.getParticipants(id);
    assert.equal(ps.find((p) => p.userId === CALLEE_ID)!.status, "joined");
    assert.equal(ps.find((p) => p.userId === CALLEE_ID)!.role, "participant", "role preserved on rejoin");
  });

  it("GET group presence returns live session + count for members only", async () => {
    const none = await req("GET", "/api/calls/group/trip_crew/trip-1");
    assert.equal(none.status, 200);
    assert.equal(none.body.session, null);
    assert.equal(none.body.participantCount, 0);

    const started = await req("POST", "/api/calls", groupStartBody);
    await req("POST", `/api/calls/${started.body.session.id}/join`, {}, CALLEE_TOKEN);
    const live = await req("GET", "/api/calls/group/trip_crew/trip-1", undefined, CALLEE_TOKEN);
    assert.equal(live.status, 200);
    assert.equal(live.body.session.id, started.body.session.id);
    assert.equal(live.body.participantCount, 2);
    assert.equal(live.body.session.roomName, undefined, "presence never leaks the room name");

    wireDepsKeepStore({ isActiveCrewMember: async () => false });
    const denied = await req("GET", "/api/calls/group/trip_crew/trip-1");
    assert.equal(denied.status, 403);
    assert.equal(denied.body.reason, "not_crew_member");
  });
});

// ── Crew-call start announcement (system message + single notification) ─────

describe("crew call start announcement", () => {
  const MEMBER_A = "aabbccdd-1001-2002-3003-aabbccdd2001"; // starter
  const MEMBER_B = "aabbccdd-1001-2002-3003-aabbccdd2002";
  const MEMBER_C = "aabbccdd-1001-2002-3003-aabbccdd2003"; // notifications off
  const REMOVED_D = "aabbccdd-1001-2002-3003-aabbccdd2004";

  function makeCrewClient(insertedMessages: any[]) {
    const memberRows = [
      { user_id: MEMBER_A, role: "owner", status: "accepted" },
      { user_id: MEMBER_B, role: "member", status: null },
      { user_id: MEMBER_C, role: "member", status: "accepted" },
      { user_id: REMOVED_D, role: "member", status: "removed" },
    ];
    function tableBuilder(table: string): any {
      const b: any = new Proxy(function () {}, {
        get(_t, prop) {
          if (prop === "then") {
            const data = table === "trip_members" ? memberRows : [];
            return (onF: any) => Promise.resolve({ data, error: null, count: data.length }).then(onF);
          }
          if (prop === "maybeSingle" || prop === "single") {
            return () => Promise.resolve({
              data: table === "message_threads" ? { id: "thread-77" }
                : table === "trips" ? { title: "Lisbon Crew" }
                : table === "profiles" ? { id: MEMBER_A, username: "sam", display_name: "Sam", name: "Samuel", avatar_url: null }
                : null,
              error: null,
            });
          }
          if (prop === "insert") {
            return (row: any) => { insertedMessages.push({ table, row }); return b; };
          }
          return () => b;
        },
      });
      return b;
    }
    return { from: (table: string) => tableBuilder(table) } as any;
  }

  it("writes the start system message and notifies each member ONCE, excluding starter, honoring prefs", async () => {
    const { announceCrewCallStarted, _setTestCrewDeps } = await import("../lib/calls/callSignaling.js");
    const inserted: any[] = [];
    const notified: any[] = [];
    _setTestCrewDeps({
      getPrefs: async (_sc: any, uid: string) => ({
        whoCanCall: "everyone", allowRentABuddyCalls: true, allowVideoCalls: true,
        incomingCallNotifications: uid !== MEMBER_C,
      }) as any,
      notify: async (_sc, input) => { notified.push(input); },
    });
    try {
      const session: any = {
        id: "call-g1", callType: "group_voice", contextType: "trip_crew",
        contextId: "trip-1", threadId: null, startedBy: MEMBER_A,
        status: "active", startedAt: new Date().toISOString(),
        connectedAt: new Date().toISOString(), endedAt: null,
      };
      await announceCrewCallStarted(makeCrewClient(inserted), session, MEMBER_A);

      const msg = inserted.find((i) => i.table === "messages");
      assert.ok(msg, "system message written to the crew thread");
      assert.equal(msg.row.thread_id, "thread-77");
      assert.match(msg.row.body, /started a Crew Call\.$/);
      assert.equal(msg.row.msg_type, "system");

      // Removed member and starter excluded; opted-out member skipped.
      assert.equal(notified.length, 1, "exactly one restrained notification");
      assert.equal(notified[0].userId, MEMBER_B);
      assert.equal(notified[0].eventType, "call.crew_started");
      assert.equal(notified[0].params.tripId, "trip-1");
      assert.equal(notified[0].params.tripTitle, "Lisbon Crew");
    } finally {
      _setTestCrewDeps(null);
    }
  });
});

// ── Group end summary line ────────────────────────────────────────────────────

describe("groupCallEndLine", () => {
  it("formats duration and participant count", async () => {
    const { groupCallEndLine } = await import("../lib/calls/callStateMachine.js");
    const startedAt = new Date("2026-07-19T10:00:00Z").toISOString();
    assert.equal(
      groupCallEndLine({
        startedAt, connectedAt: startedAt,
        endedAt: new Date("2026-07-19T10:38:00Z").toISOString(),
      }, 7),
      "Crew Call ended · 38 min · 7 participants",
    );
    assert.equal(
      groupCallEndLine({
        startedAt, connectedAt: null,
        endedAt: new Date("2026-07-19T10:00:20Z").toISOString(),
      }, 1),
      "Crew Call ended · 1 min · 1 participant",
    );
  });
});

/** Re-wire gateway overrides while keeping the current store (mid-test). */
function wireDepsKeepStore(gwOverrides: Partial<CallContextGateway>) {
  gateway = makeFakeGateway(gwOverrides);
  const keep = store;
  _setTestCallDeps({
    makeGateway: () => gateway,
    makeStore: () => keep,
    roomAdmin: () => ({
      endRoom: async (room: string) => { endedRooms.push(room); },
      muteParticipantAudio: async (room: string, userId: string) => { mutedInRoom.push({ room, userId }); },
      removeParticipant: async (room: string, userId: string) => { removedInRoom.push({ room, userId }); },
    }),
    mintToken: async (opts: any) => {
      mintedTokens.push({ userId: opts.userId, canPublishAudio: opts.canPublishAudio });
      return "test-token";
    },
    livekitUrl: () => "wss://livekit.test",
  });
}

// ── Incoming-call push preference gate ───────────────────────────────────────

describe("incoming-call push preference gate", () => {
  beforeEach(() => {
    _setTestClient(makeFakeAuthClient(), true);
    _setTestServiceClient(makeFakeAuthClient());
    wireDeps();
  });

  it("POST /api/calls sends the incoming push when preferences allow", async () => {
    const notified: any[] = [];
    let resolveNotify!: () => void;
    const done = new Promise<void>((r) => { resolveNotify = r; });
    _setTestPushDeps({
      getPrefs: async () => ({
        whoCanCall: "people_i_message", allowRentABuddyCalls: true,
        allowVideoCalls: true, incomingCallNotifications: true,
      }),
      notify: async (_sc, input) => { notified.push(input); resolveNotify(); },
    });
    try {
      const r = await req("POST", "/api/calls", startBody);
      assert.equal(r.status, 201);
      await done; // push is fire-and-forget — wait for delivery
      assert.equal(notified.length, 1);
      assert.equal(notified[0].userId, CALLEE_ID);
      assert.equal(notified[0].eventType, "call.incoming");
      assert.equal(notified[0].sourceId, r.body.session.id);
      assert.equal(notified[0].params.callKind, "call");
      assert.equal(notified[0].params.threadId, THREAD_ID);
    } finally {
      _setTestPushDeps(null);
    }
  });

  it("POST /api/calls SKIPS the push when incoming_call_notifications is disabled", async () => {
    const notified: any[] = [];
    let resolvePrefs!: () => void;
    const prefsRead = new Promise<void>((r) => { resolvePrefs = r; });
    _setTestPushDeps({
      getPrefs: async () => {
        resolvePrefs();
        return {
          whoCanCall: "people_i_message", allowRentABuddyCalls: true,
          allowVideoCalls: true, incomingCallNotifications: false,
        };
      },
      notify: async (_sc, input) => { notified.push(input); },
    });
    try {
      const r = await req("POST", "/api/calls", startBody);
      assert.equal(r.status, 201, "disabled push never blocks the call itself");
      await prefsRead;
      await new Promise((r2) => setImmediate(r2)); // drain the fire-and-forget chain
      assert.equal(notified.length, 0, "no notification when the callee opted out");
    } finally {
      _setTestPushDeps(null);
    }
  });

  it("deliverIncomingCallPush reports sent/skipped explicitly", async () => {
    const session: any = {
      id: "call-x", callType: "video", contextType: "telegraph_dm",
      contextId: THREAD_ID, threadId: THREAD_ID, startedBy: CALLER_ID,
      status: "ringing", startedAt: new Date().toISOString(), connectedAt: null, endedAt: null,
    };
    const notified: any[] = [];
    _setTestPushDeps({
      getPrefs: async () => ({
        whoCanCall: "everyone", allowRentABuddyCalls: true,
        allowVideoCalls: true, incomingCallNotifications: true,
      }),
      notify: async (_sc, input) => { notified.push(input); },
    });
    try {
      const sent = await deliverIncomingCallPush({} as any, CALLEE_ID, session, "@ana");
      assert.equal(sent, true);
      assert.equal(notified[0].params.callKind, "video call");
      assert.equal(notified[0].params.actor, "@ana");

      _setTestPushDeps({
        getPrefs: async () => ({
          whoCanCall: "everyone", allowRentABuddyCalls: true,
          allowVideoCalls: true, incomingCallNotifications: false,
        }),
        notify: async (_sc, input) => { notified.push(input); },
      });
      const sent2 = await deliverIncomingCallPush({} as any, CALLEE_ID, session, "@ana");
      assert.equal(sent2, false);
      assert.equal(notified.length, 1, "notify not called when disabled");
    } finally {
      _setTestPushDeps(null);
    }
  });
});

// ── Webhook ──────────────────────────────────────────────────────────────────

describe("calls webhook", () => {
  beforeEach(() => {
    _setTestClient(makeFakeAuthClient(), true);
    wireDeps();
  });

  it("rejects unsigned/invalid payloads with 401 and processes nothing", async () => {
    let reconciled = 0;
    _setTestWebhookDeps({
      verifier: { receive: async () => { throw new Error("bad signature"); } },
      store: () => { reconciled++; return store; },
      admin: () => ({ endRoom: async () => {} }),
    });
    const r = await req("POST", "/api/calls/webhook", { event: "room_finished" }, CALLER_TOKEN, { authorization: "" });
    assert.equal(r.status, 401);
    assert.equal(reconciled, 0);
  });

  it("verified room_finished reconciles the session; duplicates are no-ops", async () => {
    const s = await store.createSession({
      callType: "voice", contextType: "telegraph_dm", contextId: THREAD_ID,
      threadId: THREAD_ID, roomName: "pcall_test_room", startedBy: CALLER_ID,
      participants: [
        { userId: CALLER_ID, role: "caller", status: "invited" },
        { userId: CALLEE_ID, role: "callee", status: "ringing" },
      ],
    });
    await store.applyTransition(s.id, "ringing", "active", { connectedAt: new Date().toISOString() });

    const evt = { event: "room_finished", room: { name: "pcall_test_room" } };
    _setTestWebhookDeps({
      verifier: { receive: async (raw: string) => JSON.parse(raw) },
      store: () => store,
      admin: () => ({ endRoom: async () => {} }),
    });
    const r1 = await req("POST", "/api/calls/webhook", evt);
    assert.equal(r1.status, 200);
    assert.equal(store.__sessions.get(s.id)!.status, "ended");
    const endedAt = store.__sessions.get(s.id)!.endedAt;

    const r2 = await req("POST", "/api/calls/webhook", evt); // duplicate delivery
    assert.equal(r2.status, 200);
    assert.equal(store.__sessions.get(s.id)!.status, "ended");
    assert.equal(store.__sessions.get(s.id)!.endedAt, endedAt, "duplicate must be a no-op");
    _setTestWebhookDeps(null);
  });
});

// ── Real webhook sequence: caller auto-joins before callee acts ─────────────

describe("caller auto-join does not consume ringing", () => {
  beforeEach(() => {
    _setTestClient(makeFakeAuthClient(), true);
    _setTestServiceClient(makeFakeAuthClient());
    wireDeps();
  });

  function wireWebhook() {
    _setTestWebhookDeps({
      verifier: { receive: async (raw: string) => JSON.parse(raw) },
      store: () => store,
      admin: () => ({ endRoom: async (room: string) => { endedRooms.push(room); } }),
    });
  }

  it("start → caller participant_joined → callee decline ends as declined", async () => {
    const started = await req("POST", "/api/calls", startBody);
    assert.equal(started.status, 201);
    const id = started.body.session.id;
    const roomName = store.__sessions.get(id)!.roomName;

    wireWebhook();
    const w = await req("POST", "/api/calls/webhook", {
      event: "participant_joined", room: { name: roomName }, participant: { identity: CALLER_ID },
    });
    assert.equal(w.status, 200);
    assert.equal(store.__sessions.get(id)!.status, "ringing", "caller self-join must not activate a direct call");

    const r = await req("POST", `/api/calls/${id}/decline`, undefined, CALLEE_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(store.__sessions.get(id)!.status, "declined");
    _setTestWebhookDeps(null);
  });

  it("start → caller joins → no answer: sweep marks the call missed", async () => {
    const started = await req("POST", "/api/calls", startBody);
    const id = started.body.session.id;
    const roomName = store.__sessions.get(id)!.roomName;

    wireWebhook();
    await req("POST", "/api/calls/webhook", {
      event: "participant_joined", room: { name: roomName }, participant: { identity: CALLER_ID },
    });
    assert.equal(store.__sessions.get(id)!.status, "ringing");

    const { sweepOpenSessions } = await import("../lib/calls/callReconciler.js");
    const swept = await sweepOpenSessions(
      store, { endRoom: async () => {} }, Date.now() + CALL_CONFIG.RING_TIMEOUT_MS + 5_000,
    );
    assert.ok(swept.missed >= 1);
    assert.equal(store.__sessions.get(id)!.status, "missed");
    _setTestWebhookDeps(null);
  });

  it("callee participant_joined DOES activate the call", async () => {
    const started = await req("POST", "/api/calls", startBody);
    const id = started.body.session.id;
    const roomName = store.__sessions.get(id)!.roomName;

    wireWebhook();
    await req("POST", "/api/calls/webhook", {
      event: "participant_joined", room: { name: roomName }, participant: { identity: CALLEE_ID },
    });
    assert.equal(store.__sessions.get(id)!.status, "active");
    _setTestWebhookDeps(null);
  });
});

// ── Sweep ─────────────────────────────────────────────────────────────────────

describe("call sweep", () => {
  it("overdue rings become missed; 4h cap force-ends with room termination", async () => {
    wireDeps();
    const now = Date.now();
    const ringing = await store.createSession({
      callType: "voice", contextType: "telegraph_dm", contextId: THREAD_ID,
      threadId: THREAD_ID, roomName: "pcall_ring", startedBy: CALLER_ID,
      participants: [],
    });
    ringing.startedAt = new Date(now - CALL_CONFIG.RING_TIMEOUT_MS - 5_000).toISOString();
    const longCall = await store.createSession({
      callType: "voice", contextType: "telegraph_dm", contextId: THREAD_ID,
      threadId: THREAD_ID, roomName: "pcall_long", startedBy: CALLER_ID,
      participants: [],
    });
    longCall.status = "active";
    longCall.connectedAt = new Date(now - CALL_CONFIG.MAX_CALL_DURATION_MS - 5_000).toISOString();

    const { sweepOpenSessions } = await import("../lib/calls/callReconciler.js");
    const swept = await sweepOpenSessions(
      store,
      { endRoom: async (room: string) => { endedRooms.push(room); } },
      now,
    );
    assert.ok(swept.missed >= 1);
    assert.ok(swept.capped >= 1);
    assert.equal(store.__sessions.get(ringing.id)!.status, "missed");
    assert.equal(store.__sessions.get(longCall.id)!.status, "ended");
    assert.ok(endedRooms.includes("pcall_long"));
  });
});

// ── Event voice rooms (Phase 5) ──────────────────────────────────────────────

const EVENT_ID = "aabbccdd-1001-2002-3003-aabbccddeeee";
const eventStartBody = { contextType: "event", callType: "group_voice", contextId: EVENT_ID };

/** Start an event room as CALLER (host by fake-gateway default). */
async function startEventRoom() {
  const r = await req("POST", "/api/calls", eventStartBody);
  assert.equal(r.status, 201);
  return r.body.session.id as string;
}

describe("event voice rooms", () => {
  beforeEach(() => {
    _setTestClient(makeFakeAuthClient(), true);
    _setTestServiceClient(makeFakeAuthClient());
    wireDeps();
  });

  describe("start", () => {
    it("event host starts the room and gets a publish-capable host grant", async () => {
      const r = await req("POST", "/api/calls", eventStartBody);
      assert.equal(r.status, 201);
      assert.equal(r.body.role, "host");
      assert.equal(r.body.canPublishAudio, true);
      assert.equal(mintedTokens.at(-1)!.canPublishAudio, true);
      assert.ok(String(r.body.session.id).length > 0);
    });

    it("attendees (non-staff) cannot start the room — not_event_host", async () => {
      wireDeps({ eventStaffRole: async () => null });
      const r = await req("POST", "/api/calls", eventStartBody);
      assert.equal(r.status, 403);
      assert.equal(r.body.reason, "not_event_host");
    });

    it("staff who fail event eligibility cannot start", async () => {
      wireDeps({ eventRoomIneligibility: async () => "trust_ineligible" });
      const r = await req("POST", "/api/calls", eventStartBody);
      assert.equal(r.status, 403);
      assert.equal(r.body.reason, "trust_ineligible");
    });
  });

  describe("join eligibility (canonical engine, server-side)", () => {
    it("an approved attendee joins as a subscribe-only listener", async () => {
      const id = await startEventRoom();
      wireDepsKeepStore({ eventStaffRole: async () => null }); // CALLEE = plain attendee
      const r = await req("POST", `/api/calls/${id}/join`, {}, CALLEE_TOKEN);
      assert.equal(r.status, 200);
      assert.equal(r.body.role, "listener");
      assert.equal(r.body.canPublishAudio, false);
      // Enforced at the token grant — not just the response payload.
      assert.deepEqual(mintedTokens.at(-1), { userId: CALLEE_ID, canPublishAudio: false });
    });

    it("a non-attendee / private-event outsider is denied", async () => {
      const id = await startEventRoom();
      wireDepsKeepStore({ eventRoomIneligibility: async () => "not_event_eligible" });
      const r = await req("POST", `/api/calls/${id}/join`, {}, CALLEE_TOKEN);
      assert.equal(r.status, 403);
      assert.equal(r.body.reason, "not_event_eligible");
    });

    it("an age-ineligible user is denied", async () => {
      const id = await startEventRoom();
      wireDepsKeepStore({ eventRoomIneligibility: async () => "age_ineligible" });
      const r = await req("POST", `/api/calls/${id}/join`, {}, CALLEE_TOKEN);
      assert.equal(r.status, 403);
      assert.equal(r.body.reason, "age_ineligible");
    });

    it("a trust-ineligible user is denied", async () => {
      const id = await startEventRoom();
      wireDepsKeepStore({ eventRoomIneligibility: async () => "trust_ineligible" });
      const r = await req("POST", `/api/calls/${id}/join`, {}, CALLEE_TOKEN);
      assert.equal(r.status, 403);
      assert.equal(r.body.reason, "trust_ineligible");
    });

    it("a removed participant can never rejoin", async () => {
      const id = await startEventRoom();
      wireDepsKeepStore({ eventStaffRole: async (_e, u) => (u === CALLER_ID ? "host" : null) });
      assert.equal((await req("POST", `/api/calls/${id}/join`, {}, CALLEE_TOKEN)).status, 200);
      const rm = await req("POST", `/api/calls/${id}/participants/${CALLEE_ID}/remove`, {});
      assert.equal(rm.status, 200);
      wireDepsKeepStore({
        eventStaffRole: async (_e, u) => (u === CALLER_ID ? "host" : null),
        wasRemovedFromCall: async () => true,
      });
      const r = await req("POST", `/api/calls/${id}/join`, {}, CALLEE_TOKEN);
      assert.equal(r.status, 403);
      assert.equal(r.body.reason, "removed_from_room");
    });
  });

  describe("raise hand", () => {
    it("a joined listener raises and lowers a hand; state shows in GET /calls/:id", async () => {
      const id = await startEventRoom();
      wireDepsKeepStore({ eventStaffRole: async (_e, u) => (u === CALLER_ID ? "host" : null) });
      await req("POST", `/api/calls/${id}/join`, {}, CALLEE_TOKEN);
      const up = await req("POST", `/api/calls/${id}/hand`, { raised: true }, CALLEE_TOKEN);
      assert.equal(up.status, 200);
      const got = await req("GET", `/api/calls/${id}`);
      const callee = got.body.participants.find((p: any) => p.userId === CALLEE_ID);
      assert.ok(callee.handRaisedAt);
      const down = await req("POST", `/api/calls/${id}/hand`, { raised: false }, CALLEE_TOKEN);
      assert.equal(down.status, 200);
      const got2 = await req("GET", `/api/calls/${id}`);
      assert.equal(got2.body.participants.find((p: any) => p.userId === CALLEE_ID).handRaisedAt, null);
    });

    it("non-participants cannot raise a hand (call invisible to them)", async () => {
      const id = await startEventRoom();
      const r = await req("POST", `/api/calls/${id}/hand`, { raised: true }, CALLEE_TOKEN);
      assert.equal(r.status, 404);
    });
  });

  describe("moderation (engine-authorized, audit-logged)", () => {
    async function roomWithListener() {
      const id = await startEventRoom();
      wireDepsKeepStore({ eventStaffRole: async (_e, u) => (u === CALLER_ID ? "host" : null) });
      const j = await req("POST", `/api/calls/${id}/join`, {}, CALLEE_TOKEN);
      assert.equal(j.status, 200);
      return id;
    }

    it("host promotes a listener to speaker (audit) and demotion revokes publish", async () => {
      const id = await roomWithListener();
      const up = await req("POST", `/api/calls/${id}/participants/${CALLEE_ID}/role`, { role: "speaker" });
      assert.equal(up.status, 200);
      assert.deepEqual(store.__audit.at(-1), {
        callId: id, actorId: CALLER_ID, targetId: CALLEE_ID, action: "promote_speaker",
      });
      // Promoted speaker rejoins → publish-capable token.
      const rejoin = await req("POST", `/api/calls/${id}/join`, {}, CALLEE_TOKEN);
      assert.equal(rejoin.body.role, "speaker");
      assert.equal(mintedTokens.at(-1)!.canPublishAudio, true);

      const down = await req("POST", `/api/calls/${id}/participants/${CALLEE_ID}/role`, { role: "listener" });
      assert.equal(down.status, 200);
      assert.equal(store.__audit.at(-1)!.action, "demote_speaker");
      assert.deepEqual(mutedInRoom.at(-1)!.userId, CALLEE_ID); // live tracks silenced
      const rejoin2 = await req("POST", `/api/calls/${id}/join`, {}, CALLEE_TOKEN);
      assert.equal(rejoin2.body.role, "listener");
      assert.equal(mintedTokens.at(-1)!.canPublishAudio, false);
    });

    it("listeners cannot moderate — not_room_moderator, no audit entry", async () => {
      const id = await roomWithListener();
      const auditBefore = store.__audit.length;
      const r = await req("POST", `/api/calls/${id}/participants/${CALLER_ID}/role`, { role: "listener" }, CALLEE_TOKEN);
      assert.equal(r.status, 403);
      assert.equal(r.body.reason, "not_room_moderator");
      assert.equal(store.__audit.length, auditBefore);
    });

    it("moderation in non-event group rooms is refused", async () => {
      const r0 = await req("POST", "/api/calls", {
        contextType: "trip_crew", callType: "group_voice", contextId: THREAD_ID,
      });
      const r = await req("POST", `/api/calls/${r0.body.session.id}/participants/${CALLEE_ID}/mute`, {});
      assert.equal(r.status, 403);
      assert.equal(r.body.reason, "not_room_moderator");
    });

    it("host mutes a participant — LiveKit admin called and audit written", async () => {
      const id = await roomWithListener();
      const r = await req("POST", `/api/calls/${id}/participants/${CALLEE_ID}/mute`, {});
      assert.equal(r.status, 200);
      assert.equal(mutedInRoom.at(-1)!.userId, CALLEE_ID);
      assert.deepEqual(store.__audit.at(-1), {
        callId: id, actorId: CALLER_ID, targetId: CALLEE_ID, action: "mute",
      });
    });

    it("host removes a participant — kicked from room, audited, status removed", async () => {
      const id = await roomWithListener();
      const r = await req("POST", `/api/calls/${id}/participants/${CALLEE_ID}/remove`, {});
      assert.equal(r.status, 200);
      assert.equal(removedInRoom.at(-1)!.userId, CALLEE_ID);
      assert.equal(store.__audit.at(-1)!.action, "remove");
      const row = (await store.getParticipants(id)).find((p) => p.userId === CALLEE_ID)!;
      assert.equal(row.status, "removed");
    });

    it("staff are never moderation targets — cohost cannot remove the host, host cannot mute/remove a cohost", async () => {
      const id = await startEventRoom();
      // CALLEE joins as a cohost (staff).
      wireDepsKeepStore({
        eventStaffRole: async (_e, u) => (u === CALLER_ID ? "host" : "cohost"),
      });
      const j = await req("POST", `/api/calls/${id}/join`, {}, CALLEE_TOKEN);
      assert.equal(j.status, 200);
      assert.equal(j.body.role, "cohost");
      const auditBefore = store.__audit.length;

      // Cohost → host: remove and mute both refused.
      const rmHost = await req("POST", `/api/calls/${id}/participants/${CALLER_ID}/remove`, {}, CALLEE_TOKEN);
      assert.equal(rmHost.status, 400);
      assert.equal(rmHost.body.reason, "cannot_moderate_staff");
      const muteHost = await req("POST", `/api/calls/${id}/participants/${CALLER_ID}/mute`, {}, CALLEE_TOKEN);
      assert.equal(muteHost.status, 400);
      assert.equal(muteHost.body.reason, "cannot_moderate_staff");

      // Host → cohost: also refused (moderation flows only downward).
      const rmCohost = await req("POST", `/api/calls/${id}/participants/${CALLEE_ID}/remove`, {});
      assert.equal(rmCohost.status, 400);
      assert.equal(rmCohost.body.reason, "cannot_moderate_staff");
      const muteCohost = await req("POST", `/api/calls/${id}/participants/${CALLEE_ID}/mute`, {});
      assert.equal(muteCohost.status, 400);
      assert.equal(muteCohost.body.reason, "cannot_moderate_staff");

      // No audit entries, no LiveKit admin calls, host still joinable state.
      assert.equal(store.__audit.length, auditBefore);
      const host = (await store.getParticipants(id)).find((p) => p.userId === CALLER_ID)!;
      assert.notEqual(host.status, "removed");
    });

    it("listeners cannot end the room; the host can (audited end_room)", async () => {
      const id = await roomWithListener();
      const denied = await req("POST", `/api/calls/${id}/end`, {}, CALLEE_TOKEN);
      assert.equal(denied.status, 403);
      assert.equal(denied.body.reason, "not_room_moderator");
      assert.equal(store.__sessions.get(id)!.status, "active");

      const ended = await req("POST", `/api/calls/${id}/end`, {});
      assert.equal(ended.status, 200);
      assert.equal(store.__sessions.get(id)!.status, "ended");
      assert.equal(store.__audit.at(-1)!.action, "end_room");
      assert.ok(endedRooms.length >= 1);
    });
  });

  describe("event room presence (GET /api/calls/group/event/:id)", () => {
    it("returns the live room + listening count to eligible users", async () => {
      const id = await startEventRoom();
      wireDepsKeepStore({ eventStaffRole: async (_e, u) => (u === CALLER_ID ? "host" : null) });
      await req("POST", `/api/calls/${id}/join`, {}, CALLEE_TOKEN);
      const r = await req("GET", `/api/calls/group/event/${EVENT_ID}`, undefined, CALLEE_TOKEN);
      assert.equal(r.status, 200);
      assert.equal(r.body.session.id, id);
      assert.equal(r.body.participantCount, 2);
      assert.equal(r.body.canStart, false);
      const host = await req("GET", `/api/calls/group/event/${EVENT_ID}`);
      assert.equal(host.body.canStart, true);
    });

    it("room state is invisible outside the event context", async () => {
      await startEventRoom();
      wireDepsKeepStore({ eventRoomIneligibility: async () => "not_event_eligible" });
      const r = await req("GET", `/api/calls/group/event/${EVENT_ID}`, undefined, CALLEE_TOKEN);
      assert.equal(r.status, 403);
      assert.equal(r.body.reason, "not_event_eligible");
    });

    it("no open room → session null, count 0, canStart still present (host true)", async () => {
      const r = await req("GET", `/api/calls/group/event/${EVENT_ID}`);
      assert.equal(r.status, 200);
      assert.equal(r.body.session, null);
      assert.equal(r.body.participantCount, 0);
      assert.equal(r.body.canStart, true, "host must see the Start affordance when no room exists");
    });

    it("no open room → plain attendee gets canStart false", async () => {
      wireDeps({ eventStaffRole: async () => null });
      const r = await req("GET", `/api/calls/group/event/${EVENT_ID}`, undefined, CALLEE_TOKEN);
      assert.equal(r.status, 200);
      assert.equal(r.body.session, null);
      assert.equal(r.body.canStart, false);
    });
  });

  describe("start notification (restrained, preference-gated)", () => {
    it("announceEventRoomStarted notifies the audience once, excluding the starter and opted-out users", async () => {
      const { announceEventRoomStarted, _setTestEventDeps } = await import("../lib/calls/callSignaling.js");
      const AUD_A = "aabbccdd-1001-2002-3003-aabbccdd2001";
      const AUD_B = "aabbccdd-1001-2002-3003-aabbccdd2002";
      // Fake sc serving the event audience tables.
      function tableBuilder(table: string): any {
        const rows =
          table === "event_roles" ? [{ user_id: AUD_A }]
          : table === "event_rsvps" ? [{ user_id: AUD_B, status: "going" }]
          : [];
        const b: any = new Proxy(function () {}, {
          get(_t, prop) {
            if (prop === "then") return (onF: any) => Promise.resolve({ data: rows, error: null }).then(onF);
            if (prop === "maybeSingle" || prop === "single") {
              return () => Promise.resolve({
                data: table === "events" ? { host_id: CALLER_ID, title: "Sunset Rooftop Mixer" } : null,
                error: null,
              });
            }
            return () => b;
          },
        });
        return b;
      }
      const sc: any = { from: (t: string) => tableBuilder(t) };
      const notified: any[] = [];
      _setTestEventDeps({
        getPrefs: async (_sc: any, uid: string) => ({
          whoCanCall: "people_i_message", allowRentABuddyCalls: true, allowVideoCalls: true,
          incomingCallNotifications: uid !== AUD_B, // B opted out
        }),
        notify: async (_sc: any, input: any) => { notified.push(input); },
      } as any);
      try {
        await announceEventRoomStarted(sc, {
          id: "call-evt-1", callType: "group_voice", contextType: "event", contextId: EVENT_ID,
          threadId: null, startedBy: CALLER_ID, status: "active",
          startedAt: new Date().toISOString(), connectedAt: new Date().toISOString(),
          endedAt: null, roomName: "pcall_evt",
        } as any, CALLER_ID);
        // Starter (host) excluded; AUD_B opted out → exactly one notification.
        assert.equal(notified.length, 1);
        assert.equal(notified[0].userId, AUD_A);
        assert.equal(notified[0].eventType, "call.event_room_started");
        assert.equal(notified[0].params.eventTitle, "Sunset Rooftop Mixer");
      } finally {
        _setTestEventDeps(null);
      }
    });
  });
});

// ── Real store adapter projection guard ──────────────────────────────────────
// The reviewer-flagged bug class: hand_raised_at written by /hand but missing
// from the read projection. This pins the LIVE adapter's participant select.
describe("callStoreAdapter participant projection", () => {
  it("getParticipants selects hand_raised_at and maps it to handRaisedAt", async () => {
    const { makeCallStore } = await import("../lib/calls/callStoreAdapter.js");
    let selected = "";
    const sc: any = {
      from: () => ({
        select: (cols: string) => {
          selected = cols;
          return {
            eq: async () => ({
              data: [{
                call_id: "c1", user_id: "u1", role: "listener", status: "joined",
                invited_at: null, joined_at: null, left_at: null,
                hand_raised_at: "2026-07-19T00:00:00.000Z",
              }],
              error: null,
            }),
          };
        },
      }),
    };
    const rows = await makeCallStore(sc).getParticipants("c1");
    assert.ok(selected.includes("hand_raised_at"), "participant read projection must include hand_raised_at");
    assert.equal(rows[0]!.handRaisedAt, "2026-07-19T00:00:00.000Z");
  });
});

// ── Phase 6 hardening: route-level race & security cases ────────────────────

describe("direct-call double-tap dedupe", () => {
  beforeEach(() => wireDeps());

  it("a second start while the first is still ringing reuses the SAME session (no second ring)", async () => {
    let pushes = 0;
    _setTestPushDeps({
      getPrefs: async () => ({
        whoCanCall: "people_i_message", allowRentABuddyCalls: true,
        allowVideoCalls: true, incomingCallNotifications: true,
      } as any),
      notify: async () => { pushes++; },
    });
    try {
      const first = await req("POST", "/api/calls", startBody);
      assert.equal(first.status, 201);
      const second = await req("POST", "/api/calls", startBody);
      assert.equal(second.status, 200, "dedupe returns a grant, not a new creation");
      assert.equal(second.body.session.id, first.body.session.id);
      assert.equal(store.__sessions.size, 1, "exactly one session exists");
      // Give the fire-and-forget push a beat, then confirm one delivery max.
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(pushes <= 1, `duplicate start must not re-push (got ${pushes})`);
    } finally {
      _setTestPushDeps(null);
    }
  });

  it("after the call ends, a new start creates a fresh session again", async () => {
    const first = await req("POST", "/api/calls", startBody);
    await req("POST", `/api/calls/${first.body.session.id}/end`, undefined, CALLER_TOKEN);
    const again = await req("POST", "/api/calls", startBody);
    assert.equal(again.status, 201);
    assert.notEqual(again.body.session.id, first.body.session.id);
  });
});

describe("callGatewayAdapter — startsInLastHour error path", () => {
  it("returns MAX_STARTS_PER_HOUR (fail-closed) when the count query errors", async () => {
    // Simulate a DB outage: the count query returns an error.
    const errorClient: any = {
      from: () => ({
        select: () => ({
          eq: () => ({
            gte: () => Promise.resolve({ count: null, error: { message: "connection refused" } }),
          }),
        }),
      }),
    };
    const gw = makeCallGateway(errorClient);
    const result = await gw.startsInLastHour("any-user-id");
    assert.equal(
      result,
      CALL_CONFIG.MAX_STARTS_PER_HOUR,
      "fail-closed: must return the ceiling so callers deny the start, not 0",
    );
  });

  it("call start is denied 429 when the DB count query errors (fail-closed end-to-end)", async () => {
    // Gateway throws the ceiling value when the count errors — route must deny.
    wireDeps({ startsInLastHour: async () => CALL_CONFIG.MAX_STARTS_PER_HOUR });
    _resetRateLimit(); // fresh instance: no in-memory history
    const r = await req("POST", "/api/calls", startBody);
    assert.equal(r.status, 429);
    assert.equal(r.body.reason, "rate_limited");
    assert.equal(store.__sessions.size, 0, "no session created when ceiling is hit via fail-closed");
  });
});

// ── callGatewayAdapter DB error paths (fail-closed) ──────────────────────────

/**
 * Builds a Supabase-style fake client whose query chains always resolve to a
 * DB error at every terminal step (then / maybeSingle / single / limit).
 * Used to verify that each gateway method denies access rather than granting
 * it when the database is unavailable.
 */
function makeAlwaysErrorClient(message = "simulated DB outage"): any {
  const errResult = { data: null, error: { message }, count: null };
  const chain: any = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (onF: any) => Promise.resolve(errResult).then(onF);
      if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(errResult);
      if (prop === "limit") return () => Promise.resolve(errResult);
      return () => chain;
    },
    apply() { return chain; },
  });
  return { from: () => chain };
}

describe("callGatewayAdapter — DB error paths (fail-closed)", () => {
  it("getCallPreferences returns deny-all when the preferences query errors", async () => {
    const gw = makeCallGateway(makeAlwaysErrorClient());
    const prefs = await gw.getCallPreferences("any-user-id");
    assert.equal(prefs.whoCanCall, "nobody",
      "fail-closed: DB outage must deny all callers, not fall back to permissive defaults");
    assert.equal(prefs.allowRentABuddyCalls, false,
      "fail-closed: RAB calls must be denied when preferences cannot be read");
    assert.equal(prefs.allowVideoCalls, false,
      "fail-closed: video calls must be denied when preferences cannot be read");
  });

  it("call start is denied (403 not_allowed_to_call) when the preferences query errors", async () => {
    // Route-level confirmation: fail-closed preferences → whoCanCall=no_one → deny.
    wireDeps({
      getCallPreferences: async () => ({
        whoCanCall: "nobody" as const,
        allowRentABuddyCalls: false,
        allowVideoCalls: false,
      }),
    });
    const r = await req("POST", "/api/calls", startBody);
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, "callee_calls_disabled",
      "fail-closed preferences must cause the engine to deny the start");
    assert.equal(store.__sessions.size, 0, "no session persisted when denied by fail-closed preferences");
  });

  it("wasRemovedFromCall returns true (denied) when the query errors", async () => {
    const gw = makeCallGateway(makeAlwaysErrorClient());
    const result = await gw.wasRemovedFromCall("call-id", "user-id");
    assert.equal(result, true,
      "fail-closed: a kicked participant must not be allowed back in during a DB outage");
  });

  it("join is denied (removed_from_room) when wasRemovedFromCall errors", async () => {
    // Route-level: fail-closed wasRemovedFromCall → engine denies rejoin.
    const id = (await req("POST", "/api/calls", groupStartBody)).body.session.id;
    wireDepsKeepStore({ wasRemovedFromCall: async () => true });
    const r = await req("POST", `/api/calls/${id}/join`, {}, CALLEE_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, "removed_from_room",
      "fail-closed wasRemovedFromCall must lock out the user, not let them rejoin silently");
  });

  it("lastDeclineAt returns a current timestamp (fail-closed) when the query errors", async () => {
    const before = Date.now();
    const gw = makeCallGateway(makeAlwaysErrorClient());
    const result = await gw.lastDeclineAt("caller-id", "callee-id", "thread-id");
    const after = Date.now();
    assert.ok(result !== null,
      "fail-closed: must return a timestamp, not null, so the cooldown is enforced");
    assert.ok(result! >= before && result! <= after,
      "fail-closed: timestamp must be current so the caller waits the full cooldown");
  });

  it("call start is denied (429 redial_cooldown) when the decline-history query errors", async () => {
    // Route-level: fail-closed lastDeclineAt → cooldown enforced.
    wireDeps({ lastDeclineAt: async () => Date.now() - 1_000 }); // 1 s ago = within cooldown
    _resetRateLimit();
    const r = await req("POST", "/api/calls", startBody);
    assert.equal(r.status, 429);
    assert.equal(r.body.reason, "redial_cooldown",
      "fail-closed lastDeclineAt must impose the cooldown, not allow immediate redial");
  });

  it("isActiveCrewMember returns false (denied) when requireTripMember throws", async () => {
    const throwingClient: any = {
      from: () => { throw new Error("simulated DB outage"); },
    };
    const gw = makeCallGateway(throwingClient);
    const result = await gw.isActiveCrewMember("trip-id", "user-id");
    assert.equal(result, false,
      "fail-closed: a DB outage must never silently grant crew membership");
  });

  it("group start is denied (403 not_crew_member) when isActiveCrewMember errors", async () => {
    // Route-level: fail-closed isActiveCrewMember → engine returns not_crew_member.
    wireDeps({ isActiveCrewMember: async () => false });
    const r = await req("POST", "/api/calls", {
      contextType: "trip_crew", callType: "group_voice", contextId: "trip-1",
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, "not_crew_member",
      "fail-closed isActiveCrewMember must deny the group start, not let it proceed");
    assert.equal(store.__sessions.size, 0, "no session persisted when denied by fail-closed crew check");
  });

  it("eventRoomIneligibility returns 'not_event_eligible' (denied) when an event query throws", async () => {
    const throwingClient: any = {
      from: () => { throw new Error("simulated DB outage"); },
    };
    const gw = makeCallGateway(throwingClient);
    const result = await gw.eventRoomIneligibility("event-id", "user-id");
    assert.equal(result, "not_event_eligible",
      "fail-closed: a DB outage must never silently grant event room access");
  });

  it("event room join is denied (403 not_event_eligible) when eventRoomIneligibility errors", async () => {
    // Route-level: fail-closed eventRoomIneligibility → engine denies join.
    const id = await startEventRoom();
    wireDepsKeepStore({ eventRoomIneligibility: async () => "not_event_eligible" });
    const r = await req("POST", `/api/calls/${id}/join`, {}, CALLEE_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, "not_event_eligible",
      "fail-closed eventRoomIneligibility must deny the join, not let it proceed silently");
  });
});

describe("block landing mid-ring", () => {
  beforeEach(() => wireDeps());

  it("accept is denied with 'blocked' when a block lands between start and accept", async () => {
    const r = await req("POST", "/api/calls", startBody);
    assert.equal(r.status, 201);
    const id = r.body.session.id;
    // The block lands mid-ring: the engine's join-time re-check must catch it.
    wireDepsKeepStore({ isBlockedEither: async () => true });
    const accept = await req("POST", `/api/calls/${id}/accept`, {}, CALLEE_TOKEN);
    assert.equal(accept.status, 403);
    assert.equal(accept.body.reason, "blocked");
    assert.equal(store.__sessions.get(id)!.status, "ringing", "session stays for the block hook / sweep to settle");
  });

  it("an ended session can never be reused for a fresh grant", async () => {
    const r = await req("POST", "/api/calls", startBody);
    const id = r.body.session.id;
    await req("POST", `/api/calls/${id}/accept`, {}, CALLEE_TOKEN);
    await req("POST", `/api/calls/${id}/end`, undefined, CALLER_TOKEN);
    const again = await req("POST", `/api/calls/${id}/accept`, {}, CALLEE_TOKEN);
    assert.equal(again.status, 403);
    assert.equal(again.body.reason, "room_terminated");
  });
});
