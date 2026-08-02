/**
 * Delayed geotag posting — unit tests
 *
 * Covers:
 *   - sensitivityLevel() classifier
 *   - geofenceRadius() radius selector
 *   - defaultPrivacyMode() mode chooser
 *   - safeLocationLabel() public label generator
 *   - parsePublishIntervalMinutes()
 *   - runDelayedPostPublisher() worker — publish, safe-return hold, canceled/review skip
 *   - isGeotagCreditRateLimited() anti-abuse guard (via fake client)
 *
 * Uses Node.js built-in test runner (no external test framework).
 * Fake client pattern mirrors dailyBriefCleanup.test.ts and admin route tests.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  sensitivityLevel,
  geofenceRadius,
  defaultPrivacyMode,
  safeLocationLabel,
  mapPublicPost,
} from "../lib/postSchemas.js";

import {
  parsePublishIntervalMinutes,
  runDelayedPostPublisher,
  _setTestClient,
  _publishCallCount,
} from "../lib/delayedPostPublisher.js";

// ── sensitivityLevel ──────────────────────────────────────────────────────────

describe("sensitivityLevel", () => {
  it("returns low for null", () => assert.equal(sensitivityLevel(null), "low"));
  it("returns low for generic venue", () => assert.equal(sensitivityLevel("Coffee shop"), "low"));
  it("returns high for hotel", () => assert.equal(sensitivityLevel("The Grand Hotel"), "high"));
  it("returns high for home", () => assert.equal(sensitivityLevel("My Home Address"), "high"));
  it("returns high for workplace", () => assert.equal(sensitivityLevel("My Workplace HQ"), "high"));
  it("returns medium for bar", () => assert.equal(sensitivityLevel("The Local Bar"), "medium"));
  it("returns medium for nightclub", () => assert.equal(sensitivityLevel("Club Neon Nightclub"), "medium"));
  it("case-insensitive match", () => assert.equal(sensitivityLevel("HOTEL CONTINENTAL"), "high"));
});

// ── geofenceRadius ────────────────────────────────────────────────────────────

describe("geofenceRadius", () => {
  it("returns 400 for low", () => assert.equal(geofenceRadius("low"), 400));
  it("returns 600 for medium", () => assert.equal(geofenceRadius("medium"), 600));
  it("returns 800 for high", () => assert.equal(geofenceRadius("high"), 800));
  it("respects user override", () => assert.equal(geofenceRadius("low", 1000), 1000));
  it("ignores zero override", () => assert.equal(geofenceRadius("low", 0), 400));
});

// ── defaultPrivacyMode ────────────────────────────────────────────────────────

describe("defaultPrivacyMode", () => {
  it("returns none when locationSrc=none", () => assert.equal(defaultPrivacyMode("none", "low"), "none"));
  it("returns delayed_until_exit for gps low", () => assert.equal(defaultPrivacyMode("gps", "low"), "delayed_until_exit"));
  it("returns delayed_until_exit for gps medium", () => assert.equal(defaultPrivacyMode("gps", "medium"), "delayed_until_exit"));
  it("returns city_only for gps high", () => assert.equal(defaultPrivacyMode("gps", "high"), "city_only"));
  it("returns delayed_until_exit for manual low", () => assert.equal(defaultPrivacyMode("manual", "low"), "delayed_until_exit"));
});

// ── safeLocationLabel ─────────────────────────────────────────────────────────

describe("safeLocationLabel", () => {
  it("returns null for hidden mode", () =>
    assert.equal(safeLocationLabel("The Ritz", "London", "UK", "hidden", "low"), null));
  it("returns city+country for city_only", () =>
    assert.equal(safeLocationLabel("The Ritz", "London", "UK", "city_only", "low"), "London, UK"));
  it("returns city+country for high-sensitivity regardless of mode", () =>
    assert.equal(safeLocationLabel("The Ritz Hotel", "Paris", "France", "delayed_until_exit", "high"), "Paris, France"));
  it("returns venue name for none mode low sensitivity", () =>
    assert.equal(safeLocationLabel("Blue Bottle Coffee", "NYC", "US", "none", "low"), "Blue Bottle Coffee"));
  it("returns city+country when venue name is null", () =>
    assert.equal(safeLocationLabel(null, "Berlin", "Germany", "delayed_until_exit", "low"), "Berlin, Germany"));
  it("returns null when no city or country in hidden mode", () =>
    assert.equal(safeLocationLabel(null, null, null, "hidden", "low"), null));
});

// ── parsePublishIntervalMinutes ───────────────────────────────────────────────

describe("parsePublishIntervalMinutes", () => {
  it("returns 5 (default) for undefined", () => assert.equal(parsePublishIntervalMinutes(undefined), 5));
  it("returns 5 for empty string", () => assert.equal(parsePublishIntervalMinutes(""), 5));
  it("returns 5 for zero", () => assert.equal(parsePublishIntervalMinutes("0"), 5));
  it("returns 5 for negative", () => assert.equal(parsePublishIntervalMinutes("-1"), 5));
  it("parses integer", () => assert.equal(parsePublishIntervalMinutes("10"), 10));
  it("parses float", () => assert.equal(parsePublishIntervalMinutes("2.5"), 2.5));
});

// ── runDelayedPostPublisher — fake client ─────────────────────────────────────

/** Build a fake Supabase-style builder chain. */
function makeFakeBuilder(resolveValue: any) {
  const builder: any = {
    _filters: {} as Record<string, any>,
    select: () => builder,
    eq: (_col: string, _val: any) => builder,
    neq: (_col: string, _val: any) => builder,
    in: (_col: string, _val: any) => builder,
    lte: (_col: string, _val: any) => builder,
    gte: (_col: string, _val: any) => builder,
    filter: (_col: string, _op: string, _val: any) => builder,
    limit: (_n: number) => builder,
    is: (_col: string, _val: any) => builder,
    maybeSingle: async () => resolveValue,
    single: async () => resolveValue,
    update: (_patch: any) => builder,
    insert: (_row: any) => builder,
    upsert: (_row: any, _opts?: any) => builder,
    then: undefined as any,
  };
  // Make it awaitable — resolves to resolveValue
  Object.defineProperty(builder, Symbol.toStringTag, { value: "FakeBuilder" });
  const p = Promise.resolve(resolveValue);
  builder.then = p.then.bind(p);
  builder.catch = p.catch.bind(p);
  return builder;
}

interface FakeStore {
  posts?: any[];
  safe_return_sessions?: any[];
  delayed_post_location_events?: any[];
  job_health?: any[];
  places?: any[];
  feature_flags?: any[];
  place_days?: any[];
}

/** Minimal fake client for worker tests. */
function makeFakeClient(store: FakeStore = {}) {
  const updates: Array<{ table: string; patch: any; id: string }> = [];
  const inserts: Array<{ table: string; row: any }> = [];
  const upserts: Array<{ table: string; row: any }> = [];

  const client: any = {
    _updates: updates,
    _inserts: inserts,
    _upserts: upserts,
    from(table: string) {
      const rowsFor = () => {
        switch (table) {
          case "safe_return_sessions": return store.safe_return_sessions ?? [];
          case "places": return store.places ?? [];
          case "feature_flags": return store.feature_flags ?? [];
          case "place_days": return store.place_days ?? [];
          default: return [];
        }
      };
      const selected = () => {
        const filters: Array<[string, any]> = [];
        const filteredRows = () => rowsFor().filter((row) =>
          filters.every(([column, value]) => row[column] === value),
        );
        const builder: any = {
          eq: (column: string, value: any) => {
            filters.push([column, value]);
            return builder;
          },
          in: (_column: string, _values: any[]) => builder,
          lte: (_column: string, _value: any) => Promise.resolve({ data: store.posts ?? [], error: null }),
          limit: (_count: number) => builder,
          maybeSingle: async () => ({ data: filteredRows()[0] ?? null, error: null }),
        };
        return builder;
      };
      return {
        select: (_cols?: string) => selected(),
        update: (patch: any) => ({
          eq: (_col: string, id: string) => {
            updates.push({ table, patch, id });
            return Promise.resolve({ data: null, error: null });
          },
        }),
        insert: (row: any) => {
          inserts.push({ table, row });
          return Promise.resolve({ data: null, error: null });
        },
        upsert: (row: any, _opts?: any) => {
          upserts.push({ table, row });
          if (table === "place_days") (store.place_days ??= []).push(row);
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };
  return client;
}

describe("runDelayedPostPublisher — no eligible posts", () => {
  it("returns zero counts when posts array is empty", async () => {
    const client = makeFakeClient({ posts: [] });
    _setTestClient(client);
    const result = await runDelayedPostPublisher({ client });
    assert.equal(result.published, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.errors, 0);
    _setTestClient(null);
  });
});

describe("runDelayedPostPublisher — publishes eligible post", () => {
  it("publishes a pending_location_exit post with no active safe_return", async () => {
    const posts = [
      {
        id: "post-aaa",
        author_id: "user-1",
        location_privacy_mode: "delayed_until_exit",
        original_lat: 51.5,
        original_lng: -0.1,
        post_status: "pending_location_exit",
      },
    ];
    const client = makeFakeClient({ posts, safe_return_sessions: [] });
    _setTestClient(client);
    const result = await runDelayedPostPublisher({ client });
    assert.equal(result.published, 1);
    assert.equal(result.skipped, 0);
    assert.equal(result.errors, 0);
    // Check that an update was issued for the post
    const postUpdates = client._updates.filter((u: any) => u.table === "posts");
    assert.ok(postUpdates.length > 0, "should have updated post");
    const publishUpdate = postUpdates.find((u: any) => u.patch.post_status === "published");
    assert.ok(publishUpdate, "should have set post_status=published");
    _setTestClient(null);
  });

  it("materializes a Place Day after a canonical delayed post becomes published", async () => {
    const client = makeFakeClient({
      posts: [{
        id: "post-place-day",
        author_id: "user-place-day",
        canonical_place_id: "place-aaa",
        created_at: "2026-08-02T23:30:00.000Z",
        visibility: "public",
        status: "active",
        post_status: "pending_delay",
        location_privacy_mode: "delayed_until_time",
      }],
      safe_return_sessions: [],
      places: [{ id: "place-aaa", city: "Cebu City", latitude: 10.3157, longitude: 123.8854, merged_into_place_id: null }],
      feature_flags: [
        { flag: "external_places_enabled", enabled: true },
        { flag: "place_days_enabled", enabled: true },
      ],
    });
    _setTestClient(client);
    await runDelayedPostPublisher({ client });
    await new Promise((resolve) => setImmediate(resolve));
    const placeDay = client._upserts.find((entry: any) => entry.table === "place_days");
    assert.ok(placeDay, "should create a Place Day after the delayed post publishes");
    assert.equal(placeDay.row.place_id, "place-aaa");
    assert.equal(placeDay.row.local_date, "2026-08-03");
    _setTestClient(null);
  });
});

describe("runDelayedPostPublisher — safe return hold", () => {
  it("skips post when user has active Safe Return session", async () => {
    const posts = [
      {
        id: "post-bbb",
        author_id: "user-2",
        location_privacy_mode: "delayed_until_exit",
        original_lat: 48.8,
        original_lng: 2.3,
        post_status: "pending_location_exit",
      },
    ];
    const safeReturn = [{ id: "sr-1", user_id: "user-2", status: "active" }];
    const client = makeFakeClient({ posts, safe_return_sessions: safeReturn });
    _setTestClient(client);
    const result = await runDelayedPostPublisher({ client });
    assert.equal(result.published, 0);
    assert.equal(result.skipped, 1);
    const postUpdates = client._updates.filter(
      (u: any) => u.table === "posts" && u.patch.post_status === "published"
    );
    assert.equal(postUpdates.length, 0, "should NOT have published the post");
    _setTestClient(null);
  });
});

describe("runDelayedPostPublisher — coordinates revealed for exit mode", () => {
  it("copies original_lat/lng to public_lat/lng when mode is delayed_until_exit", async () => {
    const posts = [
      {
        id: "post-ccc",
        author_id: "user-3",
        location_privacy_mode: "delayed_until_exit",
        original_lat: 35.6,
        original_lng: 139.7,
        post_status: "pending_location_exit",
      },
    ];
    const client = makeFakeClient({ posts, safe_return_sessions: [] });
    _setTestClient(client);
    await runDelayedPostPublisher({ client });
    const publishUpdate = client._updates.find(
      (u: any) => u.table === "posts" && u.patch.public_lat === 35.6
    );
    assert.ok(publishUpdate, "should have set public_lat from original_lat");
    assert.equal(publishUpdate.patch.public_lng, 139.7);
    _setTestClient(null);
  });
});

describe("runDelayedPostPublisher — city_only mode strips coordinates", () => {
  it("does NOT copy coordinates when mode is city_only", async () => {
    const posts = [
      {
        id: "post-ddd",
        author_id: "user-4",
        location_privacy_mode: "city_only",
        original_lat: 40.7,
        original_lng: -74.0,
        post_status: "pending_delay",
      },
    ];
    const client = makeFakeClient({ posts, safe_return_sessions: [] });
    _setTestClient(client);
    await runDelayedPostPublisher({ client });
    const publishUpdate = client._updates.find(
      (u: any) => u.table === "posts" && u.patch.post_status === "published"
    );
    assert.ok(publishUpdate, "should have published");
    assert.equal(publishUpdate.patch.public_lat, undefined, "should NOT set public_lat for city_only");
    _setTestClient(null);
  });
});

describe("runDelayedPostPublisher — no client", () => {
  it("returns zeros and does not throw when client is null", async () => {
    // Clear the test client so resolveClient() returns null
    _setTestClient(null);
    // Override internal isServiceClientReady by passing no opts (worker uses module state)
    // Just pass an explicit null-like opts to trigger the guard
    const result = await runDelayedPostPublisher({ client: null });
    assert.equal(result.published, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.errors, 0);
  });
});

// ── mapPublicPost — privacy redaction ─────────────────────────────────────────

describe("mapPublicPost — no privacy mode", () => {
  it("passes through unchanged when mode is null", () => {
    const row = { id: "p1", location_name: "The Ritz", location_privacy_mode: null };
    const out = mapPublicPost(row);
    assert.equal(out.location_name, "The Ritz");
  });
  it("passes through unchanged when mode is 'none'", () => {
    const row = { id: "p2", location_name: "Blue Bottle", location_privacy_mode: "none" };
    const out = mapPublicPost(row);
    assert.equal(out.location_name, "Blue Bottle");
  });
});

describe("mapPublicPost — city_only mode", () => {
  it("redacts location_name", () => {
    const row = { id: "p3", location_name: "The Ritz Paris", location_privacy_mode: "city_only" };
    const out = mapPublicPost(row);
    assert.equal(out.location_name, null);
  });
});

describe("mapPublicPost — hidden mode", () => {
  it("redacts location_name", () => {
    const row = { id: "p4", location_name: "My Home", location_privacy_mode: "hidden" };
    const out = mapPublicPost(row);
    assert.equal(out.location_name, null);
  });
});

describe("mapPublicPost — trusted_circle_only mode", () => {
  it("redacts location_name", () => {
    const row = { id: "p5", location_name: "Private Club", location_privacy_mode: "trusted_circle_only" };
    const out = mapPublicPost(row);
    assert.equal(out.location_name, null);
  });
});

describe("mapPublicPost — delayed_until_exit pending", () => {
  it("redacts location_name before geofence exit", () => {
    const row = {
      id: "p6",
      location_name: "Conference Center",
      location_privacy_mode: "delayed_until_exit",
      post_status: "pending_location_exit",
    };
    const out = mapPublicPost(row);
    assert.equal(out.location_name, null);
  });
  it("reveals location_name after published", () => {
    const row = {
      id: "p7",
      location_name: "Conference Center",
      location_privacy_mode: "delayed_until_exit",
      post_status: "published",
    };
    const out = mapPublicPost(row);
    assert.equal(out.location_name, "Conference Center");
  });
});

describe("mapPublicPost — delayed_until_time pending", () => {
  it("redacts location_name before time window", () => {
    const row = {
      id: "p8",
      location_name: "Surprise Restaurant",
      location_privacy_mode: "delayed_until_time",
      post_status: "pending_delay",
    };
    const out = mapPublicPost(row);
    assert.equal(out.location_name, null);
  });
  it("reveals after published", () => {
    const row = {
      id: "p9",
      location_name: "Surprise Restaurant",
      location_privacy_mode: "delayed_until_time",
      post_status: "published",
    };
    const out = mapPublicPost(row);
    assert.equal(out.location_name, "Surprise Restaurant");
  });
});

describe("mapPublicPost — does not mutate original", () => {
  it("returns a new object when redacting", () => {
    const row = { id: "p10", location_name: "Secret Spot", location_privacy_mode: "hidden" };
    const out = mapPublicPost(row);
    assert.notEqual(out, row, "should be a new object");
    assert.equal(row.location_name, "Secret Spot", "original should be unchanged");
  });
});
