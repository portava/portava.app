/**
 * census-discovery (wave 5, 2026-10-17) — "Live from events" Path B reads its
 * venues in two steps, because `posts` has no key to `discovery_places`.
 *
 * Run: node --import tsx/esm --test src/test/eventPostsVenueTwoStepRead.test.ts
 *
 * THE DEFECT. lib/eventPostsDiscovery.ts Path B selected
 * `discovery_places!posts_location_place_id_fkey(...)` from `posts`.
 * posts.location_place_id is TEXT with no foreign key in production (catalog
 * read by the lead 2026-10-17; the 2026-08-19 baseline and the migration chain
 * agree), and no constraint of that name exists anywhere. PostgREST refused the
 * embed (PGRST200). The path answered null on every call, so every signed-in
 * GET /discovery/feed carried `failedSources: ["event_posts"]`, no venue post
 * ever reached the feed, and the result was never cached.
 *
 * THE FIX. Read the posts, then the venues they name in ONE batched read keyed
 * on discovery_places.osm_id (the module's documented join: osm_id =
 * location_place_id). Only OSM-shaped keys (`node|way|relation/<digits>`, the
 * only shape osm_id holds: routes/wishlist.ts writes it behind OSM_ID_RE) are
 * sent, so free text a client wrote into location_place_id is never put into
 * the filter. Proven here:
 *   1. on schemaStrictSupabase, a venue post is served with the venue's name and
 *      proximity, and the posts read embeds nothing;
 *   2. the venue read is one batch, of OSM keys only;
 *   3. an unreadable venue read makes the path unreadable (readFailed, nothing
 *      cached), never "no venue posts";
 *   4. storage-backed media now reaches Path B (it read `r.posts?.id` from rows
 *      that ARE posts, so no post_media was ever fetched for it).
 *
 * Mutation proofs: see the wave-5 embeds handback (scratchpad).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeSchemaStrictClient, type Seed } from "./helpers/schemaStrictSupabase.js";
import { makeFailClosedClient, type FakeReadContext } from "./helpers/failClosedSupabase.js";
import { fetchEventPostsForDiscovery, _clearEventPostsCache, type FetchEventPostsParams } from "../lib/eventPostsDiscovery.js";

beforeEach(() => _clearEventPostsCache());

const AUTHOR = "a0a0a0a0-0000-4000-a000-0000000000a0";
const VENUE_KEY = "node/1001";
const FOOD_KEY = "way/2002";

function post(id: string, placeId: string | null, over: Record<string, unknown> = {}) {
  return {
    id, author_id: AUTHOR, content: `live from ${id}`, media_urls: [], location_city: "Barcelona", location_name: "Palau",
    location_place_id: placeId, public_lat: 41.387, public_lng: 2.175, created_at: new Date().toISOString(),
    like_count: 3, comment_count: 1, visibility: "public", status: "active", post_status: "published",
    deleted_at: null, publish_eligible_at: null, location_privacy_mode: "none", published_at: null,
    ...over,
  };
}

const VENUE = { id: "dddddddd-0000-4000-a000-000000000001", osm_id: VENUE_KEY, name: "Palau de la Música", primary_category: "events", city: "Barcelona", lat: 41.3875, lng: 2.1753, status: "active" };
const FOOD  = { id: "dddddddd-0000-4000-a000-000000000002", osm_id: FOOD_KEY, name: "Bar Pinotxo", primary_category: "food", city: "Barcelona", lat: 41.38, lng: 2.17, status: "active" };

function world(over: Partial<Seed> = {}): Seed {
  return {
    post_event_links: [],
    posts: [
      post("p-venue", VENUE_KEY),
      post("p-food", FOOD_KEY),
      post("p-nominatim", "nominatim-123456"),
      post("p-crafted", 'x",node/1001,"y'),
    ],
    discovery_places: [VENUE, FOOD],
    post_media: [],
    ...over,
  };
}

function params(db: any, over: Partial<FetchEventPostsParams> = {}): FetchEventPostsParams {
  return { db, lat: 41.385, lng: 2.173, city: "Barcelona", radiusKm: 10, viewerId: "viewer-1", blockedIds: new Set(), seenPostIds: new Set(), readStatus: { readFailed: false }, ...over };
}

/** schemaStrictSupabase plus the `.ilike()` it notes but does not filter on, with every select and venue batch recorded. */
function strictDb(seed: Seed) {
  const strict = makeSchemaStrictClient(seed);
  const selects: Array<{ table: string; cols: string }> = [];
  const venueBatches: Array<{ col: string; vals: unknown[]; cols: string }> = [];
  const from = (table: string) => {
    const b = strict.from(table);
    let cols = "";
    const select = b.select;
    b.select = (c?: string, o?: any) => { cols = c ?? ""; selects.push({ table, cols }); return select(c, o); };
    const inFilter = b.in;
    b.in = (col: string, vals: unknown[]) => { if (table === "discovery_places") venueBatches.push({ col, vals, cols }); return inFilter(col, vals); };
    return b;
  };
  return { db: { from } as any, strict, selects, venueBatches };
}

/** failClosedSupabase (reads fail the way supabase-js fails), with the `.ilike()` it does not model as a no-op. */
function failDb(seed: Seed, failOn?: (ctx: FakeReadContext) => boolean) {
  const reads: string[] = [];
  const client = makeFailClosedClient({
    rows: seed as Record<string, Record<string, any>[]>,
    failOn: (ctx) => { reads.push(ctx.table); return failOn?.(ctx) ? { message: "canceling statement due to statement timeout", code: "57014" } : null; },
  });
  const from = (table: string) => { const b = client.from(table); b.ilike = () => b; return b; };
  return { db: { from } as any, reads };
}

describe("schema-strict: Path B reads posts, then one batch of venues keyed on osm_id", () => {
  it("serves the post at an events venue with the venue's name, and embeds nothing on the posts read", async () => {
    const { db, strict, selects, venueBatches } = strictDb(world());
    const p = params(db);
    const out = await fetchEventPostsForDiscovery(p);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.equal(p.readStatus!.readFailed, false, "both paths were read");
    assert.deepEqual(out.map((x) => x.id), ["p-venue"]);
    assert.deepEqual(out[0], {
      id: "p-venue", authorId: AUTHOR, content: "live from p-venue", mediaUrls: [], venueName: "Palau de la Música",
      locationCity: "Barcelona", publicLat: 41.387, publicLng: 2.175, createdAt: out[0]!.createdAt, likeCount: 3, commentCount: 1,
      linkedEventId: null, linkedEventTitle: null, venueLabel: "Palau de la Música", sourceKind: "venue_category",
    });
    const postsRead = selects.find((s) => s.table === "posts");
    assert.ok(postsRead, "precondition: Path B read posts");
    assert.ok(!postsRead!.cols.includes("("), `the posts read embeds nothing: ${postsRead!.cols}`);
    assert.match(postsRead!.cols, /\blocation_place_id\b/);
  });

  it("the venue read is ONE batch of OSM-shaped keys: free text written into location_place_id never reaches the filter", async () => {
    const { db, venueBatches } = strictDb(world());
    await fetchEventPostsForDiscovery(params(db));
    assert.equal(venueBatches.length, 1, "one venue batch per read");
    assert.equal(venueBatches[0]!.col, "osm_id");
    assert.deepEqual([...venueBatches[0]!.vals].sort(), [FOOD_KEY, VENUE_KEY].sort(), "the nominatim id and the crafted string are not sent");
  });

  it("a post whose place id names no discovery_places row, or a non-events one, is not listed (as before)", async () => {
    const { db } = strictDb(world({ posts: [post("p-venue", VENUE_KEY), post("p-food", FOOD_KEY), post("p-gone", "node/9999")] }));
    const out = await fetchEventPostsForDiscovery(params(db));
    assert.deepEqual(out.map((x) => x.id), ["p-venue"]);
  });

  it("the venue's coordinates drive the radius gate, as before", async () => {
    const far = { ...VENUE, id: "dddddddd-0000-4000-a000-000000000003", osm_id: "node/1003", lat: 52.0, lng: 4.0 };
    const { db } = strictDb(world({ posts: [post("p-venue", VENUE_KEY), post("p-far", "node/1003")], discovery_places: [VENUE, far] }));
    const out = await fetchEventPostsForDiscovery(params(db, { radiusKm: 10 }));
    assert.deepEqual(out.map((x) => x.id), ["p-venue"], "the far venue's post is gated out by the VENUE's coordinates, not the post's");
  });

  it("no post carries an OSM key: no venue read at all, and the path is still a successful read", async () => {
    const { db, venueBatches } = strictDb(world({ posts: [post("p-nominatim", "nominatim-1")] }));
    const p = params(db);
    assert.deepEqual(await fetchEventPostsForDiscovery(p), []);
    assert.equal(venueBatches.length, 0);
    assert.equal(p.readStatus!.readFailed, false);
  });

  it("storage-backed media reaches Path B (the media read used to be handed no post ids)", async () => {
    const { db } = strictDb(world({
      post_media: [{ id: "m1", post_id: "p-venue", public_url: "https://cdn.invalid/m1.jpg", sort_order: 0, processing_status: "ready", moderation_status: "approved" }],
    }));
    const out = await fetchEventPostsForDiscovery(params(db));
    assert.deepEqual(out.map((x) => x.mediaUrls), [["https://cdn.invalid/m1.jpg"]]);
  });
});

describe("an unreadable venue read is an unreadable path, never 'no venue posts'", () => {
  it("HEALTHY TWIN: served, readFailed false, and cached (the second call reads nothing)", async () => {
    const f = failDb(world());
    const p = params(f.db);
    const out = await fetchEventPostsForDiscovery(p);
    assert.deepEqual(out.map((x) => x.id), ["p-venue"]);
    assert.equal(p.readStatus!.readFailed, false);
    const readsAfter = f.reads.length;
    await fetchEventPostsForDiscovery(params(f.db));
    assert.equal(f.reads.length, readsAfter, "a healthy read is cached");
  });

  it("FAILURE: readFailed is set, nothing is cached, and the next call reads the venues again", async () => {
    const f = failDb(world(), (ctx) => ctx.table === "discovery_places");
    const p = params(f.db);
    const out = await fetchEventPostsForDiscovery(p);
    assert.deepEqual(out, []);
    assert.equal(p.readStatus!.readFailed, true, "the feed's envelope must be told");
    assert.equal(f.reads.filter((t) => t === "discovery_places").length, 1);
    const p2 = params(f.db);
    await fetchEventPostsForDiscovery(p2);
    assert.equal(f.reads.filter((t) => t === "discovery_places").length, 2, "a failed read is never cached");
    assert.equal(p2.readStatus!.readFailed, true);
  });
});

describe("both doubles refuse `discovery_places!posts_location_place_id_fkey(...)` from `posts`", () => {
  it("failClosedSupabase and schemaStrictSupabase throw PGRST200 on the old embed", () => {
    const old = "id, location_place_id, discovery_places!posts_location_place_id_fkey (name, primary_category, city, lat, lng)";
    assert.throws(() => makeFailClosedClient({}).from("posts").select(old), /failClosedSupabase: `discovery_places\(\.\.\.\)` is embedded from `posts`.*PGRST200/);
    assert.throws(() => makeSchemaStrictClient({}).from("posts").select(old), /schemaStrictSupabase: `discovery_places\(\.\.\.\)` is embedded from `posts`.*PGRST200/);
  });
});
