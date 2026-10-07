/**
 * census-trips §81 — ONE owner-only rule on EVERY reader of a plan item's
 * location (verifier finding 2, 2026-10-05).
 *
 * THE DEFECT. At `85bb3c5339` the owner-only rule (TR256) was applied to the
 * map projection's `privateAnchors` layer and nowhere else. Every sibling path
 * that reads `trip_plan_items` — the route chain, Pulse, Today, the timeline,
 * the Telegraph trip context, closeout, the impact preview, the meeting point,
 * the offline bundle, the route-plan stay, the plan list and plan map, the
 * feasibility check, the memory candidates, the daily brief, the Neighbourhoods
 * location check, the trip's Hidden Gems and the Compass trip context — served
 * another member's private place (coordinates, place name, title, notes, or a
 * value derived from them) to every accepted member, the organizer included.
 *
 * THE RULE (LEAD'S READING, for the owner to confirm — OD-TRIP-3 says "access",
 * not which fields): a viewer who is neither the item's creator nor the holder
 * of a grant still true receives the item's TIME WINDOW and a neutral label
 * ("Private plan"), and no coordinate, address, place id, location name, title
 * or notes. A value DERIVED from those (a distance, a centre of gravity, a
 * location band, a linked gem) is withheld with them.
 *
 * WHAT IS ASSERTED, per path, through the real routes over the certification
 * harness (the response the client receives):
 *   0. CONTROL — the item's creator sees it (the path really carries it; a
 *      test that cannot see the place when it should proves nothing);
 *   1. a crew member with no grant does not;
 *   2. the trip's ORGANIZER does not;
 *   3. a member granted it, sharing ON, does;
 *   4. the same member, sharing OFF, does not;
 *   5. the same member, sharing ON, grant list UNREADABLE, does not.
 *
 * SHOWN RED at `85bb3c5339` (this file run against that tree): 76 of 122 fail.
 * Cases 1, 2, 4 and 5 fail on every path except `map-projection` (wave 1's
 * fix). daily-brief 6 and 7 fail too. `plan-map` (GET /trips/:id/plan/map) is
 * asserted separately below: it is a public-coordinates-only surface by design
 * and shows no private place to anyone, its creator included; what was wrong
 * there was narrower — it read `!location_is_private`, so a row with privacy
 * UNSET (null) was drawn as public. Each path's mutation — that path's own call to the
 * rule replaced by the raw rows — is applied alone and turns that path's cases
 * 1, 2, 4 and 5 red (census-trips §81 lists each mutation and its result).
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/tripPrivateAnchorReaders.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { readFileSync, readdirSync } from "node:fs";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import tripProjectionsRouter from "../server/trips/readRoutes/tripProjections.js";
import tripOfflineRouter from "../routes/tripOffline.js";
import routePlanRouter from "../routes/routePlan.js";
import tripCommandRouter from "../server/trips/commandRoute.js";
import telegraphSharedContextRouter from "../routes/telegraphSharedContext.js";
import tripsRouter from "../routes/trips.js";
import tripFeasibilityRouter from "../routes/tripFeasibility.js";
import tripPostTripRouter from "../routes/tripPostTrip.js";
import dailyBriefRouter from "../routes/dailyBrief.js";
import neighborhoodsRouter from "../routes/neighborhoods.js";
import hiddenGemsRouter from "../routes/hiddenGems.js";
import { resolveGemCoords } from "../services/hiddenGems/HiddenGemPrivacyGuard.js";
import { makeFakeClient, startRouter, call, type RouterHarness, type FakeDbOptions } from "./telegraphCertificationHarness.js";

const ORGANIZER = "11111111-0000-4000-8000-000000000001";
const ANA = "22222222-0000-4000-8000-000000000002";   // adds a private stay
const BEN = "33333333-0000-4000-8000-000000000003";   // Ana grants him sight of it
const CLEO = "44444444-0000-4000-8000-000000000004";  // a crew member with no grant
const TRIP = "aaaaaaaa-0000-4000-8000-00000000000a";
const HOTEL = "bbbbbbbb-0000-4000-8000-00000000000b";
const DINNER = "cccccccc-0000-4000-8000-00000000000c";
const STAGE = "eeeeeeee-0000-4000-8000-00000000000e";
const PORTO = "ffffffff-0000-4000-8000-00000000000f";
const GEM = "99999999-0000-4000-8000-000000000099";
const ANA_ROUTE = "dddddddd-0000-4000-8000-0000000000a0"; // Ana's route plan (§86)
const TRIP_THREAD = "7e7e7e7e-0000-4000-8000-00000000007e"; // the trip's Telegraph thread (R1)
const GEM_AUTHOR = "55555555-0000-4000-8000-000000000005"; // submitted the gem; not on the trip

const HOTEL_LAT = 38.70417;
const DINNER_LAT = 38.71;
/** Every value of Ana's private stay, and the gem it links. Any of them in a response is the place. */
const SECRET = /Casa Segreta|Rua do Segredo|door code 4471|ChIJ-secret-place|38\.70417|-9\.13853|99999999-0000-4000-8000-000000000099|Segreta Gem|Vila Segreta|suite over the garden/; // D-65: the town and the description too

const iso = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const dayOff = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

type Rows = Array<Record<string, unknown>>;
type Scenario = "on" | "off" | "unread";

function seed(viewer: string, scenario: Scenario, hotelOver: Record<string, unknown> = {}): Record<string, Rows> {
  const flags: Rows = [
    { flag: "trip_operational_projections_enabled", enabled: true },
    { flag: "hidden_gems_enabled", enabled: true },
  ];
  if (scenario !== "off") flags.push({ flag: "trip_private_anchor_sharing_enabled", enabled: true });
  return {
    feature_flags: flags,
    trips: [{ id: TRIP, owner_id: ORGANIZER, version: 3, title: "Lisbon", destination: "Lisbon", destination_city: "Lisbon", city: "Lisbon",
      start_date: dayOff(-1), end_date: dayOff(3), status: "active", created_at: "2026-10-01T00:00:00Z" }],
    trip_members: [ORGANIZER, ANA, BEN, CLEO].map((u) => ({ trip_id: TRIP, user_id: u, role: u === ORGANIZER ? "owner" : "member", status: "accepted" })),
    trip_plan_items: [
      { id: HOTEL, trip_id: TRIP, creator_id: ANA, title: "Casa Segreta", category: "accommodation", status: "in_progress",
        lat: HOTEL_LAT, lng: -9.13853, location_is_private: true, location_name: "Rua do Segredo 7", notes: "door code 4471",
        place_id: "ChIJ-secret-place", source_type: "hidden_gem", source_id: GEM, stage_id: STAGE, day_date: dayOff(0), city: "Vila Segreta", description: "suite over the garden",
        starts_at: iso(-1), ends_at: iso(2), sort_order: 1, removed_at: null, created_at: "2026-10-01T00:00:00Z", ...hotelOver },
      { id: DINNER, trip_id: TRIP, creator_id: BEN, title: "Dinner", category: "food", status: "planned", lat: DINNER_LAT, lng: -9.14,
        location_is_private: false, location_name: "Praca", notes: null, day_date: dayOff(0), starts_at: iso(3), ends_at: iso(4),
        sort_order: 0, removed_at: null, created_at: "2026-10-01T00:00:00Z" },
    ],
    trip_private_anchor_shares: [{ plan_item_id: HOTEL, trip_id: TRIP, owner_id: ANA, member_id: BEN, created_at: "2026-10-05T00:00:00Z" }],
    trip_stages: [{ id: STAGE, trip_id: TRIP, starts_at: iso(-30), ends_at: iso(70), timezone: "Europe/Lisbon", place_id: PORTO, title: "Porto" }],
    places: [{ id: PORTO, name: "Porto", latitude: 41.15, longitude: -8.61, lat: 41.15, lng: -8.61 }],
    hidden_gems: [{ id: GEM, status: "active", title: "Segreta Gem", created_at: "2026-10-01T00:00:00Z" }],
    // verifier L4: a stored snapshot (2773's fold names each plan by its title).
    trip_snapshots: [{ id: "5c000000-0000-4000-8000-0000000000c1", trip_id: TRIP, aggregate_version: 3, created_at: "2026-10-02T00:00:00Z",
      engine_versions_json: { snapshot_fold: 1 },
      snapshot_json: { aggregate_version: 3, plans: { [HOTEL]: { title: "Casa Segreta", status: "in_progress" }, [DINNER]: { title: "Dinner", status: "planned" } } } }],
    // census-trips §85 (verifier R1): the trip's Telegraph thread.
    message_threads: [{ id: TRIP_THREAD, thread_type: "trip", trip_id: TRIP, status: "active", circle_owner_id: null, is_e2ee: false }],
    message_thread_members: [ORGANIZER, ANA, BEN, CLEO].map((u) => ({ thread_id: TRIP_THREAD, user_id: u, role: "member", left_at: null, last_read_at: null })),
    route_plans: [{ id: "dddddddd-0000-4000-8000-00000000000d", trip_id: TRIP, owner_user_id: viewer, status: "active",
      updated_at: "2026-10-02T00:00:00Z", created_at: "2026-10-02T00:00:00Z" },
      // census-trips §86: ANA's own route on this trip, one stop made from her private stay.
      { id: ANA_ROUTE, trip_id: TRIP, owner_user_id: ANA, status: "active", updated_at: "2026-10-01T00:00:00Z", created_at: "2026-10-01T00:00:00Z" }],
    route_stops: [
      { id: "5a000000-0000-4000-8000-0000000000a1", route_plan_id: ANA_ROUTE, source_type: "plan_item", source_id: HOTEL, title: "Casa Segreta",
        structured_location: { label: "Casa Segreta", lat: HOTEL_LAT, lng: -9.13853 }, order_index: 0, notes: "door code 4471", checkpoint_status: "pending" },
      { id: "5a000000-0000-4000-8000-0000000000a2", route_plan_id: ANA_ROUTE, source_type: "plan_item", source_id: DINNER, title: "Dinner",
        structured_location: { label: "Dinner", lat: DINNER_LAT, lng: -9.14 }, order_index: 1, notes: null, checkpoint_status: "pending" },
    ],
    route_legs: [{ id: "5b000000-0000-4000-8000-0000000000b1", route_plan_id: ANA_ROUTE, from_stop_id: "5a000000-0000-4000-8000-0000000000a1",
      to_stop_id: "5a000000-0000-4000-8000-0000000000a2", distance_meters: 1234, duration_seconds: 900, mode: "walk", provider: "approximated", created_at: "2026-10-01T00:00:00Z" }],
  };
}

const UNREAD_GRANTS: FakeDbOptions = { errors: { trip_private_anchor_shares: { message: "grants unavailable", code: "57P01", ops: ["select"] } } };

interface ReaderPath {
  name: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  hotel?: Record<string, unknown>;
  /** Did the private stay reach this viewer? Default: any of its values appears in the response. */
  shown?: (body: any, text: string) => boolean;
}

const PATHS: ReaderPath[] = [
  { name: "route-chain", method: "GET", path: `/trips/${TRIP}/route-chain` },
  { name: "pulse", method: "GET", path: `/trips/${TRIP}/pulse` },
  { name: "today", method: "GET", path: `/trips/${TRIP}/today` },
  { name: "timeline", method: "GET", path: `/trips/${TRIP}/timeline` },
  { name: "telegraph-context", method: "GET", path: `/trips/${TRIP}/telegraph-context` },
  // verifier L4 (1867c97df): GET /trips/:id/snapshots/:version, redacted at the API.
  { name: "trip-snapshot", method: "GET", path: `/trips/${TRIP}/snapshots/latest` },
  // verifier R1 (1867c97df): the OTHER Telegraph trip-context door, read from inside the trip's thread.
  { name: "telegraph-thread-trip-context", method: "GET", path: `/threads/${TRIP_THREAD}/trip-context` },
  { name: "compass-context", method: "GET", path: `/trips/${TRIP}/context` },
  { name: "closeout", method: "GET", path: `/trips/${TRIP}/closeout` },
  { name: "impact-simulate", method: "POST", path: `/trips/${TRIP}/simulate`,
    body: { change: { kind: "move_plan", targetId: HOTEL, startsAt: iso(5), endsAt: iso(6) } } },
  { name: "meeting-point", method: "POST", path: `/trips/${TRIP}/meeting-point`, body: {} },
  { name: "offline-bundle", method: "GET", path: `/trips/${TRIP}/offline-bundle` },
  { name: "route-plan-stay", method: "GET", path: `/route-plans/for-trip/${TRIP}` },
  // census-trips §86: another member's route, read by id — a stop made from the private stay, and the leg from it.
  { name: "route-plan-stops", method: "GET", path: `/route-plans/${ANA_ROUTE}`,
    shown: (b, t) => SECRET.test(t) || ((b?.legs ?? []) as any[]).some((l) => l.distanceMeters === 1234) },
  { name: "plan-list", method: "GET", path: `/trips/${TRIP}/plan` },
  { name: "map-projection", method: "GET", path: `/trips/${TRIP}/map` },
  { name: "feasibility", method: "GET", path: `/trips/${TRIP}/feasibility`,
    // Derived: the stay's distance from its stage anchor. Without the stay's point the check is UNCHECKABLE for it.
    shown: (b) => ((b?.consistency?.findings ?? []) as any[]).some((f) => (f.planIds ?? []).includes(HOTEL) && f.reason !== "NO_COORDINATES") },
  { name: "memory-candidates", method: "GET", path: `/trips/${TRIP}/memory-candidates`, hotel: { status: "done" } },
  { name: "daily-brief", method: "GET", path: `/trips/${TRIP}/daily-brief` },
  { name: "location-check", method: "POST", path: `/trips/${TRIP}/location-check`, body: { lat: 38.7, lng: -9.1 },
    // Derived: the crew's centre of gravity. With the stay withheld it is the dinner alone.
    shown: (b, t) => SECRET.test(t) || b?.centerOfGravity?.lat !== DINNER_LAT },
  { name: "trip-gems", method: "GET", path: `/hidden-gems?tripId=${TRIP}` },
];

let harness: RouterHarness;
before(async () => {
  process.env.TRIP_OFFLINE_BUNDLE_SECRET ??= "lane-c-test-offline-bundle-secret-0123456789";
  const all = express.Router();
  for (const r of [tripProjectionsRouter, tripOfflineRouter, routePlanRouter, tripsRouter, tripFeasibilityRouter,
    tripPostTripRouter, dailyBriefRouter, neighborhoodsRouter, hiddenGemsRouter, telegraphSharedContextRouter, tripCommandRouter]) all.use(r);
  harness = await startRouter(all);
});
after(async () => {
  _setTestClient(null, false);
  _setTestServiceClient(null as never);
  await harness.close();
});

async function read(p: ReaderPath, viewer: string, scenario: Scenario): Promise<boolean> {
  const c = makeFakeClient(seed(viewer, scenario, p.hotel), scenario === "unread" ? UNREAD_GRANTS : {});
  _setTestClient(c as never, true);
  _setTestServiceClient(c as never);
  const r = await call(harness.base, p.method, p.path, viewer, p.body);
  assert.ok(r.status >= 200 && r.status < 300, `${p.name} as ${viewer} (${scenario}): ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  const text = JSON.stringify(r.body);
  return p.shown ? p.shown(r.body, text) : SECRET.test(text);
}

for (const p of PATHS) {
  describe(`§81 path ${p.name}`, () => {
    it(`${p.name} 0. CONTROL: the stay's creator sees it — the path really carries it`, async () => {
      assert.equal(await read(p, ANA, "on"), true);
    });
    it(`${p.name} 1. a crew member with no grant does not receive it`, async () => {
      assert.equal(await read(p, CLEO, "on"), false);
    });
    it(`${p.name} 2. the trip's organizer does not receive it`, async () => {
      assert.equal(await read(p, ORGANIZER, "on"), false);
    });
    it(`${p.name} 3. a member granted it, sharing on, receives it`, async () => {
      assert.equal(await read(p, BEN, "on"), true);
    });
    it(`${p.name} 4. the same member with sharing OFF does not`, async () => {
      assert.equal(await read(p, BEN, "off"), false);
    });
    it(`${p.name} 5. the same member with the grant list UNREADABLE does not`, async () => {
      assert.equal(await read(p, BEN, "unread"), false);
    });
  });
}

describe("verifier L1 (1867c97df): GET /hidden-gems?tripId reads the link rows WITH their id", () => {
  it("the grant is keyed by the plan item's id, so the select must carry it (the harness returns whole rows, so this is read from the source)", () => {
    const src = readFileSync(new URL("../routes/hiddenGems.ts", import.meta.url), "utf8");
    const i = src.indexOf('.eq("source_type", "hidden_gem"); if (planItemsErr)');
    assert.ok(i > 0, "the trip-gems link read moved; re-point this test");
    const select = src.slice(src.lastIndexOf(".select(", i), i);
    assert.match(select, /\.select\("id, source_id, removed_at, creator_id, location_is_private" satisfies `\$\{string\}, \$\{typeof PLAN_ITEM_PRIVACY_COLUMNS\}`\)/);
  });
});

describe("the privacy columns are read in select lists check:write-path-columns can read (CI's live-DB tier)", () => {
  // checkWritePathColumns resolves a select list only when it is a literal or a SAME-FILE const; an imported constant
  // interpolated into a template is a NEW unresolvable site there (17 of them, measured on this branch before the fix).
  // Every reader therefore writes the two columns out, tied to the constant by a `satisfies` type.
  it("no source file interpolates PLAN_ITEM_PRIVACY_COLUMNS into a select list", () => {
    const root = new URL("../", import.meta.url);
    // Exactly the trees checkWritePathColumns scans (its SCAN_DIRS): routes, services, domain, server (and one Input
    // file). A select outside them (e.g. compass/) is not that checker's blind spot, so it is not this guard's.
    const scanned = (f: string) => /^(routes|services|domain|server)[\/]/.test(f) || f === "lib/inputAssistance/searchCandidates.ts";
    const scanDirs = readFileSync(new URL("../scripts/checkWritePathColumns.ts", import.meta.url), "utf8");
    for (const d of ['"../routes"', '"../services"', '"../domain"', '"../server"']) assert.ok(scanDirs.includes(d), `checkWritePathColumns no longer scans ${d}; re-derive this guard's scope`);
    const files = (readdirSync(root, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".ts") && scanned(f.replace(/\\/g, "/")));
    assert.ok(files.length > 400, `vacuity guard: only ${files.length} source files were read`);
    const hits = files.filter((f) => readFileSync(new URL(f, root), "utf8").includes("${PLAN_ITEM_PRIVACY_COLUMNS"));
    assert.deepEqual(hits, []);
    // ...and the readers do still read the two columns (the literal form is in use, not dropped).
    const literal = files.filter((f) => readFileSync(new URL(f, root), "utf8").includes('creator_id, location_is_private" satisfies `${string}, ${typeof PLAN_ITEM_PRIVACY_COLUMNS}`'));
    assert.ok(literal.length >= 17, `only ${literal.length} files carry the literal form`);
  });
});

describe("§81 daily-brief cache: a brief built while a grant held is not served after it stopped holding", () => {
  // Both brief caches are keyed per user per day. Measured: with no access
  // digest on the cached brief, Ben's brief built under a grant (sharing on)
  // was served to him, Ana's stay in it, after sharing was turned off and
  // after the grant list became unreadable — the rule applied at build time
  // and bypassed at serve time.
  const brief = PATHS.find((p) => p.name === "daily-brief")!;
  it("daily-brief 6. built under a grant, then sharing OFF: the cached brief is rebuilt without the stay", async () => {
    assert.equal(await read(brief, BEN, "on"), true, "vacuity guard: the first build carried the stay");
    assert.equal(await read(brief, BEN, "off"), false);
  });
  it("daily-brief 7. built under a grant, then the grant list unreadable: rebuilt without the stay", async () => {
    assert.equal(await read(brief, BEN, "on"), true, "vacuity guard: the first build carried the stay");
    assert.equal(await read(brief, BEN, "unread"), false);
  });
  it("daily-brief 8 (R2). built while the stay was PUBLIC, then its creator made it private: the cached brief is rebuilt without it", async () => {
    // No grant moves when an item turns private, so a digest of grants alone
    // kept serving the brief built from the public item (verifier R2, 87df318f4).
    assert.equal(await read({ ...brief, hotel: { location_is_private: false } }, CLEO, "on"), true, "vacuity guard: the public stay is in the first build");
    assert.equal(await read(brief, CLEO, "on"), false);
  });
  it("daily-brief 9 (R2). a digest that could not be computed never matches: built and checked with the grants unreadable, the private stay is not served from cache", async () => {
    // Built with the grant list unreadable (key "unread") while the stay was
    // public, then checked with the grant list still unreadable after it went
    // private: "unread" equal to "unread" must not count as "unchanged".
    assert.equal(await read({ ...brief, hotel: { location_is_private: false } }, CLEO, "unread"), true, "vacuity guard: the public stay is in the first build");
    assert.equal(await read(brief, CLEO, "unread"), false);
  });
});

describe("§81 path gem-coords (a gem linked by a private plan item unlocks nothing for others)", () => {
  const gem = { id: GEM, sensitivity_level: "reveal_after_acceptance", latitude: 10.7769, longitude: 106.7009, approx_latitude: 10.78, approx_longitude: 106.7 } as any;
  const precise = async (viewer: string, scenario: Scenario) => {
    const c = makeFakeClient(seed(viewer, scenario), scenario === "unread" ? UNREAD_GRANTS : {});
    return (await resolveGemCoords(gem, c as never, viewer, GEM_AUTHOR, TRIP)).coordsPrecision === "exact";
  };
  it("gem-coords 0. CONTROL: the link's creator gets the exact point", async () => { assert.equal(await precise(ANA, "on"), true); });
  it("gem-coords 1. a crew member with no grant does not", async () => { assert.equal(await precise(CLEO, "on"), false); });
  it("gem-coords 2. the organizer does not", async () => { assert.equal(await precise(ORGANIZER, "on"), false); });
  it("gem-coords 3. a granted member, sharing on, does", async () => { assert.equal(await precise(BEN, "on"), true); });
  it("gem-coords 4. sharing off: does not", async () => { assert.equal(await precise(BEN, "off"), false); });
  it("gem-coords 5. grant list unreadable: does not", async () => { assert.equal(await precise(BEN, "unread"), false); });
});

describe("§81 path plan-map (public coordinates only — no private place, for anyone)", () => {
  const map = async (viewer: string, hotelOver: Record<string, unknown> = {}) => {
    const c = makeFakeClient(seed(viewer, "on", hotelOver));
    _setTestClient(c as never, true);
    _setTestServiceClient(c as never);
    const r = await call(harness.base, "GET", `/trips/${TRIP}/plan/map`, viewer);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return (r.body.items as Array<{ id: string }>).map((i) => i.id);
  };
  it("plan-map 0. CONTROL: the public dinner is on the map — the surface works", async () => {
    assert.ok((await map(CLEO)).includes(DINNER));
  });
  it("plan-map 1. the private stay is on nobody's map: not the creator's, not a grantee's, not the organizer's, not a member's", async () => {
    for (const v of [ANA, BEN, ORGANIZER, CLEO]) assert.ok(!(await map(v)).includes(HOTEL), v);
  });
  it("plan-map 2. THE POINT: a row whose privacy is UNSET (null) is private here, not public", async () => {
    for (const v of [ANA, CLEO]) assert.ok(!(await map(v, { location_is_private: null })).includes(HOTEL), v);
  });
});
