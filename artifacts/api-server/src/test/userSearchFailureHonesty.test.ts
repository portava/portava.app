/**
 * GET /users/search — a read that failed is never answered as "nobody matched".
 *
 * The people search behind the Find Travelers screen (app/discover.tsx) and the
 * share, invite and close-friends pickers. Failure honesty (census-discovery
 * DV-83's principle, owner ruling D11): a failed read is never presented as an
 * empty or complete result.
 *
 * THE DEFECT. Five reads in the route failed CLOSED — correctly withholding
 * every row — but said so with the body a genuine miss gets, `200 {users: []}`:
 *   - the block-state read (error, or a thrown client);
 *   - the profile-discovery opt-out read (error, or thrown);
 *   - the name-visibility read (swallowed inside nameVisibilitySet, which then
 *     dropped every row that matched only on a real name);
 *   - the follow-state reads (ignored: a row came back "not following" when the
 *     viewer's follow edges could not be read);
 *   - the disable_profile_search stop, whose flag read also fails closed.
 * The client could not tell any of these from "no travelers found", and said
 * exactly that.
 *
 * THE FIX. A failed read answers `db_error` (500), the envelope the route's own
 * profiles read already used. The emergency stop keeps its 200 soft-stop shape
 * (emergencyFlags.test.ts pins it) and adds the refusal envelope
 * (lib/discoveryRefusal.ts, coverage "nothing"), so the body is no longer
 * byte-identical to a miss. Healthy bodies are unchanged: G1 pins one byte for
 * byte, captured before the fix.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/userSearchFailureHonesty.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import followsRouter from "../routes/follows.js";

const ME    = "aaa00000-0000-4000-a000-000000000001";
const ALICE = "bbb00000-0000-4000-a000-000000000002"; // public, real name shown, followed by ME
const BOB   = "ccc00000-0000-4000-a000-000000000003"; // real name hidden; matches "a" on the name only
const CARA  = "ddd00000-0000-4000-a000-000000000004"; // private: locked preview
const DANA  = "eee00000-0000-4000-a000-000000000005"; // ME has a pending friend request to her
const TOK   = "tok-me";

/**
 * Which read fails, and how. A key is a table name, or `table:eqColumn` for the
 * one table two different reads use (profile_privacy_settings: the discovery
 * opt-out filters on allow_profile_discovery, the name rule on show_real_name).
 */
type Failures = { error?: Set<string>; thrown?: Set<string> };

type State = {
  profiles: Array<Record<string, unknown>>;
  blocks: Array<{ blocker_id: string; blocked_id: string }>;
  profile_privacy_settings: Array<{ user_id: string; allow_profile_discovery: boolean; show_real_name: boolean }>;
  user_follows: Array<{ follower_id: string; following_id: string }>;
  friend_requests: Array<{ requester_id: string; recipient_id: string; status: string }>;
  feature_flags: Array<{ flag: string; enabled: boolean }>;
};

function healthyState(): State {
  return {
    profiles: [
      { id: ALICE, handle: "alice", username: "alice", name: "Alice Smith", avatar_url: "https://img/alice.png", is_private: false, verified: true, is_official: false },
      { id: BOB, handle: "bobby", username: "bobby", name: "Bob Hart", avatar_url: null, is_private: false, verified: false, is_official: false },
      { id: CARA, handle: "cara", username: "cara", name: "Cara Lane", avatar_url: "https://img/cara.png", is_private: true, verified: false, is_official: false },
      { id: DANA, handle: "dana", username: "dana", name: null, avatar_url: null, is_private: false, verified: false, is_official: true },
    ],
    blocks: [],
    profile_privacy_settings: [
      { user_id: ALICE, allow_profile_discovery: true, show_real_name: true },
      { user_id: BOB, allow_profile_discovery: true, show_real_name: false },
    ],
    user_follows: [
      { follower_id: ME, following_id: ALICE },
      { follower_id: DANA, following_id: ALICE },
    ],
    friend_requests: [{ requester_id: ME, recipient_id: DANA, status: "pending" }],
    feature_flags: [],
  };
}

function makeClient(state: State, fail: Failures = {}) {
  return {
    auth: {
      getUser: async (tok: string) =>
        tok === TOK
          ? { data: { user: { id: ME } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    from(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      let firstEq: string | null = null;
      const key = () => (table === "profile_privacy_settings" && firstEq ? `${table}:${firstEq}` : table);
      const source = (): any[] => {
        if (table === "profiles") return state.profiles.map((p) => ({ account_status: "active", ...p }));
        return ((state as any)[table] as any[] | undefined) ?? [];
      };
      const settle = (single: boolean) => {
        const k = key();
        if (fail.thrown?.has(k)) return Promise.reject(new Error(`${k} unreachable`));
        if (fail.error?.has(k)) return Promise.resolve({ data: null, error: { message: `${k} read failed`, code: "57014" } });
        const rows = source().filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null });
      };
      const b: any = {
        select: () => b,
        limit: () => b,
        order: () => b,
        gte: () => b,
        ilike: () => b,
        contains: () => b,
        eq(col: string, val: unknown) { if (!firstEq) firstEq = col; filters.push((r) => r[col] === val); return b; },
        neq(col: string, val: unknown) { filters.push((r) => r[col] !== val); return b; },
        in(col: string, vals: unknown[]) { filters.push((r) => vals.includes(r[col])); return b; },
        or(expr: string) {
          const parts = expr.split(",").map((p) => p.trim().match(/^(\w+)\.(\w+)\.(.*)$/)).filter(Boolean) as RegExpMatchArray[];
          filters.push((r) => parts.some(([, col, op, val]) => {
            if (op === "ilike") {
              const needle = val.replace(/^%|%$/g, "").replace(/\\(.)/g, "$1").toLowerCase();
              return String(r[col] ?? "").toLowerCase().includes(needle);
            }
            return String(r[col]) === val;
          }));
          return b;
        },
        maybeSingle: () => settle(true),
        then: (onF: any, onR: any) => settle(false).then(onF, onR),
      };
      return b;
    },
  };
}

let base = "";
let server: ReturnType<typeof createServer>;

before(async () => {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });
  app.use("/api", followsRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

after(() => server.close());

function use(state: State, fail: Failures = {}) {
  const c = makeClient(state, fail) as any;
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

async function search(q: string): Promise<{ status: number; text: string; body: any }> {
  const r = await fetch(`${base}/users/search?q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${TOK}` } });
  const text = await r.text();
  return { status: r.status, text, body: JSON.parse(text) };
}

/** A failed read: not a 200, not a `users` list, and named as the database's failure. */
function assertFailedRead(res: { status: number; body: any }, what: string) {
  assert.equal(res.status, 500, `${what}: a failed read must not answer 200 — got ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(res.body.error, "db_error", `${what}: the envelope names the failure`);
  assert.equal(res.body.users, undefined, `${what}: no users list rides on a failure`);
}

/**
 * Captured from the route BEFORE this fix, at f10a4ac9f, with healthyState()
 * and q=a. The fix must not move one byte of it.
 */
const GOLDEN_HEALTHY_Q_A =
  '{"users":[' +
  '{"id":"bbb00000-0000-4000-a000-000000000002","displayName":"Alice Smith","username":"alice","avatarUrl":"https://img/alice.png","followerCount":2,"isFollowing":true,"isPrivate":false,"friendRequestPending":false,"reason":null,"verified":true,"isOfficial":false},' +
  '{"id":"ddd00000-0000-4000-a000-000000000004","displayName":null,"username":"cara","avatarUrl":null,"followerCount":null,"isFollowing":false,"isPrivate":true,"friendRequestPending":false,"reason":null,"verified":false,"isOfficial":false},' +
  '{"id":"eee00000-0000-4000-a000-000000000005","displayName":null,"username":"dana","avatarUrl":null,"followerCount":0,"isFollowing":false,"isPrivate":false,"friendRequestPending":true,"reason":null,"verified":false,"isOfficial":true}' +
  "]}";

describe("GET /users/search — healthy answers are unchanged", () => {
  beforeEach(() => use(healthyState()));

  it("G1. a healthy search answers the pre-fix body byte for byte", async () => {
    const res = await search("a");
    assert.equal(res.status, 200);
    assert.equal(res.text, GOLDEN_HEALTHY_Q_A);
  });

  it("G2. a genuine miss is still exactly {\"users\":[]} — no refusal on it", async () => {
    const res = await search("zzzz");
    assert.equal(res.status, 200);
    assert.equal(res.text, '{"users":[]}');
  });

  it("G3. an empty query is still exactly {\"users\":[]}", async () => {
    const res = await search("@");
    assert.equal(res.status, 200);
    assert.equal(res.text, '{"users":[]}');
  });

  it("G4. a stop row present but OFF does not refuse", async () => {
    const s = healthyState();
    s.feature_flags = [{ flag: "disable_profile_search", enabled: false }];
    use(s);
    const res = await search("a");
    assert.equal(res.text, GOLDEN_HEALTHY_Q_A);
  });
});

describe("GET /users/search — a failed read is said, not answered as empty", () => {
  it("F1. the block-state read errors → db_error, not {users: []}", async () => {
    use(healthyState(), { error: new Set(["blocks"]) });
    assertFailedRead(await search("a"), "blocks error");
  });

  it("F2. the block-state read throws → db_error", async () => {
    use(healthyState(), { thrown: new Set(["blocks"]) });
    assertFailedRead(await search("a"), "blocks thrown");
  });

  it("F3. the discovery opt-out read errors → db_error", async () => {
    use(healthyState(), { error: new Set(["profile_privacy_settings:allow_profile_discovery"]) });
    assertFailedRead(await search("a"), "opt-out error");
  });

  it("F4. the discovery opt-out read throws → db_error", async () => {
    use(healthyState(), { thrown: new Set(["profile_privacy_settings:allow_profile_discovery"]) });
    assertFailedRead(await search("a"), "opt-out thrown");
  });

  it("F5. the name-visibility read fails → db_error, not the name-matched rows silently dropped", async () => {
    // "smith" matches Alice on her (shown) real name only. With the read failed
    // the old route dropped her and answered 200 {users: []}.
    use(healthyState(), { error: new Set(["profile_privacy_settings:show_real_name"]) });
    assertFailedRead(await search("smith"), "name visibility error");
  });

  it("F6. the viewer's follow-state read fails → db_error, not every row marked \"not following\"", async () => {
    use(healthyState(), { error: new Set(["user_follows"]) });
    assertFailedRead(await search("a"), "user_follows error");
  });

  it("F7. the pending-request read fails → db_error, not every request marked unsent", async () => {
    use(healthyState(), { error: new Set(["friend_requests"]) });
    assertFailedRead(await search("a"), "friend_requests error");
  });
});

describe("GET /users/search — the emergency stop refuses, it does not pose as a miss", () => {
  function assertStopRefusal(res: { status: number; body: any; text: string }) {
    assert.equal(res.status, 200, "the soft-stop status is kept (emergencyFlags.test.ts)");
    assert.deepEqual(res.body.users, [], "nothing is served while stopped");
    assert.notEqual(res.text, '{"users":[]}', "the stopped body must not be byte-identical to a miss");
    assert.equal(res.body.refusal?.coverage, "nothing");
    assert.equal(res.body.refusal?.class, "feature_disabled");
    assert.equal(res.body.refusal?.code, "profile_search_stopped");
  }

  it("K1. disable_profile_search engaged → the refusal envelope", async () => {
    const s = healthyState();
    s.feature_flags = [{ flag: "disable_profile_search", enabled: true }];
    use(s);
    assertStopRefusal(await search("a"));
  });

  it("K2. the stop's flag read fails (fail-closed: stopped) → the same refusal, still not a miss", async () => {
    use(healthyState(), { error: new Set(["feature_flags"]) });
    assertStopRefusal(await search("a"));
  });
});
