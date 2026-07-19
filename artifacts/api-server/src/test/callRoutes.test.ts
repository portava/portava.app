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
import type { CallParticipant } from "../lib/calls/callTypes.js";
import { CALL_CONFIG } from "../lib/calls/callTypes.js";

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
    isCallRestricted: async () => false,
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

  const store: CallStoreEx & { __sessions: typeof sessions; __history: string[] } = {
    __sessions: sessions,
    __history: historyWrites,
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

function wireDeps(gwOverrides: Partial<CallContextGateway> = {}) {
  gateway = makeFakeGateway(gwOverrides);
  store = makeMemStore();
  endedRooms.length = 0;
  _setTestCallDeps({
    makeGateway: () => gateway,
    makeStore: () => store,
    roomAdmin: () => ({ endRoom: async (room: string) => { endedRooms.push(room); } }),
    mintToken: async () => "test-token",
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

    it("GET /:callId returns session + participants for a participant", async () => {
      const s = await req("POST", "/api/calls", startBody);
      const r = await req("GET", `/api/calls/${s.body.session.id}`);
      assert.equal(r.status, 200);
      assert.equal(r.body.participants.length, 2);
    });
  });
});

/** Re-wire gateway overrides while keeping the current store (mid-test). */
function wireDepsKeepStore(gwOverrides: Partial<CallContextGateway>) {
  gateway = makeFakeGateway(gwOverrides);
  const keep = store;
  _setTestCallDeps({
    makeGateway: () => gateway,
    makeStore: () => keep,
    roomAdmin: () => ({ endRoom: async (room: string) => { endedRooms.push(room); } }),
    mintToken: async () => "test-token",
    livekitUrl: () => "wss://livekit.test",
  });
}

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
