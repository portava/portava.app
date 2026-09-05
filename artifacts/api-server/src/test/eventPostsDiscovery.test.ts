/**
 * Unit tests for fetchEventPostsForDiscovery — pure logic + fake DB client.
 * Run: node --import tsx/esm --test src/test/eventPostsDiscovery.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  fetchEventPostsForDiscovery,
  _clearEventPostsCache,
  type FetchEventPostsParams,
  type DiscoveryEventPost,
} from "../lib/eventPostsDiscovery.js";

// Clear the L1 event-post cache before each test so tests that share the same
// (city, radiusKm) key ("Barcelona", 10) don't observe each other's DB fakes.
beforeEach(() => {
  _clearEventPostsCache();
});

// ── Fake Supabase client builder ───────────────────────────────────────────────

type FakeRow = Record<string, any>;

/** Builds a chainable Supabase-like fake that returns the given rows. */
function fakeDb(tableData: Record<string, FakeRow[]>) {
  const makeChain = (tableName: string, rows: FakeRow[]) => {
    let filtered = [...rows];

    const chain: any = {
      select: (_cols: string) => chain,
      eq: (_col: string, _val: any) => chain,
      ilike: (_col: string, _val: any) => chain,
      is: (_col: string, _val: any) => chain,
      not: (_col: string, _op: string, _val: any) => chain,
      limit: (_n: number) => chain,
      then: (resolve: (v: any) => void) => {
        resolve({ data: filtered, error: null });
        return Promise.resolve({ data: filtered, error: null });
      },
    };

    // Make `await chain` work
    Object.defineProperty(chain, Symbol.toStringTag, { value: "Promise" });
    chain[Symbol.iterator] = undefined;
    // Make it a thenable
    chain.then = (resolve: (v: any) => void, _reject?: any) => {
      const result = { data: filtered, error: null };
      resolve(result);
      return Promise.resolve(result);
    };

    return chain;
  };

  return {
    from: (table: string) => makeChain(table, tableData[table] ?? []),
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
    },
  } as any;
}

// ── Test data helpers ─────────────────────────────────────────────────────────

const BASE_POST = {
  id: "post-1",
  author_id: "author-1",
  content: "Great show tonight!",
  media_urls: [],
  location_city: "Barcelona",
  location_name: "Palau de la Música",
  location_place_id: "osm-venue-1",
  public_lat: 41.387,
  public_lng: 2.175,
  created_at: new Date().toISOString(),
  like_count: 10,
  comment_count: 3,
  visibility: "public",
  status: "active",
  post_status: "published",
  deleted_at: null,
  publish_eligible_at: null,
};

const BASE_EVENT = {
  id: "event-1",
  title: "Jazz Festival",
  location_lat: 41.387,
  location_lng: 2.175,
  starts_at: null,
  ends_at: null,
  location_name: "Palau de la Música",
};

const BASE_PLACE = {
  name: "Palau de la Música",
  primary_category: "events",
  city: "Barcelona",
  lat: 41.387,
  lng: 2.175,
};

function makeParams(overrides: Partial<FetchEventPostsParams> = {}): FetchEventPostsParams {
  return {
    db: fakeDb({}),
    lat: 41.385,
    lng: 2.173,
    city: "Barcelona",
    radiusKm: 10,
    viewerId: "viewer-1",
    blockedIds: new Set<string>(),
    seenPostIds: new Set<string>(),
    ...overrides,
  };
}

// ── Path A: explicit event link ───────────────────────────────────────────────

describe("Path A — explicit event link", () => {
  it("returns a post linked via post_event_links within radius", async () => {
    const db = fakeDb({
      post_event_links: [
        {
          post_id: BASE_POST.id,
          event_id: BASE_EVENT.id,
          posts: { ...BASE_POST },
          events: { ...BASE_EVENT },
        },
      ],
      posts: [],
    });

    const results = await fetchEventPostsForDiscovery(makeParams({ db }));
    assert.equal(results.length, 1);
    assert.equal(results[0]!.id, "post-1");
    assert.equal(results[0]!.sourceKind, "event_link");
    assert.equal(results[0]!.linkedEventId, "event-1");
    assert.equal(results[0]!.linkedEventTitle, "Jazz Festival");
  });

  it("excludes a post whose linked event is beyond radiusKm", async () => {
    const farEvent = { ...BASE_EVENT, location_lat: 52.0, location_lng: 4.0 }; // ~1600 km away
    const db = fakeDb({
      post_event_links: [
        { post_id: BASE_POST.id, event_id: farEvent.id, posts: { ...BASE_POST }, events: farEvent },
      ],
      posts: [],
    });

    const results = await fetchEventPostsForDiscovery(makeParams({ db, radiusKm: 10 }));
    assert.equal(results.length, 0);
  });
});

// ── Path B: venue category ────────────────────────────────────────────────────

describe("Path B — venue category", () => {
  it("returns a post tagged at an events venue", async () => {
    const postWithPlace = {
      ...BASE_POST,
      discovery_places: BASE_PLACE,
    };
    const db = fakeDb({
      post_event_links: [],
      posts: [postWithPlace],
    });

    const results = await fetchEventPostsForDiscovery(makeParams({ db }));
    assert.equal(results.length, 1);
    assert.equal(results[0]!.sourceKind, "venue_category");
    assert.equal(results[0]!.venueName, "Palau de la Música");
  });

  it("excludes a post tagged at a non-events venue", async () => {
    const nonEventPlace = { ...BASE_PLACE, primary_category: "food" };
    const postWithPlace = { ...BASE_POST, discovery_places: nonEventPlace };
    const db = fakeDb({
      post_event_links: [],
      posts: [postWithPlace],
    });

    const results = await fetchEventPostsForDiscovery(makeParams({ db }));
    assert.equal(results.length, 0);
  });

  it("excludes a post at an events venue that is beyond radiusKm", async () => {
    const farPlace = { ...BASE_PLACE, lat: 52.0, lng: 4.0 };
    const postWithPlace = { ...BASE_POST, discovery_places: farPlace };
    const db = fakeDb({
      post_event_links: [],
      posts: [postWithPlace],
    });

    const results = await fetchEventPostsForDiscovery(makeParams({ db, radiusKm: 10 }));
    assert.equal(results.length, 0);
  });
});

// ── Privacy filter ────────────────────────────────────────────────────────────

describe("Privacy filter", () => {
  it("excludes trip_only posts", async () => {
    const post = { ...BASE_POST, visibility: "trip_only", discovery_places: BASE_PLACE };
    const db = fakeDb({ post_event_links: [], posts: [post] });
    const results = await fetchEventPostsForDiscovery(makeParams({ db }));
    assert.equal(results.length, 0);
  });

  it("excludes private posts", async () => {
    const post = { ...BASE_POST, visibility: "private", discovery_places: BASE_PLACE };
    const db = fakeDb({ post_event_links: [], posts: [post] });
    const results = await fetchEventPostsForDiscovery(makeParams({ db }));
    assert.equal(results.length, 0);
  });

  it("includes public posts", async () => {
    const post = { ...BASE_POST, visibility: "public", discovery_places: BASE_PLACE };
    const db = fakeDb({ post_event_links: [], posts: [post] });
    const results = await fetchEventPostsForDiscovery(makeParams({ db }));
    assert.equal(results.length, 1);
  });
});

// ── Block filter ─────────────────────────────────────────────────────────────

describe("Block filter", () => {
  it("excludes posts from a blocked author", async () => {
    const post = { ...BASE_POST, author_id: "blocked-user", discovery_places: BASE_PLACE };
    const db = fakeDb({ post_event_links: [], posts: [post] });
    const blockedIds = new Set(["blocked-user"]);
    const results = await fetchEventPostsForDiscovery(makeParams({ db, blockedIds }));
    assert.equal(results.length, 0);
  });

  it("includes posts from non-blocked authors", async () => {
    const post = { ...BASE_POST, discovery_places: BASE_PLACE };
    const db = fakeDb({ post_event_links: [], posts: [post] });
    const blockedIds = new Set(["some-other-user"]);
    const results = await fetchEventPostsForDiscovery(makeParams({ db, blockedIds }));
    assert.equal(results.length, 1);
  });
});

// ── Diversity cap ─────────────────────────────────────────────────────────────

describe("Diversity cap", () => {
  it("caps at 3 posts per venue when more than 3 posts share the same location_place_id", async () => {
    const posts = Array.from({ length: 5 }, (_, i) => ({
      ...BASE_POST,
      id: `post-${i}`,
      // same location_place_id → same groupKey
      location_place_id: "osm-venue-1",
      discovery_places: BASE_PLACE,
      created_at: new Date(Date.now() - i * 60_000).toISOString(),
    }));

    const db = fakeDb({ post_event_links: [], posts });
    const results = await fetchEventPostsForDiscovery(makeParams({ db }));
    assert.ok(results.length <= 3, `Expected ≤ 3 posts, got ${results.length}`);
  });

  it("does not cap when fewer than 3 posts share the same venue", async () => {
    const posts = Array.from({ length: 2 }, (_, i) => ({
      ...BASE_POST,
      id: `post-${i}`,
      location_place_id: "osm-venue-1",
      discovery_places: BASE_PLACE,
    }));

    const db = fakeDb({ post_event_links: [], posts });
    const results = await fetchEventPostsForDiscovery(makeParams({ db }));
    assert.equal(results.length, 2);
  });
});

// ── Deleted / inactive posts ──────────────────────────────────────────────────

describe("Status filters", () => {
  it("excludes deleted posts", async () => {
    const post = {
      ...BASE_POST,
      deleted_at: new Date().toISOString(),
      discovery_places: BASE_PLACE,
    };
    const db = fakeDb({ post_event_links: [], posts: [post] });
    const results = await fetchEventPostsForDiscovery(makeParams({ db }));
    assert.equal(results.length, 0);
  });

  it("excludes inactive posts", async () => {
    const post = { ...BASE_POST, status: "inactive", discovery_places: BASE_PLACE };
    const db = fakeDb({ post_event_links: [], posts: [post] });
    const results = await fetchEventPostsForDiscovery(makeParams({ db }));
    assert.equal(results.length, 0);
  });

  // The fixture used to say post_status: "delayed_post". That is not a label of
  // the delayed_post_status enum (draft / private / pending_location_exit /
  // pending_delay / pending_safety_review / published / canceled / expired), so
  // it could not occur in the database — and the production gate compared
  // against the same impossible literal. Test and code agreed with each other
  // and both disagreed with the schema, so the suite was green while every real
  // pending post walked through. These cases use labels POST /posts and the
  // moderation path actually write.
  for (const pending of ["pending_location_exit", "pending_delay", "pending_safety_review"]) {
    it(`excludes a post whose post_status is '${pending}' (a real, writable label)`, async () => {
      const post = { ...BASE_POST, post_status: pending, discovery_places: BASE_PLACE };
      const db = fakeDb({ post_event_links: [], posts: [post] });
      const results = await fetchEventPostsForDiscovery(makeParams({ db }));
      assert.equal(results.length, 0, `${pending} must never reach event discovery`);
    });
  }

  it("excludes a pending post even when its publish_eligible_at has already passed", async () => {
    // Fail closed: post_status is written by the sweeper, which also applies the
    // safety-review hold. A reader must not publish on its own clock reading.
    const pastTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const post = {
      ...BASE_POST,
      post_status: "pending_delay",
      publish_eligible_at: pastTime,
      discovery_places: BASE_PLACE,
    };
    const db = fakeDb({ post_event_links: [], posts: [post] });
    const results = await fetchEventPostsForDiscovery(makeParams({ db }));
    assert.equal(results.length, 0);
  });

  it("includes a published post whose publish_eligible_at is still in the future (manual release)", async () => {
    const futureTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const post = {
      ...BASE_POST,
      post_status: "published",
      publish_eligible_at: futureTime,
      discovery_places: BASE_PLACE,
    };
    const db = fakeDb({ post_event_links: [], posts: [post] });
    const results = await fetchEventPostsForDiscovery(makeParams({ db }));
    assert.equal(results.length, 1);
  });
});
