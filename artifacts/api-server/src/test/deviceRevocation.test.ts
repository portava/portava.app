/**
 * §30A.7 (census-telegraph T401 / T399) — revoking a device ends that device's
 * access, and ONLY that device's:
 *
 *   auth session   its later requests are refused (401), on every getUser site,
 *                  and GoTrue is asked to end the session (admin.signOut)
 *   realtime       its open Telegraph SSE stream is closed with access.revoked;
 *                  the person's other phone keeps its stream
 *   push           its push token is deleted, detached from the legacy
 *                  profiles copy, and removed from queued retries; the other
 *                  phone's token is untouched
 *   precise loc.   the precise-location binding naming it is cleared, and a
 *                  later read presenting its id is coarse
 *   history        no message is touched
 *
 * And honestly: a step that FAILS is a 503 that names it (the row is kept so a
 * retry can finish), a missing link is a gap that says so (complete: false),
 * and an unreadable registry changes nothing.
 *
 * Before this change DELETE /me/crypto-devices/:id deleted the row and nothing
 * else — run against origin/main, the first describe block fails on every
 * assertion after the row deletion.
 *
 * Run: node --import tsx/esm --test src/test/deviceRevocation.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { optionalUserFromToken, getGatedUser } from "../lib/accountStateGate.js";
import {
  DEVICE_ID_HEADER,
  _resetPreciseShareBindings,
  activeBinding,
  bindPreciseShare,
} from "../lib/preciseLocationDevice.js";
import {
  REVOKED_SESSIONS_CAP,
  REVOKED_SESSIONS_METADATA_KEY,
  isRevokedDeviceSession,
  sessionIdFromAccessToken,
} from "../lib/deviceRevocation.js";
import {
  registerTerminator,
  terminateScopedConnectionsLocal,
} from "../lib/telegraphEvents.js";
import { buildScopedTerminate, verifyScopedTerminate } from "../lib/telegraphBroadcast.js";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "99999999-9999-4999-8999-999999999999";
const PHONE_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PHONE_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const SESSION_A = "5a5a5a5a-0000-4000-8000-00000000000a";
const SESSION_B = "5b5b5b5b-0000-4000-8000-00000000000b";
const SESSION_C = "5c5c5c5c-0000-4000-8000-00000000000c";
const TOKEN_A_PUSH = "ExponentPushToken[phone-a-aaaaaaaa]";
const TOKEN_B_PUSH = "ExponentPushToken[phone-b-bbbbbbbb]";

/** A JWT-shaped bearer token carrying a session_id claim (the fake verifies it by lookup). */
function jwt(sessionId: string, sub = USER): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ sub, session_id: sessionId })}.sig`;
}
const TOK_A = jwt(SESSION_A);
const TOK_B = jwt(SESSION_B);
const TOK_C = jwt(SESSION_C);

// ── An in-memory PostgREST + GoTrue double that APPLIES writes ───────────────

type Row = Record<string, any>;
type Failure = { message: string; code?: string } | null;

interface World {
  tables: Record<string, Row[]>;
  appMetadata: Record<string, Row>;
  liveSessions: Set<string>; // GoTrue sessions still alive
  signedOut: string[]; // tokens admin.signOut was called with
  failOn: (table: string, op: string, cols?: string) => Failure;
  failAdminUpdate: boolean;
}

let world: World;

function freshWorld(): World {
  return {
    tables: {
      devices: [
        { id: PHONE_A, user_id: USER, platform: "ios", auth_session_id: SESSION_A, last_seen_at: "2026-10-10T00:00:00Z" },
        { id: PHONE_B, user_id: USER, platform: "android", auth_session_id: SESSION_B, last_seen_at: "2026-10-10T00:00:00Z" },
      ],
      notification_devices: [
        { id: "nd-a", user_id: USER, push_token: TOKEN_A_PUSH, platform: "expo", crypto_device_id: PHONE_A },
        { id: "nd-b", user_id: USER, push_token: TOKEN_B_PUSH, platform: "fcm", crypto_device_id: PHONE_B },
      ],
      profiles: [{ id: USER, expo_push_token: TOKEN_A_PUSH, account_status: "active" }],
      rent_buddy_profiles: [{ user_id: USER, expo_push_token: TOKEN_A_PUSH }],
      push_retry_queue: [
        { id: "q1", user_id: USER, status: "queued", tokens: [TOKEN_A_PUSH, TOKEN_B_PUSH] },
        { id: "q2", user_id: USER, status: "sent", tokens: [TOKEN_A_PUSH] },
      ],
      messages: [{ id: "m1", thread_id: "t1", sender_id: USER, body: "hello" }],
      user_location_state: [{ user_id: USER, lat: 41.157944, lng: -8.629105, accuracy_meters: 8, city: "Porto", last_known_at: new Date().toISOString() }],
      feature_flags: [],
    },
    appMetadata: { [USER]: {} },
    liveSessions: new Set([SESSION_A, SESSION_B, SESSION_C]),
    signedOut: [],
    failOn: () => null,
    failAdminUpdate: false,
  };
}

function makeClient(): any {
  const userFor = (token: string) => {
    const sid = sessionIdFromAccessToken(token);
    if (!sid || !world.liveSessions.has(sid)) return null;
    return { id: USER, app_metadata: { ...(world.appMetadata[USER] ?? {}) } };
  };
  return {
    auth: {
      getUser: async (token: string) => {
        const u = userFor(token);
        return u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: "session_not_found", code: "session_not_found", status: 403 } };
      },
      admin: {
        getUserById: async (id: string) => ({ data: { user: { id, app_metadata: { ...(world.appMetadata[id] ?? {}) } } }, error: null }),
        updateUserById: async (id: string, attrs: Row) => {
          if (world.failAdminUpdate) return { data: { user: null }, error: { message: "auth admin down" } };
          world.appMetadata[id] = { ...(world.appMetadata[id] ?? {}), ...(attrs.app_metadata ?? {}) };
          return { data: { user: { id } }, error: null };
        },
        signOut: async (token: string, _scope: string) => {
          world.signedOut.push(token);
          const sid = sessionIdFromAccessToken(token);
          if (sid) world.liveSessions.delete(sid);
          return { data: null, error: null };
        },
      },
    },
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let op: "select" | "update" | "delete" | "insert" | "upsert" = "select";
      let patch: Row | null = null;
      let cols = "*";
      let returning = false;
      const rows = () => (world.tables[table] ??= []);
      // PostgREST returns only the selected columns — a fake that returned the
      // whole row would hide a read that never asked for the link column.
      const project = (r: Row): Row => {
        if (cols === "*" || !cols) return { ...r };
        const out: Row = {};
        for (const c of cols.split(",").map((x) => x.trim()).filter((x) => /^[a-z_]+$/.test(x))) out[c] = r[c];
        return out;
      };
      const run = (): { data: any; error: any } => {
        const failure = world.failOn(table, op, cols);
        if (failure) return { data: null, error: failure };
        const t = rows();
        if (op === "select") return { data: t.filter((r) => filters.every((f) => f(r))).map(project), error: null };
        if (op === "update") {
          const hit = t.filter((r) => filters.every((f) => f(r)));
          for (const r of hit) Object.assign(r, patch);
          return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
        }
        if (op === "delete") {
          const hit = t.filter((r) => filters.every((f) => f(r)));
          world.tables[table] = t.filter((r) => !hit.includes(r));
          return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
        }
        // insert / upsert
        const row: Row = { id: `${table}-${t.length + 1}`, ...(patch ?? {}) };
        if (op === "upsert" && table === "notification_devices") {
          const existing = t.find((r) => r.user_id === row.user_id && r.push_token === row.push_token);
          if (existing) { Object.assign(existing, patch); return { data: { ...existing }, error: null }; }
        }
        t.push(row);
        return { data: { ...row }, error: null };
      };
      const chain: any = {
        select: (c?: string) => { if (op === "select") cols = c ?? "*"; else returning = true; return chain; },
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return chain; },
        neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return chain; },
        in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return chain; },
        is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return chain; },
        gt: () => chain, gte: () => chain, lt: () => chain, lte: () => chain, or: () => chain,
        order: () => chain, limit: () => chain, range: () => chain, not: () => chain, filter: () => chain, contains: () => chain,
        update: (p: Row) => { op = "update"; patch = p; return chain; },
        delete: () => { op = "delete"; return chain; },
        insert: (p: Row) => { op = "insert"; patch = p; return chain; },
        upsert: (p: Row) => { op = "upsert"; patch = p; return chain; },
        maybeSingle: async () => {
          const r = run();
          if (r.error) return r;
          const d = Array.isArray(r.data) ? r.data : r.data ? [r.data] : [];
          return { data: d[0] ?? null, error: null };
        },
        single: async () => {
          const r = run();
          if (r.error) return r;
          const d = Array.isArray(r.data) ? r.data : r.data ? [r.data] : [];
          return d.length === 1 ? { data: d[0], error: null } : { data: null, error: { message: "not single", code: "PGRST116" } };
        },
        then: (f: any, rej: any) => Promise.resolve(run()).then(f, rej),
      };
      return chain;
    },
    rpc: async () => ({ data: null, error: null }),
    channel: () => ({ on: () => ({}), subscribe: () => ({}) }),
    removeChannel: async () => {},
    storage: { from: () => ({}) },
  };
}

// ── HTTP plumbing ─────────────────────────────────────────────────────────────

let server: Server;
let port = 0;

async function call(method: string, path: string, token: string, opts: { device?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (opts.device) headers[DEVICE_ID_HEADER] = opts.device;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

/** Open a Telegraph SSE stream; resolves once the `connected` frame arrived. */
function openStream(token: string): Promise<{ frames: string[]; ended: Promise<void>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const frames: string[] = [];
    let endResolve!: () => void;
    const ended = new Promise<void>((r) => { endResolve = r; });
    let resolved = false;
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/api/telegraph/stream", method: "GET", headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        if (res.statusCode !== 200) {
          let b = ""; res.on("data", (c) => { b += c; });
          res.on("end", () => reject(Object.assign(new Error(`stream ${res.statusCode}`), { status: res.statusCode, body: b })));
          return;
        }
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          frames.push(chunk);
          if (!resolved && frames.join("").includes("event: connected")) {
            resolved = true;
            resolve({ frames, ended, close: () => req.destroy() });
          }
        });
        res.on("end", () => endResolve());
        res.on("close", () => endResolve());
      },
    );
    req.on("error", (e) => { if (!resolved) reject(e); else endResolve(); });
    req.end();
  });
}

const settled = (p: Promise<void>, ms = 1500) =>
  Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

before(() => new Promise<void>((resolve) => {
  server = createServer(app);
  server.listen(0, "127.0.0.1", () => { port = (server.address() as any).port; resolve(); });
}));
after(() => new Promise<void>((resolve) => {
  _setTestClient(null as any, false);
  _setTestServiceClient(null as any);
  server.closeAllConnections?.();
  server.close(() => resolve());
}));
beforeEach(() => {
  world = freshWorld();
  _resetPreciseShareBindings();
  const c = makeClient();
  _setTestClient(c, true);
  _setTestServiceClient(c);
});

// ── The requirement, end to end ───────────────────────────────────────────────

describe("DELETE /me/crypto-devices/:id — phone B revokes phone A", () => {
  it("A's stream is closed, B's stays open; A's push token, binding and session are gone; B is untouched; history is kept", async () => {
    bindPreciseShare(USER, PHONE_A, Date.now());
    const streamA = await openStream(TOK_A);
    const streamB = await openStream(TOK_B);

    const r = await call("DELETE", `/me/crypto-devices/${PHONE_A}`, TOK_B, { device: PHONE_B });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.complete, true, `gaps: ${JSON.stringify(r.body.revocation?.gaps)}`);
    assert.deepEqual(r.body.revocation.steps, {
      auth_session: "done",
      push_tokens: "done",
      precise_location: "done",
      realtime: "done",
      registry_row: "done",
    });

    // realtime: A closed with access.revoked, B still open
    assert.equal(await settled(streamA.ended), true, "the revoked device's stream stayed open");
    assert.match(streamA.frames.join(""), /event: access\.revoked/);
    assert.equal(await settled(streamB.ended, 300), false, "the OTHER device's stream was closed too");
    streamB.close();

    // push: A's token gone everywhere, B's untouched
    const nd = world.tables.notification_devices!;
    assert.deepEqual(nd.map((r) => r.id), ["nd-b"]);
    assert.equal(world.tables.profiles![0]!.expo_push_token, null, "legacy profiles copy still delivers to the revoked phone");
    assert.equal(world.tables.rent_buddy_profiles![0]!.expo_push_token, null);
    assert.deepEqual(world.tables.push_retry_queue!.find((q) => q.id === "q1")!.tokens, [TOKEN_B_PUSH], "a queued retry still targets the revoked phone");
    assert.deepEqual(world.tables.push_retry_queue!.find((q) => q.id === "q2")!.tokens, [TOKEN_A_PUSH], "a SENT row is history, not a pending delivery");

    // precise location: binding cleared
    assert.equal(activeBinding(USER, Date.now()), null);

    // auth session: listed in app_metadata
    assert.deepEqual(world.appMetadata[USER]![REVOKED_SESSIONS_METADATA_KEY], [SESSION_A]);

    // registry: A gone, B present; history untouched
    assert.deepEqual(world.tables.devices!.map((d) => d.id), [PHONE_B]);
    assert.equal(world.tables.messages!.length, 1);
  });

  it("A's later requests are REFUSED (401) and GoTrue is told to end A's session; B keeps working", async () => {
    const r = await call("DELETE", `/me/crypto-devices/${PHONE_A}`, TOK_B);
    assert.equal(r.status, 200);

    const fromA = await call("GET", "/me/crypto-devices", TOK_A);
    assert.equal(fromA.status, 401);
    assert.equal(fromA.body.error, "unauthenticated");
    assert.match(fromA.body.message, /signed out/i);
    assert.ok(world.signedOut.includes(TOK_A), "admin.signOut was not called for the revoked session");

    const fromB = await call("GET", "/me/crypto-devices", TOK_B);
    assert.equal(fromB.status, 200);
    assert.deepEqual(fromB.body.devices.map((d: any) => d.id), [PHONE_B]);
  });

  it("A gets no new stream", async () => {
    await call("DELETE", `/me/crypto-devices/${PHONE_A}`, TOK_B);
    await assert.rejects(openStream(TOK_A), (e: any) => e.status === 401);
  });

  it("a location read presenting A's id (through B's session) is coarse", async () => {
    bindPreciseShare(USER, PHONE_A, Date.now());
    await call("DELETE", `/me/crypto-devices/${PHONE_A}`, TOK_B);
    const r = await call("GET", "/me/location-state", TOK_B, { device: PHONE_A });
    assert.equal(r.status, 200);
    assert.equal(r.body.locationState.coordsPrecision, "approximate");
  });

  it("is idempotent: a second revoke of A is 200 and changes nothing more", async () => {
    await call("DELETE", `/me/crypto-devices/${PHONE_A}`, TOK_B);
    const again = await call("DELETE", `/me/crypto-devices/${PHONE_A}`, TOK_B);
    assert.equal(again.status, 200);
    assert.equal(again.body.revocation.deviceFound, false);
    assert.equal(again.body.revocation.steps.auth_session, "not_applicable");
    assert.deepEqual(world.appMetadata[USER]![REVOKED_SESSIONS_METADATA_KEY], [SESSION_A]);
    assert.deepEqual(world.tables.notification_devices!.map((r) => r.id), ["nd-b"]);
  });

  it("another user's device id revokes nothing", async () => {
    world.tables.devices!.push({ id: "dddddddd-4444-4444-8444-dddddddddddd", user_id: OTHER_USER, auth_session_id: SESSION_C });
    const r = await call("DELETE", "/me/crypto-devices/dddddddd-4444-4444-8444-dddddddddddd", TOK_B);
    assert.equal(r.body.revocation.deviceFound, false);
    assert.equal(world.tables.devices!.length, 3, "a foreign device row was deleted");
    assert.equal(world.appMetadata[USER]![REVOKED_SESSIONS_METADATA_KEY], undefined);
  });
});

describe("self-revocation (sign-out from the device itself)", () => {
  it("ends the caller's own session in GoTrue immediately", async () => {
    const r = await call("DELETE", `/me/crypto-devices/${PHONE_A}`, TOK_A, { device: PHONE_A });
    assert.equal(r.status, 200);
    assert.equal(r.body.revocation.steps.auth_session, "done");
    assert.ok(world.signedOut.includes(TOK_A));
    assert.equal(world.liveSessions.has(SESSION_A), false);
    assert.equal(world.liveSessions.has(SESSION_B), true, "another device's session was ended");
  });
});

// ── Honest partial failure ────────────────────────────────────────────────────

describe("a step that fails is reported, never a silent success", () => {
  it("auth admin down → 503 naming auth_session; the row is KEPT so a retry can finish; the retry completes", async () => {
    world.failAdminUpdate = true;
    const r = await call("DELETE", `/me/crypto-devices/${PHONE_A}`, TOK_B);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.retryable, true);
    assert.deepEqual(r.body.revocation.failed, ["auth_session"]);
    assert.equal(r.body.revocation.steps.registry_row, "kept_for_retry");
    assert.ok(world.tables.devices!.some((d) => d.id === PHONE_A), "the row carrying the session id was deleted");
    // the other steps still ran
    assert.equal(world.tables.notification_devices!.some((n) => n.crypto_device_id === PHONE_A), false);

    world.failAdminUpdate = false;
    const retry = await call("DELETE", `/me/crypto-devices/${PHONE_A}`, TOK_B);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.revocation.steps.auth_session, "done");
    assert.equal(world.tables.devices!.some((d) => d.id === PHONE_A), false);
    const fromA = await call("GET", "/me/crypto-devices", TOK_A);
    assert.equal(fromA.status, 401);
  });

  it("push token store down → 503 naming push_tokens", async () => {
    world.failOn = (table, op) => (table === "notification_devices" && op === "delete" ? { message: "down", code: "57P01" } : null);
    const r = await call("DELETE", `/me/crypto-devices/${PHONE_A}`, TOK_B);
    assert.equal(r.status, 503);
    assert.ok(r.body.revocation.failed.includes("push_tokens"));
  });

  it("registry unreadable → 503 and NOTHING changed", async () => {
    world.failOn = (table, op) => (table === "devices" && op === "select" ? { message: "down", code: "57P01" } : null);
    const r = await call("DELETE", `/me/crypto-devices/${PHONE_A}`, TOK_B);
    assert.equal(r.status, 503);
    assert.equal(r.body.revocation, undefined);
    assert.equal(world.tables.notification_devices!.length, 2);
    assert.equal(world.appMetadata[USER]![REVOKED_SESSIONS_METADATA_KEY], undefined);
  });
});

describe("a missing link is a gap, not a success", () => {
  it("no session recorded for A → complete:false, gap auth_session_unlinked, and EVERY stream is closed (the safe direction)", async () => {
    world.tables.devices![0]!.auth_session_id = null;
    const streamB = await openStream(TOK_B);
    const r = await call("DELETE", `/me/crypto-devices/${PHONE_A}`, TOK_B);
    assert.equal(r.status, 200);
    assert.equal(r.body.complete, false);
    assert.ok(r.body.revocation.gaps.includes("auth_session_unlinked"));
    assert.equal(r.body.revocation.steps.realtime, "done_all_connections");
    assert.equal(await settled(streamB.ended), true);
  });

  it("3743 unapplied (no link columns) → both links reported absent, the row is still revoked", async () => {
    world.failOn = (table, _op, cols) =>
      (table === "devices" && cols?.includes("auth_session_id")) || (table === "notification_devices" && _op === "delete")
        ? { message: 'column "auth_session_id" does not exist', code: "42703" }
        : null;
    const r = await call("DELETE", `/me/crypto-devices/${PHONE_A}`, TOK_B);
    assert.equal(r.status, 200);
    assert.equal(r.body.complete, false);
    assert.deepEqual(r.body.revocation.gaps.sort(), ["auth_session_link_column_absent", "push_tokens_link_column_absent"]);
    assert.equal(world.tables.devices!.some((d) => d.id === PHONE_A), false);
  });

  it("a push token registered without the device header is not linked → gap push_tokens_unlinked; B's token survives", async () => {
    world.tables.notification_devices![0]!.crypto_device_id = null;
    const r = await call("DELETE", `/me/crypto-devices/${PHONE_A}`, TOK_B);
    assert.equal(r.body.complete, false);
    assert.ok(r.body.revocation.gaps.includes("push_tokens_unlinked"));
    assert.equal(world.tables.notification_devices!.length, 2, "an unlinked token is not guessed at");
  });
});

// ── The links are written ─────────────────────────────────────────────────────

describe("the device→session and push-token→device links", () => {
  it("the public-key call records the session the device calls from", async () => {
    world.tables.devices![0]!.auth_session_id = null;
    const r = await call("POST", `/me/crypto-devices/${PHONE_A}/public-key`, TOK_C, { body: { publicKey: "x".repeat(44) } });
    assert.equal(r.status, 200);
    assert.equal(world.tables.devices![0]!.auth_session_id, SESSION_C);
  });

  it("capability fields are NOT written while telegraph_device_registry_enabled is off, and are when on", async () => {
    const body = { publicKey: "x".repeat(44), capabilities: { push: true, voiceVideo: false, proximity: true, backgroundLocation: false, trust_state: "verified" } };
    await call("POST", `/me/crypto-devices/${PHONE_A}/public-key`, TOK_A, { body });
    assert.equal(world.tables.devices![0]!.push_capable, undefined);

    world.tables.feature_flags!.push({ flag: "telegraph_device_registry_enabled", enabled: true });
    await call("POST", `/me/crypto-devices/${PHONE_A}/public-key`, TOK_A, { body });
    const a = world.tables.devices![0]!;
    assert.equal(a.push_capable, true);
    assert.equal(a.voice_video_capable, false);
    assert.equal(a.proximity_capable, true);
    assert.equal(a.background_location_capable, false);
    assert.equal(a.trust_state, undefined, "a client must never set its own trust state");
  });

  it("push registration with the device header links the token to that device — only to the caller's own device", async () => {
    const r = await call("POST", "/me/devices", TOK_A, { device: PHONE_A, body: { pushToken: "ExponentPushToken[new-a-0000]", platform: "expo" } });
    assert.equal(r.status, 201);
    const row = world.tables.notification_devices!.find((n) => n.push_token === "ExponentPushToken[new-a-0000]")!;
    assert.equal(row.crypto_device_id, PHONE_A);

    world.tables.devices!.push({ id: "dddddddd-4444-4444-8444-dddddddddddd", user_id: OTHER_USER });
    await call("POST", "/me/devices", TOK_A, { device: "dddddddd-4444-4444-8444-dddddddddddd", body: { pushToken: "ExponentPushToken[foreign-000]", platform: "apns" } });
    const foreign = world.tables.notification_devices!.find((n) => n.push_token === "ExponentPushToken[foreign-000]")!;
    assert.equal(foreign.crypto_device_id, undefined, "a token was linked to another user's device");
  });
});

// ── The gate, at every getUser site ───────────────────────────────────────────

describe("the revoked-session gate", () => {
  it("optionalUserFromToken and getGatedUser treat a revoked session as no user", async () => {
    world.appMetadata[USER] = { [REVOKED_SESSIONS_METADATA_KEY]: [SESSION_A] };
    const c = makeClient();
    assert.equal(await optionalUserFromToken(c, TOK_A), null);
    assert.equal((await getGatedUser(c, TOK_A)).data.user, null);
    assert.equal((await optionalUserFromToken(c, TOK_B))?.id, USER);
  });

  it("isRevokedDeviceSession reads the claim, and a token without one is never revoked", () => {
    const u = { app_metadata: { [REVOKED_SESSIONS_METADATA_KEY]: [SESSION_A.toUpperCase()] } } as any;
    assert.equal(isRevokedDeviceSession(u, TOK_A), true);
    assert.equal(isRevokedDeviceSession(u, TOK_B), false);
    assert.equal(isRevokedDeviceSession(u, "opaque-token"), false);
    assert.equal(sessionIdFromAccessToken("a.b"), null);
  });

  it("the revoked list is capped (it rides in every access token)", async () => {
    world.appMetadata[USER] = { [REVOKED_SESSIONS_METADATA_KEY]: Array.from({ length: REVOKED_SESSIONS_CAP }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`) };
    await call("DELETE", `/me/crypto-devices/${PHONE_A}`, TOK_B);
    const list = world.appMetadata[USER]![REVOKED_SESSIONS_METADATA_KEY] as string[];
    assert.equal(list.length, REVOKED_SESSIONS_CAP);
    assert.equal(list[list.length - 1], SESSION_A);
  });
});

// ── Scoped termination ────────────────────────────────────────────────────────

describe("device-scoped connection termination", () => {
  it("closes only connections whose session or device matches; untagged connections are not matched", () => {
    const USER = "77777777-7777-4777-8777-777777777777"; // its own user: no stream from another test can be counted
    const closed: string[] = [];
    const u1 = registerTerminator(USER, () => closed.push("a"), { sessionId: SESSION_A, deviceId: null });
    const u2 = registerTerminator(USER, () => closed.push("b"), { sessionId: SESSION_B, deviceId: PHONE_B });
    const u3 = registerTerminator(USER, () => closed.push("untagged"));
    assert.equal(terminateScopedConnectionsLocal(USER, { sessionId: SESSION_A }), 1);
    assert.deepEqual(closed, ["a"]);
    assert.equal(terminateScopedConnectionsLocal(USER, { deviceId: PHONE_B }), 1);
    assert.deepEqual(closed, ["a", "b"]);
    assert.equal(terminateScopedConnectionsLocal(USER, {}), 0);
    u1(); u2(); u3();
  });

  it("the cross-instance signal is signed over its scope: a re-aimed payload is rejected", () => {
    const p = buildScopedTerminate(USER, { sessionId: SESSION_A, deviceId: PHONE_A }, "secret", "inst-1");
    assert.equal(verifyScopedTerminate(p, "secret"), true);
    assert.equal(verifyScopedTerminate({ ...p, sessionId: SESSION_B }, "secret"), false);
    assert.equal(verifyScopedTerminate({ ...p, userId: OTHER_USER }, "secret"), false);
    assert.equal(verifyScopedTerminate(p, "other-secret"), false);
  });
});
