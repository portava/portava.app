/**
 * Wall route — Following pagination honesty (spec §27, D10 regression).
 *
 * A viewer with MORE than the candidate-fetch cap (150) of eligible followed
 * posts must be able to page past the 150th item, and the feed must NOT falsely
 * report `caughtUp: true` on a mid-tail page. Before the fix the Following fetch
 * ignored the cursor and always returned the newest 150 rows; once the cursor
 * passed the 150th item the after-cursor window was empty, the tail was
 * unreachable, and `caughtUp` was wrongly reported true.
 *
 * The fake `posts` reader faithfully honours `.order(created_at desc)`,
 * `.lte(created_at, X)` and `.limit(N)` so the 150-row cap and the cursor-slide
 * are actually simulated.
 *
 * Run: node --import tsx/esm --test src/test/wallFollowingCaughtUp.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { encodeFollowingCursor } from "../services/wall/FollowingFeedService.js";
import wallRouter from "../routes/wall.js";

const TOKEN = "tok";
const VIEWER = "viewer-1";
const AUTHOR = "author-1";
const TOTAL_POSTS = 200; // > CANDIDATE_FETCH (150)
const BASE_MS = Date.parse("2026-09-01T00:00:00Z");

// Every flag that would pull in extra subsystems is OFF, isolating the Following
// spine (the master gate is ON so the route runs).
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

// post-000 is newest; post-199 is oldest. created_at strictly descends by index.
function createdAtOf(i: number): string {
  return new Date(BASE_MS - i * 60_000).toISOString();
}
function postId(i: number): string {
  return `post-${String(i).padStart(3, "0")}`;
}
const POSTS = Array.from({ length: TOTAL_POSTS }, (_, i) => ({
  id: postId(i),
  author_id: AUTHOR,
  trip_id: null,
  content: `post ${i}`,
  visibility: "public",
  status: "active",
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

const VIEWER_PROFILE = { id: VIEWER, account_status: "active", current_city: null, current_country: null, home_city: null, interests: [] };
const AUTHOR_PROFILE = { id: AUTHOR, display_name: "Aya", username: "aya", avatar_url: null, account_status: "active" };

/** A table-routed fake whose `posts` reader honours order-desc + lte + limit. */
function fakeClient(flags: Record<string, boolean> = FLAGS) {
  function builder(table: string) {
    const eqs: Record<string, any> = {};
    const ins: Record<string, any> = {};
    let lteCreatedAt: string | null = null;
    let limitN: number | null = null;
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => { eqs[c] = v; return b; },
      in: (c: string, v: any) => { ins[c] = v; return b; },
      or: () => b,
      gt: () => b,
      gte: () => b,
      lt: () => b,
      lte: (c: string, v: string) => { if (c === "created_at") lteCreatedAt = v; return b; },
      not: () => b,
      order: () => b,
      limit: (n: number) => { limitN = n; return b; },
      maybeSingle() {
        if (table === "feature_flags") return Promise.resolve({ data: { enabled: !!flags[String(eqs["flag"])] }, error: null });
        if (table === "profiles") return Promise.resolve({ data: eqs["id"] === VIEWER ? VIEWER_PROFILE : null, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then(onF: any, onR: any) {
        let data: any[] = [];
        if (table === "posts") {
          data = POSTS.slice();
          if (ins["author_id"]) data = data.filter((r) => ins["author_id"].includes(r.author_id));
          if (eqs["author_id"]) data = data.filter((r) => r.author_id === eqs["author_id"]);
          if (lteCreatedAt) data = data.filter((r) => String(r.created_at) <= lteCreatedAt!);
          data.sort((a, b2) => (a.created_at < b2.created_at ? 1 : a.created_at > b2.created_at ? -1 : 0)); // created_at DESC
          if (limitN != null) data = data.slice(0, limitN);
        } else if (table === "profiles") {
          data = [VIEWER_PROFILE, AUTHOR_PROFILE];
        } else if (table === "user_follows") {
          data = eqs["follower_id"] === VIEWER ? [{ following_id: AUTHOR }] : [];
        } else {
          data = []; // trip_members, trips, blocks, post_media, shared_moment_memberships, places, ...
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

/** A Following cursor positioned just after the i-th newest post (0-indexed). */
function cursorAfter(i: number): string {
  return encodeFollowingCursor({ publishedAt: createdAtOf(i), id: postId(i) });
}

describe("Wall Following pagination — caughtUp honesty (D10)", () => {
  before(async () => {
    _setTestClient(fakeClient(), true);
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

  it("does NOT report caughtUp on a mid-tail page past the 150-row cap", async () => {
    _clearPromotedScopeCache();
    // Cursor just past the 150th newest post (post-149). The tail (post-150..199)
    // must still be reachable, and the page must not claim 'all caught up'.
    const res = await request(`/api/wall?mode=following&limit=20&cursor=${encodeURIComponent(cursorAfter(149))}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.mode, "following");
    assert.notEqual(res.json.caughtUp, true, "a mid-tail page with older posts remaining is NOT caught up");
    assert.equal(res.json.items.length, 20, "the tail past the 150th item is reachable");
    assert.equal(res.json.items[0].canonicalObjectId, "post-150", "pagination continues in strict order past the cap");
  });

  it("DOES report caughtUp on the genuine final page", async () => {
    _clearPromotedScopeCache();
    // Cursor just after post-189 → only post-190..199 (10) remain: the true end.
    const res = await request(`/api/wall?mode=following&limit=20&cursor=${encodeURIComponent(cursorAfter(189))}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.items.length, 10, "the final short page is returned in full");
    assert.equal(res.json.items[0].canonicalObjectId, "post-190");
    assert.equal(res.json.caughtUp, true, "the true end genuinely reports caught up");
  });
});
