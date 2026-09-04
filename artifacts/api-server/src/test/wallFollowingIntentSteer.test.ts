/**
 * Wall — session-intent steer is FOR YOU ONLY (spec §5 / §17 / TABLE 1).
 *
 * Following is the strict-chronology trust anchor: "No relevance reordering.
 * Apply only safety/visibility filters." An intent steer is a relevance filter,
 * so it must never touch Following. Two bugs the guard closes:
 *   1. an active intent would be echoed in the Following response, and
 *   2. a steer that dropped the tail would let `caughtUp` claim "all caught up"
 *      over a FILTERED subset — a false trust signal.
 *
 * A stored intent (keyword "museum") is served to BOTH requests. For You must
 * echo it and keep only the museum posts; Following must ignore it entirely —
 * no echo, no filter, and `caughtUp` honest over the full followed set.
 *
 * Run: node --import tsx/esm --test src/test/wallFollowingIntentSteer.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import wallRouter from "../routes/wall.js";

const TOKEN = "tok";
const VIEWER = "viewer-1";
const AUTHOR = "author-1";
const BASE_MS = Date.parse("2026-09-01T00:00:00Z");

// input intelligence ON so, absent the mode guard, Following WOULD resolve and
// steer by the stored intent. The master gate is ON; everything else OFF.
const FLAGS: Record<string, boolean> = {
  wall_enabled: true,
  wall_input_intelligence_enabled: true,
  wall_live_for_you_enabled: false,
  wall_discovery_insertions_enabled: false,
  wall_compass_handoff_enabled: false,
  wall_rab_integration_enabled: false,
  wall_context_threads_enabled: false,
  external_places_enabled: false,
  live_places_enabled: false,
  shared_moments_enabled: false,
};

function createdAtOf(i: number): string {
  return new Date(BASE_MS - i * 60_000).toISOString();
}
// post-0 beach, post-1 museum, post-2 museum → keyword "museum" matches 2 of 3.
const POSTS = [
  { content: "a lovely beach day" },
  { content: "the city museum tour" },
  { content: "museum of modern art" },
].map((p, i) => ({
  id: `post-${i}`,
  author_id: AUTHOR,
  trip_id: null,
  content: p.content,
  visibility: "public",
  status: "active",
  post_status: "published",
  created_at: createdAtOf(i),
  published_at: createdAtOf(i),
  canonical_place_id: null,
  has_video: false,
  media_count: 0,
  category: null,
  location_city: null,
  location_country: null,
  like_count: 0,
  save_count: 0,
  comment_count: 0,
}));

const VIEWER_PROFILE = { id: VIEWER, account_status: "active", current_city: null, home_city: null, interests: [] };
const AUTHOR_PROFILE = { id: AUTHOR, display_name: "Aya", username: "aya", avatar_url: null, account_status: "active" };
const STORED_INTENT = { filters: [], keywords: ["museum"], sessionScoped: true, createdAt: createdAtOf(0) };

function fakeClient() {
  function builder(table: string) {
    const eqs: Record<string, any> = {};
    const ins: Record<string, any> = {};
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => { eqs[c] = v; return b; },
      in: (c: string, v: any) => { ins[c] = v; return b; },
      or: () => b,
      gt: () => b, gte: () => b, lt: () => b, lte: () => b, not: () => b, order: () => b, limit: () => b,
      maybeSingle() {
        if (table === "feature_flags") return Promise.resolve({ data: { enabled: !!FLAGS[String(eqs["flag"])] }, error: null });
        if (table === "profiles") return Promise.resolve({ data: eqs["id"] === VIEWER ? VIEWER_PROFILE : null, error: null });
        if (table === "wall_session_intents") return Promise.resolve({ data: { structured_intent: STORED_INTENT }, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then(onF: any, onR: any) {
        let data: any[] = [];
        if (table === "posts") {
          data = POSTS.filter((r) => (ins["author_id"] ? ins["author_id"].includes(r.author_id) : true));
          data.sort((a, b2) => (a.created_at < b2.created_at ? 1 : -1));
        } else if (table === "profiles") {
          data = [VIEWER_PROFILE, AUTHOR_PROFILE];
        } else if (table === "user_follows") {
          data = eqs["follower_id"] === VIEWER ? [{ following_id: AUTHOR }] : []; // no second-degree
        } else {
          data = [];
        }
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

let server: http.Server;
let baseUrl = "";

function request(path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: "GET", headers: { authorization: `Bearer ${TOKEN}` } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try { json = raw ? JSON.parse(raw) : null; } catch { json = raw; }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("Wall session-intent steer is For You only (spec §5/§17)", () => {
  before(async () => {
    _setTestClient(fakeClient(), true);
    const app = express();
    app.use(express.json());
    app.use("/api", wallRouter);
    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
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

  it("For You echoes the stored intent AND steers to matching posts", async () => {
    _clearPromotedScopeCache();
    const res = await request(`/api/wall?mode=for_you&limit=20`);
    assert.equal(res.status, 200);
    assert.equal(res.json.mode, "for_you");
    assert.ok(res.json.sessionIntent, "For You echoes the active session intent");
    assert.deepEqual(res.json.sessionIntent.keywords, ["museum"]);
    const ids = new Set(res.json.items.map((i: any) => i.canonicalObjectId));
    assert.deepEqual(ids, new Set(["post-1", "post-2"]), "only the museum posts survive the steer");
    assert.ok(!ids.has("post-0"), "the beach post is steered out of For You");
  });

  it("Following IGNORES the intent — no echo, no filter, caughtUp honest", async () => {
    _clearPromotedScopeCache();
    const res = await request(`/api/wall?mode=following&limit=20`);
    assert.equal(res.status, 200);
    assert.equal(res.json.mode, "following");
    assert.equal(res.json.sessionIntent, undefined, "Following never echoes a relevance steer");
    const ids = res.json.items.map((i: any) => i.canonicalObjectId);
    assert.deepEqual(ids, ["post-0", "post-1", "post-2"], "the FULL followed set is returned, unfiltered and in strict chronology");
    assert.equal(res.json.caughtUp, true, "caughtUp is honest over the whole followed set, not a filtered subset");
  });

  it("a session_intent QUERY PARAM is likewise ignored in Following", async () => {
    _clearPromotedScopeCache();
    const res = await request(`/api/wall?mode=following&limit=20&session_intent=${encodeURIComponent("beach")}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.sessionIntent, undefined);
    assert.equal(res.json.items.length, 3, "a per-request steer cannot filter Following either");
  });
});
