/**
 * Testing-mode social lane (WP-20 / TRUST-F13 / PASS-F09) — the server half of
 * the lists this lane put on screen.
 *
 * Every list the client now renders from these routes has to obey two rules
 * before it is worth rendering:
 *
 *   1. VISIBILITY AND BLOCKS HOLD ON EVERY ROW. A profile tab, a saved-people
 *      list and a reviews list are each a way of looking at other people. A row
 *      from someone the viewer is in a block relation with (either direction)
 *      is dropped, and a post the viewer may not read at its own visibility
 *      tier is not served from the profile tab either.
 *   2. A FAILED READ IS NEVER A SHORT LIST (DV-83). supabase-js RESOLVES on a
 *      database error, so every read below that used to bind only `data`
 *      turned an outage into "nothing here" / "0 earned" / "no reviews". Each
 *      failure case here is paired with the healthy twin that must still serve.
 *
 * `blocks` is read through `.or()` everywhere (lib/blocks, lib/profileVisibility),
 * and the fail-closed double models `.or()` as a no-op — which would make one
 * seeded block row block every pair. `withRealOr` below gives the double the
 * real predicate (helpers/postgrestOrFilter) so a block between the viewer and
 * a THIRD party does not also read as a block between the viewer and the owner.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/tmSocialListGuards.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient, noopLog, type FakeReadContext } from "./helpers/failClosedSupabase.js";
import { orPredicate } from "./helpers/postgrestOrFilter.js";
import profileTabsRouter from "../routes/profileTabs.js";
import savesRouter from "../routes/saves.js";
import stampsRouter from "../routes/stamps.js";
import reviewsRouter from "../routes/reviews.js";

const OWNER    = "aaaaaaaa-0000-4000-a000-000000000001";
const VIEWER   = "bbbbbbbb-0000-4000-a000-000000000002";
const THIRD    = "cccccccc-0000-4000-a000-000000000003";
const FOURTH   = "dddddddd-0000-4000-a000-000000000004";
const PLACE    = "eeeeeeee-0000-4000-a000-000000000005";
const TRIP     = "ffffffff-0000-4000-a000-000000000006";
const EVENT    = "abababab-0000-4000-a000-000000000007";
const OWNER_TOKEN  = "tok-owner";
const VIEWER_TOKEN = "tok-viewer";
const HANDLE = "wanderer";

const READ_FAIL = { message: "server closed the connection unexpectedly", code: "08006" };

let server: http.Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = noopLog; next(); });
  app.use("/api", profileTabsRouter);
  app.use("/api", savesRouter);
  app.use("/api", stampsRouter);
  app.use("/api", reviewsRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => { await new Promise<void>((r) => server.close(() => r())); });

function get(path: string, token?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method: "GET",
        headers: token ? { authorization: `Bearer ${token}` } : {},
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

/** Give the double a REAL `.or()` on `blocks` (see header). */
function withRealOr(c: any): any {
  const origFrom = c.from.bind(c);
  c.from = (table: string) => {
    const b = origFrom(table);
    if (table !== "blocks") return b;
    const preds: Array<(row: Record<string, any>) => boolean> = [];
    b.or = (expr: string) => { preds.push(orPredicate(expr)); return b; };
    const origThen = b.then.bind(b);
    b.then = (onF: any, onR: any) =>
      origThen(
        (r: any) =>
          onF(Array.isArray(r?.data) && preds.length
            ? { ...r, data: r.data.filter((row: any) => preds.every((p) => p(row))) }
            : r),
        onR,
      );
    return b;
  };
  return c;
}

const PROFILES = [
  { id: OWNER,  handle: HANDLE,   username: HANDLE,   name: "Owner",  avatar_url: null, is_private: false, passport_visibility: "public", account_status: "active" },
  { id: VIEWER, handle: "viewer", username: "viewer", name: "Viewer", avatar_url: null, is_private: false, passport_visibility: "public", account_status: "active" },
  { id: THIRD,  handle: "third",  username: "third",  name: "Third",  avatar_url: null, is_private: false, passport_visibility: "public", account_status: "active" },
  { id: FOURTH, handle: "fourth", username: "fourth", name: "Fourth", avatar_url: null, is_private: false, passport_visibility: "public", account_status: "active" },
];

type Rows = Record<string, Record<string, any>[]>;

function install(rows: Rows, failOn?: (ctx: FakeReadContext) => boolean) {
  const c = makeFailClosedClient({
    rows: {
      profiles: PROFILES,
      profile_privacy_settings: [],
      blocks: [],
      user_account_states: [],
      user_friendships: [],
      user_follows: [],
      post_media: [],
      ...rows,
    },
    users: { [OWNER_TOKEN]: OWNER, [VIEWER_TOKEN]: VIEWER },
    failOn: (ctx) => (failOn?.(ctx) ? READ_FAIL : null),
  });
  const wrapped = withRealOr(c);
  _setTestClient(wrapped, true);
  _setTestServiceClient(wrapped);
  return wrapped;
}

let scenarios = 0;

// ── PLAT-F14: GET /users/:username/posts ─────────────────────────────────────

const POSTS = [
  { id: "p-public",    author_id: OWNER, post_status: "published", visibility: "public",         status: "active", deleted_at: null, content: "a", created_at: "2026-01-06T00:00:00Z" },
  { id: "p-followers", author_id: OWNER, post_status: "published", visibility: "followers_only", status: "active", deleted_at: null, content: "b", created_at: "2026-01-05T00:00:00Z" },
  { id: "p-private",   author_id: OWNER, post_status: "published", visibility: "private",        status: "active", deleted_at: null, content: "c", created_at: "2026-01-04T00:00:00Z" },
  { id: "p-trip",      author_id: OWNER, post_status: "published", visibility: "trip_only",      status: "active", deleted_at: null, trip_id: TRIP, content: "d", created_at: "2026-01-03T00:00:00Z" },
  { id: "p-hidden",    author_id: OWNER, post_status: "published", visibility: "public",         status: "hidden", deleted_at: null, content: "e", created_at: "2026-01-02T00:00:00Z" },
  { id: "p-deleted",   author_id: OWNER, post_status: "published", visibility: "public",         status: "active", deleted_at: "2026-01-09T00:00:00Z", content: "f", created_at: "2026-01-01T00:00:00Z" },
];

describe("GET /users/:username/posts — a post's own visibility tier holds on the profile tab", () => {
  it("a stranger sees only public, active, undeleted posts", async () => {
    scenarios++;
    install({ posts: POSTS });
    const r = await get(`/api/users/${HANDLE}/posts`, VIEWER_TOKEN);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items.map((i: any) => i.id), ["p-public"]);
  });

  it("an unauthenticated visitor sees only the public post", async () => {
    scenarios++;
    install({ posts: POSTS });
    const r = await get(`/api/users/${HANDLE}/posts`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items.map((i: any) => i.id), ["p-public"]);
  });

  it("a follower also sees followers_only — never private or trip_only", async () => {
    scenarios++;
    install({ posts: POSTS, user_follows: [{ follower_id: VIEWER, following_id: OWNER }] });
    const r = await get(`/api/users/${HANDLE}/posts`, VIEWER_TOKEN);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items.map((i: any) => i.id), ["p-public", "p-followers"]);
  });

  it("FAILURE: an unreadable follow edge is a 503, not a silently shorter tab", async () => {
    scenarios++;
    install({ posts: POSTS, user_follows: [{ follower_id: VIEWER, following_id: OWNER }] },
      (ctx) => ctx.table === "user_follows");
    const r = await get(`/api/users/${HANDLE}/posts`, VIEWER_TOKEN);
    // A public profile resolves to "full" without consulting the edge, so the
    // only reader of user_follows on this request is the posts tab itself.
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("the owner still sees every active post of their own, at every tier", async () => {
    scenarios++;
    install({ posts: POSTS });
    const r = await get(`/api/users/${HANDLE}/posts`, OWNER_TOKEN);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items.map((i: any) => i.id), ["p-public", "p-followers", "p-private", "p-trip"]);
  });
});

// ── PLAT-F14: GET /users/:username/circles ───────────────────────────────────

const MEMBERSHIPS = [
  { user_id: THIRD,  other_id: OWNER, created_at: "2026-02-02T00:00:00Z", owner: { id: THIRD,  handle: "third" } },
  { user_id: FOURTH, other_id: OWNER, created_at: "2026-02-01T00:00:00Z", owner: { id: FOURTH, handle: "fourth" } },
];

describe("GET /users/:username/circles — blocks and show_friends hold", () => {
  it("HEALTHY TWIN: a stranger sees both circles the owner belongs to", async () => {
    scenarios++;
    install({ circle_memberships: MEMBERSHIPS });
    const r = await get(`/api/users/${HANDLE}/circles`, VIEWER_TOKEN);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items.map((i: any) => i.circleOwnerId), [THIRD, FOURTH]);
  });

  it("a circle whose owner the viewer is in a block relation with is dropped", async () => {
    scenarios++;
    install({ circle_memberships: MEMBERSHIPS, blocks: [{ blocker_id: THIRD, blocked_id: VIEWER }] });
    const r = await get(`/api/users/${HANDLE}/circles`, VIEWER_TOKEN);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items.map((i: any) => i.circleOwnerId), [FOURTH]);
  });

  it("show_friends=false withholds the circles tab from a non-owner", async () => {
    scenarios++;
    install({
      circle_memberships: MEMBERSHIPS,
      profile_privacy_settings: [{ user_id: OWNER, profile_visibility: "public", show_friends: false }],
    });
    const r = await get(`/api/users/${HANDLE}/circles`, VIEWER_TOKEN);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { items: [], nextCursor: null });
  });

  it("…but never from the owner", async () => {
    scenarios++;
    install({
      circle_memberships: MEMBERSHIPS,
      profile_privacy_settings: [{ user_id: OWNER, profile_visibility: "public", show_friends: false }],
    });
    const r = await get(`/api/users/${HANDLE}/circles`, OWNER_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 2);
  });

  it("FAILURE: an unreadable block list is a 503, not the unfiltered list", async () => {
    scenarios++;
    // The viewer<->owner block check (profileVisibility) must succeed so the
    // failure lands on the per-row block read; that read is fetchBlockedSet's
    // one-sided `.or()` which carries no eq filters.
    let blockReads = 0;
    install({ circle_memberships: MEMBERSHIPS, blocks: [{ blocker_id: THIRD, blocked_id: VIEWER }] },
      (ctx) => ctx.table === "blocks" && ++blockReads > 1);
    const r = await get(`/api/users/${HANDLE}/circles`, VIEWER_TOKEN);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
  });
});

// ── PLAT-F16: GET /me/saves ──────────────────────────────────────────────────

const SAVES = [
  { saver_id: VIEWER, saved_id: THIRD,  created_at: "2026-03-02T00:00:00Z" },
  { saver_id: VIEWER, saved_id: FOURTH, created_at: "2026-03-01T00:00:00Z" },
];

describe("GET /me/saves — the saved-people list", () => {
  it("HEALTHY TWIN: lists both saved people with their handles", async () => {
    scenarios++;
    install({ user_saves: SAVES });
    const r = await get(`/api/me/saves`, VIEWER_TOKEN);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.saves.map((s: any) => [s.id, s.handle]), [[THIRD, "third"], [FOURTH, "fourth"]]);
  });

  it("a saved person now in a block relation with me is dropped", async () => {
    scenarios++;
    install({ user_saves: SAVES, blocks: [{ blocker_id: FOURTH, blocked_id: VIEWER }] });
    const r = await get(`/api/me/saves`, VIEWER_TOKEN);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.saves.map((s: any) => s.id), [THIRD]);
  });

  it("FAILURE: an unreadable block list is a 503", async () => {
    scenarios++;
    install({ user_saves: SAVES }, (ctx) => ctx.table === "blocks");
    const r = await get(`/api/me/saves`, VIEWER_TOKEN);
    assert.equal(r.status, 503);
  });

  it("FAILURE: unreadable profiles are a 503, not rows with no handle", async () => {
    scenarios++;
    install({ user_saves: SAVES }, (ctx) => ctx.table === "profiles" && ctx.filters.some((f) => f.op === "in"));
    const r = await get(`/api/me/saves`, VIEWER_TOKEN);
    assert.equal(r.status, 503);
  });
});

// ── PASS-F09: GET /stamps/me/collections ─────────────────────────────────────

const COLLECTIONS = [
  { id: "col-1", slug: "europe", name: "Europe", description: null, icon_url: null, is_active: true,
    stamp_collection_items: [{ stamp_definition_id: "d1" }, { stamp_definition_id: "d2" }] },
];

/** The router's own gate (routes/stamps.ts) — the flag the testing target runs with. */
const STAMPS_ON = [{ flag: "stamp_system_v2_enabled", enabled: true }];

describe("GET /stamps/me/collections — earned counts are read, never assumed", () => {
  it("HEALTHY TWIN: one of two earned", async () => {
    scenarios++;
    install({ feature_flags: STAMPS_ON, stamp_collections: COLLECTIONS, user_stamps: [{ user_id: VIEWER, stamp_definition_id: "d1", is_revoked: false }] });
    const r = await get(`/api/stamps/me/collections`, VIEWER_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.collections[0].earned, 1);
    assert.equal(r.body.collections[0].total, 2);
  });

  it("FAILURE: an unreadable user_stamps is an error, not '0 of 2 earned'", async () => {
    scenarios++;
    install({ feature_flags: STAMPS_ON, stamp_collections: COLLECTIONS, user_stamps: [{ user_id: VIEWER, stamp_definition_id: "d1", is_revoked: false }] },
      (ctx) => ctx.table === "user_stamps");
    const r = await get(`/api/stamps/me/collections`, VIEWER_TOKEN);
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "db_error");
    assert.equal(r.body.collections, undefined);
  });
});

// ── TRUST-F13: reviews lists ─────────────────────────────────────────────────

function review(id: string, reviewer: string, entityType: string, entityId: string, rating: number, created: string) {
  return {
    id, reviewer_id: reviewer, entity_type: entityType, entity_id: entityId, rating,
    body: `review ${id}`, tags: [], visibility: "public", state: "published", created_at: created,
    profiles: { handle: PROFILES.find((p) => p.id === reviewer)?.handle ?? null, display_name: null, avatar_url: null, verification_level: null },
  };
}

const PLACE_REVIEWS = [
  review("r-third",  THIRD,  "place", PLACE, 5, "2026-04-02T00:00:00Z"),
  review("r-fourth", FOURTH, "place", PLACE, 1, "2026-04-01T00:00:00Z"),
];

describe("GET /places/:id/reviews — blocked reviewers are not shown", () => {
  it("HEALTHY TWIN: an authed viewer with no blocks sees both", async () => {
    scenarios++;
    install({ reviews: PLACE_REVIEWS });
    const r = await get(`/api/places/${PLACE}/reviews`, VIEWER_TOKEN);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.reviews.map((x: any) => x.id), ["r-third", "r-fourth"]);
  });

  it("a review by someone who blocked the viewer is dropped", async () => {
    scenarios++;
    install({ reviews: PLACE_REVIEWS, blocks: [{ blocker_id: FOURTH, blocked_id: VIEWER }] });
    const r = await get(`/api/places/${PLACE}/reviews`, VIEWER_TOKEN);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.reviews.map((x: any) => x.id), ["r-third"]);
  });

  it("an unauthenticated reader has no block relation and sees both", async () => {
    scenarios++;
    install({ reviews: PLACE_REVIEWS, blocks: [{ blocker_id: FOURTH, blocked_id: VIEWER }] });
    const r = await get(`/api/places/${PLACE}/reviews`);
    assert.equal(r.status, 200);
    assert.equal(r.body.reviews.length, 2);
  });

  it("FAILURE: an unreadable block list is a 503 for an authed viewer", async () => {
    scenarios++;
    install({ reviews: PLACE_REVIEWS }, (ctx) => ctx.table === "blocks");
    const r = await get(`/api/places/${PLACE}/reviews`, VIEWER_TOKEN);
    assert.equal(r.status, 503);
  });

  it("FAILURE: an unreadable aggregate is an error, not 'no rating'", async () => {
    scenarios++;
    // The aggregate read is the one that selects ratings with no range.
    let reviewReads = 0;
    install({ reviews: PLACE_REVIEWS }, (ctx) => ctx.table === "reviews" && ++reviewReads === 2);
    const r = await get(`/api/places/${PLACE}/reviews`);
    assert.notEqual(r.status, 200);
  });
});

describe("GET /trips/:id/reviews — the same rule on trips", () => {
  it("a review by someone the viewer blocked is dropped", async () => {
    scenarios++;
    install({
      reviews: [review("t-third", THIRD, "trip", TRIP, 4, "2026-05-02T00:00:00Z"), review("t-fourth", FOURTH, "trip", TRIP, 2, "2026-05-01T00:00:00Z")],
      blocks: [{ blocker_id: VIEWER, blocked_id: THIRD }],
    });
    const r = await get(`/api/trips/${TRIP}/reviews`, VIEWER_TOKEN);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.reviews.map((x: any) => x.id), ["t-fourth"]);
  });

  it("FAILURE: an unreadable aggregate is an error", async () => {
    scenarios++;
    let reviewReads = 0;
    install({ reviews: [review("t-third", THIRD, "trip", TRIP, 4, "2026-05-02T00:00:00Z")] },
      (ctx) => ctx.table === "reviews" && ++reviewReads === 2);
    const r = await get(`/api/trips/${TRIP}/reviews`, VIEWER_TOKEN);
    assert.notEqual(r.status, 200);
  });
});

describe("GET /users/:id/reviews — host reviews", () => {
  const rows = () => ({
    trips: [{ id: TRIP, owner_id: OWNER }],
    events: [{ id: EVENT, host_id: OWNER }],
    reviews: [review("u-third", THIRD, "trip", TRIP, 5, "2026-06-02T00:00:00Z"), review("u-fourth", FOURTH, "trip", TRIP, 3, "2026-06-01T00:00:00Z")],
    event_reviews: [{ id: "e-1", event_id: EVENT, reviewer_id: THIRD, rating: 4, body: "ok", anonymous: false, created_at: "2026-06-03T00:00:00Z", profiles: { handle: "third" } }],
  });

  it("HEALTHY TWIN: trip + event reviews of the host are merged", async () => {
    scenarios++;
    install(rows());
    const r = await get(`/api/users/${OWNER}/reviews`, VIEWER_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.reviewCount, 3);
    assert.deepEqual(r.body.reviews.map((x: any) => x.id), ["e-1", "u-third", "u-fourth"]);
  });

  it("a blocked reviewer's review is dropped", async () => {
    scenarios++;
    install({ ...rows(), blocks: [{ blocker_id: VIEWER, blocked_id: FOURTH }] });
    const r = await get(`/api/users/${OWNER}/reviews`, VIEWER_TOKEN);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.reviews.map((x: any) => x.id), ["e-1", "u-third"]);
  });

  it("a host in a block relation with the viewer is not readable at all", async () => {
    scenarios++;
    install({ ...rows(), blocks: [{ blocker_id: OWNER, blocked_id: VIEWER }] });
    const r = await get(`/api/users/${OWNER}/reviews`, VIEWER_TOKEN);
    assert.equal(r.status, 403);
  });

  it("FAILURE: unreadable event reviews are an error, not a trips-only total", async () => {
    scenarios++;
    install(rows(), (ctx) => ctx.table === "event_reviews");
    const r = await get(`/api/users/${OWNER}/reviews`, VIEWER_TOKEN);
    assert.notEqual(r.status, 200);
  });

  it("FAILURE: unreadable hosted trips are an error, not 'no reviews'", async () => {
    scenarios++;
    install(rows(), (ctx) => ctx.table === "trips");
    const r = await get(`/api/users/${OWNER}/reviews`, VIEWER_TOKEN);
    assert.notEqual(r.status, 200);
  });
});

describe("vacuity", () => {
  it("exercised every scenario", () => {
    assert.ok(scenarios >= 27, `expected >= 27 scenarios, ran ${scenarios}`);
  });
});
