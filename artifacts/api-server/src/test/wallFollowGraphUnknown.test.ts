/**
 * The Wall must not say "you're all caught up" when it could not read who you
 * follow.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * `loadViewerContext` reads `user_follows` as
 *
 *     const { data } = await sc.from("user_follows").select(...)   // no `error`
 *
 * inside a `try/catch`. supabase-js RESOLVES on a database error, so the catch
 * is dead code and an unreadable follow graph produces the same empty
 * `followedCreatorIds` as a viewer who follows nobody.
 *
 * `loadCandidates` then takes the empty set as proof:
 *
 *     if (mode === "following" && followed.length === 0)
 *       return { ...empty, followingReachedEnd: true };
 *
 * and `buildFollowing` turns `reachedEnd` into `caughtUp: true`. So a broken
 * `user_follows` renders as the POSITIVE CLAIM "there is nothing new from the
 * people you follow" — a statement about people, made by a server that could
 * not read the relationship at all. The comment above those reads says a failed
 * signal "degrades ranking quality, never the feed itself"; for this one read in
 * Following mode that was false.
 *
 * ── THE FIX UNDER TEST ───────────────────────────────────────────────────────
 * The follow-graph read binds and checks `error`, `WallViewerContext` carries
 * `followGraphKnown`, and an UNKNOWN graph withholds the `caughtUp` claim
 * instead of asserting it. The feed is still empty — that part is honest
 * degradation — but the server stops claiming it is complete.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/wallFollowGraphUnknown.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { makeFailClosedClient, type FakeReadContext } from "./helpers/failClosedSupabase.js";
import { _setTestClient } from "../lib/http.js";
import { loadViewerContext } from "../routes/wall.js";
import wallRouter from "../routes/wall.js";

const TOKEN  = "wall-follow-graph-token";
const VIEWER = "30000000-0000-4000-a000-000000000001";
const AUTHOR = "30000000-0000-4000-a000-000000000002";
const NOW_MS = Date.parse("2026-09-01T00:00:00Z");

/** Everything but the master gate off, isolating the Following spine. */
const FLAGS = [
  { flag: "wall_enabled", enabled: true },
  { flag: "wall_live_for_you_enabled", enabled: false },
  { flag: "wall_input_intelligence_enabled", enabled: false },
  { flag: "wall_discovery_insertions_enabled", enabled: false },
  { flag: "wall_compass_handoff_enabled", enabled: false },
  { flag: "wall_rab_integration_enabled", enabled: false },
  { flag: "wall_context_threads_enabled", enabled: false },
  { flag: "external_places_enabled", enabled: false },
  { flag: "live_places_enabled", enabled: false },
  { flag: "place_days_enabled", enabled: false },
  { flag: "shared_moments_enabled", enabled: false },
];

const POST = {
  id: "40000000-0000-4000-a000-000000000001",
  author_id: AUTHOR,
  trip_id: null,
  content: "a followed post",
  visibility: "public",
  status: "active",
  created_at: new Date(NOW_MS).toISOString(),
  published_at: new Date(NOW_MS).toISOString(),
  canonical_place_id: null,
  has_video: false,
  media_count: 0,
  category: null,
  location_city: null,
  location_country: null,
  like_count: 0,
  comment_count: 0,
  save_count: 0,
};

function rows(follows: Record<string, any>[]) {
  return {
    feature_flags: FLAGS,
    user_follows: follows,
    posts: [POST],
    profiles: [{ id: VIEWER, current_city: null, home_city: null, interests: [] }],
    trip_members: [] as any[],
    trips: [] as any[],
    rank_events: [] as any[],
    post_saves: [] as any[],
    blocks: [] as any[],
  };
}

const followsUnreadable = (ctx: FakeReadContext) =>
  ctx.table === "user_follows" ? { message: "user_follows unavailable", code: "57P01" } : null;

// ─────────────────────────────────────────────────────────────────────────────
// 1. The seam: does loadViewerContext know it failed?
// ─────────────────────────────────────────────────────────────────────────────

describe("loadViewerContext — an unreadable follow graph is not 'follows nobody'", () => {
  it("CONTROL: a readable graph is KNOWN and carries the follows", async () => {
    const sc = makeFailClosedClient({
      rows: rows([{ follower_id: VIEWER, following_id: AUTHOR }]),
    });
    const ctx = await loadViewerContext(sc, VIEWER);
    assert.equal(ctx.followGraphKnown, true);
    assert.deepEqual([...ctx.followedCreatorIds], [AUTHOR], "vacuity guard: the control read something");
  });

  it("CONTROL: a viewer who genuinely follows nobody is still KNOWN", async () => {
    const sc = makeFailClosedClient({ rows: rows([]) });
    const ctx = await loadViewerContext(sc, VIEWER);
    assert.equal(ctx.followGraphKnown, true, "an empty table is an answer; only an ERROR is not");
    assert.equal(ctx.followedCreatorIds.size, 0);
  });

  it("an unreadable user_follows is reported UNKNOWN, not empty-and-fine", async () => {
    const sc = makeFailClosedClient({
      rows: rows([{ follower_id: VIEWER, following_id: AUTHOR }]),
      failOn: followsUnreadable,
    });
    const ctx = await loadViewerContext(sc, VIEWER);
    assert.equal(ctx.followedCreatorIds.size, 0, "the set is empty either way — that is the whole trap");
    assert.equal(ctx.followGraphKnown, false, "…so the emptiness must be labelled");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The route: does the response CLAIM caught up?
// ─────────────────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method: "GET",
        headers: { authorization: `Bearer ${TOKEN}` },
      },
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
    r.end();
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  // The `req.log` shim the real server installs. Without it a route that logs
  // CRASHES and the 500-from-crash masquerades as a deliberate refusal.
  app.use((req: any, _res, next) => {
    const noop = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => noop };
    req.log = noop;
    next();
  });
  app.use("/api", wallRouter);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  const addr = server.address();
  assert.ok(addr !== null && typeof addr === "object", "server must be listening on a TCP port");
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
  _setTestClient(null, false);
});

describe("GET /wall?mode=following — caughtUp is a claim, not a default", () => {
  it("CONTROL: a viewer who genuinely follows nobody IS caught up", async () => {
    _setTestClient(makeFailClosedClient({ rows: rows([]), users: { [TOKEN]: VIEWER } }), true);
    const r = await get("/api/wall?mode=following");
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.mode, "following");
    assert.deepEqual(r.body.items, []);
    assert.equal(r.body.caughtUp, true, "an empty follow graph that WAS read is a real 'caught up'");
  });

  it("an unreadable user_follows returns an empty feed WITHOUT claiming caught up", async () => {
    _setTestClient(
      makeFailClosedClient({
        rows: rows([{ follower_id: VIEWER, following_id: AUTHOR }]),
        failOn: followsUnreadable,
        users: { [TOKEN]: VIEWER },
      }),
      true,
    );
    const r = await get("/api/wall?mode=following");
    // Not `status !== 200`: an empty Following page is a legitimate answer.
    // What must not survive is the CLAIM attached to it.
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(r.body.items, [], "the feed is empty — that part is honest degradation");
    assert.notEqual(
      r.body.caughtUp, true,
      "the server must not assert 'nothing new from the people you follow' when it could not read who you follow",
    );
  });
});
