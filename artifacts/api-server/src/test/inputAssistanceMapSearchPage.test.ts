/**
 * inputAssistanceMapSearchPage — census-discovery §80 (lane W10-S1).
 *
 * A08 reason 3 (register D-W10-S1-5): the Map search sheet moves onto the input
 * gateway as the `map.search` field of `global_search`, and must show THE SAME
 * ROWS and THE SAME NOTICES it showed when it called `GET /discovery/search`
 * twice per keystroke (`type=all` and `type=saved`).
 *
 * DV-83 (register D-W10-S1-2): the gateway envelope carries coverage in the
 * Discovery refusal vocabulary instead of answering a failed read with the body
 * of an empty one.
 *
 * B04 (register D-W10-S1-3): the §24 protected-zone pass decides the gateway's
 * candidates too, behind the same flag, and is an identity with the flag off.
 *
 *   E   equivalence — the route and the gateway page over one world, every
 *       query shape the route distinguishes, healthy and degraded: the same
 *       rows (type, id, title, the display fields and the geometry the Map's
 *       adapter reads) and the same coverage (class, code, coverage,
 *       failedSources) per lane;
 *   P   the projection carries only what the Map reads;
 *   Z   protection with the flag ON, on the page and on the typeahead;
 *   C   the typeahead's coverage on the envelope;
 *   I   identity: no refusal key on a complete serve, and `generateSuggestions`
 *       unchanged by the coverage sink.
 *
 * Run: node --import tsx/esm --test src/test/inputAssistanceMapSearchPage.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import discoverySearchRouter, { invalidateBuddyLaunchGateCache } from "../routes/discoverySearch.js";
import inputAssistanceRouter from "../routes/inputAssistance.js";
import {
  DISCOVERY_SEARCH_PROTECTION_FLAG,
  invalidateSearchProtectionFlagCache,
} from "../lib/discoverySearchProtection.js";
import { clearProtectedZoneCache } from "../lib/protectedZoneStore.js";
import { invalidateDiscoveryTripProjectionFlagCache } from "../lib/discoveryTripProjectionConsumer.js";
import { generateSuggestions, newGatewayCoverage } from "../lib/inputAssistance/gateway.js";
import { resolvePolicy } from "../lib/inputAssistance/policyRegistry.js";
import { MAP_SEARCH_FIELD_ID } from "../lib/inputAssistance/searchPage.js";
import {
  VIEWER,
  VIEWER_TOKEN,
  emptyCalls,
  emptyState,
  installKit,
  kitGet,
  makeKitClient,
  settle,
  startKitServer,
  type KitState,
} from "./discoverySearchTestKit.js";

const ALICE = "c1000000-0000-4000-a000-000000000001";
const BOB = "c2000000-0000-4000-a000-000000000002"; // blocked by the viewer
const HAL = "c4000000-0000-4000-a000-000000000004";
const FUTURE = "2026-10-20T18:00:00.000Z";

const SHELTER_C = { lat: 38.7200, lng: -9.1300 };
const CLINIC_C = { lat: 38.7400, lng: -9.1500 };

function world(): Partial<KitState> {
  const cast = [
    { key: "alice", id: ALICE },
    { key: "bob", id: BOB },
    { key: "hal", id: HAL },
  ];
  const profiles = [
    { id: VIEWER, handle: "viewer", username: "viewer", name: "Viewer", display_name: null, avatar_url: null,
      is_private: false, home_city: "Lisbon", home_country: "Portugal", account_status: "active", verified: false,
      is_official: false, show_profile_picture_publicly: true, buddy_verified_at: null },
    ...cast.map((c) => ({
      id: c.id, handle: `zork_${c.key}`, username: `zork_${c.key}`, name: `Zork ${c.key}`, display_name: null,
      avatar_url: null, is_private: false, home_city: "Lisbon", home_country: "Portugal", account_status: "active",
      verified: c.key === "hal", is_official: false, show_profile_picture_publicly: true,
      buddy_verified_at: "2026-01-01T00:00:00Z",
    })),
  ];
  const place = (id: string, name: string, p: { lat: number; lng: number }, extra: Record<string, unknown> = {}) => ({
    id, name, city: "Lisbon", blurb: null, image_url: null, header_image_source: null, image_source_type: null,
    image_accuracy_status: null, category: "food", primary_category: "food", lat: p.lat, lng: p.lng,
    canonical_location_id: null, created_at: "2026-01-01T00:00:00Z", submitted_by: null, status: "active",
    saved_count: 0, ...extra,
  });
  return {
    rows: {
      profiles,
      blocks: [{ blocker_id: VIEWER, blocked_id: BOB }],
      user_privacy_settings: [], profile_privacy_settings: [], user_follows: [], friend_requests: [],
      user_friendships: [], event_rsvps: [],
      events: cast.map((c) => ({
        id: `event-${c.key}`, title: `zork event ${c.key}`, host_id: c.id, cover_url: null, city: "Lisbon",
        country: "PT", starts_at: FUTURE, visibility: "public", state: "open", created_at: "2026-01-01T00:00:00Z",
        location_lat: 38.71, location_lng: -9.12, show_exact_location: true, verified: false,
      })),
      trips: cast.map((c) => ({
        id: `trip-${c.key}`, title: `zork trip ${c.key}`, destination_city: "Lisbon", destination_country: "PT",
        owner_id: c.id, cover_url: null, start_date: FUTURE.slice(0, 10), status: "upcoming", visibility: "public",
        show_in_discovery: true, created_at: "2026-01-01T00:00:00Z",
      })),
      trip_plan_items: [],
      hidden_gems: cast.map((c) => ({
        id: `gem-${c.key}`, name: `zork gem ${c.key}`, city: "Lisbon", country: "PT", submitted_by: c.id,
        category: "food", status: "active", created_at: "2026-01-01T00:00:00Z", sensitivity_level: "approximate",
        approx_latitude: 38.71, approx_longitude: -9.14,
      })),
      posts: cast.map((c) => ({
        id: `post-${c.key}`, content: `zork post ${c.key}`, author_id: c.id, media_urls: [],
        created_at: "2026-01-01T00:00:00Z", like_count: 1, post_status: "published", visibility: "public", status: "active",
      })),
      circles: cast.map((c) => ({
        id: `circle-${c.key}`, name: `zork circle ${c.key}`, description: null, owner_id: c.id,
        cover_image_url: null, city: "Lisbon", visibility: "public", created_at: "2026-01-01T00:00:00Z",
      })),
      discovery_places: [
        place("place-shelter", "zork shelter cafe", { lat: 38.72005, lng: -9.13005 }),
        place("place-clinic", "zork clinic kiosk", { lat: 38.74003, lng: -9.15002 }),
        place("place-out", "zork harbour bar", { lat: 38.76, lng: -9.2 }, { submitted_by: ALICE }),
      ],
      hashtags: [
        { id: "tag-1", slug: "zorkfood", name: "zorkfood", usage_count: 12, created_at: "2026-01-01T00:00:00Z", is_blocked: false },
      ],
      stamp_definitions: [],
      canonical_locations: [
        { id: "cl-lisbon", kind: "city", name: "Lisbon", normalized_name: "lisbon", search_key: "lisbon",
          display_name: "Lisbon, Portugal", city: "Lisbon", region: "Lisboa", country: "Portugal", country_code: "PT",
          lat: 38.72, lng: -9.14, population: 500000 },
      ],
      wishlist_places: [
        { user_id: VIEWER, place_id: "place-out", saved_at: "2026-02-01T00:00:00Z",
          place_data: { name: "zork harbour bar", city: "Lisbon", lat: 38.76, lng: -9.2 } },
      ],
      discovery_place_saves: [{ user_id: VIEWER, place_id: "place-clinic", saved_at: "2026-03-01T00:00:00Z" }],
      rent_buddy_profiles: [],
    },
  };
}

const zoneRow = (z: { id: string; category: string; lat: number; lng: number; r: number }) => ({
  id: z.id, category: z.category, action: null, privacy_floor: null, shape: "circle",
  center_lat: z.lat, center_lng: z.lng, radius_meters: z.r, ring: null, jurisdiction: null, policy_ref: null, active: true,
});
const SHELTER_ROW = zoneRow({ id: "z-shelter", category: "shelter", ...SHELTER_C, r: 60 });
const CLINIC_ROW = zoneRow({ id: "z-clinic", category: "medical_facility", ...CLINIC_C, r: 80 });

let base = "";
let server: Server;
before(async () => { ({ base, server } = await startKitServer([discoverySearchRouter, inputAssistanceRouter])); });
after(() => server.close());
beforeEach(() => {
  clearProtectedZoneCache();
  invalidateSearchProtectionFlagCache();
  invalidateBuddyLaunchGateCache();
  invalidateDiscoveryTripProjectionFlagCache();
});

function fresh(over: Partial<KitState>) {
  clearProtectedZoneCache();
  invalidateSearchProtectionFlagCache();
  invalidateBuddyLaunchGateCache();
  invalidateDiscoveryTripProjectionFlagCache();
  return installKit(over);
}

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${VIEWER_TOKEN}` },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

const GEOMETRY = ["lat", "lng", "coordsPrecision", "savedKind", "bounds"];

/** What the Map's adapter reads off one route row. */
function routeRow(r: any) {
  const md = r.metadata ?? null;
  return {
    type: r.type, id: r.id, title: r.title, subtitle: r.subtitle ?? null, locationPreview: r.locationPreview ?? null,
    destinationRoute: r.destinationRoute ?? null, startsAt: r.startsAt ?? null,
    metadata: md ? Object.fromEntries(Object.entries(md).filter(([k]) => GEOMETRY.includes(k))) : null,
  };
}
/** The same, off one gateway row. */
function gatewayRow(s: any) {
  const m = s.mapResult;
  return {
    type: m.serverType, id: s.entityId, title: s.label, subtitle: m.subtitle, locationPreview: m.locationPreview,
    destinationRoute: m.destinationRoute, startsAt: m.startsAt, metadata: m.metadata,
  };
}
const coverageOf = (r: any) =>
  r ? { class: r.class, code: r.code, coverage: r.coverage, failedSources: r.failedSources ?? null } : null;

interface Shape { name: string; q: string; qs?: string; body?: Record<string, unknown>; over?: (w: Partial<KitState>) => Partial<KitState> }

const SHAPES: Shape[] = [
  { name: "plain", q: "zork" },
  { name: "@handle", q: "@zork_alice" },
  { name: "nearby with a position", q: "zork nearby", qs: "&lat=38.72&lng=-9.13&city=Lisbon", body: { lat: 38.72, lng: -9.13, city: "Lisbon" } },
  { name: "a time intent", q: "zork next week", qs: "&tz=Europe%2FLisbon", body: { tz: "Europe/Lisbon" } },
  { name: "an emoji in the query (D-W10-S1-1)", q: "🔥 zork" },
  { name: "an alias", q: "zork lisboa" },
  { name: "a fan-out bucket unreadable", q: "zork", over: (w) => ({ ...w, errorTables: { hashtags: { code: "08006", message: "connection failure" } } }) },
  { name: "a fan-out bucket rejecting", q: "zork", over: (w) => ({ ...w, throwTables: new Set(["circles"]) }) },
  { name: "one saved table unreadable", q: "zork", over: (w) => ({ ...w, errorTables: { wishlist_places: { code: "08006", message: "connection failure" } } }) },
  { name: "both saved tables unreadable", q: "zork", over: (w) => ({ ...w, errorTables: { wishlist_places: { code: "08006", message: "x" }, discovery_place_saves: { code: "08006", message: "x" } } }) },
  { name: "the block state unreadable", q: "zork", over: (w) => ({ ...w, errorTables: { blocks: { code: "08006", message: "connection failure" } } }) },
];

describe("E — the gateway's map page serves the route's rows and the route's coverage", () => {
  for (const shape of SHAPES) {
    it(`E: ${shape.name}`, async () => {
      const w = shape.over ? shape.over(world()) : world();
      const enc = encodeURIComponent(shape.q);
      fresh(w);
      const all = await kitGet(base, `/discovery/search?q=${enc}&type=all${shape.qs ?? ""}`);
      await settle();
      fresh(w);
      const saved = await kitGet(base, `/discovery/search?q=${enc}&type=saved${shape.qs ?? ""}`);
      await settle();
      fresh(w);
      const gw = await post("/input-assistance/suggest", {
        context: "global_search", fieldId: MAP_SEARCH_FIELD_ID, text: shape.q, ...(shape.body ?? {}),
      });
      assert.equal(all.status, 200);
      assert.equal(saved.status, 200);
      assert.equal(gw.status, 200);

      const want = [...(all.body.results ?? []), ...(saved.body.results ?? [])].map(routeRow);
      const got = (gw.body.suggestions as any[]).map(gatewayRow);
      assert.deepEqual(got, want, "the rows differ");
      assert.deepEqual(coverageOf(gw.body.refusal), coverageOf(all.body.refusal), "the fan-out's coverage differs");
      assert.deepEqual(coverageOf(gw.body.laneRefusals?.saved), coverageOf(saved.body.refusal), "the saved lane's coverage differs");
      if (gw.body.refusal) assert.equal(gw.body.refusal.route, "POST /input-assistance/suggest");
    });
  }

  it("E: the world is not vacuous — the plain query serves places, events, trips, gems, people and both saves", async () => {
    fresh(world());
    const gw = await post("/input-assistance/suggest", { context: "global_search", fieldId: MAP_SEARCH_FIELD_ID, text: "zork" });
    const types = new Set((gw.body.suggestions as any[]).map((s) => s.mapResult.serverType));
    for (const t of ["places", "events", "trips", "hidden_gems", "travelers", "saved"]) assert.ok(types.has(t), `no ${t} row`);
    const ids = (gw.body.suggestions as any[]).map((s) => s.entityId);
    assert.ok(!ids.includes("event-bob") && !ids.includes("trip-bob"), "control: a blocked owner's rows are not served");
    assert.equal(gw.body.refusal, undefined);
    assert.equal(gw.body.laneRefusals, undefined);
  });

  it("E: nothing searchable — the route's 400 is the gateway's validation refusal on both lanes", async () => {
    for (const q of ["🔥", "(("]) {
      fresh(world());
      const all = await kitGet(base, `/discovery/search?q=${encodeURIComponent(q)}&type=all`);
      assert.equal(all.status, 400);
      fresh(world());
      const gw = await post("/input-assistance/suggest", { context: "global_search", fieldId: MAP_SEARCH_FIELD_ID, text: q });
      assert.deepEqual(gw.body.suggestions, []);
      assert.equal(gw.body.refusal?.class, "validation");
      assert.equal(gw.body.refusal?.code, "query_too_short");
      assert.equal(gw.body.laneRefusals?.saved?.code, "query_too_short");
    }
  });

  it("E: the route's catch arm sends a refusal, not an empty answer (static: nothing in the serve path is left to throw)", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../routes/inputAssistance.ts", import.meta.url), "utf8");
    const catchArm = src.slice(src.indexOf("'input-assistance/suggest failed'"));
    assert.match(catchArm.slice(0, 900), /suggestions: \[\], refusal: gatewayFailureRefusal\(\)/);
    const { gatewayFailureRefusal } = await import("../lib/inputAssistance/gateway.js");
    assert.deepEqual(gatewayFailureRefusal(), {
      class: "transient_db", code: "suggest_failed", route: "POST /input-assistance/suggest", coverage: "nothing",
    });
  });
});

describe("P — the projection carries only what the Map reads", () => {
  it("P1: mapResult.metadata holds geometry keys only, and every row is an open_entity suggestion", async () => {
    fresh(world());
    const gw = await post("/input-assistance/suggest", { context: "global_search", fieldId: MAP_SEARCH_FIELD_ID, text: "zork" });
    assert.ok(gw.body.suggestions.length > 5);
    for (const s of gw.body.suggestions as any[]) {
      for (const k of Object.keys(s.mapResult.metadata ?? {})) assert.ok(GEOMETRY.includes(k), `${s.id}: metadata.${k} reached the wire`);
      assert.equal(s.type, "entity");
      assert.equal(s.action?.type, "open_entity");
      assert.ok(!("metadata" in s), "the raw metadata bag reached the suggestion");
    }
    const gem = (gw.body.suggestions as any[]).find((s) => s.mapResult.serverType === "hidden_gems");
    assert.equal(gem.mapResult.metadata.coordsPrecision, "approximate", "a gem carries its approximate pair only");
  });

  it("P2: another global_search field keeps the typeahead — no mapResult, the policy's cap", async () => {
    fresh(world());
    const gw = await post("/input-assistance/suggest", { context: "global_search", text: "zork" });
    assert.ok(gw.body.suggestions.length > 0);
    assert.ok((gw.body.suggestions as any[]).every((s) => !("mapResult" in s)));
    assert.ok(gw.body.suggestions.length <= resolvePolicy("global_search")!.maxSuggestions);
  });
});

describe("Z — the §24 pass with the flag ON (controlled data)", () => {
  const on = (zones: any[] | "error") => {
    const w = world();
    const state: Partial<KitState> = { ...w, flags: { [DISCOVERY_SEARCH_PROTECTION_FLAG]: true } };
    if (Array.isArray(zones)) state.rows = { ...w.rows!, protected_zones: zones };
    else state.errorTables = { protected_zones: { code: "57014", message: "canceling statement due to statement timeout" } };
    return state;
  };

  it("Z1: map page — the shelter is not served, the clinic is coarsened, the rest untouched; the route agrees", async () => {
    const w = on([SHELTER_ROW, CLINIC_ROW]);
    fresh(w);
    const gw = await post("/input-assistance/suggest", { context: "global_search", fieldId: MAP_SEARCH_FIELD_ID, text: "zork" });
    const byId = new Map((gw.body.suggestions as any[]).map((s) => [`${s.mapResult.serverType}:${s.entityId}`, s]));
    assert.ok(!byId.has("places:place-shelter"), "a place inside a shelter zone was served");
    const clinic = byId.get("places:place-clinic");
    assert.equal(clinic.mapResult.metadata.coordsPrecision, "approximate");
    assert.ok(Math.abs(clinic.mapResult.metadata.lat - CLINIC_C.lat) < 1e-9 && Math.abs(clinic.mapResult.metadata.lng - CLINIC_C.lng) < 1e-9, "the clinic is snapped to its zone's anchor");
    const out = byId.get("places:place-out");
    assert.deepEqual([out.mapResult.metadata.lat, out.mapResult.metadata.lng], [38.76, -9.2]);
    fresh(w);
    const all = await kitGet(base, "/discovery/search?q=zork&type=all");
    fresh(w);
    const saved = await kitGet(base, "/discovery/search?q=zork&type=saved");
    assert.deepEqual(
      (gw.body.suggestions as any[]).map(gatewayRow),
      [...all.body.results, ...saved.body.results].map(routeRow),
    );
  });

  it("Z2: map page — the policy unreadable: positions withheld, rows kept (never an empty search)", async () => {
    fresh(on("error"));
    const gw = await post("/input-assistance/suggest", { context: "global_search", fieldId: MAP_SEARCH_FIELD_ID, text: "zork" });
    const places = (gw.body.suggestions as any[]).filter((s) => s.mapResult.serverType === "places");
    assert.equal(places.length, 3);
    for (const p of places) {
      assert.equal(p.mapResult.metadata.lat, null);
      assert.equal(p.mapResult.metadata.coordsPrecision, "hidden");
    }
  });

  it("Z3: typeahead — a place inside a suppress zone is not suggested BY NAME (§46.4's gap)", async () => {
    fresh(on([SHELTER_ROW]));
    const gw = await post("/input-assistance/suggest", { context: "global_search", text: "zork" });
    const ids = (gw.body.suggestions as any[]).map((s) => s.entityId);
    assert.ok(!ids.includes("place-shelter"), "the shelter place was suggested by name");
    assert.ok(ids.includes("place-clinic"), "control: a place outside every suppress zone is still suggested");
  });

  it("Z4: typeahead with the flag OFF — the shelter place IS suggested and protected_zones is never read", async () => {
    const { calls } = fresh({ ...world(), rows: { ...world().rows!, protected_zones: [SHELTER_ROW] }, flags: { [DISCOVERY_SEARCH_PROTECTION_FLAG]: false } });
    const gw = await post("/input-assistance/suggest", { context: "global_search", text: "zork" });
    assert.ok((gw.body.suggestions as any[]).some((s) => s.entityId === "place-shelter"));
    assert.equal(calls.tables.filter((t) => t === "protected_zones").length, 0);
  });

  it("Z5: place_picker with the flag ON — the shelter place is not offered", async () => {
    fresh(on([SHELTER_ROW]));
    const gw = await post("/input-assistance/suggest", { context: "place_picker", text: "zork" });
    const ids = (gw.body.suggestions as any[]).map((s) => s.entityId);
    assert.ok(!ids.includes("place-shelter"));
    assert.ok(ids.includes("place-out"));
  });
});

describe("C — the typeahead's coverage rides the envelope", () => {
  it("C1: the block state unreadable — refusal nothing / visibility_state_unreadable, no entity row", async () => {
    fresh({ ...world(), errorTables: { blocks: { code: "08006", message: "connection failure" } } });
    const gw = await post("/input-assistance/suggest", { context: "global_search", text: "zork" });
    assert.equal(gw.body.refusal?.code, "visibility_state_unreadable");
    assert.equal(gw.body.refusal?.coverage, "nothing");
    assert.ok((gw.body.suggestions as any[]).every((s) => s.type !== "entity"));
  });

  it("C2: one type unreadable — refusal partial naming it, and the other types' rows are served", async () => {
    fresh({ ...world(), errorTables: { circles: { code: "08006", message: "connection failure" } } });
    const gw = await post("/input-assistance/suggest", { context: "global_search", text: "zork" });
    assert.equal(gw.body.refusal?.coverage, "partial");
    assert.deepEqual(gw.body.refusal?.failedSources, ["circles"]);
    assert.ok((gw.body.suggestions as any[]).some((s) => s.type === "entity"));
  });

  it("C3: place_picker with the block state unreadable says so too", async () => {
    fresh({ ...world(), errorTables: { blocks: { code: "08006", message: "connection failure" } } });
    const gw = await post("/input-assistance/suggest", { context: "place_picker", text: "zork" });
    assert.equal(gw.body.refusal?.code, "visibility_state_unreadable");
  });
});

describe("I — identity where nothing failed", () => {
  it("I1: a complete typeahead serve carries no refusal key", async () => {
    fresh(world());
    const gw = await post("/input-assistance/suggest", { context: "global_search", text: "zork" });
    assert.ok(!("refusal" in gw.body));
    assert.ok(!("laneRefusals" in gw.body));
  });

  it("I2: generateSuggestions returns the same suggestions with and without the coverage sink", async () => {
    for (const context of ["global_search", "place_picker", "city_picker", "hashtag"] as const) {
      const text = context === "city_picker" ? "lis" : context === "hashtag" ? "#zork" : "zork";
      const run = async (withSink: boolean) => {
        invalidateBuddyLaunchGateCache();
        invalidateSearchProtectionFlagCache();
        const sc = makeKitClient(emptyState(world()), emptyCalls());
        const policy = resolvePolicy(context)!;
        return generateSuggestions(sc, {
          context, policy, text, userId: VIEWER, limit: policy.maxSuggestions, lat: 38.72, lng: -9.13, city: "Lisbon",
          ...(withSink ? { coverage: newGatewayCoverage() } : {}),
        });
      };
      assert.deepEqual(await run(true), await run(false), context);
    }
  });
});
