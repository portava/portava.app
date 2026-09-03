/**
 * Wall route — discovery insertion is flag-gated + social-explained (spec §13),
 * and Context Threads attach through the route behind their own flag (spec §8/§9).
 *
 * Drives the real /wall router over HTTP with a table-routed fake client:
 *   • discovery flag OFF ⇒ For You stays inside the follow graph (no outside item);
 *   • discovery flag ON  ⇒ an outside post that CAN be socially explained (the
 *     viewer's trip city) is inserted WITH a discoveryReason, while an outside
 *     post with no social tie is dropped — never a naked directory listing;
 *   • context-thread flag ON ⇒ the trip-relevant object carries a trip_relevance
 *     Context Thread; OFF ⇒ no object carries one.
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

const BASE_FLAGS: Record<string, boolean> = {
  wall_enabled: true,
  wall_live_for_you_enabled: false,
  wall_discovery_insertions_enabled: false,
  wall_input_intelligence_enabled: false,
  wall_compass_handoff_enabled: false,
  wall_rab_integration_enabled: false,
  wall_context_threads_enabled: false,
};

const PROFILES: Record<string, any> = {
  [VIEWER]: { id: VIEWER, account_status: "active", current_city: "Da Nang", current_country: "VN", home_city: "Da Nang", interests: [] },
  "author-1": { id: "author-1", display_name: "Aya", username: "aya", avatar_url: null, account_status: "active" },
  "author-2": { id: "author-2", display_name: "Ben", username: "ben", avatar_url: null, account_status: "active" },
  "author-3": { id: "author-3", display_name: "Cy", username: "cy", avatar_url: null, account_status: "active" },
};

// author-1 = followed (Da Nang). author-2 = outside, place Bangkok (viewer trip).
// author-3 = outside, place Nowhere, low engagement (no social tie ⇒ dropped).
const POSTS = [
  { id: "post-1", author_id: "author-1", trip_id: null, content: "hi", visibility: "public", status: "active",
    created_at: "2026-08-30T10:00:00Z", published_at: "2026-08-30T10:00:00Z", canonical_place_id: "place-dn",
    has_video: false, media_count: 1, category: "food", location_city: "Da Nang", location_country: "VN",
    like_count: 2, comment_count: 0, save_count: 0 },
  { id: "post-2", author_id: "author-2", trip_id: null, content: "bkk nights", visibility: "public", status: "active",
    created_at: "2026-08-29T10:00:00Z", published_at: "2026-08-29T10:00:00Z", canonical_place_id: "place-bkk",
    has_video: false, media_count: 1, category: "nightlife", location_city: "Bangkok", location_country: "TH",
    like_count: 3, comment_count: 1, save_count: 1 },
  { id: "post-3", author_id: "author-3", trip_id: null, content: "meh", visibility: "public", status: "active",
    created_at: "2026-08-29T10:00:00Z", published_at: "2026-08-29T10:00:00Z", canonical_place_id: "place-now",
    has_video: false, media_count: 1, category: "misc", location_city: "Nowhere", location_country: "XX",
    like_count: 0, comment_count: 0, save_count: 0 },
];
const PLACES = [
  { id: "place-dn", name: "An Thuong", city: "Da Nang", country_code: "VN" },
  { id: "place-bkk", name: "Khao San", city: "Bangkok", country_code: "TH" },
  { id: "place-now", name: "Nowhere", city: "Nowhere", country_code: "XX" },
];
// Viewer has an upcoming trip to Bangkok — the social explanation for post-2 and
// the trip_relevance Context Thread on it.
const TRIPS = [{ id: "trip-9", owner_id: VIEWER, destination_city: "Bangkok", destination_country: "TH", start_date: "2026-09-20", status: "upcoming" }];

function fakeClient(flags: Record<string, boolean>) {
  function builder(table: string) {
    const eqs: Record<string, any> = {};
    const ins: Record<string, any[]> = {};
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => { eqs[c] = v; return b; },
      in: (c: string, v: any[]) => { ins[c] = v; return b; },
      gte: () => b,
      lte: () => b,
      gt: () => b,
      or: () => b,
      order: () => b,
      limit: () => b,
      insert: () => Promise.resolve({ error: null }),
      upsert: () => Promise.resolve({ error: null }),
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
      maybeSingle: () => {
        if (table === "feature_flags") return Promise.resolve({ data: { enabled: !!flags[String(eqs["flag"])] }, error: null });
        if (table === "profiles") return Promise.resolve({ data: PROFILES[String(eqs["id"])] ?? null, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then: (onF: any, onR: any) => {
        let data: any[] = [];
        if (table === "posts") {
          if (eqs["visibility"] === "public") data = POSTS.filter((p) => p.visibility === "public");
          else if (ins["author_id"]) data = POSTS.filter((p) => ins["author_id"].includes(p.author_id));
        } else if (table === "profiles") {
          data = ins["id"] ? ins["id"].map((id) => PROFILES[id]).filter(Boolean) : Object.values(PROFILES);
        } else if (table === "places") {
          data = ins["id"] ? PLACES.filter((p) => ins["id"].includes(p.id)) : PLACES;
        } else if (table === "trips") {
          data = TRIPS;
        } else if (table === "user_follows") {
          // Primary follows for the viewer; no meaningful second-degree here.
          if (ins["follower_id"]) data = []; // second-degree seeds ⇒ nothing new
          else if (eqs["follower_id"] === VIEWER) data = [{ following_id: "author-1" }];
        } else if (table === "trip_members" || table === "blocks" || table === "hidden_gems") {
          data = [];
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
        token === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "invalid" } },
    },
  };
}

let server: http.Server;
let baseUrl = "";
function request(method: string, path: string, opts: { token?: string } = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method,
        headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } },
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

function idsOf(json: any): string[] {
  return (json.items ?? []).map((i: any) => i.canonicalObjectId);
}

describe("Wall route — discovery insertion + context threads", () => {
  before(async () => {
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
    await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
  });

  it("discovery flag OFF ⇒ For You stays inside the follow graph", async () => {
    _clearPromotedScopeCache();
    _setTestClient(fakeClient({ ...BASE_FLAGS, wall_discovery_insertions_enabled: false }), true);
    const res = await request("GET", "/api/wall?mode=for_you", { token: TOKEN });
    assert.equal(res.status, 200);
    const ids = idsOf(res.json);
    assert.deepEqual(ids, ["post-1"], "only the followed-author post");
    assert.ok(!res.json.items.some((i: any) => i.objectType === "discovery"));
  });

  it("discovery flag ON ⇒ explained outside post inserted, unexplained dropped", async () => {
    _clearPromotedScopeCache();
    _setTestClient(fakeClient({ ...BASE_FLAGS, wall_discovery_insertions_enabled: true }), true);
    const res = await request("GET", "/api/wall?mode=for_you", { token: TOKEN });
    assert.equal(res.status, 200);
    const ids = idsOf(res.json);
    assert.ok(ids.includes("post-1"), "followed post present");
    assert.ok(ids.includes("post-2"), "trip-relevant outside post inserted");
    assert.ok(!ids.includes("post-3"), "unexplained outside post dropped (no naked listing)");
    const disc = res.json.items.find((i: any) => i.canonicalObjectId === "post-2");
    assert.equal(disc.objectType, "discovery");
    assert.match(disc.discoveryReason, /heading to Bangkok/);
  });

  it("context-thread flag ON ⇒ trip-relevant object carries a trip_relevance thread", async () => {
    _clearPromotedScopeCache();
    _setTestClient(
      fakeClient({ ...BASE_FLAGS, wall_discovery_insertions_enabled: true, wall_context_threads_enabled: true }),
      true,
    );
    const res = await request("GET", "/api/wall?mode=for_you", { token: TOKEN });
    assert.equal(res.status, 200);
    const post2 = res.json.items.find((i: any) => i.canonicalObjectId === "post-2");
    assert.ok(post2, "post-2 present");
    assert.ok(post2.contextThread, "post-2 carries a context thread");
    assert.equal(post2.contextThread.kind, "trip_relevance");
    assert.equal(post2.contextThread.action.type, "add_to_trip");
  });

  it("context-thread flag OFF ⇒ no object carries a thread", async () => {
    _clearPromotedScopeCache();
    _setTestClient(
      fakeClient({ ...BASE_FLAGS, wall_discovery_insertions_enabled: true, wall_context_threads_enabled: false }),
      true,
    );
    const res = await request("GET", "/api/wall?mode=for_you", { token: TOKEN });
    assert.equal(res.status, 200);
    assert.ok(!res.json.items.some((i: any) => i.contextThread), "no context threads when the flag is OFF");
  });
});
