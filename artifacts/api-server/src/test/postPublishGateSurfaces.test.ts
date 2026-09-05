/**
 * The delayed-publish gate on the serving surfaces that had none.
 *
 * WHAT THIS EXISTS FOR
 * --------------------
 * `posts.post_status` (enum `delayed_post_status`, NOT NULL DEFAULT 'published')
 * is the publication state machine. POST /posts writes a delayed-geotag post as
 * status='active' with a PENDING post_status — 'pending_location_exit' when the
 * author asked to publish after leaving, 'pending_delay' for a timed release,
 * 'pending_safety_review' when moderation parks it — and a sweeper flips it to
 * 'published' later. `status = 'active'` is therefore NOT a publication filter:
 * a reader that gates only on it serves the post the moment it is created.
 *
 * PR #360 closed this on the Wall. The same defect survived on every other
 * surface still mounted in routes/index.ts. Two of them are covered here,
 * because neither had any test of its own:
 *
 *   • GET /airport/pulse — keyed on location_city, so serving a pending post
 *     announces "this person is in this city right now", which is precisely
 *     what delayed geotagging exists to prevent (§23 / §37).
 *   • lib/places/placeCollections.getBestOf — the Living Destination Page's
 *     best-of rails, keyed on canonical_place_id, i.e. "this person is at this
 *     PLACE". Consumed by routes/placeLiving.ts.
 *
 * Each surface is proven at BOTH layers, the way routes/wall.ts is:
 *   • the query CARRIES `.eq("post_status", "published")` — asserted against
 *     captured predicates, because a fake that filters rows itself would stay
 *     green after the predicate was deleted;
 *   • a pending row fed PAST the filter is still refused in memory by
 *     lib/postVisibility.isPostPublished — and an ABSENT post_status reads as
 *     published, matching GET /posts/:postId and lib/mediaEligibility.
 *
 * Run: node --import tsx/esm --test src/test/postPublishGateSurfaces.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import airportRouter from "../routes/airport.js";
import { getBestOf } from "../lib/places/placeCollections.js";

const TOKEN = "pubgate-token";
const VIEWER = "e0000000-0000-4000-a000-000000000001";
const AUTHOR = "e0000000-0000-4000-a000-000000000002";
const CITY = "Da Nang";
const PLACE = "e0000000-0000-4000-a000-0000000000aa";

const PENDING_LABELS = ["pending_location_exit", "pending_delay", "pending_safety_review"] as const;

interface Captured { table: string; eqs: Record<string, any> }

function postRow(id: string, over: Record<string, any> = {}): Record<string, any> {
  return {
    id,
    author_id: AUTHOR,
    content: `post ${id}`,
    media_urls: [],
    created_at: "2026-09-01T10:00:00Z",
    location_city: CITY,
    location_country: "VN",
    canonical_place_id: PLACE,
    visibility: "public",
    status: "active",
    post_status: "published",
    media_type: "photo",
    media_thumbnail_url: null,
    like_count: 1,
    save_count: 0,
    share_count: 0,
    ...over,
  };
}

/** Rows that every case shares: one published, one of each pending label. */
function fixture(): Record<string, any>[] {
  return [
    postRow("published-1"),
    ...PENDING_LABELS.map((s, i) => postRow(`pending-${i}`, { post_status: s })),
  ];
}

/**
 * Table-routed fake. Records the `.eq()` predicates of every terminal read and,
 * unless the column is in `ignoreEqCols`, applies them the way the DB would.
 * `ignoreEqCols` is what feeds a pending row PAST the query filter, leaving the
 * route's own in-memory re-check as the only thing that can refuse it.
 */
function makeClient(opts: {
  posts: Record<string, any>[];
  captured?: Captured[];
  ignoreEqCols?: string[];
  flags?: Record<string, boolean>;
}) {
  const ignore = new Set(opts.ignoreEqCols ?? []);
  const flags = opts.flags ?? { airport_mode_enabled: true, airport_pulse_enabled: true };
  const tables: Record<string, Record<string, any>[]> = {
    posts: opts.posts,
    profiles: [{ id: AUTHOR, username: "aya", display_name: "Aya", name: "Aya", full_name: "Aya", avatar_url: null }],
    profile_privacy_settings: [],
    post_media: [],
    place_best_of: [],
    place_cache_invalidation_queue: [],
  };

  function builder(table: string) {
    const eqs: Record<string, any> = {};
    let rows = [...(tables[table] ?? [])];
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => {
        eqs[c] = v;
        if (!ignore.has(c)) rows = rows.filter((r) => r[c] === v);
        return b;
      },
      in: (c: string, v: any[]) => { rows = rows.filter((r) => v.includes(r[c])); return b; },
      ilike: (c: string, pat: string) => {
        const re = new RegExp("^" + String(pat).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
        rows = rows.filter((r) => re.test(String(r[c] ?? "")));
        return b;
      },
      not: () => b, is: () => b, or: () => b, like: () => b, neq: () => b, contains: () => b,
      gte: () => b, lte: () => b, gt: () => b, lt: () => b,
      order: () => b, limit: () => b, range: () => b,
      insert: () => Promise.resolve({ error: null }),
      upsert: () => Promise.resolve({ error: null }),
      maybeSingle: () => {
        if (table === "feature_flags") {
          return Promise.resolve({ data: { enabled: !!flags[String(eqs["flag"])] }, error: null });
        }
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

  return {
    from: builder,
    auth: {
      getUser: async (t: string) =>
        t === TOKEN
          ? { data: { user: { id: VIEWER } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
  } as any;
}

// ── GET /airport/pulse ────────────────────────────────────────────────────────

describe("GET /api/airport/pulse — delayed-publish gate (§23/§37)", () => {
  let server: http.Server;
  let baseUrl = "";

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
      next();
    });
    app.use("/api", airportRouter);
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

  beforeEach(() => invalidateFlagsCache());

  async function serve(client: any): Promise<string[]> {
    _setTestClient(client, true);
    _setTestServiceClient(client);
    const res = await fetch(`${baseUrl}/api/airport/pulse?city=${encodeURIComponent(CITY)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.featureEnabled, true, "both airport flags are on in this fixture");
    return (body.posts as any[]).map((p: any) => p.id as string);
  }

  it("the query CARRIES post_status='published' (the DB-layer predicate)", async () => {
    const captured: Captured[] = [];
    const ids = await serve(makeClient({ posts: fixture(), captured }));
    assert.deepEqual(ids, ["published-1"], "only the published post is served");

    const feedReads = captured.filter((c) => c.table === "posts" && c.eqs.status === "active");
    assert.ok(feedReads.length >= 1, "the airport pulse feed read posts");
    for (const q of feedReads) {
      assert.equal(q.eqs.visibility, "public");
      assert.equal(q.eqs.post_status, "published", "the query carries the canonical predicate");
    }
  });

  it("pending rows fed PAST the query filter are still refused in memory", async () => {
    const ids = await serve(makeClient({ posts: fixture(), ignoreEqCols: ["post_status"] }));
    for (const label of PENDING_LABELS.keys()) {
      assert.ok(!ids.includes(`pending-${label}`), `pending-${label} must never be served`);
    }
    assert.deepEqual(ids, ["published-1"]);
  });

  it("a legacy row with NO post_status reads as published (absent ⇒ published)", async () => {
    const legacy = postRow("legacy-1");
    delete legacy.post_status;
    const ids = await serve(makeClient({ posts: [legacy], ignoreEqCols: ["post_status"] }));
    assert.deepEqual(ids, ["legacy-1"], "absent must not fail closed");
  });
});

// ── placeCollections.getBestOf ────────────────────────────────────────────────

describe("placeCollections.getBestOf — delayed-publish gate (§23/§37)", () => {
  /** Every post id that appears anywhere in the BestOf envelope. */
  function idsIn(best: Awaited<ReturnType<typeof getBestOf>>): string[] {
    return [...new Set(
      [...best.videos, ...best.photos, ...best.viewpoints, ...best.foodNearby, ...best.experiences]
        .map((i) => i.postId),
    )].sort();
  }

  it("the realtime best-of query CARRIES post_status='published' (the DB-layer predicate)", async () => {
    const captured: Captured[] = [];
    const best = await getBestOf(PLACE, makeClient({ posts: fixture(), captured }));
    assert.deepEqual(idsIn(best), ["published-1"], "only the published post reaches the place page");

    const postReads = captured.filter((c) => c.table === "posts");
    assert.ok(postReads.length >= 1, "getBestOf fell back to the realtime posts read");
    for (const q of postReads) {
      assert.equal(q.eqs.canonical_place_id, PLACE);
      assert.equal(q.eqs.status, "active");
      assert.equal(q.eqs.post_status, "published", "the query carries the canonical predicate");
    }
  });

  it("pending rows fed PAST the query filter are still refused in memory", async () => {
    const best = await getBestOf(PLACE, makeClient({ posts: fixture(), ignoreEqCols: ["post_status"] }));
    assert.deepEqual(idsIn(best), ["published-1"],
      "a pending post must not appear on the place it is still standing at");
  });

  it("a legacy row with NO post_status reads as published (absent ⇒ published)", async () => {
    const legacy = postRow("legacy-1");
    delete legacy.post_status;
    const best = await getBestOf(PLACE, makeClient({ posts: [legacy], ignoreEqCols: ["post_status"] }));
    assert.deepEqual(idsIn(best), ["legacy-1"], "absent must not fail closed");
  });
});

// ── Compass fallback feed — popular posts ─────────────────────────────────────
//
// CompassFallbackFeedBuilder.fetchPopularPosts filtered with
// `.not("post_status", "eq", "delayed_post")` and set its downstream safety flag
// with `r.post_status === "delayed_post"`. `delayed_post` is not a label of the
// delayed_post_status enum, so neither could ever match: the query excluded
// nothing (or, if PostgREST rejected the literal as 22P02, the whole read failed
// into this file's best-effort catch and the lane returned nothing at all), and
// CompassSafetyFilter's delayed-post gate never saw a true isDelayedPost.

describe("CompassFallbackFeedBuilder — popular posts carry the real publish gate", () => {
  it("the query CARRIES post_status='published' and no pending post survives", async () => {
    const { buildFallbackFeed } = await import("../compass/CompassFallbackFeedBuilder.js");
    invalidateFlagsCache();
    const captured: Captured[] = [];
    const client = makeClient({ posts: fixture(), captured });
    const out = await buildFallbackFeed(client, VIEWER, null, "test");

    const postReads = captured.filter((c) => c.table === "posts");
    assert.ok(postReads.length >= 1, "the fallback feed read posts");
    for (const q of postReads) {
      assert.equal(q.eqs.post_status, "published", "the query carries the canonical predicate");
    }

    const postIds = out.safeItems.filter((i: any) => i.type === "post").map((i: any) => i.id).sort();
    assert.deepEqual(postIds, ["published-1"], "only the published post is offered");
  });

  it("a pending row fed PAST the query filter is refused by the delayed-post safety gate", async () => {
    const { buildFallbackFeed } = await import("../compass/CompassFallbackFeedBuilder.js");
    invalidateFlagsCache();
    const client = makeClient({ posts: fixture(), ignoreEqCols: ["post_status"] });
    const out = await buildFallbackFeed(client, VIEWER, null, "test");
    const postIds = out.safeItems.filter((i: any) => i.type === "post").map((i: any) => i.id).sort();
    assert.deepEqual(postIds, ["published-1"],
      "isDelayedPost must be true for a pending row so CompassSafetyFilter denies it");
  });
});
