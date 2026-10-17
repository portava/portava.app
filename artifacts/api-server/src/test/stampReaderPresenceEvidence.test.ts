/**
 * H4 (census-highlights-memories), the READER half — wave 5, lane 5.
 *
 * The award path now needs occurrence evidence for a presence stamp's place.
 * The rows ALREADY WRITTEN do not carry it: planning stamps from before §BD
 * hold the destination, completion stamps from before 60d199e2d were minted for
 * trips nobody took, and an admin could type a place onto a presence slug. The
 * owner's data repair (OD-1012-STAMP-4) has not run, and this lane does not
 * touch those rows. So every reader applies one rule
 * (services/passport/stampPresenceView.ts): a stamp's PLACE is named, counted,
 * pinned or used to key a feed only for a presence stamp whose own source's
 * occurrence evidence holds — a check-in on its trip, a GPS stamp-eligible
 * unrevoked postcard for its post.
 *
 * THE WORLD (one traveller, five stamps, each a case):
 *   s-plan   trip_planner, Paris — a planning stamp from before §BD, with a place
 *   s-ghost  first_trip_completed, Lisbon — completed by the calendar, nobody checked in
 *   s-real   first_trip_completed, Kyoto — the traveller's arrival is on record
 *   s-gps    city_explorer, Bangkok — a GPS stamp-eligible postcard
 *   s-admin  city_explorer, Rome — an admin typed the place; no evidence
 *
 * Every exclusion sits beside a positive control (s-real / s-gps), so a reader
 * that simply stopped showing places would fail here too.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/stampReaderPresenceEvidence.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { makePassportDb } from "./helpers/fakePassportDb.js";
import { readStampPresenceView, stampPresenceVerdict, withPresencePlaces } from "../services/passport/stampPresenceView.js";
import { readOccurrenceEvidence } from "../services/passport/stampOccurrenceEvidence.js";
import { readTripPresenceEvidenceForPairs, EVIDENCE_CHUNK, EVIDENCE_PAGE_CEILING } from "../services/passport/tripCompletionPresence.js";
import { buildStats } from "../services/passport/PassportMapService.js";
import { buildSharedContext } from "../services/passport/SharedContextService.js";
import { resolveMetric } from "../lib/stamps/criteria/metrics.js";
import { buildStructuredCompassContext } from "../compass/CompassStructuredContext.js";
import { buildJourneys } from "../services/passport/PassportJourneyService.js";
import { buildUnifiedStamps, filterUnifiedStamps } from "../services/passport/UnifiedStampService.js";
import { readPostTripInputs } from "../domain/trips/projections/TripPostTripProjections.js";
import { buildGraphFromSources } from "../compass/CompassGraphEngine.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import stampsRouter from "../routes/stamps.js";
import stampShowcaseRouter from "../routes/stampShowcase.js";
import wellKnownShareRouter from "../routes/wellKnownShare.js";
import passportRouter from "../routes/passport.js";
import stampAdmireRouter from "../routes/stampAdmire.js";

const OWNER = "aaaaaaaa-1111-4000-8000-000000000001";
const VIEWER = "aaaaaaaa-1111-4000-8000-000000000002";
const T_PLAN = "bbbbbbbb-1111-4000-8000-000000000001";
const T_GHOST = "bbbbbbbb-1111-4000-8000-000000000002";
const T_REAL = "bbbbbbbb-1111-4000-8000-000000000003";
const P_GPS = "cccccccc-1111-4000-8000-000000000001";
const S = {
  plan: "dddddddd-1111-4000-8000-000000000001",
  ghost: "dddddddd-1111-4000-8000-000000000002",
  real: "dddddddd-1111-4000-8000-000000000003",
  gps: "dddddddd-1111-4000-8000-000000000004",
  admin: "dddddddd-1111-4000-8000-000000000005",
};

type Row = Record<string, any>;

function def(slug: string, presence: boolean, name: string) {
  return { slug, name, evidences_presence: presence, category: "trip", stamp_type: "city", rarity: "common", icon_url: null };
}

function stampRows(userId = OWNER): Row[] {
  const base = { user_id: userId, is_revoked: false, visibility: "public", display_on_passport: true, title_override: null, catalog_id: null, lat: null, lng: null, metadata: null, created_at: "2026-01-01T00:00:00Z" };
  return [
    { ...base, id: S.plan, stamp_definition_id: "def-trip_planner", source_type: "trips", source_id: T_PLAN, city: "Paris", country: "France", earned_at: "2026-01-05T00:00:00Z", stamp_definitions: def("trip_planner", false, "Trip Planner") },
    { ...base, id: S.ghost, stamp_definition_id: "def-first_trip_completed", source_type: "trips", source_id: T_GHOST, city: "Lisbon", country: "Portugal", earned_at: "2026-01-04T00:00:00Z", stamp_definitions: def("first_trip_completed", true, "First Trip Completed") },
    { ...base, id: S.real, stamp_definition_id: "def-first_trip_completed", source_type: "trips", source_id: T_REAL, city: "Kyoto", country: "Japan", earned_at: "2026-01-03T00:00:00Z", stamp_definitions: def("first_trip_completed", true, "First Trip Completed") },
    { ...base, id: S.gps, stamp_definition_id: "def-city_explorer", source_type: "posts", source_id: P_GPS, city: "Bangkok", country: "Thailand", earned_at: "2026-01-02T00:00:00Z", stamp_definitions: def("city_explorer", true, "City Explorer") },
    { ...base, id: S.admin, stamp_definition_id: "def-city_explorer", source_type: "admin", source_id: "none", city: "Rome", country: "Italy", earned_at: "2026-01-01T00:00:00Z", stamp_definitions: def("city_explorer", true, "City Explorer") },
  ];
}

const DEFINITIONS = [
  { id: "def-trip_planner", slug: "trip_planner", name: "Trip Planner" },
  { id: "def-first_trip_completed", slug: "first_trip_completed", name: "First Trip Completed" },
  { id: "def-city_explorer", slug: "city_explorer", name: "City Explorer" },
];

function evidence(userId = OWNER): Row {
  return {
    plan_checkins: [{ user_id: userId, trip_id: T_REAL, status: "arrived", checked_in_at: "2026-01-03T09:00:00Z" }],
    passport_stamps: [],
    passport_postcards: [{ user_id: userId, post_id: P_GPS, stamp_eligible: true, stamp_revoked: false }],
  };
}

function world(extra: Row = {}, opts: Parameters<typeof makePassportDb>[1] = {}) {
  return makePassportDb({ user_stamps: stampRows(), ...evidence(), ...extra }, opts);
}

const PLACES_SHOWN = ["Bangkok", "Kyoto"];

// ── 1. The rule ──────────────────────────────────────────────────────────────

describe("stampPresenceView — the one rule", () => {
  it("verdicts: not presence, evidenced (trip / postcard), unevidenced (no check-in / an admin source)", async () => {
    const rows = stampRows();
    const view = await readStampPresenceView(world() as any, rows);
    assert.deepEqual(rows.map((r) => view.verdict(r)), ["not_presence", "unevidenced", "evidenced", "evidenced", "unevidenced"]);
    assert.deepEqual(rows.map((r) => view.place(r).city), [null, null, "Kyoto", "Bangkok", null]);
    assert.deepEqual(rows.map((r) => view.presenceClaimHolds(r)), [true, false, true, true, false]);
    assert.deepEqual(view.unreadable, []);
  });

  it("another member's check-in on the same trip is not this person's evidence", async () => {
    const db = world({ plan_checkins: [{ user_id: VIEWER, trip_id: T_GHOST, status: "arrived", checked_in_at: "2026-01-04T09:00:00Z" }] });
    const view = await readStampPresenceView(db as any, stampRows());
    assert.equal(view.verdict(stampRows()[1]), "unevidenced");
  });

  it("someone else's postcard for the same post is not this person's evidence", async () => {
    const db = world({ passport_postcards: [{ user_id: VIEWER, post_id: P_GPS, stamp_eligible: true, stamp_revoked: false }] });
    assert.equal((await readStampPresenceView(db as any, stampRows())).verdict(stampRows()[3]), "unevidenced");
  });

  it("a planned (not arrived) check-in row and a revoked postcard stamp are not evidence", async () => {
    const db = world({
      plan_checkins: [{ user_id: OWNER, trip_id: T_REAL, status: "planned", checked_in_at: null }],
      passport_postcards: [{ user_id: OWNER, post_id: P_GPS, stamp_eligible: true, stamp_revoked: true }],
    });
    const view = await readStampPresenceView(db as any, stampRows());
    assert.equal(view.verdict(stampRows()[2]), "unevidenced");
    assert.equal(view.verdict(stampRows()[3]), "unevidenced");
  });

  it("a verified passport_stamps fix on the trip is evidence too", async () => {
    const db = world({ plan_checkins: [], passport_stamps: [{ user_id: OWNER, trip_id: T_REAL, verification_level: "gps" }] });
    assert.equal((await readStampPresenceView(db as any, stampRows())).verdict(stampRows()[2]), "evidenced");
  });

  it("UNREADABLE evidence withholds the place and is reported — never 'evidenced', never 'nobody'", async () => {
    const db = world({}, { failReads: { plan_checkins: { message: "timeout" }, passport_stamps: { message: "timeout" }, passport_postcards: { message: "timeout" } } });
    const view = await readStampPresenceView(db as any, stampRows());
    assert.equal(view.verdict(stampRows()[2]), "unverifiable");
    assert.equal(view.verdict(stampRows()[3]), "unverifiable");
    assert.equal(view.place(stampRows()[2]).city, null);
    assert.ok(view.unreadable.includes("plan_checkins") && view.unreadable.includes("passport_postcards"));
  });

  it("one readable evidence table that shows the arrival is enough when the other failed", async () => {
    const db = world({}, { failReads: { passport_stamps: { message: "timeout" } } });
    assert.equal((await readStampPresenceView(db as any, stampRows())).verdict(stampRows()[2]), "evidenced");
  });

  it("FAIL CLOSED on the classification: no slug, an unknown slug, or evidences_presence=false is not presence", () => {
    const ev = { present: new Set([`${OWNER}|trips|${T_REAL}`]), unverifiable: new Set<string>() };
    const real = stampRows()[2];
    assert.equal(stampPresenceVerdict(real, ev), "evidenced");
    assert.equal(stampPresenceVerdict({ ...real, stamp_definitions: { evidences_presence: true } }, ev), "not_presence");
    assert.equal(stampPresenceVerdict({ ...real, stamp_definitions: { slug: "First_Trip_Completed", evidences_presence: true } }, ev), "not_presence");
    assert.equal(stampPresenceVerdict({ ...real, stamp_definitions: [{ slug: "first_trip_completed", evidences_presence: false }] }, ev), "not_presence");
    assert.equal(stampPresenceVerdict({ ...real, stamp_definitions: [{ slug: "first_trip_completed", evidences_presence: true }] }, ev), "evidenced", "the one-element-array embed is read");
  });

  it("reads nothing when no row is a presence stamp with a re-checkable source", async () => {
    let reads = 0;
    const counting = { from: (t: string) => { reads++; return (world() as any).from(t); } };
    await readStampPresenceView(counting as any, [stampRows()[0], stampRows()[4]]);
    assert.equal(reads, 0);
  });

  it("withPresencePlaces copies, never mutates, and removes no row", async () => {
    const rows = stampRows();
    const view = await readStampPresenceView(world() as any, rows);
    const out = withPresencePlaces(view, rows, ["city", "country"]);
    assert.equal(out.length, 5);
    assert.equal(rows[0].city, "Paris", "the input row is untouched");
    assert.deepEqual(out.map((r) => r.city), [null, null, "Kyoto", "Bangkok", null]);
  });
});

describe("evidence reads are chunked and refuse a cut page", () => {
  it(`trips are read ${EVIDENCE_CHUNK} at a time, and every pair is still answered`, async () => {
    const pairs = Array.from({ length: 60 }, (_, i) => ({ userId: OWNER, tripId: `trip-${i}` }));
    const checkins = pairs.map((p) => ({ user_id: OWNER, trip_id: p.tripId, status: "left", checked_in_at: "2026-01-01T00:00:00Z" }));
    const inCalls: number[] = [];
    const base = makePassportDb({ plan_checkins: checkins, passport_stamps: [] }) as any;
    const spy = { from: (t: string) => { const b = base.from(t); const orig = b.in.bind(b); b.in = (c: string, v: unknown[]) => { if (c === "trip_id") inCalls.push(v.length); return orig(c, v); }; return b; } };
    const r = await readTripPresenceEvidenceForPairs(spy as any, pairs);
    assert.equal(r.present.size, 60);
    assert.equal(EVIDENCE_CHUNK, 25, "the chunk is small enough for a URL and a page");
    assert.ok(inCalls.length >= 6 && inCalls.every((n) => n <= 25), `chunk sizes ${inCalls}`);
  });

  it("a many-person read (by trip alone) still matches evidence to THE person: another member's arrival is not theirs", async () => {
    const people = Array.from({ length: 40 }, (_, i) => `person-${i}`);
    const pairs = people.map((userId) => ({ userId, tripId: "trip-shared" }));
    const db = makePassportDb({ plan_checkins: [{ user_id: "person-7", trip_id: "trip-shared", status: "arrived", checked_in_at: "2026-01-01T00:00:00Z" }], passport_stamps: [] });
    const r = await readTripPresenceEvidenceForPairs(db as any, pairs);
    assert.deepEqual([...r.present], ["person-7|trip-shared"]);
  });

  it("a chunk answering at the page ceiling is UNREADABLE, not complete", async () => {
    const rows = Array.from({ length: EVIDENCE_PAGE_CEILING }, (_, i) => ({ user_id: OWNER, trip_id: "trip-0", status: "planned", checked_in_at: null, i }));
    const r = await readTripPresenceEvidenceForPairs(makePassportDb({ plan_checkins: rows, passport_stamps: [] }) as any, [{ userId: OWNER, tripId: "trip-0" }]);
    assert.deepEqual(r.unreadable, ["plan_checkins"]);
    const ev = await readOccurrenceEvidence(makePassportDb({ plan_checkins: rows, passport_stamps: [] }) as any, [{ userId: OWNER, source: "trips", sourceId: "trip-0" }]);
    assert.equal(ev.unverifiable.size, 1);
  });
});

// ── 2. The readers ───────────────────────────────────────────────────────────

describe("readers — each names, counts or keys only evidenced places", () => {
  it("buildStats (GET /me/passport/stats): Countries/Cities are Japan and Thailand only; totalStamps keeps all five", async () => {
    const s = await buildStats(world() as any, OWNER);
    assert.deepEqual([s.countries, s.cities, s.totalStamps, s.readFailed], [2, 2, 5, false]);
  });

  it("buildStats: unreadable evidence is readFailed (a floor), not a smaller truth", async () => {
    const s = await buildStats(world({}, { failReads: { passport_postcards: { message: "timeout" } } }) as any, OWNER);
    assert.equal(s.readFailed, true);
  });

  it("buildStats over a caller's RLS client reads the evidence with the service client (3363 withholds passport_postcards.stamp_eligible from authenticated)", async () => {
    const rlsClient = world({}, { failReads: { passport_postcards: { code: "42501", message: "permission denied for column stamp_eligible" } } });
    const denied = await buildStats(rlsClient as any, OWNER);
    assert.equal(denied.readFailed, true, "without the service client the evidence is unreadable, and said so");
    const s = await buildStats(rlsClient as any, OWNER, { evidenceClient: world() as any });
    assert.deepEqual([s.countries, s.cities, s.readFailed], [2, 2, false]);
  });

  it("countries_visited / cities_visited (what mints globe_trotter): 2, not 5", async () => {
    const db = world();
    assert.equal(await resolveMetric(db as any, OWNER, "countries_visited", { context: {} }), 2);
    assert.equal(await resolveMetric(db as any, OWNER, "cities_visited", { context: {} }), 2);
  });

  it("shared_cities: a city both 'completed' by the calendar is not shared; a city both really visited is", async () => {
    const both = [...stampRows(OWNER), ...stampRows(VIEWER)];
    const ev = { plan_checkins: [...evidence(OWNER).plan_checkins, ...evidence(VIEWER).plan_checkins], passport_stamps: [], passport_postcards: [...evidence(OWNER).passport_postcards, ...evidence(VIEWER).passport_postcards] };
    const ctx = await buildSharedContext(makePassportDb({ user_stamps: both, ...ev, profiles: [{ id: OWNER }, { id: VIEWER }] }) as any, OWNER, VIEWER);
    const fact = ctx.facts.find((f) => f.key === "shared_cities");
    assert.ok(fact, "Kyoto and Bangkok are genuinely shared");
    assert.equal(fact!.magnitude, 2);
    for (const never of ["lisbon", "paris", "rome"]) assert.ok(!(fact!.detail ?? "").toLowerCase().includes(never), never);
  });

  it("Compass 'Passport history' (the AI's context): no unevidenced presence claim, no unevidenced place", async () => {
    const ctx = await buildStructuredCompassContext(world({ profiles: [{ id: OWNER }] }) as any, { userId: OWNER } as any);
    const titles = ctx.recentStamps.map((s) => `${s.title}@${s.city ?? "-"}`);
    assert.deepEqual(titles.sort(), ["City Explorer@Bangkok", "First Trip Completed@Kyoto", "Trip Planner@-"].sort());
  });

  it("journeys: the ghost trip carries no completion stamp; the planned trip's stamp carries no place", async () => {
    const trips = [T_PLAN, T_GHOST, T_REAL].map((id, i) => ({ id, owner_id: OWNER, title: `t${i}`, destination_city: ["Paris", "Lisbon", "Kyoto"][i], destination_country: ["France", "Portugal", "Japan"][i], start_date: `2025-0${i + 1}-01`, end_date: `2025-0${i + 1}-05`, status: "completed", visibility: "public", show_on_profile: true, show_exact_dates: true }));
    const db = world({ trips, trip_members: trips.map((t) => ({ trip_id: t.id, user_id: OWNER, role: "owner" })) });
    const r = await buildJourneys(db as any, OWNER, { isSelf: true, canSeeTrips: true, canSeeRestricted: true });
    const all = r.years.flatMap((y) => y.countries.flatMap((c) => c.cities.flatMap((ci) => ci.journeys)));
    const byTrip = new Map(all.map((j) => [j.tripId, j] as const));
    assert.equal(byTrip.get(T_GHOST)!.stampCount, 0, "a completion stamp for a trip nobody checked in on is not shown");
    assert.equal(byTrip.get(T_REAL)!.stampCount, 1, "POSITIVE CONTROL");
    assert.equal(byTrip.get(T_PLAN)!.stampCount, 1, "the planning achievement stays");
    assert.equal((byTrip.get(T_PLAN) as any).stamps[0].city, null, "…without its place");
  });

  it("unified shelf: places withheld, the owner keeps every row, a viewer never sees an unevidenced presence claim", async () => {
    // A second planning stamp of the SAME definition (another trip): with its
    // place withheld it has no place to dedupe on, and must not collapse into
    // the first by definition.
    const second = { ...stampRows()[0], id: "dddddddd-1111-4000-8000-000000000006", source_id: "bbbbbbbb-1111-4000-8000-000000000009", city: "Porto", country: "Portugal" };
    const r = await buildUnifiedStamps(world({ user_stamps: [...stampRows(), second] }) as any, OWNER);
    const v2 = r.stamps.filter((s) => s.source === "v2_achievement");
    assert.equal(v2.length, 6, "a withheld place dedupes by its own id, never collapsing distinct stamps");
    assert.deepEqual(v2.map((s) => s.city).filter(Boolean).sort(), PLACES_SHOWN);
    const forViewer = filterUnifiedStamps(r.stamps, "public").filter((s) => s.source === "v2_achievement");
    assert.deepEqual(forViewer.map((s) => s.userStampId).sort(), [S.gps, S.plan, S.real, second.id].sort());
    assert.equal(filterUnifiedStamps(r.stamps, "owner").length, r.stamps.length);
  });

  it("post-trip passport projection: the ghost trip lists no completion stamp; the real one does, with its place", async () => {
    const tables = (tripId: string) => world({
      trips: [{ id: tripId, title: "t", status: "completed", destination_city: "X", destination_country: "Y", start_date: "2025-01-01", end_date: "2025-01-05" }],
      trip_plan_items: [], trip_members: [], memories: [], stamp_definitions: DEFINITIONS,
      user_stamps: stampRows().map((r) => ({ ...r, stamp_definitions: undefined })),
    });
    const ghost = await readPostTripInputs(tables(T_GHOST) as any, T_GHOST, OWNER);
    assert.ok(ghost.ok);
    assert.deepEqual(ghost.ok && ghost.inputs.stamps, []);
    const real = await readPostTripInputs(tables(T_REAL) as any, T_REAL, OWNER);
    assert.ok(real.ok);
    assert.deepEqual(real.ok && real.inputs.stamps!.map((s) => [s.slug, s.city]), [["first_trip_completed", "Kyoto"]]);
    const plan = await readPostTripInputs(tables(T_PLAN) as any, T_PLAN, OWNER);
    assert.deepEqual(plan.ok && plan.inputs.stamps!.map((s) => [s.slug, s.city, s.country]), [["trip_planner", null, null]], "the planning achievement stays, without its place");
  });

  it("Compass graph: `visited` edges only for evidenced presence stamps", async () => {
    const store: Record<string, Row[]> = { user_stamps: stampRows(), ...evidence() };
    const upserts: Row[] = [];
    const db = {
      from(t: string) {
        const base = (makePassportDb(store) as any).from(t);
        const real = base.upsert?.bind(base);
        base.upsert = (rows: Row | Row[]) => { if (t === "compass_graph_edges") upserts.push(...(Array.isArray(rows) ? rows : [rows])); return real ? real(rows) : base; };
        return base;
      },
      rpc: async () => ({ data: null, error: null }),
    };
    await buildGraphFromSources(db as any, {});
    const visited = upserts.filter((e) => e.edge_type === "visited" && e.src_key === OWNER).map((e) => String(e.dst_key)).sort();
    assert.deepEqual(visited, ["bangkok", "kyoto"]);
  });
});

// ── 3. The HTTP readers ──────────────────────────────────────────────────────

function routeWorld() {
  const db = world({
    profiles: [{ id: OWNER, username: "owner", handle: "owner", passport_visibility: "public", account_status: "active" }, { id: VIEWER, username: "viewer", handle: "viewer", passport_visibility: "public", account_status: "active" }],
    feature_flags: [
      { flag: "stamp_system_v2_enabled", enabled: true },
      { flag: "stamp_showcase_enabled", enabled: true },
      { flag: "stamp_admire_enabled", enabled: true },
    ],
    stamp_admires: [], notifications: [],
    user_stamp_showcase: Object.values(S).map((id, rank) => ({ user_id: OWNER, user_stamp_id: id, rank })),
    blocks: [], user_friendships: [], stamp_definitions: DEFINITIONS,
  }) as any;
  return {
    from: (t: string) => db.from(t),
    auth: { getUser: async (tok: string) => (tok === "tok-owner" ? { data: { user: { id: OWNER } }, error: null } : tok === "tok-viewer" ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    storage: { from: () => ({ createSignedUrls: async () => ({ data: [], error: null }) }) },
  };
}

describe("HTTP readers — routes/stamps.ts, the showcase, the public share page", () => {
  let server: http.Server;
  let base = "";
  before(async () => {
    client = routeWorld();
    _setTestClient(client, true);
    _setTestServiceClient(client as any);
    const app = express();
    app.use(express.json());
    app.use((r: any, _res: any, next: any) => { r.log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
    app.use("/api", stampsRouter);
    app.use("/api", stampShowcaseRouter);
    app.use("/api", stampAdmireRouter);
    app.use(wellKnownShareRouter);
    app.use(passportRouter);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  after(() => server.close());
  let client: ReturnType<typeof routeWorld>;
  const get = async (path: string, who: "owner" | "viewer") => {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer tok-${who}` } });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };

  it("GET /stamps/me (owner): every stamp stays (paged by row offset); only Kyoto and Bangkok keep a place", async () => {
    const r = await get("/api/stamps/me", "owner");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.stamps.length, 5);
    assert.deepEqual(r.body.stamps.map((s: any) => s.city).filter(Boolean).sort(), PLACES_SHOWN);
    assert.deepEqual(r.body.stamps.map((s: any) => s.country).filter(Boolean).sort(), ["Japan", "Thailand"]);
  });

  it("GET /stamps/me?country=France (the country page): the planning stamp is not a stamp 'in' France", async () => {
    const r = await get("/api/stamps/me?country=France", "owner");
    assert.deepEqual([r.body.stamps.length, r.body.total], [0, 0]);
    const jp = await get("/api/stamps/me?country=Japan", "owner");
    assert.deepEqual(jp.body.stamps.map((s: any) => s.id), [S.real], "POSITIVE CONTROL");
  });

  it("GET /stamps/city/:city and /stamps/country/:country list only evidenced stamps", async () => {
    assert.deepEqual((await get("/api/stamps/city/Lisbon", "viewer")).body.stamps, []);
    assert.deepEqual((await get("/api/stamps/city/Rome", "viewer")).body.stamps, []);
    assert.deepEqual((await get("/api/stamps/country/France", "viewer")).body.stamps, []);
    assert.deepEqual((await get("/api/stamps/city/Kyoto", "viewer")).body.stamps.map((s: any) => s.id), [S.real], "POSITIVE CONTROL");
  });

  it("GET /stamps/user/:id for a viewer: no unevidenced presence claim; the planning achievement stays, placeless", async () => {
    const r = await get(`/api/stamps/user/${OWNER}`, "viewer");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.stamps.map((s: any) => s.id).sort(), [S.gps, S.plan, S.real].sort());
    assert.equal(r.body.stamps.find((s: any) => s.id === S.plan).city, null);
  });

  it("GET /stamps/recent: the public feed carries no unevidenced presence claim", async () => {
    const r = await get("/api/stamps/recent", "viewer");
    const ids = r.body.stamps.map((s: any) => s.id);
    assert.ok(!ids.includes(S.ghost) && !ids.includes(S.admin), JSON.stringify(ids));
    assert.ok(ids.includes(S.real), "POSITIVE CONTROL");
  });

  it("GET /stamps/:id: the ghost stamp is not found for a viewer, and placeless for its owner", async () => {
    assert.equal((await get(`/api/stamps/${S.ghost}`, "viewer")).status, 404);
    const own = await get(`/api/stamps/${S.ghost}`, "owner");
    assert.equal(own.status, 200);
    assert.equal(own.body.stamp.city, null);
    assert.equal((await get(`/api/stamps/${S.real}`, "viewer")).body.stamp.city, "Kyoto", "POSITIVE CONTROL");
  });

  it("GET /users/:username/stamp-showcase: no unevidenced presence claim, no unevidenced place", async () => {
    const r = await get("/api/users/owner/stamp-showcase", "viewer");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.items.map((i: any) => i.userStampId).sort(), [S.gps, S.plan, S.real].sort());
    assert.deepEqual(r.body.items.map((i: any) => i.city).filter(Boolean).sort(), PLACES_SHOWN);
  });

  it("GET /stamp/:id (public share page): no page for the ghost stamp, no place for the planning stamp", async () => {
    const page = async (id: string) => (await fetch(`${base}/stamp/${id}`)).text();
    const ghost = await page(S.ghost);
    assert.ok(!/Lisbon/.test(ghost), "the ghost stamp's place is not printed");
    assert.ok(!/First Trip Completed/.test(ghost), "and it gets the generic card, not a stamp card");
    assert.ok(!/Paris/.test(await page(S.plan)), "a planning stamp's place is not printed");
    assert.match(await page(S.real), /earned in Kyoto, Japan/, "POSITIVE CONTROL");
  });

  it("GET /users/:username/stamps/:id/preview (crawler card): no card for the ghost stamp, no place for the planning stamp", async () => {
    const card = async (id: string) => { const r = await fetch(`${base}/users/owner/stamps/${id}/preview`); return { status: r.status, body: await r.json().catch(() => null) as any }; };
    assert.equal((await card(S.ghost)).status, 404);
    const plan = await card(S.plan);
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    assert.deepEqual([plan.body.city, plan.body.country], [null, null]);
    assert.deepEqual([(await card(S.real)).body.city, (await card(S.real)).body.country], ["Kyoto", "Japan"], "POSITIVE CONTROL");
  });

  it("POST /stamps/:id/admire: the owner is told about their 'Trip Planner' stamp, not their 'Paris' stamp", async () => {
    const admire = async (id: string) => fetch(`${base}/api/stamps/${id}/admire`, { method: "POST", headers: { Authorization: "Bearer tok-viewer" } });
    for (const id of [S.plan, S.real]) assert.equal((await admire(id)).status, 201);
    const labels = async () => {
      for (let i = 0; i < 50; i++) {
        const { data } = await (client.from("notifications") as any).select("*");
        const got = (data ?? []).map((n: any) => n.params?.stamp ?? n.metadata?.params?.stamp ?? n.body).filter(Boolean);
        if (got.length >= 2) return got;
        await new Promise((r) => setTimeout(r, 10));
      }
      return [];
    };
    const got = await labels();
    assert.equal(got.length, 2, "both admire notifications were written (non-vacuity)");
    assert.ok(!got.some((l: string) => /Paris/.test(String(l))), JSON.stringify(got));
    assert.ok(got.some((l: string) => /Kyoto/.test(String(l))), "POSITIVE CONTROL");
  });
});
