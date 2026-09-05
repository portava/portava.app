/**
 * The delayed-publish gate on the surfaces PR #397 did not reach.
 *
 * WHAT THIS EXISTS FOR
 * --------------------
 * `posts.post_status` (enum `delayed_post_status`, NOT NULL DEFAULT 'published')
 * is the publication state machine. POST /posts writes a delayed-geotag post as
 * `status = 'active'` with a PENDING post_status — 'pending_location_exit' when
 * the author asked to publish only after they had left, 'pending_delay' for a
 * timed release, 'pending_safety_review' when moderation parks it — and the
 * sweeper (lib/delayedPostPublisher) flips it to 'published' later. Serving such
 * a post publishes the author's location before the delay they asked for has
 * expired, which is the whole thing delayed geotagging exists to prevent
 * (§23 / §37). `status = 'active'` is NOT a publication filter.
 *
 * PR #360 closed this on the Wall; PR #397 closed it on GET /trips/:tripId/posts,
 * GET /pulse, GET /airport/pulse, discovery search and
 * placeCollections.fetchBestOfRealtime. Two readers were still open, and both
 * are the "gate landed on one path and not its twin" shape:
 *
 *   • compass/CompassItemHydrator.fetchPosts — the Compass feed's MAIN post
 *     source. It never selected post_status at all, and postToItem copies
 *     `location_city` / `location_country` / `canonical_place_id` straight onto
 *     the item. CompassPrivacyGuard's delayed-post coordinate scrub keys on
 *     `item.isDelayedPost`, a flag only CompassFallbackFeedBuilder sets — so on
 *     this path the downstream defense could never fire either.
 *
 *   • compass/CompassFallbackFeedBuilder.fetchVerifiedEvents — carried
 *     `.not("post_status", "eq", "delayed_post")`. `delayed_post` is NOT a label
 *     of `delayed_post_status` (migration 0049: draft / private /
 *     pending_location_exit / pending_delay / pending_safety_review / published /
 *     canceled / expired), so the predicate could never match: it excluded
 *     nothing, or PostgREST rejected the literal 22P02 and the lane's
 *     best-effort catch swallowed the whole read. #397 repaired the identical
 *     literal in fetchPopularPosts in this same file and left this one, because
 *     the existing test drives buildFallbackFeed with a NULL city and this lane
 *     returns [] before its query when there is no city. These cases pass a city.
 *
 * A third, lib/places/placeCollectionsWorker.processPlace, has the same defect
 * (getBestOf serves the CACHED place_best_of row first, so #397's gate on the
 * realtime fallback is bypassed on the path normally served) but is already
 * fixed by PR #405 on the same lines, and fixed better — see section 3 below.
 *
 * Each is proven at BOTH layers, as routes/wall.ts is:
 *   • the query CARRIES the DB-layer predicate — asserted against captured
 *     predicates, because a fake that filters rows itself would stay green after
 *     the predicate was deleted;
 *   • a pending row fed PAST the query filter is still refused in memory by
 *     lib/postVisibility.isPostPublished — and an ABSENT post_status reads as
 *     published, matching GET /posts/:postId and lib/mediaEligibility.
 *
 * Also covered: the second dead `delayed_post` literal, in
 * routes/adminCompass.ts's dashboard. That one is not a leak — it is an
 * admin-only COUNT that discloses no row — but it is a dead query: the pending
 * delayed-publish backlog reported 0 whatever the real backlog was.
 *
 * Run: node --import tsx/esm --test src/test/postPublishGatePlatformWide.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminCompassRouter from "../routes/adminCompass.js";
import { hydrateCompassItems } from "../compass/CompassItemHydrator.js";
import { buildFallbackFeed } from "../compass/CompassFallbackFeedBuilder.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import type { CompassProfile } from "../compass/types.js";

const VIEWER = "f0000000-0000-4000-a000-000000000001";
const AUTHOR = "f0000000-0000-4000-a000-000000000002";
const CITY   = "Da Nang";
const PLACE  = "f0000000-0000-4000-a000-0000000000aa";

/** Every pending label of the delayed_post_status enum (migration 0049). */
const PENDING_LABELS = ["pending_location_exit", "pending_delay", "pending_safety_review"] as const;

/** A label that is NOT in the enum. The repaired call sites must never name it. */
const DEAD_LABEL = "delayed_post";

interface Captured {
  table: string;
  eqs:   Record<string, any>;
  ins:   Record<string, any[]>;
  nots:  Array<[string, string, any]>;
}

function postRow(id: string, over: Record<string, any> = {}): Record<string, any> {
  return {
    id,
    author_id:            AUTHOR,
    content:              `post ${id}`,
    media_urls:           [],
    media_type:           "photo",
    media_thumbnail_url:  null,
    created_at:           "2026-09-01T10:00:00Z",
    location_city:        CITY,
    location_country:     "VN",
    canonical_place_id:   PLACE,
    category:             "event",
    location_verified:    true,
    visibility:           "public",
    status:               "active",
    post_status:          "published",
    post_buckets:         [],
    like_count:           5,
    save_count:           0,
    share_count:          0,
    view_count:           0,
    qualified_view_count: 0,
    ...over,
  };
}

/** One published post plus one post in each pending state. */
function fixture(): Record<string, any>[] {
  return [
    postRow("published-1"),
    ...PENDING_LABELS.map((s, i) => postRow(`pending-${i}`, { post_status: s })),
  ];
}

/**
 * Table-routed fake. Records the predicates of every terminal read and, unless
 * the column is listed in `ignoreEqCols`, applies them the way the DB would.
 * `ignoreEqCols` is what feeds a pending row PAST the query filter, leaving the
 * reader's own in-memory re-check as the only thing that can refuse it.
 */
function makeClient(opts: {
  posts:         Record<string, any>[];
  captured?:     Captured[];
  ignoreEqCols?: string[];
  extraTables?:  Record<string, Record<string, any>[]>;
}) {
  const ignore = new Set(opts.ignoreEqCols ?? []);
  const tables: Record<string, Record<string, any>[]> = {
    posts:                         opts.posts,
    profiles:                      [{ id: AUTHOR, username: "aya", display_name: "Aya", avatar_url: null }],
    blocks:                        [],
    user_interactions:             [],
    rent_buddy_profiles:           [],
    discovery_places:              [],
    events:                        [],
    hidden_gems:                   [],
    message_threads:               [],
    place_best_of:                 [],
    place_top_contributors:        [],
    place_living_cache:            [],
    place_cache_invalidation_queue: [],
    ...(opts.extraTables ?? {}),
  };

  function builder(table: string) {
    const rec: Captured = { table, eqs: {}, ins: {}, nots: [] };
    let rows = [...(tables[table] ?? [])];
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => {
        rec.eqs[c] = v;
        if (!ignore.has(c)) rows = rows.filter((r) => r[c] === v);
        return b;
      },
      in: (c: string, v: any[]) => {
        rec.ins[c] = v;
        if (!ignore.has(c)) rows = rows.filter((r) => v.includes(r[c]));
        return b;
      },
      not: (c: string, op: string, v: any) => { rec.nots.push([c, op, v]); return b; },
      ilike: (c: string, pat: string) => {
        const re = new RegExp(
          "^" + String(pat).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$",
          "i",
        );
        rows = rows.filter((r) => re.test(String(r[c] ?? "")));
        return b;
      },
      is: () => b, or: () => b, like: () => b, neq: () => b, contains: () => b,
      gte: () => b, lte: () => b, gt: () => b, lt: () => b,
      order: () => b, limit: () => b, range: () => b,
      insert:  () => Promise.resolve({ data: null, error: null }),
      update:  () => b,
      upsert:  () => Promise.resolve({ data: null, error: null }),
      delete:  () => b,
      maybeSingle: () => { opts.captured?.push(rec); return Promise.resolve({ data: rows[0] ?? null, error: null }); },
      single:      () => b.maybeSingle(),
      then: (onF: any, onR: any) => {
        opts.captured?.push(rec);
        return Promise.resolve({ data: rows, error: null, count: rows.length }).then(onF, onR);
      },
    };
    return b;
  }

  return { from: builder } as any;
}

/** Reads captured on the `posts` table only. */
function postReads(captured: Captured[]): Captured[] {
  return captured.filter((c) => c.table === "posts");
}

function baseProfile(over: Partial<CompassProfile> = {}): CompassProfile {
  return {
    userId:                 VIEWER,
    preferredCities:        [],
    preferredLanguages:     ["en"],
    budgetStyle:            null,
    travelStyles:           [],
    socialStyle:            null,
    safetyPreference:       "standard",
    visibilityPreference:   "semi_private",
    blockedUserIds:         [],
    blockerUserIds:         [],
    mutedUserIds:           [],
    blockCount:             0,
    blockerCount:           0,
    trustScore:             null,
    trustLevel:             null,
    activeUserScore:        null,
    hasActiveTrip:          false,
    hasActiveBooking:       false,
    upcomingTripWithin48h:  false,
    hasFutureTripScheduled: false,
    currentCity:            null,
    currentCountry:         null,
    safeReturnActive:       false,
    categoryWeights:        null,
    ignoredItemIds:         [],
    mutedHashtags:          [],
    computedAt:             new Date().toISOString(),
    ...over,
  } as CompassProfile;
}

// ── 1. CompassItemHydrator.fetchPosts ─────────────────────────────────────────

describe("CompassItemHydrator.fetchPosts — delayed-publish gate (§23/§37)", () => {
  /** Post-item ids the hydrator offered the pipeline. */
  function postIds(items: Awaited<ReturnType<typeof hydrateCompassItems>>): string[] {
    return items.filter((i) => i.type === "post").map((i) => i.id).sort();
  }

  it("the global-pool query CARRIES post_status='published' (the DB-layer predicate)", async () => {
    const captured: Captured[] = [];
    const items = await hydrateCompassItems(makeClient({ posts: fixture(), captured }), baseProfile());

    assert.deepEqual(postIds(items), ["published-1"], "only the published post reaches the pipeline");

    const reads = postReads(captured);
    assert.ok(reads.length >= 1, "the hydrator read posts");
    for (const q of reads) {
      assert.equal(q.eqs.status, "active");
      assert.equal(q.eqs.visibility, "public");
      assert.equal(q.eqs.post_status, "published", "the query carries the canonical predicate");
    }
  });

  it("the city-biased query CARRIES post_status='published' too (both paths, not just one)", async () => {
    const captured: Captured[] = [];
    const items = await hydrateCompassItems(
      makeClient({ posts: fixture(), captured }),
      baseProfile({ currentCity: CITY }),
    );

    assert.deepEqual(postIds(items), ["published-1"]);

    const reads = postReads(captured);
    assert.ok(reads.length >= 2, "the city path issues BOTH the city read and the global read");
    for (const q of reads) {
      assert.equal(q.eqs.post_status, "published", "every posts read carries the canonical predicate");
    }
  });

  it("pending rows fed PAST the query filter are still refused in memory (global path)", async () => {
    const items = await hydrateCompassItems(
      makeClient({ posts: fixture(), ignoreEqCols: ["post_status"] }),
      baseProfile(),
    );
    assert.deepEqual(postIds(items), ["published-1"],
      "a post whose location is still withheld must never reach the Compass feed");
  });

  it("pending rows fed PAST the query filter are still refused in memory (city path)", async () => {
    const items = await hydrateCompassItems(
      makeClient({ posts: fixture(), ignoreEqCols: ["post_status"] }),
      baseProfile({ currentCity: CITY }),
    );
    assert.deepEqual(postIds(items), ["published-1"]);
  });

  it("a legacy row with NO post_status reads as published (absent ⇒ published)", async () => {
    const legacy = postRow("legacy-1");
    delete legacy.post_status;
    const items = await hydrateCompassItems(
      makeClient({ posts: [legacy], ignoreEqCols: ["post_status"] }),
      baseProfile(),
    );
    assert.deepEqual(postIds(items), ["legacy-1"], "absent must not fail closed");
  });

  it("the served item would otherwise carry the author's live location (why this matters)", async () => {
    // Not a gate assertion — it pins WHAT leaks, so a future refactor that drops
    // city/country/placeId from the item cannot quietly make this suite vacuous.
    const items = await hydrateCompassItems(makeClient({ posts: fixture() }), baseProfile());
    const served = items.find((i) => i.type === "post");
    assert.ok(served, "the published post is served");
    assert.equal((served as any).city, CITY);
    assert.equal((served as any).country, "VN");
    assert.equal((served as any).placeId, PLACE);
  });
});

// ── 2. CompassFallbackFeedBuilder.fetchVerifiedEvents ─────────────────────────

describe("CompassFallbackFeedBuilder.fetchVerifiedEvents — the second dead `delayed_post` literal", () => {
  beforeEach(() => invalidateFlagsCache());

  /** Verified-event item ids the fallback feed offered. */
  function eventIds(out: Awaited<ReturnType<typeof buildFallbackFeed>>): string[] {
    return out.safeItems
      .filter((i: any) => i.category === "verified_event")
      .map((i: any) => i.id as string)
      .sort();
  }

  it("the query CARRIES post_status='published' and never names the dead label", async () => {
    const captured: Captured[] = [];
    const out = await buildFallbackFeed(
      makeClient({ posts: fixture(), captured }),
      VIEWER,
      baseProfile({ currentCity: CITY }),
      "test",
    );

    assert.deepEqual(eventIds(out), ["published-1"], "only the published event post is offered");

    const eventReads = postReads(captured).filter((c) => c.eqs.category === "event");
    assert.ok(eventReads.length >= 1, "the verified-events lane read posts (it needs a city to run at all)");
    for (const q of eventReads) {
      assert.equal(q.eqs.location_city, CITY);
      assert.equal(q.eqs.post_status, "published", "the query carries the canonical predicate");
    }

    // No posts read anywhere in this module may still compare against a label
    // that is not in the delayed_post_status enum — that is what made both of
    // these filters inert in the first place.
    for (const q of postReads(captured)) {
      assert.notEqual(q.eqs.post_status, DEAD_LABEL);
      for (const [col, , val] of q.nots) {
        assert.ok(
          !(col === "post_status" && val === DEAD_LABEL),
          "the dead `delayed_post` literal must not survive anywhere in this module",
        );
      }
    }
  });

  it("pending rows fed PAST the query filter are still refused in memory", async () => {
    const out = await buildFallbackFeed(
      makeClient({ posts: fixture(), ignoreEqCols: ["post_status"] }),
      VIEWER,
      baseProfile({ currentCity: CITY }),
      "test",
    );
    assert.deepEqual(eventIds(out), ["published-1"],
      "CompassSafetyFilter's delayed-post gate only inspects type='post'; these are type='event', " +
      "so this lane's own in-memory re-check is the last line of defense");
  });

  it("a legacy row with NO post_status reads as published (absent ⇒ published)", async () => {
    const legacy = postRow("legacy-1");
    delete legacy.post_status;
    const out = await buildFallbackFeed(
      makeClient({ posts: [legacy], ignoreEqCols: ["post_status"] }),
      VIEWER,
      baseProfile({ currentCity: CITY }),
      "test",
    );
    assert.deepEqual(eventIds(out), ["legacy-1"], "absent must not fail closed");
  });
});

// ── 3. placeCollectionsWorker.processPlace → place_best_of ────────────────────
//
// NOT covered here, deliberately. lib/places/placeCollectionsWorker.processPlace
// has the same defect — getBestOf serves the CACHED place_best_of row first and
// only falls back to the gated realtime query, so a gate on the fallback alone
// fixes nothing in practice — but PR #405 already fixes it, on the same lines,
// and fixes it better: it gates Best-Of through placeCollections.isPublicPlaceRailPost
// (publication AND visibility) while deliberately leaving contributor counting
// over every active post at the place, which narrowing the query would have
// changed as a side effect. Duplicating it here would only guarantee a conflict.
// Its proof lives in src/test/placeBestOfVisibility.test.ts on that branch.

// ── 4. adminCompass dashboard — the OTHER dead `delayed_post` literal ─────────
//
// Not a leak: this is an admin-only COUNT with head:true, so no row is
// disclosed. It is a DEAD QUERY. `.eq("post_status", "delayed_post")` names a
// label that is not in the delayed_post_status enum, so the delayed-publish
// backlog on the ops dashboard read 0 no matter how many posts were actually
// waiting — and if PostgREST rejected the literal 22P02 the Promise.allSettled
// entry simply rejected, which the reader also treats as 0. Same defect class
// as the two filters above; different consequence.

describe("adminCompass dashboard — pending delayed-post count uses REAL enum labels", () => {
  const ADMIN = "f0000000-0000-4000-a000-0000000000ad";
  const TOKEN = "pubgate-admin-token";
  let server: http.Server;
  let baseUrl = "";

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
      next();
    });
    app.use("/api", adminCompassRouter);
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
    _setTestServiceClient(null as any);
    await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
  });

  /** Admin-authorised client wrapping the predicate-recording builder. */
  function adminClient(captured: Captured[]) {
    const inner = makeClient({ posts: fixture(), captured });
    const client: any = {
      from(table: string) {
        if (table === "profiles") {
          const b: any = {
            select: () => b, eq: () => b,
            maybeSingle: () => Promise.resolve({ data: { id: ADMIN, role: "admin" }, error: null }),
            then: (r: any) => r({ data: [{ id: ADMIN, role: "admin" }], error: null, count: 1 }),
          };
          return b;
        }
        return inner.from(table);
      },
      auth: {
        getUser: async (t: string) =>
          t === TOKEN
            ? { data: { user: { id: ADMIN } }, error: null }
            : { data: { user: null }, error: { message: "bad token" } },
      },
    };
    return client;
  }

  it("counts the three pending labels, and never names `delayed_post`", async () => {
    const captured: Captured[] = [];
    const client = adminClient(captured);
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const res = await fetch(`${baseUrl}/api/admin/compass/dashboard`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;

    // The fixture holds exactly one post in each pending state plus one
    // published post. A working metric reports 3; the dead literal reported 0.
    assert.equal(body.delayedPosts.pendingCount, PENDING_LABELS.length,
      "the backlog metric must actually count the posts that are waiting");

    const pendingRead = postReads(captured).find((c) => "post_status" in c.ins);
    assert.ok(pendingRead, "the dashboard issued a post_status-scoped read");
    assert.deepEqual([...pendingRead.ins.post_status].sort(), [...PENDING_LABELS].sort(),
      "the predicate names exactly the pending labels of delayed_post_status");

    for (const q of postReads(captured)) {
      assert.notEqual(q.eqs.post_status, DEAD_LABEL,
        "no posts read on this dashboard may still compare against the dead label");
      assert.ok(!(q.ins.post_status ?? []).includes(DEAD_LABEL));
    }
  });
});
