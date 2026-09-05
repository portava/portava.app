/**
 * Best-Of honours post visibility (spec §23/§24).
 *
 * WHAT THIS EXISTS FOR
 * --------------------
 * The Living Destination Page's Best-Of rails are keyed on `canonical_place_id`
 * and rendered on that place's page to every viewer — routes/placeLiving calls
 * `getBestOf(survivorId, sc)` with NO viewer at all. Only a post a STRANGER may
 * read belongs on them.
 *
 * `fetchBestOfRealtime` had no `visibility` filter of any kind. A `private` post
 * — and a `trip_only` post, readable only by accepted members of its trip —
 * attached to a place reached that place's public rails: its media, its caption,
 * and the fact that its author was at that venue.
 *
 * The producer side leaked the same way and mattered MORE: placeCollectionsWorker
 * builds `place_best_of`, and getBestOf serves that cache FIRST, so a post the
 * realtime path refuses can still arrive baked into the cache.
 *
 * The rule is the canonical one, not a second implementation:
 * lib/postVisibility.canReadPost (the predicate WallProjectionService and
 * GET /posts/:postId apply) evaluated for a no-viewer stranger, composed with
 * lib/postVisibility.isPostPublished — the delayed-publish gate PR #397 added
 * here, which this file also re-proves is intact and composes with the new one.
 *
 * Both layers are proven, the way routes/wall.ts is:
 *   • the query CARRIES the predicates — asserted against captured `.eq()`
 *     filters, because a fake that filters rows itself would stay green after
 *     the predicate was deleted;
 *   • a restricted row fed PAST the filter is still refused in memory.
 *
 * Run: node --import tsx/esm --test src/test/placeBestOfVisibility.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getBestOf, isPublicPlaceRailPost } from "../lib/places/placeCollections.js";
import { runCollectionsTick, _setTestAwardStamp } from "../lib/places/placeCollectionsWorker.js";

const PLACE = "e1000000-0000-4000-a000-0000000000aa";
const AUTHOR = "e1000000-0000-4000-a000-0000000000b1";
const TRIP = "e1000000-0000-4000-a000-0000000000c1";

interface Captured { table: string; eqs: Record<string, any> }

function postRow(id: string, over: Record<string, any> = {}): Record<string, any> {
  return {
    id,
    author_id: AUTHOR,
    trip_id: null,
    visibility: "public",
    status: "active",
    post_status: "published",
    canonical_place_id: PLACE,
    content: `post ${id}`,
    media_type: "photo",
    media_urls: [`media/${id}.jpg`],
    media_thumbnail_url: null,
    post_buckets: [],
    like_count: 5,
    save_count: 0,
    share_count: 0,
    view_count: 0,
    qualified_view_count: 0,
    created_at: "2026-09-01T10:00:00Z",
    ...over,
  };
}

/** One public post plus one of every restricted tier, all at the same place. */
function fixture(): Record<string, any>[] {
  return [
    postRow("public-1"),
    postRow("private-1", { visibility: "private" }),
    postRow("trip-only-1", { visibility: "trip_only", trip_id: TRIP }),
    postRow("followers-1", { visibility: "followers_only" }),
    postRow("future-tier-1", { visibility: "some_tier_invented_later" }),
  ];
}

/**
 * Table-routed fake. Records each terminal read's `.eq()` predicates and, unless
 * the column is in `ignoreEqCols`, applies them the way the DB would.
 * `ignoreEqCols` is what feeds a restricted row PAST the query filter, leaving
 * the in-memory re-check as the only thing that can refuse it.
 */
function makeClient(opts: {
  posts: Record<string, any>[];
  captured?: Captured[];
  ignoreEqCols?: string[];
  cached?: Record<string, any> | null;
}) {
  const ignore = new Set(opts.ignoreEqCols ?? []);
  const tables: Record<string, Record<string, any>[]> = {
    posts: opts.posts,
    place_best_of: opts.cached ? [opts.cached] : [],
    place_cache_invalidation_queue: [],
  };

  function builder(table: string) {
    const eqs: Record<string, any> = {};
    let rows = [...(tables[table] ?? [])];
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => {
        eqs[c] = v;
        if (!ignore.has(c)) rows = rows.filter((r) => (r[c] ?? null) === v);
        return b;
      },
      in: (c: string, v: any[]) => { rows = rows.filter((r) => v.includes(r[c])); return b; },
      not: () => b, is: () => b, or: () => b, neq: () => b,
      gte: () => b, lte: () => b, gt: () => b, lt: () => b,
      order: () => b, limit: () => b, range: () => b,
      insert: () => Promise.resolve({ error: null }),
      upsert: () => Promise.resolve({ error: null }),
      maybeSingle: () => {
        opts.captured?.push({ table, eqs: { ...eqs } });
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      single: () => b.maybeSingle(),
      then: (onF: any, onR: any) => {
        opts.captured?.push({ table, eqs: { ...eqs } });
        return Promise.resolve({ data: rows, error: null }).then(onF, onR);
      },
    };
    return b;
  }
  return { from: builder } as any;
}

/** Every post id anywhere in the BestOf envelope. */
function idsIn(best: Awaited<ReturnType<typeof getBestOf>>): string[] {
  return [...new Set(
    [...best.videos, ...best.photos, ...best.viewpoints, ...best.foodNearby, ...best.experiences]
      .map((i) => i.postId),
  )].sort();
}

// ── the pure predicate ────────────────────────────────────────────────────────

describe("isPublicPlaceRailPost — the one rule the rails apply", () => {
  it("admits a published public post", () => {
    assert.equal(isPublicPlaceRailPost(postRow("p") as any), true);
  });

  it("refuses private, trip_only and followers_only", () => {
    for (const visibility of ["private", "trip_only", "followers_only", "followers"]) {
      assert.equal(
        isPublicPlaceRailPost(postRow("p", { visibility, trip_id: TRIP }) as any),
        false,
        `${visibility} must never reach a public place rail`,
      );
    }
  });

  it("fails CLOSED on a visibility tier it does not recognise", () => {
    assert.equal(isPublicPlaceRailPost(postRow("p", { visibility: "invented_later" }) as any), false);
  });

  it("treats a legacy row with no visibility column as public", () => {
    const legacy = postRow("legacy");
    delete legacy.visibility;
    assert.equal(isPublicPlaceRailPost(legacy as any), true);
  });

  it("never admits a post through the author branch — the rail has no viewer", () => {
    // decidePostReadable lets an AUTHOR read their own private post. Best-Of has
    // no viewer, so the stranger it evaluates against is a non-uuid sentinel that
    // no real author_id can equal — a private post stays refused whoever wrote it.
    for (const author_id of [AUTHOR, "00000000-0000-0000-0000-000000000000", "", "anonymous"]) {
      assert.equal(
        isPublicPlaceRailPost(postRow("p", { visibility: "private", author_id }) as any),
        false,
        `a private post by ${author_id || "(empty author)"} must stay off the rail`,
      );
    }
  });

  it("still composes with the delayed-publish gate (#397) — pending never serves", () => {
    for (const post_status of ["pending_location_exit", "pending_delay", "pending_safety_review"]) {
      assert.equal(isPublicPlaceRailPost(postRow("p", { post_status }) as any), false);
    }
  });
});

// ── getBestOf realtime path ───────────────────────────────────────────────────

describe("getBestOf — restricted posts never reach a place's Best-Of rails", () => {
  it("the query CARRIES visibility='public' alongside the publish gate", async () => {
    const captured: Captured[] = [];
    const best = await getBestOf(PLACE, makeClient({ posts: fixture(), captured }));
    assert.deepEqual(idsIn(best), ["public-1"], "only the public post reaches the place page");

    const postReads = captured.filter((c) => c.table === "posts");
    assert.ok(postReads.length >= 1, "getBestOf fell back to the realtime posts read");
    for (const q of postReads) {
      assert.equal(q.eqs.canonical_place_id, PLACE);
      assert.equal(q.eqs.status, "active");
      assert.equal(q.eqs.post_status, "published", "the publication gate is intact");
      assert.equal(q.eqs.visibility, "public", "the query carries the visibility predicate");
    }
  });

  it("a private post fed PAST the query filter is still refused in memory", async () => {
    const best = await getBestOf(
      PLACE,
      makeClient({ posts: fixture(), ignoreEqCols: ["visibility"] }),
    );
    assert.deepEqual(idsIn(best), ["public-1"],
      "a private/trip_only/followers_only post must never appear on a public rail");
  });

  it("both gates compose: neither a pending nor a private post survives", async () => {
    const best = await getBestOf(
      PLACE,
      makeClient({
        posts: [
          postRow("public-1"),
          postRow("pending-1", { post_status: "pending_location_exit" }),
          postRow("private-1", { visibility: "private" }),
          postRow("private-pending-1", { visibility: "private", post_status: "pending_delay" }),
        ],
        ignoreEqCols: ["visibility", "post_status"],
      }),
    );
    assert.deepEqual(idsIn(best), ["public-1"]);
  });

  it("a legacy row with no visibility column still serves (absent ⇒ public)", async () => {
    const legacy = postRow("legacy-1");
    delete legacy.visibility;
    const best = await getBestOf(PLACE, makeClient({ posts: [legacy], ignoreEqCols: ["visibility"] }));
    assert.deepEqual(idsIn(best), ["legacy-1"], "absent must not fail closed");
  });
});

// ── the CACHE producer (what getBestOf serves first) ─────────────────────────

/**
 * Minimal worker fake: one pending queue row for PLACE, and the posts read
 * returns `posts` unfiltered — so the worker's OWN in-memory gate is the only
 * thing that can keep a restricted post out of the cached rails.
 */
function workerClient(posts: Record<string, any>[], upserts: Array<{ table: string; row: any }>) {
  let queue: Record<string, any>[] = [
    { place_id: PLACE, status: "pending", queued_at: "2026-09-01T00:00:00Z", locked_by: null, locked_until: null },
  ];
  function from(table: string) {
    let patch: any = null;
    const filters: Array<(r: any) => boolean> = [];
    let wantsSelect = false;
    const b: any = {
      select() { if (patch != null) wantsSelect = true; return b; },
      upsert(row: any) {
        upserts.push({ table, row });
        if (table === "place_cache_invalidation_queue") {
          const i = queue.findIndex((r) => r.place_id === row.place_id);
          if (i >= 0) queue[i] = { ...queue[i], ...row };
          else queue.push({ ...row });
        }
        return Promise.resolve({ data: null, error: null });
      },
      update(p: any) { patch = p; return b; },
      eq(col: string, val: any) { filters.push((r: any) => r[col] === val); return b; },
      in(col: string, vals: any[]) { filters.push((r: any) => vals.includes(r[col])); return b; },
      or: () => b, is: () => b, not: () => b,
      gt: () => b, gte: () => b, lt: () => b, lte: () => b,
      order: () => b,
      limit(n: number) {
        if (table === "place_cache_invalidation_queue") {
          return Promise.resolve({ data: queue.filter((r) => filters.every((f) => f(r))).slice(0, n), error: null });
        }
        // The posts read comes back UNFILTERED: the worker's own in-memory gate
        // is then the only thing that can keep a restricted post out of the cache.
        if (table === "posts") return Promise.resolve({ data: posts, error: null });
        return Promise.resolve({ data: [], error: null });
      },
      then(resolve: (v: any) => any) {
        if (table === "place_cache_invalidation_queue" && patch) {
          // Match BEFORE mutating — the claim filters on the pre-patch status.
          const matched = queue.filter((r) => filters.every((f) => f(r)));
          queue = queue.map((r) => (filters.every((f) => f(r)) ? { ...r, ...patch } : r));
          return Promise.resolve(
            wantsSelect ? { data: matched.map((r) => ({ ...r, ...patch })), error: null } : { data: null, error: null },
          ).then(resolve);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return b;
  }
  return { from } as any;
}

describe("placeCollectionsWorker — the cached rails carry the same gate", () => {
  it("never bakes a private / trip_only / pending post into place_best_of", async () => {
    _setTestAwardStamp(() => Promise.resolve({ awarded: false, reason: "test" }));
    try {
      const upserts: Array<{ table: string; row: any }> = [];
      await runCollectionsTick(workerClient([
        ...fixture(),
        postRow("pending-1", { post_status: "pending_location_exit" }),
      ], upserts));

      const bestOf = upserts.find((u) => u.table === "place_best_of");
      assert.ok(bestOf, "the worker wrote place_best_of");
      const cachedIds = [
        ...(bestOf.row.top_videos ?? []),
        ...(bestOf.row.top_photos ?? []),
        ...(bestOf.row.top_viewpoints ?? []),
        ...(bestOf.row.food_nearby ?? []),
        ...(bestOf.row.top_experiences ?? []),
      ].map((i: any) => i.postId ?? i.post_id ?? i.id);
      assert.deepEqual([...new Set(cachedIds)].sort(), ["public-1"],
        "only the public published post may be cached onto a place's public rails");
    } finally {
      _setTestAwardStamp(null);
    }
  });
});
