/**
 * Wall route — the RAB contextual-opportunity producer is WIRED (spec §19):
 *
 *   • For You, both flags ON ⇒ the page carries a contextual_opportunity item
 *     (buddy_around) alongside the followed post, with a coarse book_buddy action;
 *   • Following ⇒ never (Following is the strict chronology of followed
 *     PEOPLE's content, TABLE 1 — an availability signal is not a post);
 *   • wall_rab_integration_enabled OFF ⇒ no opportunity on For You;
 *   • rent_buddy_enabled OFF ⇒ no opportunity on For You (master fail-closed).
 *
 * Drives the real /wall router over HTTP with a table-routed fake client that
 * also serves the consolidated booking gate's reads.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { invalidateGcCache } from "../routes/rentABuddyRollout.js";
import wallRouter from "../routes/wall.js";

const TOKEN = "tok";
const VIEWER = "viewer-1";
const NOW = Date.now();
const iso = (deltaMs: number) => new Date(NOW + deltaMs).toISOString();

const BASE_FLAGS: Record<string, boolean> = {
  wall_enabled: true,
  wall_live_for_you_enabled: false,
  wall_discovery_insertions_enabled: false,
  wall_input_intelligence_enabled: false,
  wall_compass_handoff_enabled: false,
  wall_rab_integration_enabled: true,
  wall_context_threads_enabled: false,
  rent_buddy_enabled: true,
};

const PROFILES: Record<string, any> = {
  [VIEWER]: { id: VIEWER, account_status: "active", current_city: "Da Nang", home_city: "Da Nang", interests: ["food"],
    date_of_birth: "1990-01-01", verification_status: "verified", id_verified_at: iso(-1), phone_verified_at: iso(-1) },
  "author-1": { id: "author-1", display_name: "Aya", username: "aya", avatar_url: null, account_status: "active" },
  "buddy-user-1": { id: "buddy-user-1", display_name: "Minh", username: "minh", avatar_url: null, account_status: "active" },
};

const POSTS = [
  { id: "post-1", author_id: "author-1", trip_id: null, content: "hi", visibility: "public", status: "active",
    created_at: iso(-3_600_000), published_at: iso(-3_600_000), canonical_place_id: null,
    has_video: false, media_count: 0, category: "food", location_city: "Da Nang", location_country: "VN",
    like_count: 2, comment_count: 0, save_count: 0 },
];

const BUDDIES = [
  { id: "bp-1", user_id: "buddy-user-1", display_name: "Minh", tagline: "Food crawl", city: "Da Nang", country: "VN",
    categories: ["food"], available_now: true, available_now_until: iso(3_600_000), preferred_meetup_zones: ["An Thuong"],
    cover_photo_url: "profile-media/covers/buddy-user-1/c.jpg", gallery_urls: [], intro_video_url: null,
    buddy_level: "established", updated_at: iso(-60_000), status: "active", admin_status: "active", risk_hold: false,
    category_approvals: {}, nightlife_admin_approved: false, verification_status: "verified", id_verified: true, phone_verified: true,
    meetup_base_lat: 16.05, meetup_base_lng: 108.2 },
];

function fakeClient(flags: Record<string, boolean>) {
  function builder(table: string) {
    const eqs: Record<string, any> = {};
    const ins: Record<string, any[]> = {};
    const iss: Record<string, any> = {};
    const ilikes: Record<string, string> = {};
    let single = false;
    function resolve(): any {
      if (table === "feature_flags") return { data: { enabled: !!flags[String(eqs.flag)] }, error: null };
      if (table === "profiles") {
        if (single) return { data: PROFILES[String(eqs.id)] ?? null, error: null };
        return { data: (ins.id ?? Object.keys(PROFILES)).map((i) => PROFILES[i]).filter(Boolean), error: null };
      }
      if (table === "posts") {
        if (ins.author_id) return { data: POSTS.filter((p) => ins.author_id.includes(p.author_id)), error: null };
        return { data: [], error: null };
      }
      if (table === "user_follows") {
        if (ins.follower_id) return { data: [], error: null };
        if (eqs.follower_id === VIEWER) return { data: [{ following_id: "author-1" }], error: null };
        return { data: [], error: null };
      }
      if (table === "rent_buddy_profiles") {
        if (eqs.user_id !== undefined) return { data: BUDDIES.find((b) => b.user_id === eqs.user_id) ?? null, error: null };
        let rows = BUDDIES;
        for (const [c, v] of Object.entries(eqs)) rows = rows.filter((r: any) => r[c] === v);
        return { data: single ? rows[0] ?? null : rows, error: null };
      }
      if (table === "rent_buddy_city_rollouts") {
        const want = String(ilikes.city ?? "").toLowerCase();
        return { data: want === "da nang" ? { id: "cr", status: "public_mvp" } : null, error: null };
      }
      if (table === "rent_buddy_launch_controls") return single ? { data: null, error: null } : { data: [], count: 0, error: null };
      if (table === "blocks") return { data: single ? null : [], error: null };
      return { data: single ? null : [], error: null };
    }
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => { eqs[c] = v; return b; },
      in: (c: string, v: any[]) => { ins[c] = v; return b; },
      is: (c: string, v: any) => { iss[c] = v; return b; },
      ilike: (c: string, v: string) => { ilikes[c] = v; return b; },
      gte: () => b, lte: () => b, gt: () => b, or: () => b, order: () => b, limit: () => b,
      insert: () => Promise.resolve({ error: null }),
      upsert: () => Promise.resolve({ error: null }),
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
      maybeSingle: () => { single = true; return Promise.resolve().then(resolve); },
      then: (onF: any, onR: any) => Promise.resolve().then(resolve).then(onF, onR),
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
function request(method: string, path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method,
        headers: { authorization: `Bearer ${TOKEN}` } },
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

function opportunities(json: any): any[] {
  return (json.items ?? []).filter((i: any) => i.objectType === "contextual_opportunity");
}

describe("Wall route — RAB opportunity producer wiring", () => {
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

  it("For You with both flags ON carries a buddy_around opportunity with a coarse book_buddy action", async () => {
    _clearPromotedScopeCache(); invalidateGcCache();
    _setTestClient(fakeClient(BASE_FLAGS), true);
    const res = await request("GET", "/api/wall?mode=for_you");
    assert.equal(res.status, 200);
    const ops = opportunities(res.json);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].opportunityKind, "buddy_around");
    assert.equal(ops[0].canonicalObjectId, "bp-1");
    assert.equal(ops[0].actor.isBuddy, true);
    assert.equal(ops[0].actor.buddyRole, "Food Buddy");
    const book = ops[0].actions.find((a: any) => a.type === "book_buddy");
    assert.deepEqual(book.params, { area: "Da Nang" });
    assert.ok(!/16\.05|108\.2|meetup_base/.test(JSON.stringify(res.json)), "no coordinate on the wire");
    // The social spine is untouched.
    assert.ok(res.json.items.some((i: any) => i.canonicalObjectId === "post-1"));
  });

  it("Following never carries an opportunity", async () => {
    _clearPromotedScopeCache(); invalidateGcCache();
    _setTestClient(fakeClient(BASE_FLAGS), true);
    const res = await request("GET", "/api/wall?mode=following");
    assert.equal(res.status, 200);
    assert.equal(opportunities(res.json).length, 0);
    assert.ok(res.json.items.some((i: any) => i.canonicalObjectId === "post-1"));
  });

  it("wall_rab_integration_enabled OFF ⇒ no opportunity", async () => {
    _clearPromotedScopeCache(); invalidateGcCache();
    _setTestClient(fakeClient({ ...BASE_FLAGS, wall_rab_integration_enabled: false }), true);
    const res = await request("GET", "/api/wall?mode=for_you");
    assert.equal(res.status, 200);
    assert.equal(opportunities(res.json).length, 0);
    assert.ok(res.json.items.some((i: any) => i.canonicalObjectId === "post-1"), "feed still serves");
  });

  it("rent_buddy_enabled (master) OFF ⇒ no opportunity", async () => {
    _clearPromotedScopeCache(); invalidateGcCache();
    _setTestClient(fakeClient({ ...BASE_FLAGS, rent_buddy_enabled: false }), true);
    const res = await request("GET", "/api/wall?mode=for_you");
    assert.equal(res.status, 200);
    assert.equal(opportunities(res.json).length, 0);
  });
});
