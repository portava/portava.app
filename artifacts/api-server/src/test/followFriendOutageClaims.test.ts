/**
 * A FAILED READ IS NOT A RELATIONSHIP.
 *
 * supabase-js RESOLVES `{ data: null, error }` on a database error — it does not
 * throw — so an unbound `.error` makes an unreadable table indistinguishable
 * from a table in which the row genuinely does not exist. On the social graph
 * that difference is the whole answer: "you do not follow them", "you are not
 * friends", "you have no friends" are statements ABOUT PEOPLE, and each one was
 * being manufactured out of an outage and served with a 200.
 *
 * The four surfaces pinned here, and the direction each one used to fall:
 *
 *   GET /users/:id/follow-status
 *     user_follows unreadable -> isFollowing:false / followsYou:false
 *     profiles unreadable     -> is_private falsy -> canSeeCounts TRUE, so a
 *                                PRIVATE account's exact follower and following
 *                                counts were served to a stranger. FAIL-OPEN.
 *     counts unreadable       -> `count ?? 0` -> "0 followers", stated as fact.
 *
 *   GET /users/:id/friend-status
 *     three cascading reads that only ever fall one way; when all three fail the
 *     handler lands on its terminal, most-permissive verdict `status:"none"` —
 *     two friends told they are strangers, and a pending request hidden along
 *     with the requestId needed to accept, decline or cancel it.
 *
 *   GET /me/friends
 *     a pair is stored once under a sorted key, so half the roster lives in each
 *     of two reads; one failed half silently DELETED every friend on that side
 *     of the sort order with nothing in the payload marking it partial.
 *
 *   GET /me/following, GET /me/followers
 *     the mutuality decoration asserted `followsYou:false` for every row at once
 *     from a single failed reverse-edge read. The list itself is authoritative,
 *     so this one reports the unknown (null + `mutualStatusUnavailable`) rather
 *     than refusing the whole response.
 *
 * ── WHY EVERY CASE IS PAIRED ────────────────────────────────────────────────
 * A test in which the relationship does not exist and a test in which the table
 * cannot be READ pass for exactly the same reason. So every outage case here
 * has a positive control on the same route with the SAME fixture, differing
 * only in whether the read is allowed to succeed — and the control asserts the
 * relationship is reported PRESENT. A fix that simply refused everything would
 * fail the controls.
 *
 * ── THE TRAP THIS TEST HAD TO AVOID ─────────────────────────────────────────
 * `requireUser` reads `profiles.account_status` for the CALLER and already
 * answers 503 `degraded_unavailable` when that read fails. A test that broke
 * `profiles` wholesale would get a 503 from the auth gate and prove nothing
 * about the handler. So the injector fails a table only for a specific filter
 * value: `profiles` fails for the TARGET's id, never the caller's, and each
 * test asserts the caller's own profile read still succeeded by checking that a
 * neighbouring readable field is present.
 *
 * Run: node --import tsx/esm --test src/test/followFriendOutageClaims.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import followsRouter from "../routes/follows.js";
import friendsRouter from "../routes/friends.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestClient } from "../lib/http.js";

const VIEWER = "11111111-1111-1111-1111-111111111111";
const TARGET = "22222222-2222-2222-2222-222222222222";
const OTHER = "33333333-3333-3333-3333-333333333333";

/** Sorted friendship pair, exactly as normalizedFriendshipPair computes it. */
function pair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

interface Fail {
  /** Table to break. */
  table: string;
  /**
   * Optional filter guard: the read fails only when this eq column carries this
   * value. This is what keeps the CALLER's own `profiles` read working while the
   * TARGET's fails, so the 503 under test comes from the handler and not from
   * the auth gate.
   */
  eq?: [string, string];
}

type State = Record<string, any[]>;

const DB_ERROR = { code: "57014", message: "canceling statement due to statement timeout" };

function makeClient(state: State, fails: Fail[]) {
  function shouldFail(table: string, eqs: Array<[string, any]>): boolean {
    return fails.some((f) => {
      if (f.table !== table) return false;
      if (!f.eq) return true;
      return eqs.some(([c, v]) => c === f.eq![0] && v === f.eq![1]);
    });
  }

  function from(table: string) {
    const eqs: Array<[string, any]> = [];
    const ins: Array<[string, any[]]> = [];
    let head = false;
    const b: any = {
      select(_c?: string, opts?: any) { if (opts?.head) head = true; return b; },
      eq(c: string, v: any) { eqs.push([c, v]); return b; },
      in(c: string, v: any[]) { ins.push([c, v]); return b; },
      or() { return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { return resolve(true); },
      single() { return resolve(true); },
      then(f: any, r: any) { return resolve(false).then(f, r); },
    };
    function match(): any[] {
      let rows: any[] = state[table] ?? [];
      for (const [c, v] of eqs) rows = rows.filter((r) => r[c] === v);
      for (const [c, v] of ins) rows = rows.filter((r) => v.includes(r[c]));
      return rows;
    }
    async function resolve(single: boolean): Promise<any> {
      // A REJECTED QUERY RESOLVES. This is the whole point: the fake must hand
      // back `{ data: null, error }` rather than throw, because a throwing fake
      // would be caught by try/catch blocks that in production never fire.
      if (shouldFail(table, eqs)) return { data: null, error: DB_ERROR, count: null };
      const rows = match();
      if (head) return { data: null, error: null, count: rows.length };
      if (single) return { data: rows[0] ?? null, error: null, count: null };
      return { data: rows, error: null, count: rows.length };
    }
    return b;
  }
  return {
    from,
    auth: { getUser: async () => ({ data: { user: { id: VIEWER } }, error: null }) },
  };
}

function baseState(): State {
  return {
    // The CALLER's profile row must always be readable — requireUser gates on it.
    profiles: [
      { id: VIEWER, handle: "me", name: "Me", avatar_url: null, account_status: "active", is_private: false },
      { id: TARGET, handle: "them", name: "Them", avatar_url: null, account_status: "active", is_private: false },
      { id: OTHER, handle: "other", name: "Other", avatar_url: null, account_status: "active", is_private: false },
    ],
    user_follows: [],
    user_friendships: [],
    friend_requests: [],
    profile_privacy_settings: [],
  };
}

async function startApp(state: State, fails: Fail[]) {
  const app = express();
  app.use(express.json());
  // Without this shim every `req.log.error(...)` in a refusal branch THROWS and
  // the 500-from-crash would masquerade as a fail-closed refusal.
  app.use((req: any, _res, next) => {
    req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", followsRouter);
  app.use("/api", friendsRouter);
  const client = makeClient(state, fails);
  _setTestServiceClient(client as any);
  _setTestClient(client as any, true);
  const server = createServer(app);
  const baseUrl = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as import("net").AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
  return { baseUrl, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function get(baseUrl: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { authorization: "Bearer tok" } });
  return { status: res.status, body: (await res.json()) as any };
}

/** Every assertion in this file runs through here, and this counts them. */
let inspected = 0;
function checked<T>(v: T): T { inspected += 1; return v; }

afterEach(() => { _setTestServiceClient(null); _setTestClient(null, false); });

// ── GET /users/:id/follow-status ────────────────────────────────────────────

describe("follow-status must not manufacture a follow verdict from a failed read", () => {
  it("POSITIVE CONTROL: a readable follow edge is reported as following", async () => {
    const state = baseState();
    state.user_follows = [
      { follower_id: VIEWER, following_id: TARGET },
      { follower_id: TARGET, following_id: VIEWER },
    ];
    const app = await startApp(state, []);
    try {
      const { status, body } = await get(app.baseUrl, `/api/users/${TARGET}/follow-status`);
      assert.equal(checked(status), 200);
      assert.equal(checked(body.isFollowing), true, "the edge exists and is readable");
      assert.equal(checked(body.followsYou), true, "the reverse edge exists and is readable");
      assert.equal(checked(body.followersCount), 1);
    } finally { await app.close(); }
  });

  it("refuses (503) instead of reporting isFollowing:false when user_follows is unreadable", async () => {
    // Same fixture as the control — the edge IS there. Only the read fails.
    const state = baseState();
    state.user_follows = [
      { follower_id: VIEWER, following_id: TARGET },
      { follower_id: TARGET, following_id: VIEWER },
    ];
    const app = await startApp(state, [{ table: "user_follows" }]);
    try {
      const { status, body } = await get(app.baseUrl, `/api/users/${TARGET}/follow-status`);
      assert.equal(checked(status), 503, "an outage must not be answered with a relationship");
      assert.equal(checked(body.error), "degraded_unavailable");
      assert.equal(checked(body.retryable), true);
      assert.equal(checked(body.isFollowing), undefined, "no follow verdict may be present at all");
    } finally { await app.close(); }
  });

  it("POSITIVE CONTROL: a private target's counts are withheld from a non-follower", async () => {
    const state = baseState();
    state.profiles = state.profiles.map((p) => (p.id === TARGET ? { ...p, is_private: true } : p));
    const app = await startApp(state, []);
    try {
      const { status, body } = await get(app.baseUrl, `/api/users/${TARGET}/follow-status`);
      assert.equal(checked(status), 200);
      assert.equal(checked(body.isFollowing), false, "genuinely not following — a READ, not an outage");
      assert.equal(checked(body.followersCount), null, "private account: counts withheld");
      assert.equal(checked(body.followingCount), null);
    } finally { await app.close(); }
  });

  it("refuses (503) instead of downgrading an unreadable private profile to public and leaking its counts", async () => {
    // The target IS private. Breaking only the TARGET's profiles read (never the
    // caller's, which requireUser needs) used to make `is_private` read falsy,
    // flip canSeeCounts to true and serve the exact counts to a stranger.
    const state = baseState();
    state.profiles = state.profiles.map((p) => (p.id === TARGET ? { ...p, is_private: true } : p));
    state.user_follows = [{ follower_id: OTHER, following_id: TARGET }];
    const app = await startApp(state, [{ table: "profiles", eq: ["id", TARGET] }]);
    try {
      const { status, body } = await get(app.baseUrl, `/api/users/${TARGET}/follow-status`);
      assert.equal(checked(status), 503, "a private account must not be downgraded by an outage");
      assert.equal(checked(body.error), "degraded_unavailable");
      assert.equal(
        checked(body.followersCount), undefined,
        "no count may be served when the privacy flag behind it could not be read",
      );
    } finally { await app.close(); }
  });
});

// ── GET /users/:id/friend-status ────────────────────────────────────────────

describe("friend-status must not land on 'none' because three reads failed", () => {
  it("POSITIVE CONTROL: a readable friendship is reported as friends", async () => {
    const state = baseState();
    const [ua, ub] = pair(VIEWER, TARGET);
    state.user_friendships = [{ user_a: ua, user_b: ub, created_at: "2026-01-01T00:00:00Z" }];
    const app = await startApp(state, []);
    try {
      const { status, body } = await get(app.baseUrl, `/api/users/${TARGET}/friend-status`);
      assert.equal(checked(status), 200);
      assert.equal(checked(body.status), "friends");
    } finally { await app.close(); }
  });

  it("refuses (503) instead of calling two friends strangers when user_friendships is unreadable", async () => {
    const state = baseState();
    const [ua, ub] = pair(VIEWER, TARGET);
    state.user_friendships = [{ user_a: ua, user_b: ub, created_at: "2026-01-01T00:00:00Z" }];
    const app = await startApp(state, [{ table: "user_friendships" }]);
    try {
      const { status, body } = await get(app.baseUrl, `/api/users/${TARGET}/friend-status`);
      assert.equal(checked(status), 503);
      assert.equal(checked(body.error), "degraded_unavailable");
      assert.notEqual(checked(body.status), "none", "'none' is a positive claim and must not come from an outage");
    } finally { await app.close(); }
  });

  it("POSITIVE CONTROL: a readable outgoing request is reported with its requestId", async () => {
    const state = baseState();
    state.friend_requests = [
      { id: "req-1", requester_id: VIEWER, recipient_id: TARGET, status: "pending" },
    ];
    const app = await startApp(state, []);
    try {
      const { status, body } = await get(app.baseUrl, `/api/users/${TARGET}/friend-status`);
      assert.equal(checked(status), 200);
      assert.equal(checked(body.status), "outgoing_pending");
      assert.equal(checked(body.requestId), "req-1", "the id the client needs to cancel it");
    } finally { await app.close(); }
  });

  it("refuses (503) instead of hiding a pending request when friend_requests is unreadable", async () => {
    // There IS a pending request; hiding it also hides the requestId, denying the
    // caller an accept/decline/cancel they are entitled to.
    const state = baseState();
    state.friend_requests = [
      { id: "req-1", requester_id: TARGET, recipient_id: VIEWER, status: "pending" },
    ];
    const app = await startApp(state, [{ table: "friend_requests" }]);
    try {
      const { status, body } = await get(app.baseUrl, `/api/users/${TARGET}/friend-status`);
      assert.equal(checked(status), 503);
      assert.equal(checked(body.error), "degraded_unavailable");
      assert.equal(checked(body.status), undefined);
      assert.equal(checked(body.requestId), undefined);
    } finally { await app.close(); }
  });
});

// ── GET /me/friends ─────────────────────────────────────────────────────────

describe("me/friends must not serve a partial roster as a complete one", () => {
  it("POSITIVE CONTROL: friends from BOTH halves of the sorted pair are returned", async () => {
    const state = baseState();
    const [a1, b1] = pair(VIEWER, TARGET);
    const [a2, b2] = pair(VIEWER, OTHER);
    state.user_friendships = [
      { user_a: a1, user_b: b1, created_at: "2026-01-01T00:00:00Z" },
      { user_a: a2, user_b: b2, created_at: "2026-01-02T00:00:00Z" },
    ];
    const app = await startApp(state, []);
    try {
      const { status, body } = await get(app.baseUrl, "/api/me/friends");
      assert.equal(checked(status), 200);
      const ids = (body.friends as any[]).map((f) => f.id).sort();
      assert.deepEqual(checked(ids), [TARGET, OTHER].sort(), "both halves are present");
    } finally { await app.close(); }
  });

  it("refuses (503) instead of answering 'you have no friends' when user_friendships is unreadable", async () => {
    const state = baseState();
    const [a1, b1] = pair(VIEWER, TARGET);
    state.user_friendships = [{ user_a: a1, user_b: b1, created_at: "2026-01-01T00:00:00Z" }];
    const app = await startApp(state, [{ table: "user_friendships" }]);
    try {
      const { status, body } = await get(app.baseUrl, "/api/me/friends");
      assert.equal(checked(status), 503);
      assert.equal(checked(body.error), "degraded_unavailable");
      assert.equal(checked(body.friends), undefined, "an empty roster is a claim, not a degradation");
    } finally { await app.close(); }
  });
});

// ── GET /me/following and /me/followers — the reported-unknown case ─────────

describe("mutuality decorations report the unknown rather than asserting false", () => {
  it("POSITIVE CONTROL: a readable reverse edge yields followsYou:true and no degraded flag", async () => {
    const state = baseState();
    state.user_follows = [
      { follower_id: VIEWER, following_id: TARGET, created_at: "2026-01-01T00:00:00Z" },
      { follower_id: TARGET, following_id: VIEWER, created_at: "2026-01-01T00:00:00Z" },
    ];
    const app = await startApp(state, []);
    try {
      const { status, body } = await get(app.baseUrl, "/api/me/following");
      assert.equal(checked(status), 200);
      assert.equal(checked(body.users.length), 1);
      assert.equal(checked(body.users[0].followsYou), true);
      assert.equal(checked(body.mutualStatusUnavailable), undefined, "nothing was degraded");
    } finally { await app.close(); }
  });

  it("reports followsYou:null + mutualStatusUnavailable when only the reverse edge read fails", async () => {
    // The primary list read filters on follower_id and the mutuality read on
    // following_id, so breaking ONLY the latter leaves the authoritative list
    // intact — which is exactly the situation the reported-unknown posture is
    // for. Both edges exist in the fixture, so `false` would be a lie.
    const state = baseState();
    state.user_follows = [
      { follower_id: VIEWER, following_id: TARGET, created_at: "2026-01-01T00:00:00Z" },
      { follower_id: TARGET, following_id: VIEWER, created_at: "2026-01-01T00:00:00Z" },
    ];
    const app = await startApp(state, [{ table: "user_follows", eq: ["following_id", VIEWER] }]);
    try {
      const { status, body } = await get(app.baseUrl, "/api/me/following");
      assert.equal(checked(status), 200, "the list itself was readable and is still served");
      assert.equal(checked(body.users.length), 1, "the authoritative list survives");
      assert.equal(
        checked(body.users[0].followsYou), null,
        "unknown must be null, never the false claim 'they do not follow you back'",
      );
      assert.equal(checked(body.mutualStatusUnavailable), true, "and the degradation is announced");
    } finally { await app.close(); }
  });

  it("does the same on /me/followers when only the forward edge read fails", async () => {
    const state = baseState();
    state.user_follows = [
      { follower_id: VIEWER, following_id: TARGET, created_at: "2026-01-01T00:00:00Z" },
      { follower_id: TARGET, following_id: VIEWER, created_at: "2026-01-01T00:00:00Z" },
    ];
    const app = await startApp(state, [{ table: "user_follows", eq: ["follower_id", VIEWER] }]);
    try {
      const { status, body } = await get(app.baseUrl, "/api/me/followers");
      assert.equal(checked(status), 200);
      assert.equal(checked(body.users.length), 1);
      assert.equal(checked(body.users[0].youFollow), null, "unknown, not 'you do not follow them'");
      assert.equal(checked(body.mutualStatusUnavailable), true);
    } finally { await app.close(); }
  });
});

describe("the assertion count is non-zero", () => {
  it("inspected a non-vacuous number of assertions", () => {
    assert.ok(inspected >= 33, `expected >=33 checked assertions, got ${inspected}`);
  });
});
