/**
 * Pulse feed Compass ranking signal tests — GET /api/pulse
 *
 * Covers:
 *  A. Blocked user exclusion — posts by blocked users are not returned
 *  B. Blocked-by exclusion — posts by users who blocked the viewer are filtered
 *  C. Delayed-publish gate — a post whose post_status is still pending is not served at all
 *  D. Followed-user boost — posts from followed users score higher than strangers
 *  E. Hashtag interest boost — posts matching a user's interests rank higher
 *  F. City boost — posts in the viewer's Compass city rank higher than other cities
 *  G. Auth guard — 401 when unauthenticated
 *  H. Prompts field — response always includes a prompts array
 *  I. Moderation guard — posts whose media is entirely rejected/failed are excluded
 *  J. Block-query fail-closed — feed returns empty when the blocks DB query errors
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest).
 * Fake Supabase client injected via _setTestClient.
 *
 * Run: node --import tsx/esm --test src/test/pulseRanking.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import { invalidateFlagsCache } from "../compass/flags.js";

// ── Shared constants ──────────────────────────────────────────────────────────

const ALICE_ID    = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";
const BOB_ID      = "b2b2b2b2-bbbb-bbbb-bbbb-000000000002";
const CAROL_ID    = "cccccccc-cccc-cccc-cccc-000000000003";
const DAVE_ID     = "dddddddd-dddd-dddd-dddd-000000000004";

const NOW          = new Date().toISOString();
const ONE_HOUR_AGO = new Date(Date.now() - 1 * 60 * 60 * 1_000).toISOString();
const TWO_DAYS_AGO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString();

// ── Post factory ──────────────────────────────────────────────────────────────

let _postSeq = 0;
function makePost(overrides: Record<string, any> = {}): Record<string, any> {
  const seq   = ++_postSeq;
  // IDs must be valid hex UUIDs: 8-4-4-4-12 format
  const hexId = seq.toString(16).padStart(8, "0");
  const id    = `${hexId}-0000-0000-0000-000000000001`;
  return {
    id,
    author_id:        overrides.author_id ?? BOB_ID,
    content:          overrides.body ?? overrides.content ?? "A test post",
    created_at:       overrides.created_at ?? NOW,
    visibility:       "public",
    status:           "active",
    // posts.post_status is NOT NULL DEFAULT 'published' (migration 0049), so a
    // real row ALWAYS carries one. Fixtures that omitted it could not tell a
    // published post from a pending delayed-geotag one.
    post_status:      overrides.post_status ?? "published",
    location_city:    overrides.location_city ?? null,
    location_country: overrides.location_country ?? null,
    location_name:    overrides.location_name ?? null,
    location_source:  overrides.location_source ?? null,
    venue_name:       overrides.venue_name ?? null,
    media_urls:       [],
    trip_id:          null,
    // Embedded relations that the pulse route accesses on each row
    pulse_geo_tags: null,
    post_media:     [],
    profiles:       {
      id:        overrides.author_id ?? BOB_ID,
      username:  "testuser",
      full_name: "Test User",
      avatar_url: null,
    },
    ...overrides,
  };
}

// ── Fake client factory ───────────────────────────────────────────────────────

interface FakeState {
  users?:                   Record<string, { id: string } | null>;
  posts?:                   Array<Record<string, any>>;
  profiles?:                Array<Record<string, any>>;
  blocks?:                  Array<{ blocker_id: string; blocked_id: string }>;
  follows?:                 Array<{ follower_id: string; following_id: string }>;
  featureFlags?:            Array<{ flag: string; enabled: boolean }>;
  compassProfiles?:         Array<Record<string, any>>;
  compassUserPreferences?:  Array<Record<string, any>>;
  hashtagUsages?:           Array<{ source_id: string; source_type: string; hashtag_id: string }>;
  hashtags?:                Array<{ id: string; slug: string; is_blocked: boolean }>;
  /** Every terminal read is recorded here (table + the .eq() predicates it carried),
   *  so a test can assert that a query CARRIES a filter and not merely that the
   *  response happens to be right. Without this the fake's own row filtering
   *  hides a deleted DB predicate. */
  captured?:                Array<{ table: string; eqs: Record<string, any> }>;
  /** Columns whose .eq() the fake does NOT apply — it feeds those rows PAST the
   *  filter the way a widened query or a stale client would, so the route's
   *  in-memory re-check is what has to refuse them. */
  ignoreEqCols?:            string[];
}

function makeClient(state: FakeState = {}, callerUserId: string = ALICE_ID) {
  const db: Record<string, any[]> = {
    posts:                   state.posts ?? [],
    profiles:                state.profiles ?? [],
    blocks:                  state.blocks ?? [],
    follows:                 state.follows ?? [],
    feature_flags:           state.featureFlags ?? [{ flag: "COMPASS_ENABLED", enabled: true }],
    compass_profiles:        state.compassProfiles ?? [
      {
        user_id:     callerUserId,
        current_city: "Manila",
        persona_type: "explorer",
        travel_intensity: "moderate",
        active_trip_id: null,
        vibe_tags: [],
      },
    ],
    compass_user_preferences: state.compassUserPreferences ?? [],
    trips:                   [],
    trip_members:            [],
    hashtag_usage:           state.hashtagUsages ?? [],
    hashtags:                state.hashtags ?? [],
    tags:                    [],
    // Tables queried by CompassProfileService.buildProfile:
    user_location_state:     [{ user_id: callerUserId, city: "Manila", country: "Philippines" }],
    trust_profiles:          [],
    user_preference_profiles: [],
    user_location_preferences: [],
    safe_return_sessions:    [],
    rent_buddy_bookings:     [],
    user_mutes:              [],
  };

  const ignoreEq = new Set(state.ignoreEqCols ?? []);

  function builder(table: string, rows: any[]) {
    let filtered = [...rows];
    const ops: Array<() => void> = [];
    const eqs: Record<string, any> = {};

    const b: any = {
      select: (_cols?: string) => builder(table, rows),
      eq: (col: string, val: any) => {
        eqs[col] = val;
        if (ignoreEq.has(col)) return b;
        filtered = filtered.filter((r) => r[col] === val);
        return b;
      },
      neq: (col: string, val: any) => {
        filtered = filtered.filter((r) => r[col] !== val);
        return b;
      },
      in: (col: string, vals: any[]) => {
        filtered = filtered.filter((r) => vals.includes(r[col]));
        return b;
      },
      not: (col: string, op: string, val: any) => {
        if (op === "in") {
          filtered = filtered.filter((r) => !val.includes(r[col]));
        }
        return b;
      },
      like: (col: string, pattern: string) => {
        const rx = new RegExp(
          "^" + pattern.replace(/%/g, ".*").replace(/_/g, ".") + "$", "i",
        );
        filtered = filtered.filter((r) => typeof r[col] === "string" && rx.test(r[col]));
        return b;
      },
      ilike: (col: string, pattern: string) => {
        const rx = new RegExp(
          "^" + pattern.replace(/%/g, ".*").replace(/_/g, ".") + "$", "i",
        );
        filtered = filtered.filter((r) => typeof r[col] === "string" && rx.test(r[col]));
        return b;
      },
      lt: (_col: string, _val: any) => b,
      lte: (_col: string, _val: any) => b,
      gt: (_col: string, _val: any) => b,
      gte: (_col: string, _val: any) => b,
      contains: (_col: string, _val: any) => b,
      overlaps: (_col: string, _val: any) => b,
      or: (_filter: string) => b,
      order: (_col: string, _opts?: any) => b,
      limit: (_n: number) => b,
      range: (_from: number, _to: number) => b,
      is: (col: string, val: any) => {
        filtered = filtered.filter((r) => {
          if (val === null) return r[col] == null;
          return r[col] === val;
        });
        return b;
      },
      maybeSingle: () =>
        Promise.resolve({ data: filtered[0] ?? null, error: null }),
      single: () =>
        Promise.resolve({ data: filtered[0] ?? null, error: null }),
      then: (resolve: any) => {
        state.captured?.push({ table, eqs: { ...eqs } });
        return resolve({ data: [...filtered], error: null });
      },
    };
    return b;
  }

  return {
    auth: {
      getUser: (token?: string) => {
        if (token === "alice-token") {
          return Promise.resolve({ data: { user: { id: callerUserId } }, error: null });
        }
        const users = state.users ?? {};
        if (token && users[token]) {
          return Promise.resolve({ data: { user: users[token] }, error: null });
        }
        return Promise.resolve({ data: { user: null }, error: { message: "no token" } });
      },
    },
    from: (table: string) => {
      const rows = db[table] ?? [];
      return builder(table, rows);
    },
    rpc: (_name: string, _params?: any) =>
      Promise.resolve({ data: null, error: null }),
  };
}

// ── Server factory ────────────────────────────────────────────────────────────

async function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = createServer(app).listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      resolve({
        url:   `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((res) => srv.close(() => res(undefined))),
      });
    });
  });
}

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  return app;
}

// ── A: Blocked user exclusion ──────────────────────────────────────────────────

describe("GET /api/pulse — blocked user exclusion", async () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    invalidateFlagsCache();
    const app = makeApp();
    const { default: pulseRouter } = await import("../routes/pulse.js");
    app.use("/api", pulseRouter);
    ({ url, close } = await startServer(app));

    const blockedPost = makePost({ author_id: BOB_ID, body: "I am blocked" });
    const normalPost  = makePost({ author_id: CAROL_ID, body: "I am visible" });

    _setTestClient(
      makeClient({
        posts:  [blockedPost, normalPost],
        blocks: [{ blocker_id: ALICE_ID, blocked_id: BOB_ID }],
      }),
      true,
    );
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("does not return posts from a user that Alice has blocked", async () => {
    const r = await fetch(`${url}/api/pulse`, {
      headers: { Authorization: "Bearer alice-token" },
    });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const authorIds = (body.posts as any[]).map((p: any) => p.authorId);
    assert.ok(!authorIds.includes(BOB_ID), "blocked user's posts should be excluded");
    assert.ok(authorIds.includes(CAROL_ID), "non-blocked user's posts should appear");
  });
});

// ── B: Blocked-by exclusion ────────────────────────────────────────────────────

describe("GET /api/pulse — blocked-by exclusion", async () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    invalidateFlagsCache();
    const app = makeApp();
    const { default: pulseRouter } = await import("../routes/pulse.js");
    app.use("/api", pulseRouter);
    ({ url, close } = await startServer(app));

    const blockerPost = makePost({ author_id: DAVE_ID, body: "I blocked you" });
    const normalPost  = makePost({ author_id: CAROL_ID, body: "All good" });

    _setTestClient(
      makeClient({
        posts:  [blockerPost, normalPost],
        // Dave blocked Alice (Alice is the blocked_id)
        blocks: [{ blocker_id: DAVE_ID, blocked_id: ALICE_ID }],
      }),
      true,
    );
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("does not return posts from users who have blocked Alice", async () => {
    const r = await fetch(`${url}/api/pulse`, {
      headers: { Authorization: "Bearer alice-token" },
    });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const authorIds = (body.posts as any[]).map((p: any) => p.authorId);
    assert.ok(!authorIds.includes(DAVE_ID), "posts from users who blocked the viewer should be excluded");
  });
});

// ── C: Delayed-publish gate ────────────────────────────────────────────────────
//
// This block used to assert that a post with location_source='delayed_pending'
// had its location fields nulled. It proved nothing twice over:
//
//   • 'delayed_pending' is not a label of the Postgres enum `location_source`
//     (its only labels are 'gps' | 'manual' | 'none' — see the baseline and
//     database.types.ts), so no row could ever hold it. The route's guard
//     compared against the same impossible string and never fired; the test
//     passed because the fixture's location fields were nulled by the SHAPER,
//     not by the guard (POST_SAFE_COLUMNS does not even select venue_name).
//   • Nulling location was the wrong remedy anyway: it still served the BODY of
//     a post whose author had asked for it to stay hidden until they had left
//     the place — the entire point of delayed geotagging (§23/§37).
//
// The publication state lives in `post_status` (enum delayed_post_status, NOT
// NULL DEFAULT 'published'). These tests pin BOTH layers of the real gate.

describe("GET /api/pulse — delayed-publish gate (§23/§37)", async () => {
  let url: string;
  let close: () => Promise<void>;

  const pendingPost = () => makePost({
    author_id:     BOB_ID,
    body:          "I am standing here right now",
    location_city: "Manila",
    location_name: "Some precise location",
    post_status:   "pending_location_exit",
  });
  const publishedPost = () => makePost({
    author_id:     BOB_ID,
    body:          "A post that is actually published",
    location_city: "Manila",
    post_status:   "published",
  });

  before(async () => {
    invalidateFlagsCache();
    const app = makeApp();
    const { default: pulseRouter } = await import("../routes/pulse.js");
    app.use("/api", pulseRouter);
    ({ url, close } = await startServer(app));
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  async function get() {
    const r = await fetch(`${url}/api/pulse`, { headers: { Authorization: "Bearer alice-token" } });
    assert.equal(r.status, 200);
    return (await r.json()) as any;
  }

  it("the feed query CARRIES post_status='published' (the DB-layer predicate)", async () => {
    const captured: Array<{ table: string; eqs: Record<string, any> }> = [];
    _setTestClient(makeClient({ posts: [publishedPost(), pendingPost()], captured }), true);
    const body = await get();
    assert.equal((body.posts as any[]).length, 1, "only the published post is served");

    const feedReads = captured.filter((c) => c.table === "posts" && c.eqs.status === "active");
    assert.ok(feedReads.length >= 1, "the pulse feed read posts");
    for (const q of feedReads) {
      assert.equal(q.eqs.visibility, "public");
      assert.equal(q.eqs.post_status, "published", "the pulse query carries the canonical predicate");
    }
  });

  it("a pending row fed PAST the query filter is still refused in memory", async () => {
    // ignoreEqCols makes the fake NOT apply .eq('post_status', …) — the shape of
    // a widened query. The route's own re-check has to catch it.
    _setTestClient(makeClient({
      posts: [publishedPost(), pendingPost()],
      ignoreEqCols: ["post_status"],
    }), true);
    const body = await get();
    const bodies = (body.posts as any[]).map((p: any) => p.content ?? p.body);
    assert.ok(
      !bodies.some((c: string) => String(c).includes("standing here right now")),
      "a pending post must not be served — not its location, and not its body",
    );
    assert.equal(bodies.length, 1, "the published post is still served");
  });

  it("a legacy row with NO post_status reads as published (absent ⇒ published)", async () => {
    const legacy = makePost({ author_id: BOB_ID, body: "legacy row", location_city: "Manila" });
    delete (legacy as any).post_status;
    _setTestClient(makeClient({ posts: [legacy], ignoreEqCols: ["post_status"] }), true);
    const body = await get();
    assert.equal((body.posts as any[]).length, 1, "absent post_status must not fail closed");
  });
});

// ── D: Followed-user boost ─────────────────────────────────────────────────────

describe("GET /api/pulse — followed-user recency boost", async () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    invalidateFlagsCache();
    const app = makeApp();
    const { default: pulseRouter } = await import("../routes/pulse.js");
    app.use("/api", pulseRouter);
    ({ url, close } = await startServer(app));

    // BOB is followed; posted recently.  CAROL is not followed; posted even more recently.
    // With a followed-user boost, Bob's post should rank above Carol's older-stranger post.
    const bobPost   = makePost({ author_id: BOB_ID,   created_at: ONE_HOUR_AGO,  body: "Bob followed recent" });
    const carolPost = makePost({ author_id: CAROL_ID,  created_at: TWO_DAYS_AGO, body: "Carol stranger old" });

    _setTestClient(
      makeClient({
        posts:   [carolPost, bobPost], // carol first in raw order
        follows: [{ follower_id: ALICE_ID, following_id: BOB_ID }],
      }),
      true,
    );
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("followed user's recent post ranks above stranger's older post", async () => {
    const r = await fetch(`${url}/api/pulse`, {
      headers: { Authorization: "Bearer alice-token" },
    });
    assert.equal(r.status, 200);
    const body      = await r.json() as any;
    const authorIds = (body.posts as any[]).map((p: any) => p.authorId);
    assert.ok(authorIds.length >= 2, "should have at least 2 posts");
    const bobIdx   = authorIds.indexOf(BOB_ID);
    const carolIdx = authorIds.indexOf(CAROL_ID);
    assert.ok(bobIdx < carolIdx, `followed user (BOB idx=${bobIdx}) should rank before stranger (CAROL idx=${carolIdx})`);
  });
});

// ── E: Hashtag interest boost ──────────────────────────────────────────────────

describe("GET /api/pulse — hashtag interest boost", async () => {
  let url: string;
  let close: () => Promise<void>;

  const HASHTAG_ID = "11111111-1111-1111-1111-111111111111";

  before(async () => {
    invalidateFlagsCache();
    const app = makeApp();
    const { default: pulseRouter } = await import("../routes/pulse.js");
    app.use("/api", pulseRouter);
    ({ url, close } = await startServer(app));

    // Both posts are old (same age) — only the hashtag boost differentiates them.
    const plainPost   = makePost({ author_id: BOB_ID,   created_at: TWO_DAYS_AGO, body: "No hashtags" });
    const taggedPost  = makePost({ author_id: CAROL_ID, created_at: TWO_DAYS_AGO, body: "#street_food vibes" });

    _setTestClient(
      makeClient({
        posts: [plainPost, taggedPost],  // plain first in raw order
        compassUserPreferences: [
          { user_id: ALICE_ID, interests: ["street_food"] },
        ],
        hashtagUsages: [
          { source_id: taggedPost.id, source_type: "post", hashtag_id: HASHTAG_ID },
        ],
        hashtags: [
          { id: HASHTAG_ID, slug: "street_food", is_blocked: false },
        ],
      }),
      true,
    );
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("post matching viewer interest ranks above post without matching hashtag", async () => {
    const r = await fetch(`${url}/api/pulse`, {
      headers: { Authorization: "Bearer alice-token" },
    });
    assert.equal(r.status, 200);
    const body      = await r.json() as any;
    const authorIds = (body.posts as any[]).map((p: any) => p.authorId);
    assert.ok(authorIds.length >= 2, "should have at least 2 posts");
    const taggedIdx = authorIds.indexOf(CAROL_ID);
    const plainIdx  = authorIds.indexOf(BOB_ID);
    assert.ok(taggedIdx < plainIdx, `interest-matched post (CAROL idx=${taggedIdx}) should rank before plain post (BOB idx=${plainIdx})`);
  });
});

// ── F: City boost ──────────────────────────────────────────────────────────────

describe("GET /api/pulse — city boost", async () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    invalidateFlagsCache();
    const app = makeApp();
    const { default: pulseRouter } = await import("../routes/pulse.js");
    app.use("/api", pulseRouter);
    ({ url, close } = await startServer(app));

    // Both posts at the same time — only city match differentiates them.
    // Alice's compass_profile.current_city = "Manila" (default).
    const manilaPost = makePost({ author_id: CAROL_ID, created_at: NOW, location_city: "Manila" });
    const cebuPost   = makePost({ author_id: BOB_ID,   created_at: NOW, location_city: "Cebu" });

    _setTestClient(
      makeClient({
        posts: [cebuPost, manilaPost],  // cebu first in raw order
      }),
      true,
    );
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("post in viewer's Compass city ranks above post in a different city", async () => {
    const r = await fetch(`${url}/api/pulse`, {
      headers: { Authorization: "Bearer alice-token" },
    });
    assert.equal(r.status, 200);
    const body      = await r.json() as any;
    const authorIds = (body.posts as any[]).map((p: any) => p.authorId);
    assert.ok(authorIds.length >= 2, "should have at least 2 posts");
    const manilaIdx = authorIds.indexOf(CAROL_ID);
    const cebuIdx   = authorIds.indexOf(BOB_ID);
    assert.ok(manilaIdx < cebuIdx, `Manila post (CAROL idx=${manilaIdx}) should rank before Cebu post (BOB idx=${cebuIdx})`);
  });
});

// ── G: Auth guard ──────────────────────────────────────────────────────────────

describe("GET /api/pulse — auth guard", async () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    invalidateFlagsCache();
    const app = makeApp();
    const { default: pulseRouter } = await import("../routes/pulse.js");
    app.use("/api", pulseRouter);
    ({ url, close } = await startServer(app));
    _setTestClient(makeClient(), true);
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("returns 401 when no Authorization header is sent", async () => {
    const r = await fetch(`${url}/api/pulse`);
    assert.equal(r.status, 401);
  });
});

// ── H: Prompts field always present ───────────────────────────────────────────

describe("GET /api/pulse — prompts field", async () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    invalidateFlagsCache();
    const app = makeApp();
    const { default: pulseRouter } = await import("../routes/pulse.js");
    app.use("/api", pulseRouter);
    ({ url, close } = await startServer(app));
    _setTestClient(makeClient({ posts: [makePost()] }), true);
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("always includes a prompts array in the response", async () => {
    const r = await fetch(`${url}/api/pulse`, {
      headers: { Authorization: "Bearer alice-token" },
    });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.ok(Array.isArray(body.prompts), "body.prompts should be an array");
  });
});

// ── I: Moderation guard ────────────────────────────────────────────────────────

describe("GET /api/pulse — moderation guard", async () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    invalidateFlagsCache();
    const app = makeApp();
    const { default: pulseRouter } = await import("../routes/pulse.js");
    app.use("/api", pulseRouter);
    ({ url, close } = await startServer(app));

    // postGood: has one ready media item — should appear in feed
    const postGood = makePost({
      author_id: BOB_ID,
      content: "Good post with ready media",
      post_media: [
        { id: "m1", media_type: "photo", public_url: "https://cdn/ok.jpg",
          thumbnail_url: null, duration_seconds: null, width: 800, height: 600,
          sort_order: 0, processing_status: "ready", moderation_status: "approved" },
      ],
    });

    // postRejected: all media rejected — must be excluded from feed
    const postRejected = makePost({
      author_id: CAROL_ID,
      content: "Post with fully-rejected media",
      post_media: [
        { id: "m2", media_type: "photo", public_url: "https://cdn/bad.jpg",
          thumbnail_url: null, duration_seconds: null, width: 800, height: 600,
          sort_order: 0, processing_status: "ready", moderation_status: "rejected" },
      ],
    });

    // postTextOnly: no media — should always appear
    const postTextOnly = makePost({
      author_id: DAVE_ID,
      content: "Text-only post with no media",
      post_media: [],
    });

    _setTestClient(
      makeClient({ posts: [postGood, postRejected, postTextOnly] }),
      true,
    );
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("excludes posts whose media is entirely rejected and passes text-only posts", async () => {
    const r = await fetch(`${url}/api/pulse`, {
      headers: { Authorization: "Bearer alice-token" },
    });
    assert.equal(r.status, 200);
    const body      = await r.json() as any;
    const authorIds = (body.posts as any[]).map((p: any) => p.authorId);
    // CAROL's post (fully-rejected media) must NOT appear
    assert.ok(!authorIds.includes(CAROL_ID), "rejected-media post must be excluded");
    // BOB's good post and DAVE's text-only post must appear
    assert.ok(authorIds.includes(BOB_ID),  "post with ready media must be included");
    assert.ok(authorIds.includes(DAVE_ID), "text-only post must be included");
  });
});

// ── J: Block-query fail-closed ─────────────────────────────────────────────────

describe("GET /api/pulse — block-query failure returns empty feed (fail-closed)", async () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    invalidateFlagsCache();
    const app = makeApp();
    // Stub req.log so the fail-closed warn() doesn't crash the handler.
    app.use((req: any, _res: any, next: any) => {
      req.log = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };
      next();
    });
    const { default: pulseRouter } = await import("../routes/pulse.js");
    app.use("/api", pulseRouter);
    ({ url, close } = await startServer(app));

    // A post exists so there IS content to return if the filter fails open.
    const post = makePost({ author_id: BOB_ID, body: "Should not appear" });

    // Build a client where the blocks table always returns a DB error.
    const baseClient = makeClient({ posts: [post] });
    const faultyClient = {
      ...baseClient,
      from: (table: string) => {
        if (table === "blocks") {
          const b: any = {
            select: () => b,
            eq:     () => b,
            then:   (resolve: any) =>
              resolve({ data: null, error: { message: "simulated blocks DB error" } }),
          };
          return b;
        }
        return baseClient.from(table);
      },
    };

    _setTestClient(faultyClient, true);
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("returns empty posts array when the blocks query errors — not unfiltered posts", async () => {
    const r = await fetch(`${url}/api/pulse`, {
      headers: { Authorization: "Bearer alice-token" },
    });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.deepEqual(body.posts, [], "feed must be empty when block state cannot be determined");
    assert.equal(body.total, 0, "total must be 0 when block state cannot be determined");
  });
});
