/**
 * Wall — a FAILED read must never be served as an EMPTY feed (spec §27/§34).
 *
 * THE DEFECT THIS PINS
 * ====================
 * supabase-js does NOT throw on a rejected query: it RESOLVES with
 * `{ data: null, error: {...} }`. Every Wall read written as
 *
 *     const { data } = await sc.from("posts")...;
 *     const rows = (data as any[]) ?? [];
 *
 * therefore discards the error, never enters its own `try/catch`, logs nothing,
 * and hands the feed an empty array that is INDISTINGUISHABLE from "this viewer
 * genuinely has nothing to read". In Following mode it is worse than
 * indistinguishable: `loadCandidates` derives `followingReachedEnd` from
 * `primary.length < CANDIDATE_FETCH`, so a permission error / schema drift / RLS
 * change produces `0 < 150` ⇒ "reached the end" ⇒ the response asserts
 * `caughtUp: true`. An outage renders as the "You're all caught up" trust
 * signal.
 *
 * WHAT IS ASSERTED
 * ================
 *  1. Following + the `posts` spine read rejected ⇒ NOT caughtUp, and the
 *     response says which lane failed (`degraded`).
 *  2. Following + the `user_follows` graph read rejected ⇒ NOT caughtUp. (An
 *     unreadable follow graph looks exactly like "follows nobody", which is the
 *     one input that short-circuits straight to "caught up".)
 *  3. THE CONTROL: a genuinely empty spine (no rows, NO error) still reports
 *     `caughtUp: true` and carries NO `degraded` marker. Without this the fix
 *     could be "always claim degraded", which distinguishes nothing.
 *  4. A supplementary loader failing (postcards) is reported as degraded while
 *     the Post spine still serves items — §34 graceful degradation is preserved,
 *     it is just no longer SILENT.
 *
 * Run: node --import tsx/esm --test src/test/wallFailureVsEmpty.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import wallRouter, { loadCandidates } from "../routes/wall.js";

const TOKEN = "tok";
const VIEWER = "viewer-1";
const AUTHOR = "author-1";

// Every subsystem flag OFF; only the master gate is ON. This isolates the Post
// spine + Following contract from the live strip, discovery and RAB.
const FLAGS: Record<string, boolean> = {
  wall_enabled: true,
  wall_live_for_you_enabled: false,
  wall_input_intelligence_enabled: false,
  wall_discovery_insertions_enabled: false,
  wall_compass_handoff_enabled: false,
  wall_rab_integration_enabled: false,
  wall_context_threads_enabled: false,
  external_places_enabled: false,
  live_places_enabled: false,
  place_days_enabled: false,
  shared_moments_enabled: false,
};

const VIEWER_PROFILE = {
  id: VIEWER,
  account_status: "active",
  current_city: null,
  home_city: null,
  interests: [],
};
const AUTHOR_PROFILE = {
  id: AUTHOR,
  display_name: "Aya",
  username: "aya",
  avatar_url: null,
  account_status: "active",
};

const POSTS = [
  {
    id: "post-1",
    author_id: AUTHOR,
    trip_id: null,
    content: "Sunset at An Thuong",
    visibility: "public",
    status: "active",
    post_status: "published",
    created_at: "2026-09-01T10:00:00Z",
    published_at: "2026-09-01T10:00:00Z",
    canonical_place_id: null,
    has_video: false,
    media_count: 0,
    category: null,
    location_city: null,
    location_country: null,
    like_count: 0,
    save_count: 0,
    comment_count: 0,
  },
];

/** A PostgREST-shaped rejection: resolves (never throws) with data:null. */
function pgrstError(code: string, message: string) {
  return { data: null, error: { code, message, details: null, hint: null } };
}

interface FakeOpts {
  /** Tables whose reads resolve with a PostgREST error instead of rows. */
  rejectTables?: Set<string>;
  /** Flag overrides merged over FLAGS. */
  flags?: Record<string, boolean>;
  /** Rows the `posts` table returns when it is NOT rejected. */
  posts?: any[];
  /** Rows the `user_follows` table returns when it is NOT rejected. */
  follows?: { following_id: string }[];
  /** Rows `passport_postcards` returns when it is NOT rejected. */
  postcards?: any[];
}

/**
 * A table-routed fake client. Any table listed in `rejectTables` RESOLVES with
 * `{ data: null, error }` — the real supabase-js failure shape, which is the
 * whole point: a thrown error would be caught by the route's existing
 * `try/catch`, and that is not the bug.
 */
function fakeClient(opts: FakeOpts = {}) {
  const reject = opts.rejectTables ?? new Set<string>();
  const flags = { ...FLAGS, ...(opts.flags ?? {}) };
  function builder(table: string) {
    const eqs: Record<string, any> = {};
    const ins: Record<string, any> = {};
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => {
        eqs[c] = v;
        return b;
      },
      in: (c: string, v: any) => {
        ins[c] = v;
        return b;
      },
      or: () => b,
      is: () => b,
      not: () => b,
      gt: () => b,
      gte: () => b,
      lt: () => b,
      lte: () => b,
      order: () => b,
      limit: () => b,
      insert: () => Promise.resolve({ error: null }),
      upsert: () => Promise.resolve({ error: null }),
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
      maybeSingle() {
        if (reject.has(table)) return Promise.resolve(pgrstError("42501", `${table} denied`));
        if (table === "feature_flags") {
          return Promise.resolve({ data: { enabled: !!flags[String(eqs["flag"])] }, error: null });
        }
        if (table === "profiles") {
          return Promise.resolve({ data: eqs["id"] === VIEWER ? VIEWER_PROFILE : null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(onF: any, onR: any) {
        if (reject.has(table)) {
          return Promise.resolve(pgrstError("42501", `${table} denied`)).then(onF, onR);
        }
        let data: any[] = [];
        if (table === "posts") data = (opts.posts ?? POSTS).slice();
        else if (table === "profiles") data = [VIEWER_PROFILE, AUTHOR_PROFILE];
        else if (table === "user_follows") {
          data = eqs["follower_id"] === VIEWER ? (opts.follows ?? [{ following_id: AUTHOR }]) : [];
        } else if (table === "passport_postcards") data = opts.postcards ?? [];
        else data = [];
        return Promise.resolve({ data, error: null }).then(onF, onR);
      },
    };
    return b;
  }
  return {
    from: builder,
    auth: {
      getUser: async (token: string) =>
        token === TOKEN
          ? { data: { user: { id: VIEWER } }, error: null }
          : { data: { user: null }, error: { message: "invalid" } },
    },
  };
}

// ONE server for the whole file, started/stopped at the top level, so no suite
// owns the lifecycle of another suite's transport.
let server: http.Server;
let baseUrl = "";

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", wallRouter);
  await new Promise<void>((resolve) => {
    server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      server.unref();
      resolve();
    });
  });
});

after(async () => {
  _clearTestClient();
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
});

beforeEach(() => {
  _clearPromotedScopeCache();
});

function request(path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: "GET",
        headers: { authorization: `Bearer ${TOKEN}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = raw;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("Wall: a failed read is never served as an empty feed (§27/§34)", () => {
  it("CONTROL: a genuinely empty spine reports caughtUp and NO degradation", async () => {
    _setTestClient(fakeClient({ posts: [] }) as any, true);
    const res = await request("/api/wall?mode=following&limit=20");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.items, [], "no rows ⇒ no items");
    assert.equal(res.json.caughtUp, true, "a genuinely empty followed spine IS caught up");
    assert.equal(
      res.json.degraded,
      undefined,
      "an honestly empty feed must carry NO degradation marker — otherwise the marker distinguishes nothing",
    );
  });

  it("a rejected `posts` spine read is NOT reported as 'you're all caught up'", async () => {
    _setTestClient(fakeClient({ rejectTables: new Set(["posts"]) }) as any, true);
    const res = await request("/api/wall?mode=following&limit=20");
    assert.equal(res.status, 200, "§34: the route still answers, it does not 500");
    assert.deepEqual(res.json.items, []);
    assert.notEqual(
      res.json.caughtUp,
      true,
      "a spine read that FAILED has not reached the end of anything — claiming caughtUp turns an outage into a trust signal",
    );
    assert.ok(
      Array.isArray(res.json.degraded) && res.json.degraded.includes("spine"),
      `the response must name the failed lane; got degraded=${JSON.stringify(res.json.degraded)}`,
    );
  });

  it("a rejected `user_follows` read is NOT reported as 'you're all caught up'", async () => {
    _setTestClient(fakeClient({ rejectTables: new Set(["user_follows"]) }) as any, true);
    const res = await request("/api/wall?mode=following&limit=20");
    assert.equal(res.status, 200);
    assert.notEqual(
      res.json.caughtUp,
      true,
      "an UNREADABLE follow graph is not the same fact as 'follows nobody' — only the latter is caught up",
    );
    assert.ok(
      Array.isArray(res.json.degraded) && res.json.degraded.includes("follow_graph"),
      `the response must name the failed lane; got degraded=${JSON.stringify(res.json.degraded)}`,
    );
  });

  it("For You: a rejected `posts` spine read is reported, not served as a quiet feed", async () => {
    _setTestClient(fakeClient({ rejectTables: new Set(["posts"]) }) as any, true);
    const res = await request("/api/wall?mode=for_you&limit=20");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.items, []);
    assert.ok(
      Array.isArray(res.json.degraded) && res.json.degraded.includes("spine"),
      `For You must report the failed spine too; got degraded=${JSON.stringify(res.json.degraded)}`,
    );
  });

  it("a failed SUPPLEMENTARY loader is reported while the spine still serves (§34)", async () => {
    _setTestClient(
      fakeClient({ rejectTables: new Set(["passport_postcards"]) }) as any,
      true,
    );
    const res = await request("/api/wall?mode=following&limit=20");
    assert.equal(res.status, 200);
    assert.equal(res.json.items.length, 1, "§34: the Post spine is untouched by a loader failure");
    assert.ok(
      Array.isArray(res.json.degraded) && res.json.degraded.includes("postcards"),
      `a silently-empty postcard lane is exactly the defect; got degraded=${JSON.stringify(res.json.degraded)}`,
    );
    assert.notEqual(
      res.json.caughtUp,
      true,
      "a lane that could have carried followed content did not answer, so the END of that content was never established — the trust signal is withheld, not guessed",
    );
  });
});

describe("Wall live strip + quick media: empty by nature is not empty by failure", () => {
  it("GET /wall/live CONTROL: nothing live right now carries NO degradation", async () => {
    _setTestClient(fakeClient({ flags: { wall_live_for_you_enabled: true } }) as any, true);
    const res = await request("/api/wall/live");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.liveForYou, [], "no live signals is the ordinary answer");
    assert.equal(res.json.degraded, undefined, "and it must not be dressed up as an outage");
  });

  it("GET /wall/live: the strip's place source failing is reported, not served as 'nothing live'", async () => {
    _setTestClient(
      fakeClient({ flags: { wall_live_for_you_enabled: true }, rejectTables: new Set(["posts"]) }) as any,
      true,
    );
    const res = await request("/api/wall/live");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.liveForYou, [], "§34: an empty strip, never a fabricated live label");
    assert.ok(
      Array.isArray(res.json.degraded) && res.json.degraded.includes("live"),
      `on this route the strip IS the whole answer; got degraded=${JSON.stringify(res.json.degraded)}`,
    );
  });

  it("GET /wall/quick-media CONTROL: nobody posted today carries NO degradation", async () => {
    _setTestClient(fakeClient() as any, true);
    const res = await request("/api/wall/quick-media");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.items, []);
    assert.equal(res.json.degraded, undefined, "a quiet Stories row is a real, common state");
  });

  it("GET /wall/quick-media: an unreadable BLOCK list fails closed AND says so", async () => {
    // The block read failing makes fetchBlockedSet return null, which §18 turns
    // into an empty row on purpose (fail-closed). Correct — and previously
    // indistinguishable from the control above.
    _setTestClient(fakeClient({ rejectTables: new Set(["blocks"]) }) as any, true);
    const res = await request("/api/wall/quick-media");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.items, [], "fail-closed still yields no items");
    assert.ok(
      Array.isArray(res.json.degraded) && res.json.degraded.includes("quick_media"),
      `a fail-CLOSED empty row must be distinguishable from a naturally empty one; got degraded=${JSON.stringify(res.json.degraded)}`,
    );
  });
});

/**
 * The route applies TWO independent guards against a dishonest `caughtUp`:
 * `loadCandidates` refuses to infer `followingReachedEnd` from a graph it could
 * not read, and the handler withdraws `caughtUp` whenever any lane is degraded.
 * Over HTTP the second masks the first, so a regression in `loadCandidates`
 * survives every route-level test. These pin the seam's own answer.
 */
describe("loadCandidates: `followingReachedEnd` is never inferred from an unread graph", () => {
  /** A client whose every read answers with no rows and no error. */
  const quietClient = () => fakeClient({ posts: [], follows: [] }) as any;

  const baseViewer = () => ({
    followedCreatorIds: new Set<string>(),
    viewerTripIds: new Set<string>(),
    currentCity: null,
    currentCountry: null,
    mutualFollowedAuthorIds: new Set<string>(),
    upcomingTripCities: new Set<string>(),
    preferredCities: new Set<string>(),
    interests: new Set<string>(),
  });

  it("a viewer who genuinely follows nobody HAS reached the end", async () => {
    const loaded = await loadCandidates(quietClient(), "following", baseViewer(), {
      discoveryEnabled: false,
    });
    assert.equal(
      loaded.followingReachedEnd,
      true,
      "following nobody is a real, terminal fact — this is the claim that must stay available",
    );
  });

  it("a viewer whose follow graph could NOT be read has reached the end of nothing", async () => {
    const loaded = await loadCandidates(
      quietClient(),
      "following",
      { ...baseViewer(), followGraphFailed: true },
      { discoveryEnabled: false },
    );
    assert.equal(
      loaded.followingReachedEnd,
      false,
      "an empty set that came from a FAILED read must not be reported as the end of the spine",
    );
  });
});
