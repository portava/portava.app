/**
 * The Saved map layer is the UNION of the two tables saves actually land in.
 *
 * THE DEFECT THIS PINS
 * ====================
 * `readSavedPlacePins` read `public.saved_places`, a table with ZERO writers
 * anywhere in the repo. The layer was built, mounted and reachable from eight
 * surfaces, and returned nothing forever. It stayed green because the producer
 * suite seeded `saved_places` directly, and because an empty table and an empty
 * fixture are indistinguishable: the gateway records `{refusal: null,
 * collected: 0}` — a successful layer with no pins — so nothing anywhere goes
 * red.
 *
 * That last property is why the assertion that matters here is the COUNT, not
 * the refusal. `producers.saved_place.refusal === null` PASSES on the broken
 * code. It is asserted anyway, because a "fix" that degrades into a plausible
 * refusal (`places_read_failed` from using `lat`/`lng` against `public.places`,
 * whose columns are `latitude`/`longitude`) must fail loudly rather than read
 * as "0 pins, no error" all over again.
 *
 * WHAT EACH WRONG FIX SCORES ON THE FIXTURE BELOW (4 pins is correct).
 * Every line was MEASURED by mutating the producer and re-running this file,
 * not predicted:
 *   read saved_places (today)          0 — the defect. 8 of 9 cases fail.
 *   repoint to discovery_place_saves   2 — 'Canonical Cafe' and 'Gem' vanish
 *   lat/lng used against public.places 3 — 'Canonical Cafe' vanishes
 *   no .eq("user_id", viewer)          5 — 'Other user place' appears by name
 *   union keyed on the save ROW        6 — node/1 twice plus its dp mirror,
 *                                          and duplicate object ids
 * (repointing to wishlist_places alone scores 3 by the same arithmetic:
 * 'Community Spot' has no wishlist row at all.)
 *
 * Run:
 *   node --import tsx/esm --test src/test/mapSavedPlaceUnion.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import mapProjectionRouter, {
  _clearProtectedZoneCache,
  _clearFlowZoneCache,
} from "../routes/mapProjection.js";
import { makeFakeMapDb, startRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";
import { readSavedPlacePins } from "../lib/mapProducers/savedPlaceProducer.js";
import { _clearPlaceIdBridgeCache } from "../lib/placeIdBridge.js";
import { parseBbox } from "../lib/mapProjection.js";
import type { MapObject } from "../lib/mapObjects.js";
import type { BBox } from "../lib/mapAggregation.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

const VIEWER = "77777777-1111-4111-8111-777777777777";
const OTHER = "88888888-2222-4222-8222-888888888888";
const TOKEN = "saved-union-token";
const BBOX_STR = "108.0,15.9,108.4,16.2";
const BBOX: BBox = parseBbox(BBOX_STR) as BBox;

/** Inside the bbox. */
const IN = { lat: 16.0653, lng: 108.2455 };
/** Ho Chi Minh City — far outside it. */
const FAR = { lat: 10.7769, lng: 106.7009 };

const DP_OSM = "11111111-aaaa-4aaa-8aaa-111111111111";
const DP_COMM = "22222222-bbbb-4bbb-8bbb-222222222222";
/** A canonical public.places row with NO discovery_places mirror. */
const PLACES_ID = "33333333-cccc-4ccc-8ccc-333333333333";
/** A closed canonical place — saved, but the `place` layer hides it. */
const PLACES_CLOSED = "44444444-dddd-4ddd-8ddd-444444444444";
/** A hidden-gem id: a bare uuid in a space that bridges to nothing. */
const GEM_ID = "55555555-eeee-4eee-8eee-555555555555";
const CITY_ID = "66666666-ffff-4fff-8fff-666666666666";

function wish(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    user_id: VIEWER,
    place_id: "unset",
    place_data: {},
    list_id: "global",
    saved_at: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

function world(over: FakeState = {}): FakeState {
  return {
    // The table the producer used to read. Seeded EMPTY on purpose: it has no
    // writers in production, so a fixture that fills it is a fixture that
    // cannot fail.
    saved_places: [],

    discovery_places: [
      {
        id: DP_OSM, osm_id: "node/1", name: "Osm Bar", city: "Da Nang", neighborhood: "An Thuong",
        primary_category: "bar", lat: IN.lat, lng: IN.lng, canonical_location_id: null,
      },
      {
        id: DP_COMM, osm_id: null, name: "Community Spot", city: "Da Nang", neighborhood: null,
        primary_category: "cafe", lat: IN.lat + 0.001, lng: IN.lng + 0.001, canonical_location_id: null,
      },
    ],

    // The DiscoveryWall bookmark path. Writes NOTHING to wishlist_places.
    discovery_place_saves: [
      { user_id: VIEWER, place_id: DP_OSM, saved_at: "2026-09-02T00:00:00.000Z" },
      { user_id: VIEWER, place_id: DP_COMM, saved_at: "2026-09-03T00:00:00.000Z" },
      { user_id: OTHER, place_id: DP_COMM, saved_at: "2026-09-03T00:00:00.000Z" },
    ],

    places: [
      {
        id: PLACES_ID, name: "Canonical Cafe", primary_category: "cafe", city: "Da Nang",
        neighborhood: "Hai Chau", country_code: "VN", latitude: IN.lat + 0.002,
        longitude: IN.lng + 0.002, status: "active", merged_into_place_id: null,
      },
      {
        id: PLACES_CLOSED, name: "Shuttered Bar", primary_category: "bar", city: "Da Nang",
        neighborhood: null, country_code: "VN", latitude: IN.lat + 0.003,
        longitude: IN.lng + 0.003, status: "closed", merged_into_place_id: null,
      },
    ],

    // The TripWishlistPicker path — every save that is not a DiscoveryWall
    // bookmark, the Map's own long-press `save` included.
    wishlist_places: [
      // Same OSM venue saved to two trips: ONE pin, not two, and it is the same
      // venue discovery_place_saves already holds under DP_OSM — so the union
      // must collapse three rows into one.
      wish({ place_id: "node/1", list_id: "global", place_data: { name: "Osm Bar", lat: IN.lat, lng: IN.lng } }),
      wish({ place_id: "node/1", list_id: "trip-1", place_data: { name: "Osm Bar", lat: IN.lat, lng: IN.lng } }),
      // `db/<places.id>` with no discovery mirror: resolvable only against
      // public.places, whose coordinate columns are latitude/longitude.
      wish({
        place_id: `db/${PLACES_ID}`,
        place_data: { name: "Canonical Cafe", category: "cafe", lat: IN.lat + 0.002, lng: IN.lng + 0.002 },
      }),
      // A second `db/<uuid>` in the SAME bridge page — the id after the first
      // must not be silently dropped. Its place is closed, so the authoritative
      // read refuses it and the snapshot must NOT redraw it.
      wish({
        place_id: `db/${PLACES_CLOSED}`,
        place_data: { name: "Shuttered Bar", category: "bar", lat: IN.lat + 0.003, lng: IN.lng + 0.003 },
      }),
      // A hidden gem: bridges to nothing. Its only geometry is the snapshot.
      wish({ place_id: GEM_ID, place_data: { name: "Gem", category: "hidden_gem", lat: IN.lat - 0.001, lng: IN.lng - 0.001 } }),
      // A city save carries no exact point and must never become a pin.
      wish({ place_id: CITY_ID, place_data: { name: "Da Nang", category: "city", lat: null, lng: null } }),
      // Another user's save — the ONLY scoping is `.eq("user_id", viewer)`,
      // because the gateway holds a service client and RLS is off.
      // Drawable for ITS OWN owner (the second gateway case below proves that),
      // so its absence from the viewer's layer is scoping, not an accident of
      // an unresolvable fixture.
      wish({ user_id: OTHER, place_id: "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa", place_data: { name: "Other user place", category: "hidden_gem", lat: IN.lat, lng: IN.lng } }),
    ],

    feature_flags: [{ flag: "map_projection_enabled", enabled: true }],
    blocks: [],
    protected_zones: [],
    ...over,
  };
}

function titlesOf(objs: MapObject[]): Set<string> {
  return new Set(objs.map((o) => String(o.title)));
}

// ── through the gateway ───────────────────────────────────────────────────────

describe("the saved layer unions wishlist_places and discovery_place_saves", () => {
  let app: ProjectionApp | null = null;

  beforeEach(() => {
    _clearProtectedZoneCache();
    _clearFlowZoneCache();
    _clearPlaceIdBridgeCache();
  });
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  async function saved(state: FakeState, userId: string): Promise<{ body: any; objs: MapObject[] }> {
    app = await startRouterApp(mapProjectionRouter, state, { token: TOKEN, userId });
    const r = await app.projection(`bbox=${BBOX_STR}&zoom=14&kinds=saved_place`);
    assert.equal(r.status, 200);
    const objs = (r.body.objects as MapObject[]).filter((o) => o.kind === "saved_place");
    return { body: r.body, objs };
  }

  it("draws every venue the viewer actually saved, once each", async () => {
    const { body, objs } = await saved(world(), VIEWER);

    // (i) THE LOAD-BEARING ASSERTION. 0 today; 2 or 3 for either naive repoint;
    // 6 for an un-deduped union.
    assert.equal(
      objs.length,
      4,
      `expected 4 saved venues, got ${objs.length}: ${[...titlesOf(objs)].join(", ")}`,
    );

    // (ii) each one names the path that produced it.
    assert.deepEqual(
      titlesOf(objs),
      new Set(["Osm Bar", "Community Spot", "Canonical Cafe", "Gem"]),
    );

    // (iii) what must NOT be there, named rather than counted.
    const t = titlesOf(objs);
    assert.ok(!t.has("Other user place"), "another user's save reached the viewer");
    assert.ok(!t.has("Da Nang"), "a city save became a pin");
    assert.ok(!t.has("Shuttered Bar"), "a closed place was redrawn from its client snapshot");
    const wire = JSON.stringify(body);
    assert.ok(!wire.includes(OTHER), "another user's id reached the wire");

    // (iv) PASSES ON THE BROKEN CODE — deliberately. It fails only for a fix
    // that degrades into a refusal, which would otherwise look like today.
    assert.equal(body.producers.saved_place.refusal, null);
    assert.equal(body.producers.saved_place.collected, 4);
    assert.ok(body.sources.includes("saved"));

    // (v) one pin per venue: the row-keyed form of the dedup bug also produces
    // duplicate object ids.
    assert.equal(new Set(objs.map((o) => o.id)).size, objs.length);
  });

  it("the OSM venue arrives ONCE, though it was saved through both tables and two lists", async () => {
    const { objs } = await saved(world(), VIEWER);
    assert.equal(objs.filter((o) => o.title === "Osm Bar").length, 1);
  });

  it("another viewer sees their own list, not this one", async () => {
    const { objs } = await saved(world(), OTHER);
    assert.deepEqual(titlesOf(objs), new Set(["Community Spot", "Other user place"]));
  });
});

// ── the read, directly ────────────────────────────────────────────────────────

function client(state: FakeState) {
  return makeFakeMapDb(state, { token: TOKEN, userId: VIEWER });
}

describe("readSavedPlacePins — union, provenance and refusals", () => {
  beforeEach(() => _clearPlaceIdBridgeCache());

  it("reports which table drew each pin, so the layer is measurable not assumed", async () => {
    const r = await readSavedPlacePins(client(world()), VIEWER, { bbox: BBOX });
    assert.ok(r.ok);
    if (!r.ok) return;

    assert.equal(r.pins.length, 4);
    assert.equal(r.report.saved, 6, "6 distinct venues: 4 drawable, the closed place, the city");
    assert.equal(r.report.unplaced, 2, "the closed canonical place and the city");
    assert.equal(r.report.fromSnapshot, 1, "only the gem has no authoritative row");
    assert.equal(r.report.wishlist, 6);
    assert.equal(r.report.discoverySaves, 2);
    assert.ok(r.report.deduped >= 2, "node/1 twice plus its discovery_place_saves mirror");

    const sources = new Map(
      r.pins.map((p) => [String(p.title), (p.payload as { geometrySource: string }).geometrySource]),
    );
    assert.equal(sources.get("Osm Bar"), "discovery_places");
    assert.equal(sources.get("Community Spot"), "discovery_places");
    assert.equal(sources.get("Canonical Cafe"), "places");
    assert.equal(sources.get("Gem"), "snapshot");
  });

  it("a canonical save carries public.places as its live-claim subject", async () => {
    const r = await readSavedPlacePins(client(world()), VIEWER, { bbox: BBOX });
    assert.ok(r.ok);
    if (!r.ok) return;
    const cafe = r.pins.find((p) => p.title === "Canonical Cafe");
    assert.ok(cafe);
    assert.equal((cafe!.payload as { canonicalPlaceId: string | null }).canonicalPlaceId, PLACES_ID);
    // The sheet opens on the SERVED id, not a bare uuid.
    assert.equal(cafe!.interaction?.detailRoute, `/place/${encodeURIComponent(`db/${PLACES_ID}`)}`);
    // An unbridgeable save has no canonical subject to attach a live claim to.
    const gem = r.pins.find((p) => p.title === "Gem");
    assert.equal((gem!.payload as { canonicalPlaceId: string | null }).canonicalPlaceId, null);
  });

  it("is viewport-scoped on every geometry source, snapshots included", async () => {
    const r = await readSavedPlacePins(
      client(
        world({
          discovery_places: [
            { id: DP_OSM, osm_id: "node/1", name: "Osm Bar", city: null, neighborhood: null, primary_category: null, lat: FAR.lat, lng: FAR.lng, canonical_location_id: null },
            { id: DP_COMM, osm_id: null, name: "Community Spot", city: null, neighborhood: null, primary_category: null, lat: FAR.lat, lng: FAR.lng, canonical_location_id: null },
          ],
          places: [
            { id: PLACES_ID, name: "Canonical Cafe", primary_category: null, city: null, neighborhood: null, country_code: "VN", latitude: FAR.lat, longitude: FAR.lng, status: "active", merged_into_place_id: null },
          ],
          wishlist_places: [
            wish({ place_id: GEM_ID, place_data: { name: "Gem", category: "hidden_gem", lat: FAR.lat, lng: FAR.lng } }),
            wish({ place_id: `db/${PLACES_ID}`, place_data: { name: "Canonical Cafe", lat: FAR.lat, lng: FAR.lng } }),
          ],
        }),
      ),
      VIEWER,
      { bbox: BBOX },
    );
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.pins.length, 0);
    assert.ok(r.report.unplaced > 0);
  });

  it("each read failure is its OWN refusal — never an empty layer", async () => {
    const a = await readSavedPlacePins(client(world({ wishlist_places: { error: { message: "down" } } })), VIEWER, { bbox: BBOX });
    assert.deepEqual(a, { ok: false, reason: "wishlist_read_failed" });

    const b = await readSavedPlacePins(client(world({ discovery_place_saves: { error: { message: "down" } } })), VIEWER, { bbox: BBOX });
    assert.deepEqual(b, { ok: false, reason: "saved_read_failed" });

    const c = await readSavedPlacePins(client(world({ discovery_places: { error: { message: "down" } } })), VIEWER, { bbox: BBOX });
    assert.deepEqual(c, { ok: false, reason: "places_read_failed" });

    // The canonical read is the one that 42703s if `lat`/`lng` are used against
    // public.places. It must refuse, not quietly drop 'Canonical Cafe'.
    const d = await readSavedPlacePins(client(world({ places: { error: { message: "42703" } } })), VIEWER, { bbox: BBOX });
    assert.deepEqual(d, { ok: false, reason: "places_read_failed" });
  });

  it("neither save table is dropped when the other is empty", async () => {
    const onlyWishlist = await readSavedPlacePins(
      client(world({ discovery_place_saves: [] })),
      VIEWER,
      { bbox: BBOX },
    );
    assert.ok(onlyWishlist.ok);
    if (!onlyWishlist.ok) return;
    assert.deepEqual(titlesOf(onlyWishlist.pins), new Set(["Osm Bar", "Canonical Cafe", "Gem"]));

    const onlyDiscovery = await readSavedPlacePins(
      client(world({ wishlist_places: [] })),
      VIEWER,
      { bbox: BBOX },
    );
    assert.ok(onlyDiscovery.ok);
    if (!onlyDiscovery.ok) return;
    assert.deepEqual(titlesOf(onlyDiscovery.pins), new Set(["Osm Bar", "Community Spot"]));
  });

  it("no saves at all is an empty layer, not a refusal", async () => {
    const r = await readSavedPlacePins(
      client(world({ wishlist_places: [], discovery_place_saves: [] })),
      VIEWER,
      { bbox: BBOX },
    );
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.pins, []);
    assert.equal(r.report.saved, 0);
  });
});
