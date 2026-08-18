/**
 * Tests for the map-travelers privacy core: eligibility (who appears),
 * coarsening (where markers sit), and freshness bucketing.
 *
 * Run: npx tsx --test src/test/mapTravelers.test.ts
 */
import { test, describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  effectiveDiscoveryVisibility,
  coarsenPosition,
  freshnessBucket,
  hash01,
  listMapTravelers,
  _clearMapTravelersCache,
} from "../lib/mapTravelers";

// ── effectiveDiscoveryVisibility — the opt-in gate ───────────────────────────

test("missing prefs row → product default city_only (visible at city precision)", () => {
  assert.equal(effectiveDiscoveryVisibility(null), "city_only");
  assert.equal(effectiveDiscoveryVisibility(undefined), "city_only");
  assert.equal(effectiveDiscoveryVisibility({}), "city_only");
});

test("location_mode off → hidden, regardless of overrides", () => {
  assert.equal(effectiveDiscoveryVisibility({ location_mode: "off" }), null);
  assert.equal(
    effectiveDiscoveryVisibility({ location_mode: "off", discovery_visibility: "neighborhood" }),
    null,
  );
});

test("sharing_paused → hidden, regardless of mode", () => {
  assert.equal(
    effectiveDiscoveryVisibility({ location_mode: "nearby", sharing_paused: true }),
    null,
  );
});

test("explicit no_location override → hidden", () => {
  assert.equal(
    effectiveDiscoveryVisibility({ location_mode: "nearby", discovery_visibility: "no_location" }),
    null,
  );
});

test("mode defaults map to expected precision", () => {
  assert.equal(effectiveDiscoveryVisibility({ location_mode: "city_only" }), "city_only");
  assert.equal(effectiveDiscoveryVisibility({ location_mode: "nearby" }), "neighborhood");
  assert.equal(
    effectiveDiscoveryVisibility({ location_mode: "live_during_activity" }),
    "neighborhood",
  );
  assert.equal(
    effectiveDiscoveryVisibility({ location_mode: "trusted_circle_live" }),
    "venue_tagged",
  );
});

test("explicit discovery_visibility override wins over mode default", () => {
  assert.equal(
    effectiveDiscoveryVisibility({ location_mode: "city_only", discovery_visibility: "neighborhood" }),
    "neighborhood",
  );
});

test("unknown mode value → safe default city_only, not a crash", () => {
  assert.equal(effectiveDiscoveryVisibility({ location_mode: "something_new" }), "city_only");
});

// ── coarsenPosition — no precise coordinates ever ─────────────────────────────

test("area coarsening: output is inside the ~2.2km cell but not the raw point", () => {
  const raw = { lat: 10.31672, lng: 123.89071 }; // Cebu-ish
  const out = coarsenPosition("user-a", raw.lat, raw.lng, "neighborhood");
  assert.equal(out.precision, "area");
  // Same 0.02° cell…
  assert.equal(Math.floor(out.lat / 0.02), Math.floor(raw.lat / 0.02));
  assert.equal(Math.floor(out.lng / 0.02), Math.floor(raw.lng / 0.02));
  // …but never off the cell edges (0.15–0.85 of the cell).
  const fracLat = out.lat / 0.02 - Math.floor(out.lat / 0.02);
  assert.ok(fracLat >= 0.14 && fracLat <= 0.86, `fracLat ${fracLat}`);
});

test("city coarsening uses the ~11km grid", () => {
  const out = coarsenPosition("user-a", 10.31672, 123.89071, "city_only");
  assert.equal(out.precision, "city");
  assert.equal(Math.floor(out.lat / 0.1), Math.floor(10.31672 / 0.1));
});

test("coarsening is deterministic per user and differs between users", () => {
  const a1 = coarsenPosition("user-a", 10.316, 123.89, "neighborhood");
  const a2 = coarsenPosition("user-a", 10.316, 123.89, "neighborhood");
  const b = coarsenPosition("user-b", 10.316, 123.89, "neighborhood");
  assert.deepEqual(a1, a2);
  assert.notDeepEqual({ lat: a1.lat, lng: a1.lng }, { lat: b.lat, lng: b.lng });
});

test("tiny raw movements inside one cell do NOT move the marker (no averaging attack)", () => {
  const p1 = coarsenPosition("user-a", 10.3161, 123.8901, "neighborhood");
  const p2 = coarsenPosition("user-a", 10.3169, 123.8909, "neighborhood");
  assert.deepEqual(p1, p2);
});

test("venue_tagged and exact_hidden are still capped at area precision", () => {
  for (const vis of ["venue_tagged", "exact_hidden"]) {
    const out = coarsenPosition("user-a", 10.31672, 123.89071, vis);
    assert.equal(out.precision, "area");
    assert.notEqual(out.lat, 10.31672);
  }
});

// ── freshnessBucket — coarse buckets only, stale users drop off ───────────────

test("freshness buckets: live < 15min, recent < 60min, stale → null", () => {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  assert.equal(freshnessBucket(iso(5 * 60 * 1000), now), "live");
  assert.equal(freshnessBucket(iso(30 * 60 * 1000), now), "recent");
  assert.equal(freshnessBucket(iso(90 * 60 * 1000), now), null);
  assert.equal(freshnessBucket(null, now), null);
  assert.equal(freshnessBucket("not-a-date", now), null);
});

// ── hash01 sanity ─────────────────────────────────────────────────────────────

test("hash01 is deterministic, in [0,1), and spreads across seeds", () => {
  assert.equal(hash01("abc"), hash01("abc"));
  const vals = ["a", "b", "c", "d", "e"].map(hash01);
  for (const v of vals) assert.ok(v >= 0 && v < 1);
  assert.ok(new Set(vals.map((v) => v.toFixed(3))).size >= 4);
});

// ── listMapTravelers — show_profile_picture_publicly enforcement ────────────
//
// The candidate cache is viewer-independent (shared across every client
// polling the same viewport), so the photo-visibility gate can't be baked in
// at candidate-build time — it has to be resolved per viewer, after the
// cache, the same place self/block filtering already happens. These tests
// exercise listMapTravelers() end to end (fake DB → candidate load → cache →
// per-viewer gate), not just the pure helpers above.

const ME    = "aa000000-0000-4000-a000-000000000001";
const DAVE  = "ee000000-0000-4000-a000-000000000007"; // flag off, stranger
const EVE   = "ee000000-0000-4000-a000-000000000008"; // flag on
const FRED  = "ee000000-0000-4000-a000-000000000009"; // flag off, follower
const GINA  = "ee000000-0000-4000-a000-00000000000a"; // flag off, friend (uuid > ME)
const AAA   = "01000000-0000-4000-a000-000000000001"; // flag off, friend (uuid < ME)

type MapFakeState = {
  user_location_state?: any[];
  location_preferences?: any[];
  profiles?: any[];
  profile_privacy_settings?: any[];
  user_privacy_settings?: any[];
  canonical_locations?: any[];
  user_follows?: any[];
  user_friendships?: any[];
};

function makeMapDb(state: MapFakeState) {
  return {
    from: (table: string) => {
      const rowsAll: any[] = (state as any)[table] ?? [];
      const filters: Array<(r: any) => boolean> = [];
      // Column projection for "profiles" only — mirrors the discipline used
      // in the other route fixes: the mock must actually respect the SELECT
      // string, or a mutation that strips the column from the real query
      // would go unnoticed here.
      let profileCols: string[] | null = null;
      const builder: any = {
        select(cols?: string) {
          if (table === "profiles" && typeof cols === "string" && cols !== "*") {
            profileCols = cols.split(",").map((c) => c.trim());
          }
          return builder;
        },
        eq(col: string, val: any)    { filters.push((r) => r[col] === val); return builder; },
        neq(col: string, val: any)   { filters.push((r) => r[col] !== val); return builder; },
        in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
        not(col: string, op: string, val: any) {
          if (op === "is") filters.push((r) => (val === null ? r[col] != null : r[col] !== val));
          return builder;
        },
        gte(col: string, val: any) { filters.push((r) => r[col] != null && r[col] >= val); return builder; },
        lte(col: string, val: any) { filters.push((r) => r[col] != null && r[col] <= val); return builder; },
        order() { return builder; },
        limit() { return builder; },
        then(onF: any, onR: any) {
          let rows = rowsAll.filter((r) => filters.every((f) => f(r)));
          if (table === "profiles" && profileCols) {
            rows = rows.map((r) => Object.fromEntries(profileCols!.filter((c) => c in r).map((c) => [c, r[c]])));
          }
          return Promise.resolve({ data: rows, error: null }).then(onF, onR);
        },
      };
      return builder;
    },
  } as any;
}

function travelerFixture(id: string, showProfilePicturePublicly: boolean) {
  return {
    loc: { user_id: id, lat: 0.01, lng: 0.01, city: null, country: null, last_known_at: new Date().toISOString() },
    prefs: { user_id: id, location_mode: "nearby" }, // → "neighborhood" vis, area precision, no canonical_locations lookup
    profile: {
      id, handle: id.slice(0, 8), name: "Traveler", display_name: null,
      avatar_url: `https://cdn/${id.slice(0, 8)}.jpg`, verified: false, open_to_meet: false,
      is_private: false, account_status: "active",
      show_profile_picture_publicly: showProfilePicturePublicly,
    },
  };
}

function buildState(travelers: ReturnType<typeof travelerFixture>[], extra: Partial<MapFakeState> = {}): MapFakeState {
  return {
    user_location_state: travelers.map((t) => t.loc),
    location_preferences: travelers.map((t) => t.prefs),
    profiles: travelers.map((t) => t.profile),
    profile_privacy_settings: [],
    user_privacy_settings: [],
    canonical_locations: [],
    user_follows: [],
    user_friendships: [],
    ...extra,
  };
}

const VIEWPORT = { viewerId: ME, lat: 0, lng: 0, radiusKm: 50, blockedSet: new Set<string>() };

describe("listMapTravelers — show_profile_picture_publicly enforcement", () => {
  beforeEach(() => { _clearMapTravelersCache(); });

  it("hides avatarUrl for a public traveler whose owner turned the photo off, for a stranger", async () => {
    const db = makeMapDb(buildState([travelerFixture(DAVE, false)]));
    const rows = await listMapTravelers(db, VIEWPORT);
    const dave = rows.find((r) => r.id === DAVE);
    assert.ok(dave, "traveler must still appear on the map (this is not the is_private gate)");
    assert.equal(dave!.avatarUrl, null);
  });

  it("shows avatarUrl for a public traveler whose owner left the photo on", async () => {
    const db = makeMapDb(buildState([travelerFixture(EVE, true)]));
    const rows = await listMapTravelers(db, VIEWPORT);
    const eve = rows.find((r) => r.id === EVE);
    assert.equal(eve!.avatarUrl, `https://cdn/${EVE.slice(0, 8)}.jpg`);
  });

  it("shows avatarUrl to a follower even when the flag is off", async () => {
    const db = makeMapDb(buildState(
      [travelerFixture(FRED, false)],
      { user_follows: [{ follower_id: ME, following_id: FRED }] },
    ));
    const rows = await listMapTravelers(db, VIEWPORT);
    const fred = rows.find((r) => r.id === FRED);
    assert.equal(fred!.avatarUrl, `https://cdn/${FRED.slice(0, 8)}.jpg`);
  });

  it("shows avatarUrl to a friend even when the flag is off (friendsAsA direction: viewer's uuid sorts first)", async () => {
    const db = makeMapDb(buildState(
      [travelerFixture(GINA, false)],
      { user_friendships: [{ user_a: ME, user_b: GINA }] },
    ));
    const rows = await listMapTravelers(db, VIEWPORT);
    const gina = rows.find((r) => r.id === GINA);
    assert.equal(gina!.avatarUrl, `https://cdn/${GINA.slice(0, 8)}.jpg`);
  });

  it("shows avatarUrl to a friend on the other normalized side (friendsAsB direction: viewer's uuid sorts second)", async () => {
    const db = makeMapDb(buildState(
      [travelerFixture(AAA, false)],
      { user_friendships: [{ user_a: AAA, user_b: ME }] },
    ));
    const rows = await listMapTravelers(db, VIEWPORT);
    const aaa = rows.find((r) => r.id === AAA);
    assert.equal(aaa!.avatarUrl, `https://cdn/${AAA.slice(0, 8)}.jpg`);
  });

  it("never leaks the internal showProfilePicturePublicly field onto the response row", async () => {
    const db = makeMapDb(buildState([travelerFixture(DAVE, false), travelerFixture(EVE, true)]));
    const rows = await listMapTravelers(db, VIEWPORT);
    for (const r of rows) {
      assert.ok(!("showProfilePicturePublicly" in r), "internal cache field must not reach the response");
    }
  });

  it("the shared candidate cache does not leak one viewer's connections into another viewer's response", async () => {
    // FRED has the flag off. A follower of FRED (ME) polls first — this
    // populates the shared 20s viewport cache. A second, UNCONNECTED viewer
    // then polls the same viewport within the cache window and must still
    // get avatarUrl: null, proving the follow/friend check runs per-request
    // rather than being baked into the cached row.
    const STRANGER = "ee000000-0000-4000-a000-00000000000b";
    const db = makeMapDb(buildState(
      [travelerFixture(FRED, false)],
      { user_follows: [{ follower_id: ME, following_id: FRED }] },
    ));
    const meRows = await listMapTravelers(db, VIEWPORT);
    assert.equal(meRows.find((r) => r.id === FRED)!.avatarUrl, `https://cdn/${FRED.slice(0, 8)}.jpg`);

    const strangerRows = await listMapTravelers(db, { ...VIEWPORT, viewerId: STRANGER });
    assert.equal(
      strangerRows.find((r) => r.id === FRED)!.avatarUrl, null,
      "an unconnected second viewer hitting the SAME cached candidates must not inherit the first viewer's follow relationship",
    );
  });
});
