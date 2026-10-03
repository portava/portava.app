/**
 * mediaFeedReadsHonest — census-media §47 on routes/mediaFeed.ts: the Watch
 * feed, the single-item read, the Gems feed, the grid, and the item actions.
 *
 * The defect, in every one of these: supabase-js RESOLVES `{ data: null, error }`
 * on a failure, and the reads here sat in `try { … } catch { /* non-fatal *\/ }`
 * blocks that never ran for it (22 such sites were baselined as S2 in
 * SILENT_SUPABASE_READS_BASELINE.json). So:
 *   - the viewer's own state (saved, stamped, follow request pending,
 *     following) read as false when it could not be read (defect 2);
 *   - counts were made from one row per stamp / reaction — an unbounded read
 *     PostgREST cuts at 1,000 rows — and read 0 on a failure; saveCount and
 *     commentCount were the cached columns, which POST /media/:id/save never
 *     maintained;
 *   - "who you follow" and "what you saved" read as nothing on a failure, so the
 *     following and saved views answered an outage with an empty page;
 *   - an unread item answered 404 "not found".
 *
 * Watch feed (GET /media/feed?mode=fullscreen)
 *   MW0  healthy: likeCount and stampItCount exact past 1,000 rows; saveCount and
 *        commentCount live over a stale cache; viewer state right; no failedSources
 *   MW1  post_saves unread → hasSaved null and saveCount null, named
 *   MW2  content_stamps unread → hasLiked null and likeCount null, named
 *   MW3  friend_requests unread → hasFollowRequestPending null, named
 *   MW4  media_stamp_reactions unread → stampItCount null, named
 *   MW5  following: user_follows unread → 503, never an empty "caught up" page
 *   MW6  blocks unread → an empty page that NAMES blocks
 *   MW7  ranking inputs unread → the page is served and they are named
 * Single item (GET /media/:id)
 *   MS1  post_saves unread → hasSaved null, named
 *   MS2  user_follows unread, public creator → served, isFollowingCreator null, named
 *   MS3  user_follows unread, private creator → 503, never 404
 *   MS4  counts exact past 1,000 rows (HEAD counts), and null + named when unread
 *   MS5  blocks unread → 503, never 404
 * Gems feed (GET /media/gems-feed)
 *   MG1  hidden_gem_saves unread → hasSaved null and saveCount null, named
 *   MG2  user_follows unread → isFollowingCreator null, named
 *   MG3  healthy: saveCount live over a stale cached save_count
 *   MG4  my_trip: the trip read fails → db_error, never "Trip not found"
 *   MG5  my_trip: the membership read fails → db_error, never "Not a trip member"
 * Grid (GET /media/feed?mode=grid)
 *   MD1  filter=following: user_follows unread → 503, never empty
 *   MD2  filter=saved: post_saves unread → 503, never "no saved posts"
 *   MD3  filter=saved: a save past the viewer's first 1,000 is still found
 * Item actions
 *   MA1  POST /media/:id/save: the posts read fails → 503, never 404
 *   MA2  POST /media/:id/save keeps posts.save_count in step and answers the count
 *   MA3  POST /media/:id/view: the posts read fails → db_error, never 404
 *   MA4  PATCH /media/:id: the posts read fails → db_error, never 404
 *
 * Run: node --import tsx/esm --test src/test/mediaFeedReadsHonest.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import mediaFeedRouter from "../routes/mediaFeed.js";
import { makeFeedDb, type FakeFeedDb, type FakeFeedDbSpec } from "./helpers/fakeFeedDb.js";

const VIEWER = "aaaaaaaa-0000-4000-a000-000000000001";
const CREATOR = "bbbbbbbb-0000-4000-a000-000000000002";
const PRIVATE_CREATOR = "bbbbbbbb-0000-4000-a000-000000000003";
const P1 = "11111111-0000-4000-a000-000000000001";
const P2 = "11111111-0000-4000-a000-000000000002";
const PP = "11111111-0000-4000-a000-000000000009";
const GEM = "22222222-0000-4000-a000-000000000001";
const TRIP = "eeeeeeee-0000-4000-a000-000000000001";
const TOKEN = "tok-viewer";

const n12 = (n: number) => String(n).padStart(12, "0");

function profile(id: string, over: Record<string, unknown> = {}) {
  return {
    id, username: `u${id.slice(-3)}`, full_name: null, avatar_url: null, show_profile_picture_publicly: true,
    is_private: false, verified: false, bio: null, account_status: "active", is_official: false, ...over,
  };
}

function videoPost(id: string, over: Record<string, unknown> = {}) {
  const author = (over.author_id as string) ?? CREATOR;
  return {
    id, author_id: author, trip_id: null, content: `video ${id}`, visibility: "public", status: "active",
    post_status: "published", has_video: true, created_at: `2026-09-0${id.slice(-1)}T00:00:00Z`, category: null,
    location_name: null, location_city: null, location_country: null, location_source: null, location_verified: false,
    location_privacy_mode: "none", location_lat: null, location_lng: null,
    save_count: 99, like_count: 5, comment_count: 7, canonical_place_id: null, post_buckets: null,
    moderation_status: "approved",
    post_media: [{
      id: `m-${id}`, media_type: "video", public_url: `https://cdn.test/${id}.mp4`, thumbnail_url: null,
      thumbnail_storage_path: null, duration_seconds: 12, width: 1080, height: 1920, sort_order: 0,
      processing_status: "ready", moderation_status: "approved", storage_path: null, storage_bucket: null,
    }],
    profiles: profile(author),
    ...over,
  };
}

const FLAGS = [
  "MEDIA_FOR_YOU_ENABLED", "MEDIA_FOLLOWING_ENABLED", "MEDIA_VIEW_MODE_GRID_ENABLED",
  "MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED", "MEDIA_COMMENTS_ENABLED", "MEDIA_SHARES_ENABLED",
].map((flag) => ({ flag, enabled: true }));

function seed(over: Partial<FakeFeedDbSpec> = {}): FakeFeedDbSpec {
  return {
    users: { [TOKEN]: VIEWER },
    tables: {
      feature_flags: [...FLAGS],
      posts: [videoPost(P1), videoPost(P2)],
      profiles: [profile(VIEWER), profile(CREATOR), profile(PRIVATE_CREATOR, { is_private: true })],
      user_follows: [{ follower_id: VIEWER, following_id: CREATOR }],
      post_saves: [
        { id: "ps-1", post_id: P1, user_id: VIEWER },
        { id: "ps-2", post_id: P1, user_id: `cccccccc-0000-4000-a000-${n12(5)}` },
      ],
      posts_comments: [
        { id: "c-1", post_id: P1, user_id: `cccccccc-0000-4000-a000-${n12(6)}`, deleted_at: null },
        { id: "c-2", post_id: P1, user_id: `cccccccc-0000-4000-a000-${n12(7)}`, deleted_at: null },
        { id: "c-3", post_id: P1, user_id: `cccccccc-0000-4000-a000-${n12(8)}`, deleted_at: "2026-09-10T00:00:00Z" },
      ],
      content_stamps: [
        ...Array.from({ length: 1_700 }, (_, i) => ({ id: `cs1-${n12(i)}`, user_id: `dddddddd-0000-4000-a000-${n12(i)}`, entity_type: "media", entity_id: P1 })),
        { id: "cs2-a", user_id: VIEWER, entity_type: "media", entity_id: P2 },
      ],
      media_stamp_reactions: Array.from({ length: 1_200 }, (_, i) => ({ id: `msr-${n12(i)}`, post_id: P1, user_id: `dddddddd-0000-4000-a000-${n12(i)}` })),
      friend_requests: [{ id: "fr-1", requester_id: VIEWER, recipient_id: PRIVATE_CREATOR, status: "pending" }],
      hidden_gems: [{
        id: GEM, name: "Quiet Cove", category: "beach", city: "Lisbon", country: "Portugal", status: "active",
        moderation_status: "approved", submitted_by: CREATOR, canonical_place_id: "place-1", source_type: null,
        save_count: 50, visit_count: 3, sensitivity_level: "public", verification_level: "unverified",
        latitude: 38.7, longitude: -9.1, created_at: "2026-09-01T00:00:00Z", image_url: null, vibe_tags: [],
      }],
      hidden_gem_saves: [{ gem_id: GEM, user_id: VIEWER, saved_at: "2026-09-02T00:00:00Z" }],
      trips: [{ id: TRIP, owner_id: CREATOR, destination_city: "Lisbon" }],
      trip_members: [{ trip_id: TRIP, user_id: VIEWER, role: "member", status: "accepted" }],
    },
    unique: { post_saves: ["user_id", "post_id"], hidden_gem_saves: ["user_id", "gem_id"] },
    ...over,
  };
}

let db: FakeFeedDb;
let server: http.Server;
let base = "";

function use(spec: FakeFeedDbSpec) {
  db = makeFeedDb(spec);
  _setTestClient(db.client, true);
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const get = (path: string) => call("GET", path);
const item = (items: any[], id: string) => items.find((i) => i.id === id);

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
    next();
  });
  app.use(mediaFeedRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as any).port}`;
      resolve();
    });
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const WATCH = "/media/feed?mode=fullscreen";

describe("Watch feed — counts exact, the viewer's state named when unread (census-media §47)", () => {
  it("MW0 — healthy: exact past 1,000 rows, live over a stale cache, no failedSources", async () => {
    use(seed());
    const r = await get(WATCH);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p1 = item(r.body.items, P1), p2 = item(r.body.items, P2);
    assert.equal(p1.stats.likeCount, 1_700, "1,700 media stamps — not the 1,000 rows PostgREST serves");
    assert.equal(p1.stats.stampItCount, 1_200, "1,200 Stamp It reactions — not 1,000");
    assert.equal(p1.stats.saveCount, 2, "live post_saves, not the cached save_count (99)");
    assert.equal(p2.stats.saveCount, 0);
    assert.equal(p1.stats.commentCount, 2, "live non-deleted comments, not the cached comment_count (7)");
    assert.equal(p1.viewerState.hasSaved, true);
    assert.equal(p2.viewerState.hasSaved, false);
    assert.equal(p2.viewerState.hasLiked, true);
    assert.equal(p1.viewerState.hasLiked, false);
    assert.equal(r.body.failedSources, undefined);
  });

  it("MW1 — post_saves unread: hasSaved and saveCount are null, and named", async () => {
    use(seed({ failReads: { post_saves: true } }));
    const r = await get(WATCH);
    assert.equal(r.status, 200);
    for (const i of r.body.items) {
      assert.equal(i.viewerState.hasSaved, null, "unknown is not 'not saved'");
      assert.equal(i.stats.saveCount, null);
    }
    assert.ok(r.body.failedSources.includes("post_saves"));
  });

  it("MW2 — content_stamps unread: hasLiked and likeCount are null, and named", async () => {
    use(seed({ failReads: { content_stamps: true } }));
    const r = await get(WATCH);
    assert.equal(r.status, 200);
    for (const i of r.body.items) {
      assert.equal(i.viewerState.hasLiked, null);
      assert.equal(i.stats.likeCount, null);
    }
    assert.ok(r.body.failedSources.includes("content_stamps"));
  });

  it("MW3 — friend_requests unread: hasFollowRequestPending is null, and named", async () => {
    use(seed({ failReads: { friend_requests: true } }));
    const r = await get(WATCH);
    assert.equal(r.status, 200);
    for (const i of r.body.items) assert.equal(i.viewerState.hasFollowRequestPending, null);
    assert.ok(r.body.failedSources.includes("friend_requests"));
  });

  it("MW4 — media_stamp_reactions unread: stampItCount is null, and named", async () => {
    use(seed({ failReads: { media_stamp_reactions: true } }));
    const r = await get(WATCH);
    assert.equal(r.status, 200);
    for (const i of r.body.items) assert.equal(i.stats.stampItCount, null);
    assert.ok(r.body.failedSources.includes("media_stamp_reactions"));
  });

  it("MW5 — following: an unread follow graph is a 503, never an empty 'caught up' page", async () => {
    use(seed({ failReads: { user_follows: true } }));
    const r = await get(`${WATCH}&feedType=following`);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("MW6 — blocks unread: the page is empty (fail-closed) and NAMES blocks", async () => {
    use(seed({ failReads: { blocks: true } }));
    const r = await get(WATCH);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items, []);
    assert.deepEqual(r.body.failedSources, ["blocks"]);
  });

  it("MW7 — ranking inputs unread: the page is served and each input is named", async () => {
    use(seed({ failReads: { compass_user_preferences: true, rank_events: true } }));
    const r = await get(WATCH);
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 2);
    assert.ok(r.body.failedSources.includes("compass_user_preferences"), JSON.stringify(r.body.failedSources));
    assert.ok(r.body.failedSources.includes("rank_events"));
  });
});

describe("Single item (census-media §47)", () => {
  it("MS1 — post_saves unread: hasSaved null, named", async () => {
    use(seed({ failReads: { post_saves: true } }));
    const r = await get(`/media/${P1}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.item.viewerState.hasSaved, null);
    assert.equal(r.body.item.stats.saveCount, null);
    assert.ok(r.body.failedSources.includes("post_saves"));
  });

  it("MS2 — user_follows unread, public creator: served with isFollowingCreator null, named", async () => {
    use(seed({ failReads: { user_follows: true } }));
    const r = await get(`/media/${P1}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.item.viewerState.isFollowingCreator, null);
    assert.ok(r.body.failedSources.includes("user_follows"));
  });

  it("MS3 — user_follows unread, private creator: 503, never 404", async () => {
    const spec = seed({ failReads: { user_follows: true } });
    spec.tables.posts.push(videoPost(PP, { author_id: PRIVATE_CREATOR, profiles: profile(PRIVATE_CREATOR, { is_private: true }) }));
    use(spec);
    const r = await get(`/media/${PP}`);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("MS4 — counts exact past 1,000 rows, and null + named when unread", async () => {
    use(seed());
    const ok = await get(`/media/${P1}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.item.stats.likeCount, 1_700);
    assert.equal(ok.body.item.stats.stampItCount, 1_200);
    assert.equal(ok.body.item.stats.saveCount, 2);
    assert.equal(ok.body.failedSources, undefined);
    use(seed({ failReads: { media_stamp_reactions: true, content_stamps: true } }));
    const bad = await get(`/media/${P1}`);
    assert.equal(bad.status, 200);
    assert.equal(bad.body.item.stats.stampItCount, null);
    assert.equal(bad.body.item.stats.likeCount, null);
    assert.ok(bad.body.failedSources.includes("media_stamp_reactions"));
    assert.ok(bad.body.failedSources.includes("content_stamps"));
  });

  it("MS5 — blocks unread: 503, never 404", async () => {
    use(seed({ failReads: { blocks: true } }));
    const r = await get(`/media/${P1}`);
    assert.equal(r.status, 503, JSON.stringify(r.body));
  });
});

describe("Gems feed (census-media §47)", () => {
  it("MG1 — hidden_gem_saves unread: hasSaved and saveCount null, named", async () => {
    use(seed({ failReads: { hidden_gem_saves: true } }));
    const r = await get("/media/gems-feed");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const g = item(r.body.items, GEM);
    assert.equal(g.viewerState.hasSaved, null);
    assert.equal(g.stats.saveCount, null);
    assert.ok(r.body.failedSources.includes("hidden_gem_saves"));
  });

  it("MG2 — user_follows unread: isFollowingCreator null, named", async () => {
    use(seed({ failReads: { user_follows: true } }));
    const r = await get("/media/gems-feed");
    assert.equal(r.status, 200);
    assert.equal(item(r.body.items, GEM).viewerState.isFollowingCreator, null);
    assert.ok(r.body.failedSources.includes("user_follows"));
  });

  it("MG3 — healthy: saveCount live, not the cached save_count", async () => {
    use(seed());
    const r = await get("/media/gems-feed");
    assert.equal(r.status, 200);
    const g = item(r.body.items, GEM);
    assert.equal(g.stats.saveCount, 1, "one hidden_gem_saves row, whatever save_count (50) says");
    assert.equal(g.viewerState.hasSaved, true);
    assert.equal(r.body.failedSources, undefined);
  });

  it("MG4 — my_trip: an unread trip is db_error, never 'Trip not found'", async () => {
    use(seed({ failReads: { trips: true } }));
    const r = await get(`/media/gems-feed?areaMode=my_trip&tripId=${TRIP}`);
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(r.body.error, "db_error");
  });

  it("MG5 — my_trip: an unread membership is db_error, never 'Not a trip member'", async () => {
    use(seed({ failReads: { trip_members: true } }));
    const r = await get(`/media/gems-feed?areaMode=my_trip&tripId=${TRIP}`);
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(r.body.error, "db_error");
  });
});

describe("Grid (census-media §47)", () => {
  it("MD1 — filter=following: an unread follow graph is a 503, never empty", async () => {
    use(seed({ failReads: { user_follows: true } }));
    const r = await get("/media/feed?mode=grid&filter=following");
    assert.equal(r.status, 503, JSON.stringify(r.body));
  });

  it("MD2 — filter=saved: an unread saved list is a 503, never 'no saved posts'", async () => {
    use(seed({ failReads: { post_saves: true } }));
    const r = await get("/media/feed?mode=grid&filter=saved");
    assert.equal(r.status, 503, JSON.stringify(r.body));
  });

  it("MD3 — filter=saved: a save past the viewer's first 1,000 is still found", async () => {
    const spec = seed();
    const LATE = "11111111-0000-4000-a000-ffffffffffff";
    spec.tables.post_saves = Array.from({ length: 1_100 }, (_, i) => ({ id: `s-${n12(i)}`, user_id: VIEWER, post_id: `11111111-0000-4000-a000-${n12(100 + i)}` }));
    spec.tables.post_saves.push({ id: "s-late", user_id: VIEWER, post_id: LATE });
    spec.tables.posts.push(videoPost(LATE));
    use(spec);
    const r = await get("/media/feed?mode=grid&filter=saved");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.items.some((i: any) => i.id === LATE), "the 1,101st save must not be cut");
  });
});

describe("Item actions (census-media §47)", () => {
  it("MA1 — POST /media/:id/save with the posts read failing: 503, never 404", async () => {
    use(seed({ failReads: { posts: true } }));
    const r = await call("POST", `/media/${P2}/save`);
    assert.equal(r.status, 503, JSON.stringify(r.body));
  });

  it("MA2 — POST /media/:id/save keeps posts.save_count in step and answers the count", async () => {
    use(seed());
    const r = await call("POST", `/media/${P2}/save`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.saved, true);
    assert.equal(r.body.saveCount, 1);
    assert.equal(db.tables.posts.find((p) => p.id === P2)!.save_count, 1, "the cached counter follows the write");
  });

  it("MA3 — POST /media/:id/view with the posts read failing: db_error, never 404", async () => {
    const spec = seed({ failReads: { posts: true } });
    spec.tables.feature_flags.push({ flag: "MEDIA_RANKING_ENABLED", enabled: true });
    use(spec);
    const r = await call("POST", `/media/${P1}/view`, { type: "impression" });
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(r.body.error, "db_error");
  });

  it("MA4 — PATCH /media/:id with the posts read failing: db_error, never 404", async () => {
    use(seed({ failReads: { posts: true } }));
    const r = await call("PATCH", `/media/${P1}`, { visibility: "private" });
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(r.body.error, "db_error");
  });
});
