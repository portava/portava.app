/**
 * The authentication and feature-flag hot path remembers (lib/hotPathCache.ts),
 * and nothing it remembers weakens a fail-closed answer.
 *
 * WHAT IS PROVEN HERE
 *   verified tokens   a hit skips `auth.getUser` (and a remembered active state
 *                     skips the gate's profiles read); the key is sha256, never
 *                     the token; a token with no readable `exp`, or 5s or less
 *                     left, is verified every time; 30s is the ceiling; a failed
 *                     verification, the auth service's banned refusal, a throw,
 *                     an unreadable / banned / suspended / deleted state are
 *                     never remembered; one cache serves all four getUser sites.
 *   invalidation      device revocation (the API's sign-out), a ban or
 *                     suspension through applyAccountRestriction, a revoked
 *                     session found on re-verification, and an invalidation
 *                     racing an in-flight read; a change made ELSEWHERE (another
 *                     instance) is seen within the TTL and not before — the
 *                     cross-instance bound, stated rather than hidden.
 *   flag rows         a hit skips the read; the kill switch still ENGAGES on
 *                     every failed or thrown read (never remembered); 15s TTL;
 *                     PATCH /admin/feature-flags/:flag and its metadata variant
 *                     bust it at once; the older per-client flag caches end on
 *                     the same write.
 *   service client    built once, PostgREST-backed and cacheable; an injected
 *                     double is neither remembered nor cacheable.
 *   isolation         a double that is NOT opted in is read through every time,
 *                     which is what keeps every other suite unchanged.
 *
 * Synthetic: an in-memory supabase-js shaped double, opted in with
 * _markHotPathCacheableForTest; `_setTestClient` empties the caches per case.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/authHotPathCache.test.ts
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { _setTestClient, _clearTestClient, requireUser, optionalUser } from "../lib/http.js";
import { _setTestServiceClient, getServiceClient, isPostgrestBackedClient } from "../lib/supabase.js";
import { getGatedUser, optionalUserFromToken, requireUserFromToken } from "../lib/accountStateGate.js";
import { getFlagRow, isFlagEnabled, isKillSwitchEngaged, readFlagState } from "../lib/featureFlags.js";
import {
  MAX_VERIFIED_TOKENS,
  _hotPathCacheContentsForTest,
  _markHotPathCacheableForTest,
  _resetHotPathCachesForTest,
  authCacheGeneration,
  featureFlagWriteEpoch,
  invalidateFeatureFlagCache,
  invalidateUserAuthCache,
  isHotPathCacheableClient,
  rememberVerifiedUser,
} from "../lib/hotPathCache.js";
import { revokeDevice, REVOKED_DEVICE_MESSAGE, REVOKED_SESSIONS_METADATA_KEY } from "../lib/deviceRevocation.js";
import { applyAccountRestriction } from "../lib/accountModeration.js";
import { discoveryStopHalt } from "../lib/discoveryStopGate.js";
import { outboxFanoutInForce } from "../lib/telegraphOutboxDrainScheduler.js";
import { withLayoverSystemAudit } from "../lib/layoverServiceAudit.js";
import adminRouter from "../routes/admin.js";

const USER = "11111111-1111-4111-8111-111111111111";
const DEVICE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const SESSION = "5a5a5a5a-0000-4000-8000-00000000000a";
const OTHER_SESSION = "5b5b5b5b-0000-4000-8000-00000000000b";

/** A JWT-shaped bearer token. The double "verifies" it; only `exp` and `session_id` are read by the API. */
function jwt(claims: { exp?: number; session_id?: string; sub?: string; nonce?: string }): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ sub: USER, ...claims })}.sig`;
}
const inSeconds = (s: number) => Math.floor(Date.now() / 1000) + s;

// ── Clock ────────────────────────────────────────────────────────────────────
const realNow = Date.now;
/** Move the clock every cache reads forward by `ms` (and hold it there). */
function advance(ms: number): void {
  const base = Date.now();
  Date.now = () => base + ms;
}
afterEach(() => { Date.now = realNow; _clearTestClient(); _setTestServiceClient(null); });

// ── The double ───────────────────────────────────────────────────────────────

type Failure = { message: string; code?: string };
interface World {
  user: { id: string; app_metadata: Record<string, unknown>; email?: string };
  auth: "ok" | "invalid" | "banned" | "throws";
  authGate: Promise<void> | null; // when set, getUser waits on it (an in-flight verification)
  authCalls: number;
  accountStatus: string;
  states: Array<{ user_id: string; state: string; expires_at: string | null }>;
  profileError: Failure | null;
  gateReads: number;
  flags: Record<string, { flag: string; enabled: boolean; metadata?: Record<string, unknown> | null }>;
  flagFailure: Failure | "throws" | null;
  flagReads: number;
  devices: Array<{ id: string; user_id: string; auth_session_id: string | null }>;
}

function freshWorld(): World {
  return {
    user: { id: USER, app_metadata: {}, email: "a@example.test" },
    auth: "ok",
    authGate: null,
    authCalls: 0,
    accountStatus: "active",
    states: [],
    profileError: null,
    gateReads: 0,
    flags: {},
    flagFailure: null,
    flagReads: 0,
    devices: [{ id: DEVICE, user_id: USER, auth_session_id: SESSION }],
  };
}

function makeClient(w: World): any {
  function answer(table: string, st: any, single: boolean): any {
    if (table === "profiles" && st.op === "select") {
      const gate = String(st.cols).includes("user_account_states");
      if (gate) {
        w.gateReads++;
        if (w.profileError) return { data: null, error: w.profileError };
      }
      const row = {
        id: USER, role: "admin", display_name: "Admin", username: "admin", handle: "admin",
        account_status: w.accountStatus,
        user_account_states: w.states.filter((s) => s.user_id === USER).map((s) => ({ state: s.state, expires_at: s.expires_at })),
      };
      return { data: single ? row : [row], error: null };
    }
    if (table === "feature_flags" && st.op === "select") {
      w.flagReads++;
      if (w.flagFailure === "throws") throw new Error("fetch failed");
      if (w.flagFailure) return { data: null, error: w.flagFailure };
      if (st.inVals) {
        const rows = Object.values(w.flags).filter((f) => st.inVals.includes(f.flag)).map((f) => ({ ...f }));
        return { data: rows, error: null };
      }
      const row = w.flags[st.filters.flag];
      return { data: row ? { ...row } : null, error: null };
    }
    if (table === "user_account_states") {
      if (st.op === "upsert") {
        const p = st.payload;
        w.states = w.states.filter((s) => !(s.user_id === p.user_id && s.state === p.state));
        w.states.push({ user_id: p.user_id, state: p.state, expires_at: p.expires_at ?? null });
        return { data: null, error: null };
      }
      return { data: w.states.filter((s) => s.user_id === st.filters.user_id), error: null };
    }
    if (table === "devices" && st.op === "select") {
      const row = w.devices.find((d) => d.id === st.filters.id && d.user_id === st.filters.user_id) ?? null;
      return { data: single ? row : row ? [row] : [], error: null };
    }
    if (table === "devices" && st.op === "delete") {
      w.devices = w.devices.filter((d) => !(d.id === st.filters.id && d.user_id === st.filters.user_id));
      return { data: null, error: null };
    }
    return { data: single ? null : [], error: null };
  }
  function builder(table: string): any {
    const st: any = { op: "select", cols: "*", filters: {}, payload: null, inVals: null };
    const b: any = {
      select: (cols?: string) => { if (st.op === "select") st.cols = cols ?? "*"; return b; },
      insert: (p: any) => { st.op = "insert"; st.payload = p; return b; },
      upsert: (p: any) => { st.op = "upsert"; st.payload = p; return b; },
      update: (p: any) => { st.op = "update"; st.payload = p; return b; },
      delete: () => { st.op = "delete"; return b; },
      eq: (c: string, v: unknown) => { st.filters[c] = v; return b; },
      in: (c: string, vals: unknown[]) => { if (c === "flag") st.inVals = vals; return b; },
      is: () => b, or: () => b, order: () => b, limit: () => b, gt: () => b, lte: () => b,
      maybeSingle: () => Promise.resolve(answer(table, st, true)),
      single: () => Promise.resolve(answer(table, st, true)),
      then: (f: any, r: any) => Promise.resolve().then(() => answer(table, st, false)).then(f, r),
    };
    return b;
  }
  return {
    auth: {
      async getUser(_token: string) {
        w.authCalls++;
        if (w.authGate) await w.authGate;
        if (w.auth === "throws") throw new Error("fetch failed");
        if (w.auth === "invalid") return { data: { user: null }, error: { message: "invalid JWT", status: 401 } };
        if (w.auth === "banned") return { data: { user: null }, error: { message: "User is banned", code: "user_banned", status: 403 } };
        return { data: { user: structuredClone(w.user) }, error: null };
      },
      admin: {
        async getUserById(_id: string) { return { data: { user: structuredClone(w.user) }, error: null }; },
        async updateUserById(_id: string, attrs: any) {
          if (attrs?.app_metadata) w.user.app_metadata = { ...w.user.app_metadata, ...attrs.app_metadata };
          return { data: { user: w.user }, error: null };
        },
        async signOut() { return { error: null }; },
      },
    },
    from: (table: string) => builder(table),
    rpc: async (fn: string, args: any) => {
      const row = w.flags[args?.p_flag];
      if (!row) return { data: null, error: { code: "P0002", message: `Flag not found: ${args?.p_flag}` } };
      if (fn === "toggle_feature_flag_with_audit") {
        const old = row.enabled; row.enabled = args.p_new_enabled;
        return { data: [{ ...row, old_enabled: old, changed_at: new Date().toISOString(), updated_at: new Date().toISOString() }], error: null };
      }
      if (fn === "set_feature_flag_metadata_with_audit") {
        const old = row.metadata ?? null; row.metadata = args.p_metadata;
        return { data: [{ ...row, old_metadata: old, changed_at: new Date().toISOString(), updated_at: new Date().toISOString() }], error: null };
      }
      return { data: null, error: { code: "42883", message: `function ${fn} does not exist` } };
    },
  };
}

/** A world, its double opted in to the caches, injected as both clients (which empties the caches). */
function setup(mutate: (w: World) => void = () => {}, opts: { cacheable?: boolean } = {}): { w: World; client: any } {
  const w = freshWorld();
  mutate(w);
  const client = makeClient(w);
  if (opts.cacheable !== false) _markHotPathCacheableForTest(client);
  _setTestClient(client, true);
  return { w, client };
}

function sink() {
  const out: { status: number | null; body: any } = { status: null, body: null };
  const res: any = { status(c: number) { out.status = c; return res; }, json(b: any) { out.body = b; return res; } };
  return { res, out };
}
const SILENT_LOG = { info() {}, warn() {}, error() {}, debug() {} };
const reqWith = (token: string): any => ({ headers: { authorization: `Bearer ${token}` }, log: SILENT_LOG, method: "GET", path: "/x" });

async function callRequireUser(token: string): Promise<{ ok: boolean; status: number | null; body: any; user: any }> {
  const s = sink();
  const r = await requireUser(reqWith(token), s.res);
  return { ok: r !== null, status: s.out.status, body: s.out.body, user: r?.user ?? null };
}

// ═════════════════════════════════════════════════════════════════════════════
// Verified tokens
// ═════════════════════════════════════════════════════════════════════════════

describe("verified-token cache — a hit skips the network", () => {
  it("the second and third requireUser with the same token make no getUser call and no account-state read", async () => {
    const { w } = setup();
    const token = jwt({ exp: inSeconds(3600), session_id: SESSION });
    for (let i = 0; i < 3; i++) assert.equal((await callRequireUser(token)).ok, true);
    assert.equal(w.authCalls, 1, "one verification for three requests");
    assert.equal(w.gateReads, 1, "one account-state read for three requests");
  });

  it("the raw token is never a key: the one key held is its sha256", async () => {
    setup();
    const token = jwt({ exp: inSeconds(3600) });
    await callRequireUser(token);
    const { tokenKeys } = _hotPathCacheContentsForTest();
    assert.deepEqual(tokenKeys, [crypto.createHash("sha256").update(token).digest("hex")]);
    assert.ok(!tokenKeys.some((k) => k.includes(token) || token.includes(k)));
  });

  it("each hit hands back a fresh copy: a route that mutates its user does not change the next request's", async () => {
    setup((w) => { w.user.app_metadata = { role: "traveller" }; });
    const token = jwt({ exp: inSeconds(3600) });
    const first = await callRequireUser(token); // verified: the answer getUser gave
    first.user.app_metadata.role = "admin";
    const second = await callRequireUser(token); // a hit
    assert.equal(second.user.app_metadata.role, "traveller", "the stored copy was taken before the route could mutate it");
    second.user.app_metadata.role = "admin";
    second.user.id = "someone-else";
    const third = await callRequireUser(token); // another hit
    assert.equal(third.user.id, USER, "a hit's user is a copy, not the stored object");
    assert.equal(third.user.app_metadata.role, "traveller");
  });

  it("one cache serves all four getUser sites: optionalUser, optionalUserFromToken, getGatedUser, requireUserFromToken", async () => {
    const { w, client } = setup();
    const token = jwt({ exp: inSeconds(3600) });
    assert.equal((await callRequireUser(token)).ok, true);
    assert.equal((await optionalUser(reqWith(token)))?.user.id, USER);
    assert.equal((await optionalUserFromToken(client, token))?.id, USER);
    assert.equal((await getGatedUser(client, token)).data.user?.id, USER);
    const s = sink();
    assert.equal((await requireUserFromToken(reqWith(token), s.res, client, token))?.id, USER);
    assert.equal(w.authCalls, 1, "every site answered from the one remembered verification");
    assert.equal(w.gateReads, 1, "and from the one remembered account state");
  });
});

describe("verified-token cache — expiry: a token is never remembered past its own exp, nor longer than 30s", () => {
  it("a token with no readable exp is verified on every request", async () => {
    const { w } = setup();
    await callRequireUser("opaque-token");
    await callRequireUser("opaque-token");
    assert.equal(w.authCalls, 2);
  });

  it("a token with 5s or less left is verified on every request", async () => {
    const { w } = setup();
    const token = jwt({ exp: inSeconds(4) });
    await callRequireUser(token);
    await callRequireUser(token);
    assert.equal(w.authCalls, 2);
    assert.deepEqual(_hotPathCacheContentsForTest().tokenKeys, []);
  });

  it("a token with 20s left is remembered until 5s before its exp, then re-verified", async () => {
    const { w } = setup();
    const token = jwt({ exp: inSeconds(20) });
    await callRequireUser(token);
    advance(10_000);
    await callRequireUser(token);
    assert.equal(w.authCalls, 1, "inside the window: remembered");
    advance(16_000);
    await callRequireUser(token);
    assert.equal(w.authCalls, 2, "within 5s of exp: verified again");
  });

  it("a long-lived token is remembered for at most 30s", async () => {
    const { w } = setup();
    const token = jwt({ exp: inSeconds(3600) });
    await callRequireUser(token);
    advance(29_000);
    await callRequireUser(token);
    assert.equal(w.authCalls, 1);
    advance(31_000);
    await callRequireUser(token);
    assert.equal(w.authCalls, 2, "past 30s: verified again");
  });
});

describe("verified-token cache — a failure is never remembered", () => {
  const token = jwt({ exp: inSeconds(3600) });

  it("a rejected token: 401 on every request, verified every time, and a later good answer is not shadowed", async () => {
    const { w } = setup((x) => { x.auth = "invalid"; });
    assert.equal((await callRequireUser(token)).status, 401);
    assert.equal((await callRequireUser(token)).status, 401);
    assert.equal(w.authCalls, 2);
    w.auth = "ok";
    assert.equal((await callRequireUser(token)).ok, true);
    assert.equal(w.authCalls, 3);
  });

  it("the auth service's banned refusal (user_banned): 403 account_restricted every time, verified every time", async () => {
    const { w } = setup((x) => { x.auth = "banned"; });
    for (let i = 0; i < 2; i++) {
      const r = await callRequireUser(token);
      assert.equal(r.status, 403);
      assert.equal(r.body.reason, "account_restricted");
    }
    assert.equal(w.authCalls, 2);
  });

  it("an Auth call that throws: anonymous where the site says so, re-attempted every time", async () => {
    const { w, client } = setup((x) => { x.auth = "throws"; });
    assert.equal(await optionalUserFromToken(client, token, { authThrowIsAnonymous: true }), null);
    assert.equal(await optionalUserFromToken(client, token, { authThrowIsAnonymous: true }), null);
    assert.equal(w.authCalls, 2);
    assert.deepEqual(_hotPathCacheContentsForTest().tokenKeys, []);
  });

  it("an unreadable account state: 503 every time, read every time, never served from memory", async () => {
    const { w } = setup((x) => { x.profileError = { message: "permission denied for table profiles", code: "42501" }; });
    for (let i = 0; i < 2; i++) {
      const r = await callRequireUser(token);
      assert.equal(r.status, 503);
      assert.equal(r.body.error, "degraded_unavailable");
    }
    assert.equal(w.gateReads, 2);
    assert.deepEqual(_hotPathCacheContentsForTest().accountUserIds, [], "an unreadable state is not remembered");
  });

  for (const state of ["banned", "suspended"] as const) {
    it(`a ${state} account: 403 every time and its state read every time`, async () => {
      const { w } = setup((x) => { x.states = [{ user_id: USER, state, expires_at: null }]; });
      for (let i = 0; i < 2; i++) {
        const r = await callRequireUser(token);
        assert.equal(r.status, 403);
        assert.equal(r.body.reason, `account_${state}`);
      }
      assert.equal(w.gateReads, 2);
      assert.deepEqual(_hotPathCacheContentsForTest().accountUserIds, []);
    });
  }

  for (const status of ["deleted", "deactivated", "pending_deletion"]) {
    it(`a ${status} account: its state is read every time (only "active" is remembered)`, async () => {
      const { w } = setup((x) => { x.accountStatus = status; });
      await optionalUser(reqWith(token));
      await optionalUser(reqWith(token));
      assert.equal(w.gateReads, 2);
    });
  }

  it("a deleted account stays anonymous on optional auth on every request", async () => {
    setup((x) => { x.accountStatus = "deleted"; });
    assert.equal(await optionalUser(reqWith(token)), null);
    assert.equal(await optionalUser(reqWith(token)), null);
  });

  it("a revoked device session: refused every time, never remembered", async () => {
    const t = jwt({ exp: inSeconds(3600), session_id: SESSION });
    const { w } = setup((x) => { x.user.app_metadata = { [REVOKED_SESSIONS_METADATA_KEY]: [SESSION] }; });
    for (let i = 0; i < 2; i++) {
      const r = await callRequireUser(t);
      assert.equal(r.status, 401);
      assert.equal(r.body.message, REVOKED_DEVICE_MESSAGE);
    }
    assert.equal(w.authCalls, 2);
    assert.deepEqual(_hotPathCacheContentsForTest().tokenKeys, []);
  });
});

describe("isolation — a double that is not opted in reads through every time, as every other suite relies on", () => {
  it("no verification, account state or flag row is remembered for it", async () => {
    const { w, client } = setup((x) => { x.flags.f = { flag: "f", enabled: true }; }, { cacheable: false });
    assert.equal(isHotPathCacheableClient(client), false);
    const token = jwt({ exp: inSeconds(3600) });
    await callRequireUser(token);
    await callRequireUser(token);
    await isFlagEnabled(client, "f");
    await isFlagEnabled(client, "f");
    assert.deepEqual([w.authCalls, w.gateReads, w.flagReads], [2, 2, 2]);
    assert.deepEqual(_hotPathCacheContentsForTest(), { tokenKeys: [], accountUserIds: [], flagKeys: [] });
  });

  it("_setTestClient / _setTestServiceClient empty every map, so no case inherits another's memory", async () => {
    setup();
    await callRequireUser(jwt({ exp: inSeconds(3600) }));
    assert.equal(_hotPathCacheContentsForTest().tokenKeys.length, 1);
    _setTestServiceClient(null);
    assert.deepEqual(_hotPathCacheContentsForTest(), { tokenKeys: [], accountUserIds: [], flagKeys: [] });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Invalidation, and the cross-instance bound
// ═════════════════════════════════════════════════════════════════════════════

describe("invalidation on this instance — the next request is answered fresh", () => {
  it("device revocation (the API's sign-out) ends the remembered verification: the revoked session is refused on its next request", async () => {
    const { w, client } = setup();
    const token = jwt({ exp: inSeconds(3600), session_id: SESSION });
    assert.equal((await callRequireUser(token)).ok, true);
    const report = await revokeDevice(client, { userId: USER, deviceId: DEVICE, callerToken: jwt({ exp: inSeconds(3600), session_id: OTHER_SESSION }), callerDeviceId: null });
    assert.equal(report.steps.auth_session, "done");
    const r = await callRequireUser(token);
    assert.equal(r.status, 401, "refused on the very next request, not after the TTL");
    assert.equal(r.body.message, REVOKED_DEVICE_MESSAGE);
    assert.equal(w.authCalls, 2, "re-verified after the revocation");
  });

  it("CROSS-INSTANCE BOUND — a revocation written elsewhere is seen within 30s, not before", async () => {
    const { w } = setup();
    const token = jwt({ exp: inSeconds(3600), session_id: SESSION });
    assert.equal((await callRequireUser(token)).ok, true);
    w.user.app_metadata = { [REVOKED_SESSIONS_METADATA_KEY]: [SESSION] }; // another instance revoked it
    assert.equal((await callRequireUser(token)).ok, true, "inside the TTL this instance still holds the earlier verification");
    advance(30_001);
    assert.equal((await callRequireUser(token)).status, 401, "past the TTL: re-verified, refused");
  });

  it("a ban through applyAccountRestriction refuses the very next request on this instance", async () => {
    const { w, client } = setup();
    const token = jwt({ exp: inSeconds(3600) });
    assert.equal((await callRequireUser(token)).ok, true);
    assert.equal((await callRequireUser(token)).ok, true);
    assert.equal(w.gateReads, 1);
    const applied = await applyAccountRestriction(client, { userId: USER, kind: "banned", reason: "test", expiresAt: null, actorId: "admin-1" });
    assert.equal(applied.ok, true);
    const r = await callRequireUser(token);
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, "account_banned");
  });

  it("a suspension through applyAccountRestriction refuses the very next optional-auth request too", async () => {
    const { client } = setup();
    const token = jwt({ exp: inSeconds(3600) });
    assert.equal((await optionalUser(reqWith(token)))?.user.id, USER);
    const until = new Date(Date.now() + 3_600_000).toISOString();
    assert.equal((await applyAccountRestriction(client, { userId: USER, kind: "suspended", reason: "test", expiresAt: until, actorId: "admin-1" })).ok, true);
    await assert.rejects(() => optionalUser(reqWith(token)), (e: any) => e?.status === 403 && e?.reason === "account_suspended");
  });

  it("CROSS-INSTANCE BOUND — a ban written elsewhere is enforced within 30s, not before", async () => {
    const { w } = setup();
    const token = jwt({ exp: inSeconds(3600) });
    assert.equal((await callRequireUser(token)).ok, true);
    w.states.push({ user_id: USER, state: "banned", expires_at: null }); // another instance's write
    assert.equal((await callRequireUser(token)).ok, true, "inside the TTL: the remembered unrestricted state");
    advance(30_001);
    const r = await callRequireUser(token);
    assert.equal(r.status, 403, "past the TTL: read again and refused");
  });

  it("a revoked session found on re-verification forgets the user's OTHER remembered tokens (the end-session path)", async () => {
    const { w } = setup();
    const refreshed = jwt({ exp: inSeconds(3600), session_id: SESSION, nonce: "refreshed" });
    const older = jwt({ exp: inSeconds(3600), session_id: SESSION, nonce: "older" });
    assert.equal((await callRequireUser(refreshed)).ok, true);
    w.user.app_metadata = { [REVOKED_SESSIONS_METADATA_KEY]: [SESSION] }; // revoked elsewhere
    assert.equal((await callRequireUser(older)).status, 401, "a token this instance had not seen is verified, and refused");
    assert.equal((await callRequireUser(refreshed)).status, 401, "and the other token of the same account is no longer served from memory");
  });

  it("an invalidation that runs while a verification is in flight: the in-flight answer is not stored", async () => {
    const { w } = setup();
    const token = jwt({ exp: inSeconds(3600) });
    let release!: () => void;
    w.authGate = new Promise<void>((r) => { release = r; });
    const pending = callRequireUser(token);
    await new Promise((r) => setImmediate(r));
    invalidateUserAuthCache(USER); // e.g. a ban written while GoTrue was answering
    release();
    assert.equal((await pending).ok, true);
    w.authGate = null;
    await callRequireUser(token);
    assert.equal(w.authCalls, 2, "the answer that raced the invalidation was not remembered");
  });

  it("account deletion invalidates after the tombstone and after the auth user is deleted (source pin)", () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "services", "accountDeletion", "AccountDeletionService.ts"), "utf8");
    const anonymise = src.indexOf('"anonymise profile",');
    const authDelete = src.indexOf("sc.auth.admin.deleteUser(userId)");
    const firstInvalidate = src.indexOf("invalidateUserAuthCache(userId)", anonymise);
    const secondInvalidate = src.indexOf("invalidateUserAuthCache(userId)", authDelete);
    assert.ok(anonymise > 0 && authDelete > anonymise, "the two steps are where this pin expects them");
    assert.ok(firstInvalidate > anonymise && firstInvalidate < authDelete, "invalidated after the tombstone, before the auth step");
    assert.ok(secondInvalidate > authDelete && secondInvalidate < src.indexOf('"mark_account_state"'), "invalidated again after the auth user is deleted");
  });

  it("bounded: past MAX_VERIFIED_TOKENS the OLDEST verification is evicted first", () => {
    _resetHotPathCachesForTest();
    const gen = authCacheGeneration();
    const tokens = Array.from({ length: MAX_VERIFIED_TOKENS + 1 }, (_, i) => jwt({ exp: inSeconds(3600), nonce: String(i) }));
    for (const t of tokens) assert.equal(rememberVerifiedUser(t, { id: USER, app_metadata: {} } as any, gen), true);
    const keys = new Set(_hotPathCacheContentsForTest().tokenKeys);
    const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
    assert.equal(keys.size, MAX_VERIFIED_TOKENS);
    assert.equal(keys.has(sha(tokens[0]!)), false, "the oldest is gone");
    assert.equal(keys.has(sha(tokens[MAX_VERIFIED_TOKENS]!)), true, "the newest is held");
    _resetHotPathCachesForTest();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Flag rows
// ═════════════════════════════════════════════════════════════════════════════

describe("flag cache — remembered 15s, a failure never", () => {
  it("a hit skips the read: isFlagEnabled, isKillSwitchEngaged and readFlagState share one read per 15s", async () => {
    const { w, client } = setup((x) => { x.flags.disable_tagging = { flag: "disable_tagging", enabled: false }; });
    assert.equal(await isKillSwitchEngaged(client, "disable_tagging"), false);
    assert.equal(await isFlagEnabled(client, "disable_tagging"), false);
    assert.equal(await readFlagState(client, "disable_tagging"), "off");
    assert.equal(w.flagReads, 1);
    w.flags.disable_tagging!.enabled = true; // written elsewhere
    assert.equal(await isKillSwitchEngaged(client, "disable_tagging"), false, "inside 15s: the remembered row");
    advance(15_001);
    assert.equal(await isKillSwitchEngaged(client, "disable_tagging"), true, "past 15s: read again");
    assert.equal(w.flagReads, 2);
  });

  it("an absent row is remembered as absent (a real answer), and a kill switch with no row is not engaged", async () => {
    const { w, client } = setup();
    assert.equal(await isKillSwitchEngaged(client, "disable_nothing"), false);
    assert.equal(await isKillSwitchEngaged(client, "disable_nothing"), false);
    assert.equal(w.flagReads, 1);
  });

  it("the kill switch ENGAGES on a read error, on every failed read — the error is never remembered", async () => {
    const { w, client } = setup((x) => { x.flags.disable_tagging = { flag: "disable_tagging", enabled: false }; x.flagFailure = { message: "connection refused", code: "08006" }; });
    assert.equal(await isKillSwitchEngaged(client, "disable_tagging"), true);
    assert.equal(await isKillSwitchEngaged(client, "disable_tagging"), true);
    assert.equal(await isFlagEnabled(client, "disable_tagging"), false);
    assert.equal(await readFlagState(client, "disable_tagging"), "unknown");
    assert.equal(await getFlagRow(client, "disable_tagging"), null);
    assert.equal(w.flagReads, 5, "every call read: nothing was remembered");
    assert.deepEqual(_hotPathCacheContentsForTest().flagKeys, []);
    w.flagFailure = null;
    assert.equal(await isKillSwitchEngaged(client, "disable_tagging"), false, "the first good read answers");
    assert.equal(w.flagReads, 6);
  });

  it("a read that THROWS engages the kill switch and is never remembered", async () => {
    const { w, client } = setup((x) => { x.flags.disable_tagging = { flag: "disable_tagging", enabled: false }; x.flagFailure = "throws"; });
    assert.equal(await isKillSwitchEngaged(client, "disable_tagging"), true);
    assert.equal(await isKillSwitchEngaged(client, "disable_tagging"), true);
    assert.equal(await readFlagState(client, "disable_tagging"), "unknown");
    assert.equal(w.flagReads, 3);
    assert.deepEqual(_hotPathCacheContentsForTest().flagKeys, []);
  });

  it("getFlagRow hands back a fresh copy of the remembered metadata", async () => {
    const { client } = setup((x) => { x.flags.mode_flag = { flag: "mode_flag", enabled: true, metadata: { mode: "legacy" } }; });
    const a = await getFlagRow(client, "mode_flag");
    (a!.metadata as any).mode = "pde";
    const b = await getFlagRow(client, "mode_flag");
    assert.equal((b!.metadata as any).mode, "legacy");
  });
});

describe("flag cache — busted by the admin PATCH routes", () => {
  let server: http.Server;
  let base = "";
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => { req.log = SILENT_LOG; next(); });
    app.use(adminRouter);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  after(() => { server.closeAllConnections?.(); server.close(); });

  function patch(p: string, body: unknown, token: string): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const url = new URL(p, base);
      const payload = JSON.stringify(body);
      const r = http.request({ hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${token}` } }, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { let b: any = raw; try { b = JSON.parse(raw); } catch { /* not JSON */ } resolve({ status: res.statusCode ?? 0, body: b }); });
      });
      r.on("error", reject);
      r.write(payload);
      r.end();
    });
  }

  it("PATCH /admin/feature-flags/:flag: the next read on this instance sees the new value at once", async () => {
    const { w, client } = setup((x) => { x.flags.disable_tagging = { flag: "disable_tagging", enabled: false }; });
    assert.equal(await isKillSwitchEngaged(client, "disable_tagging"), false);
    const epoch = featureFlagWriteEpoch();
    const r = await patch("/admin/feature-flags/disable_tagging", { enabled: true }, jwt({ exp: inSeconds(3600) }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await isKillSwitchEngaged(client, "disable_tagging"), true, "engaged on the next read, not after 15s");
    assert.equal(w.flagReads, 2);
    assert.ok(featureFlagWriteEpoch() > epoch, "the write epoch the older per-client caches compare advanced");
  });

  it("PATCH /admin/feature-flags/:flag/metadata: the next getFlagRow sees the new document at once", async () => {
    const { client } = setup((x) => { x.flags.mode_flag = { flag: "mode_flag", enabled: true, metadata: { mode: "legacy" } }; });
    assert.deepEqual((await getFlagRow(client, "mode_flag"))?.metadata, { mode: "legacy" });
    const r = await patch("/admin/feature-flags/mode_flag/metadata", { metadata: { mode: "shadow" } }, jwt({ exp: inSeconds(3600) }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((await getFlagRow(client, "mode_flag"))?.metadata, { mode: "shadow" });
  });

  it("a PATCH that FAILS still busts (an errored write may have committed): the next read goes to the database", async () => {
    const { w, client } = setup((x) => { x.flags.disable_tagging = { flag: "disable_tagging", enabled: false }; });
    await isFlagEnabled(client, "disable_tagging");
    const r = await patch("/admin/feature-flags/no_such_flag", { enabled: true }, jwt({ exp: inSeconds(3600) }));
    assert.equal(r.status, 404);
    await isFlagEnabled(client, "disable_tagging");
    assert.equal(w.flagReads, 2);
  });
});

describe("flag cache — every flag write the API makes busts it (ratchet)", () => {
  const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const WRITE = /\.rpc\(\s*["'](?:toggle_feature_flag_with_audit|set_feature_flag_metadata_with_audit)["']|\.from\(\s*["']feature_flags["']\s*\)\s*\.(?:update|upsert|insert|delete)\(/g;
  const BUST = /\binvalidateFeatureFlagCache\(\)/g;
  function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "test" || e.name === "__tests__" || e.name === "scripts" ? [] : walk(p);
      return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts") ? [p] : [];
    });
  }

  it("each production file that writes feature_flags calls invalidateFeatureFlagCache() at least once per write", () => {
    const writers: string[] = [];
    const short: string[] = [];
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, "utf8");
      const writes = text.match(WRITE)?.length ?? 0;
      if (writes === 0) continue;
      const rel = path.relative(SRC, file);
      writers.push(rel);
      const busts = text.match(BUST)?.length ?? 0;
      if (busts < writes) short.push(`${rel}: ${writes} write(s), ${busts} bust(s)`);
    }
    assert.ok(writers.length >= 6, `the scan found the known writers (found: ${writers.join(", ")})`);
    assert.deepEqual(short, [], "a flag write without invalidateFeatureFlagCache() leaves this instance serving the old row for 15s");
  });
});

describe("flag cache — the older per-client flag caches end on a flag write too", () => {
  it("discoveryStopGate's 30s manual-stop read ends on invalidateFeatureFlagCache", async () => {
    const { w, client } = setup((x) => { x.flags.disable_discovery_pde = { flag: "disable_discovery_pde", enabled: false }; });
    const t = Date.now();
    assert.equal(await discoveryStopHalt(client, {}, t), null);
    w.flags.disable_discovery_pde!.enabled = true;
    assert.equal(await discoveryStopHalt(client, {}, t + 1_000), null, "inside its TTL, with no write on this instance: unchanged");
    invalidateFeatureFlagCache();
    assert.equal(await discoveryStopHalt(client, {}, t + 2_000), "kill_switch_engaged", "a write on this instance ends it at once");
  });

  it("the Telegraph outbox fan-out answer ends on invalidateFeatureFlagCache", async () => {
    const { w, client } = setup((x) => {
      x.flags.telegraph_outbox_fanout_enabled = { flag: "telegraph_outbox_fanout_enabled", enabled: true };
      x.flags.telegraph_message_kernel_enabled = { flag: "telegraph_message_kernel_enabled", enabled: true };
    });
    assert.equal(await outboxFanoutInForce(client), true);
    w.flags.telegraph_outbox_fanout_enabled!.enabled = false;
    invalidateFeatureFlagCache();
    assert.equal(await outboxFanoutInForce(client), false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The one service client
// ═════════════════════════════════════════════════════════════════════════════

describe("getServiceClient — built once per process", () => {
  it("the same object on every call, PostgREST-backed and cacheable", () => {
    _setTestServiceClient(null);
    const a = getServiceClient();
    const b = getServiceClient();
    assert.ok(a, "the test script sets the (dummy, 127.0.0.1:9) service credentials; nothing here dials them");
    assert.equal(a, b);
    assert.equal(isPostgrestBackedClient(a), true);
    assert.equal(isHotPathCacheableClient(a), true);
  });

  it("inside a request's audit scope the wrapper is stable, and still recognised as the service client", () => {
    _setTestServiceClient(null);
    const raw = getServiceClient();
    const [p1, p2] = withLayoverSystemAudit("hot_path_test", () => [getServiceClient(), getServiceClient()]);
    assert.notEqual(p1, raw, "wrapped by auditedLayoverClient inside a scope");
    assert.equal(p1, p2);
    assert.equal(isPostgrestBackedClient(p1), true);
    assert.equal(isHotPathCacheableClient(p1), true);
  });

  it("an injected double is returned instead, and is neither PostgREST-backed nor cacheable; clearing it builds a new client", () => {
    _setTestServiceClient(null);
    const before = getServiceClient();
    const double = makeClient(freshWorld());
    _setTestServiceClient(double);
    assert.equal(getServiceClient(), double);
    assert.equal(isPostgrestBackedClient(double), false);
    assert.equal(isHotPathCacheableClient(double), false);
    _setTestServiceClient(null);
    const after = getServiceClient();
    assert.ok(after && after !== before, "a cleared double drops the memo");
    assert.equal(getServiceClient(), after);
  });
});
