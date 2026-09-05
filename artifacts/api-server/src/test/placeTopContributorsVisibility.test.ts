/**
 * place_top_contributors — the PUBLIC contributor rail must be built from
 * publicly-readable posts only, while the place_contributor STAMP keeps
 * counting the author's full body of work at the place.
 *
 * ## The defect these tests pin
 *
 * lib/places/placeCollectionsWorker.computeContributors received the UNFILTERED
 * post set — every post with `status = 'active'`, regardless of `visibility` or
 * `post_status` — and upserted the top three authors into
 * `place_top_contributors`. routes/placeLiving (lines 192-202, 395-421, 439)
 * then serves that row as `topContributor { userId, displayName, avatarUrl,
 * contributionCount }` on the ANONYMOUS living page, through the service-role
 * client, with no viewer and no staleness check.
 *
 * Net effect: a user whose only posts at a venue were `private` — or still
 * `pending_location_exit`, a delayed geotag whose author has not left the place
 * yet — was publicly named as that venue's top contributor. That is the "this
 * person is at this place" disclosure class that post visibility and delayed
 * geotagging exist to prevent, and `place_top_contributors` was the one read on
 * that page that was not visibility-gated.
 *
 * ## The split these tests hold in place
 *
 *   A. PUBLIC RAIL   → posts.filter(isPublicPlaceRailPost)  (stranger-readable,
 *                      published; fails CLOSED on any tier decidePostReadable
 *                      does not recognise)
 *   B. STAMP         → the full active set, byte-for-byte as before
 *
 * Group E does not merely check that stamps still fire — it replays the
 * PRE-SPLIT algorithm over the same fixtures and asserts the observed
 * awardStamp calls are deep-equal to it, argument for argument and in order.
 * If the split ever moves a threshold, that comparison fails.
 *
 * Run: node --import tsx/esm --test src/test/placeTopContributorsVisibility.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isPublicPlaceRailPost } from "../lib/places/placeCollections.js";
import {
  runCollectionsTick,
  _setTestAwardStamp,
} from "../lib/places/placeCollectionsWorker.js";

const PLACE_ID = "bbbbbbbb-0000-0000-0000-000000000001";

// ── Fixture helpers ───────────────────────────────────────────────────────────

interface PostFixture { [key: string]: any }

/**
 * A post row shaped like what the worker's SELECT projects. `visibility` is
 * spelled explicitly on every fixture that means to test a tier; omitting it
 * models a legacy row (the column post-dates the table), which the canonical
 * predicate treats as public.
 */
function post(overrides: PostFixture = {}): PostFixture {
  return {
    id:                   `p-${Math.random().toString(36).slice(2, 10)}`,
    author_id:            "author-default",
    trip_id:              null,
    visibility:           "public",
    post_status:          "published",
    media_type:           "photo",
    media_urls:           [],
    media_thumbnail_url:  null,
    post_buckets:         [],
    content:              null,
    like_count:           0,
    save_count:           0,
    share_count:          0,
    view_count:           0,
    qualified_view_count: 0,
    ...overrides,
  };
}

function posts(n: number, overrides: PostFixture = {}): PostFixture[] {
  return Array.from({ length: n }, (_, i) =>
    post({ id: `${overrides.author_id ?? "author-default"}-${i}`, ...overrides }),
  );
}

// ── Fake Supabase client ──────────────────────────────────────────────────────

interface Captured {
  upserts: Array<{ table: string; row: any }>;
  deletes: Array<{ table: string; filters: Array<[string, ...any[]]> }>;
  selects: Array<{ table: string; cols: string }>;
}

/**
 * Minimal fake covering exactly the call shapes processPlace uses:
 *   place_cache_invalidation_queue — claim SELECT (.eq/.or/.order/.limit) and
 *     UPDATE...RETURNING (.update/.in/.eq/.select)
 *   posts                          — .select/.eq/.eq/.limit
 *   place_best_of                  — .upsert
 *   place_top_contributors         — .upsert, and .delete/.eq/.not
 *
 * Unlike a mock library this records rather than asserts, so a test can state
 * what the rail contains AND what it must not contain.
 */
function makeFakeSc(opts: { postRows: PostFixture[]; captured: Captured }) {
  const { postRows, captured } = opts;
  let queueRows: any[] = [
    { place_id: PLACE_ID, status: "pending", queued_at: new Date().toISOString(), locked_until: null },
  ];

  return {
    from(table: string) {
      let mode: "read" | "update" | "delete" = "read";
      let patch: any = null;
      const filters: Array<(r: any) => boolean> = [];
      const recordedFilters: Array<[string, ...any[]]> = [];
      let wantsReturning = false;

      const builder: any = {
        select(cols?: string) {
          if (mode === "update") wantsReturning = true;
          else captured.selects.push({ table, cols: cols ?? "" });
          return builder;
        },
        upsert(row: any, _o?: any) {
          captured.upserts.push({ table, row });
          return Promise.resolve({ data: null, error: null });
        },
        update(p: any) { mode = "update"; patch = p; return builder; },
        delete()       { mode = "delete"; return builder; },
        eq(col: string, val: any) {
          recordedFilters.push(["eq", col, val]);
          filters.push((r: any) => r[col] === val);
          return builder;
        },
        not(col: string, op: string, val: any) {
          recordedFilters.push(["not", col, op, val]);
          return builder;
        },
        in(col: string, vals: any[]) {
          filters.push((r: any) => vals.includes(r[col]));
          return builder;
        },
        or(expr: string) {
          if (expr.includes("locked_until.is.null")) {
            const m = expr.match(/locked_until\.lt\.([^\s,]+)/);
            const cutoff = m ? m[1] : null;
            filters.push((r: any) =>
              r.locked_until == null || (cutoff != null && r.locked_until < cutoff));
          }
          return builder;
        },
        lt()    { return builder; },
        gt()    { return builder; },
        gte()   { return builder; },
        order() { return builder; },
        limit(n: number) {
          if (table === "place_cache_invalidation_queue") {
            return Promise.resolve({
              data: queueRows.filter((r) => filters.every((f) => f(r))).slice(0, n),
              error: null,
            });
          }
          if (table === "posts") return Promise.resolve({ data: postRows, error: null });
          return Promise.resolve({ data: [], error: null });
        },
        then(resolve: (v: any) => any) {
          if (mode === "delete") {
            captured.deletes.push({ table, filters: recordedFilters });
            return resolve({ data: null, error: null });
          }
          if (mode === "update" && table === "place_cache_invalidation_queue") {
            const matched = queueRows.filter((r) => filters.every((f) => f(r)));
            queueRows = queueRows.map((r) =>
              filters.every((f) => f(r)) ? { ...r, ...patch } : r);
            if (wantsReturning) {
              return resolve({ data: matched.map((r) => ({ ...r, ...patch })), error: null });
            }
          }
          return resolve({ data: null, error: null });
        },
      };
      return builder;
    },
  };
}

interface AwardCall { userId: string; definitionSlug: string; placeId: string; threshold: number }

async function runWith(postRows: PostFixture[]): Promise<{
  captured: Captured;
  awardCalls: AwardCall[];
}> {
  const captured: Captured = { upserts: [], deletes: [], selects: [] };
  const awardCalls: AwardCall[] = [];
  _setTestAwardStamp(async (_sc, input) => {
    awardCalls.push({
      userId:         input.userId,
      definitionSlug: input.definitionSlug,
      placeId:        (input.metadata as any)?.placeId as string,
      threshold:      (input.metadata as any)?.threshold as number,
    });
    return { awarded: true, reason: "test" };
  });
  const sc = makeFakeSc({ postRows, captured });
  await runCollectionsTick(sc);
  return { captured, awardCalls };
}

function railRows(captured: Captured): Array<{ user_id: string; contribution_count: number }> {
  return captured.upserts
    .filter((u) => u.table === "place_top_contributors")
    .map((u) => ({ user_id: u.row.user_id, contribution_count: u.row.contribution_count }));
}

// ── A. The predicate itself ───────────────────────────────────────────────────

describe("A. isPublicPlaceRailPost — the one gate, failing closed", () => {
  it("admits a published public post", () => {
    assert.strictEqual(isPublicPlaceRailPost({ author_id: "u1", visibility: "public", post_status: "published" }), true);
  });

  it("admits a legacy row with no visibility and no post_status", () => {
    // Both columns post-date the table; absent has always meant public/published.
    assert.strictEqual(isPublicPlaceRailPost({ author_id: "u1" }), true);
  });

  it("refuses private", () => {
    assert.strictEqual(isPublicPlaceRailPost({ author_id: "u1", visibility: "private", post_status: "published" }), false);
  });

  it("refuses trip_only even with a trip_id", () => {
    assert.strictEqual(
      isPublicPlaceRailPost({ author_id: "u1", visibility: "trip_only", trip_id: "t1", post_status: "published" }),
      false,
    );
  });

  it("refuses followers_only (both spellings)", () => {
    assert.strictEqual(isPublicPlaceRailPost({ author_id: "u1", visibility: "followers_only" }), false);
    assert.strictEqual(isPublicPlaceRailPost({ author_id: "u1", visibility: "followers" }), false);
  });

  it("refuses a published public post that is not yet published (delayed geotag)", () => {
    for (const st of ["pending_location_exit", "pending_delay", "pending_safety_review", "draft", "canceled", "expired"]) {
      assert.strictEqual(
        isPublicPlaceRailPost({ author_id: "u1", visibility: "public", post_status: st }),
        false,
        `post_status ${st} must not reach a public rail`,
      );
    }
  });

  it("FAILS CLOSED on an unknown / future visibility tier", () => {
    for (const v of ["circle_only", "close_friends", "", "PUBLIC", "unlisted"]) {
      assert.strictEqual(
        isPublicPlaceRailPost({ author_id: "u1", visibility: v, post_status: "published" }),
        false,
        `unrecognised visibility ${JSON.stringify(v)} must fail closed`,
      );
    }
  });

  it("cannot be unlocked by an author_id colliding with the no-viewer sentinel", () => {
    // The sentinel is deliberately not a uuid; a post whose author_id is a uuid
    // can never match it, so the author branch cannot admit a private post.
    assert.strictEqual(
      isPublicPlaceRailPost({ author_id: "bbbbbbbb-0000-0000-0000-0000000000ff", visibility: "private" }),
      false,
    );
  });
});

// ── B. The rail is built from the gated subset ────────────────────────────────

describe("B. place_top_contributors is built from publicly-readable posts only", () => {
  beforeEach(() => { _setTestAwardStamp(() => Promise.resolve({ awarded: false, reason: "test" })); });
  afterEach(()  => { _setTestAwardStamp(null); });

  it("does not name a private-only author as top contributor", async () => {
    // THE DEFECT, in one fixture: `private-only` outposts `public-one` 5:1, but
    // every one of those five posts is private. Before the split the rail named
    // `private-only` — on an anonymous page, with their display name and avatar.
    const { captured } = await runWith([
      ...posts(5, { author_id: "private-only", visibility: "private" }),
      ...posts(1, { author_id: "public-one",   visibility: "public"  }),
    ]);

    const rows = railRows(captured);
    assert.deepStrictEqual(
      rows,
      [{ user_id: "public-one", contribution_count: 1 }],
      "the public rail must credit only the publicly-readable author",
    );
    assert.ok(
      !rows.some((r) => r.user_id === "private-only"),
      "a private-only author must never be written to place_top_contributors",
    );
  });

  it("does not name an author whose posts are all still pending publication", async () => {
    const { captured } = await runWith([
      ...posts(4, { author_id: "delayed", visibility: "public", post_status: "pending_location_exit" }),
      ...posts(1, { author_id: "published-one" }),
    ]);
    assert.deepStrictEqual(railRows(captured), [{ user_id: "published-one", contribution_count: 1 }]);
  });

  it("excludes trip_only and followers_only from the count", async () => {
    const { captured } = await runWith([
      ...posts(3, { author_id: "mixed", visibility: "public" }),
      ...posts(7, { author_id: "mixed", visibility: "trip_only", trip_id: "t1" }),
      ...posts(9, { author_id: "mixed", visibility: "followers_only" }),
    ]);
    assert.deepStrictEqual(
      railRows(captured),
      [{ user_id: "mixed", contribution_count: 3 }],
      "contributionCount is the PUBLIC count, not the total",
    );
  });

  it("excludes an unknown future visibility tier (fails closed)", async () => {
    const { captured } = await runWith([
      ...posts(6, { author_id: "future-tier", visibility: "circle_only" }),
      ...posts(1, { author_id: "plain-public" }),
    ]);
    assert.deepStrictEqual(railRows(captured), [{ user_id: "plain-public", contribution_count: 1 }]);
  });

  it("writes nothing at all when a place has no publicly-readable posts", async () => {
    const { captured } = await runWith(posts(12, { author_id: "all-private", visibility: "private" }));
    assert.deepStrictEqual(railRows(captured), [], "an all-private place has no public top contributor");
  });

  it("still credits legacy rows that predate the visibility column", async () => {
    const legacy = posts(3, { author_id: "legacy" }).map((p) => {
      const { visibility, post_status, ...rest } = p;
      return rest;
    });
    const { captured } = await runWith(legacy);
    assert.deepStrictEqual(railRows(captured), [{ user_id: "legacy", contribution_count: 3 }]);
  });
});

// ── C. Already-baked rows are pruned, not left to be served forever ───────────

describe("C. the rail prunes rows the gated recompute no longer credits", () => {
  beforeEach(() => { _setTestAwardStamp(() => Promise.resolve({ awarded: false, reason: "test" })); });
  afterEach(()  => { _setTestAwardStamp(null); });

  it("issues a scoped DELETE keeping exactly the new public top-3", async () => {
    const { captured } = await runWith([
      ...posts(2, { author_id: "aaa" }),
      ...posts(1, { author_id: "bbb" }),
    ]);
    const del = captured.deletes.find((d) => d.table === "place_top_contributors");
    assert.ok(del, "expected a place_top_contributors DELETE");
    assert.deepStrictEqual(del.filters[0], ["eq", "place_id", PLACE_ID]);
    const keep = del.filters.find((f) => f[0] === "not");
    assert.ok(keep, "expected a NOT IN keep-list");
    assert.strictEqual(keep[1], "user_id");
    assert.strictEqual(keep[2], "in");
    assert.strictEqual(keep[3], "(aaa,bbb)");
  });

  it("purges every row for the place when nothing is publicly readable", async () => {
    // routes/placeLiving reads place_top_contributors with NO staleness check,
    // so an unpruned row from an earlier all-private bake would be served for
    // ever. The DELETE must therefore be unfiltered by user when the keep-list
    // is empty.
    const { captured } = await runWith(posts(4, { author_id: "all-private", visibility: "private" }));
    const del = captured.deletes.find((d) => d.table === "place_top_contributors");
    assert.ok(del, "expected a place_top_contributors DELETE");
    assert.deepStrictEqual(del.filters, [["eq", "place_id", PLACE_ID]]);
  });
});

// ── D. Best-of and the rail are independent of one another ───────────────────

describe("D. the split does not disturb the rest of processPlace", () => {
  beforeEach(() => { _setTestAwardStamp(() => Promise.resolve({ awarded: false, reason: "test" })); });
  afterEach(()  => { _setTestAwardStamp(null); });

  it("still upserts place_best_of for the claimed place", async () => {
    const { captured } = await runWith(posts(2, { author_id: "aaa" }));
    const bestOf = captured.upserts.find((u) => u.table === "place_best_of");
    assert.ok(bestOf, "expected a place_best_of upsert");
    assert.strictEqual(bestOf.row.place_id, PLACE_ID);
  });

  it("PROJECTS the gate columns — an unprojected column would read as legacy/public", async () => {
    // PostgREST returns ONLY the projected columns. If `visibility` were dropped
    // from the SELECT the rows would come back with it undefined, the canonical
    // predicate would treat every one of them as a legacy public row, and the
    // gate above would pass everything while still LOOKING correct. The
    // behavioural tests cannot see this (the fake ignores the projection), so
    // the projection is asserted directly.
    const { captured } = await runWith(posts(1, { author_id: "aaa" }));
    const postsSelect = captured.selects.find((s) => s.table === "posts");
    assert.ok(postsSelect, "expected a posts SELECT");
    for (const col of ["author_id", "trip_id", "visibility", "post_status"]) {
      assert.ok(
        new RegExp(`\\b${col}\\b`).test(postsSelect.cols),
        `worker posts SELECT must project ${col} — the visibility gate reads it`,
      );
    }
  });
});

// ── E. STAMP THRESHOLDS ARE UNCHANGED BY THE SPLIT ───────────────────────────

/**
 * The PRE-SPLIT algorithm, restated. Counts every post with an author_id,
 * takes the top 3, and awards each crossed threshold in ascending order.
 * Group E asserts the live worker's awardStamp calls are deep-equal to this.
 */
const STAMP_THRESHOLDS = [10, 50, 100] as const;
function legacyStampCalls(all: PostFixture[]): AwardCall[] {
  const counts = new Map<string, number>();
  for (const row of all) {
    if (!row.author_id) continue;
    counts.set(row.author_id, (counts.get(row.author_id) ?? 0) + 1);
  }
  const top3 = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const out: AwardCall[] = [];
  for (const [userId, count] of top3) {
    for (const threshold of STAMP_THRESHOLDS) {
      if (count >= threshold) {
        out.push({ userId, definitionSlug: "place_contributor", placeId: PLACE_ID, threshold });
      }
    }
  }
  return out;
}

describe("E. place_contributor stamp thresholds still count the FULL active set", () => {
  afterEach(() => { _setTestAwardStamp(null); });

  it("awards a private-only contributor exactly as before the split", async () => {
    // 55 private posts. The rail must credit nobody; the stamp must still fire
    // at 10 and 50. This is the whole point of splitting rather than filtering
    // at the source.
    const fixture = posts(55, { author_id: "contributor-a", visibility: "private" });
    const { captured, awardCalls } = await runWith(fixture);

    assert.deepStrictEqual(railRows(captured), [], "no public rail credit");
    assert.deepStrictEqual(
      awardCalls,
      legacyStampCalls(fixture),
      "stamp awards must be identical to the pre-split algorithm",
    );
    assert.deepStrictEqual(awardCalls.map((c) => c.threshold), [10, 50]);
  });

  it("matches the pre-split algorithm on a mixed-visibility place, call for call", async () => {
    const fixture = [
      ...posts(10, { author_id: "author-a", visibility: "public"  }),
      ...posts(50, { author_id: "author-a", visibility: "private" }),
      ...posts(12, { author_id: "author-b", visibility: "public"  }),
      ...posts(3,  { author_id: "author-c", visibility: "trip_only", trip_id: "t1" }),
    ];
    const { captured, awardCalls } = await runWith(fixture);

    // Stamps: full counts (a=60, b=12, c=3), unchanged order and thresholds.
    assert.deepStrictEqual(awardCalls, legacyStampCalls(fixture));
    assert.deepStrictEqual(awardCalls, [
      { userId: "author-a", definitionSlug: "place_contributor", placeId: PLACE_ID, threshold: 10 },
      { userId: "author-a", definitionSlug: "place_contributor", placeId: PLACE_ID, threshold: 50 },
      { userId: "author-b", definitionSlug: "place_contributor", placeId: PLACE_ID, threshold: 10 },
    ]);

    // Rail: public counts only (b=12 outranks a=10; c is absent entirely).
    assert.deepStrictEqual(railRows(captured), [
      { user_id: "author-b", contribution_count: 12 },
      { user_id: "author-a", contribution_count: 10 },
    ]);
  });

  it("awards nothing when the place has no posts at all", async () => {
    const { captured, awardCalls } = await runWith([]);
    assert.deepStrictEqual(awardCalls, []);
    assert.deepStrictEqual(railRows(captured), []);
  });

  it("does not award a fourth author, before or after the split", async () => {
    const fixture = [
      ...posts(100, { author_id: "a1" }),
      ...posts(60,  { author_id: "a2" }),
      ...posts(20,  { author_id: "a3" }),
      ...posts(15,  { author_id: "a4", visibility: "private" }),
    ];
    const { awardCalls } = await runWith(fixture);
    assert.deepStrictEqual(awardCalls, legacyStampCalls(fixture));
    assert.ok(!awardCalls.some((c) => c.userId === "a4"), "a4 is outside the top 3, as it always was");
  });
});
