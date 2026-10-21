/**
 * LAYOVER 165, lane B1-R1 — §8 with Google Routes on the path a traveller in
 * production reaches: GET /api/airport/sessions/:id/recommendations.
 *
 * NOTHING ON THE PATH IS A DOUBLE EXCEPT THE TWO EXTERNAL EDGES:
 *   • Google: the PRODUCTION provider (`googleRoutesCorridorProvider`, the
 *     singleton `LAYOVER_RETURN_CORRIDOR_PROVIDER` names) is used as-is. Only
 *     `globalThis.fetch` is replaced — BEFORE the router is imported, because the
 *     singleton captures fetch at construction — and the replacement answers the
 *     Routes endpoint with the documented contract fixtures (fixtures/googleRoutes)
 *     and throws for any other host. Nothing reaches the network.
 *   • the database: the house fake (`fakeLayoverDb`) for the layover tables,
 *     with ONE real edge: its `rpc` executes `routes_api_try_spend_layover` on an
 *     isolated PGlite where migrations 3971 and 3856 are applied as written. So
 *     every call this route charges is counted by the real spend function.
 * The router, the recommendation service, the routed evaluator, the provider,
 * the layover spend gate and its configuration are the production code.
 *
 * ENV. This file sets LAYOVER_ROUTED_CORRIDOR_ENABLED, GOOGLE_MAPS_API_KEY (a
 * placeholder, never sent anywhere but the stub) and the ROUTES_API_DAILY_*
 * configuration for its own process — the production configuration's NAMES.
 *
 * WHAT IS PINNED, BY ROW
 *   L60   each landside card's way out and way back are separate requests at
 *         separate instants; the way back is priced at arrival + dwell.
 *   L65   the card is rated with outbound + dwell + CONSERVATIVE return (assess
 *         reads the routed return); a card that does not fit says so.
 *   L68   a robust corridor ranks above a fragile one with the same way out.
 *   L69/L70/L71/L282  the fragile, the ferry and the fragile+ferry candidates
 *         carry their margins, bands and RETURN_ROUTE_UNRELIABLE.
 *   L61/L66/L63  the response carries the routed union and its isochrone.
 *   L221  a 6-hour visa-free international layover: landside open, and every
 *         routed landside card carries a return contract WITH its route.
 *   L260  the place the straight-line envelope proves unreachable is never
 *         asked of Google; six candidates at most are routed.
 *   R5    every call is charged to the layover SESSION and the person (counted
 *         by the real function), never to the session's trip; the caps bind.
 *   FAIL CLOSED  Routes not enabled, the kill-switch flag off, a Google fallback,
 *         a spent session cap: named absences, no figure, the straight-line pin.
 *
 * Run: node --import tsx/esm --test src/test/layoverRoutedRecommendationsRoute.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";

// ── the production configuration, by name, for THIS process ─────────────────
process.env.LAYOVER_ROUTED_CORRIDOR_ENABLED = "true";
process.env.GOOGLE_MAPS_API_KEY = "test-placeholder-not-a-key";
process.env.ROUTES_API_DAILY_QUOTA = "500";
process.env.ROUTES_API_DAILY_BUDGET_USD = "10";
process.env.ROUTES_API_COST_PER_CALL_USD = "0.01";

const fixture = (n: string): any => JSON.parse(readFileSync(new URL(`./fixtures/googleRoutes/${n}`, import.meta.url), "utf8"));
const AIRPORT = { lat: 25.0797, lng: 121.2342 };
const KM_LNG = 1 / (111.32 * Math.cos((AIRPORT.lat * Math.PI) / 180));

/** Every Routes request this process makes, and what it was answered with. */
const google: Array<{ place: string; toAirport: boolean; mode: string; departureTime: string | undefined; fieldMask: string; key: string }> = [];
/** The return fixture per place. */
const returnFor = new Map<string, unknown>();
const placeKey = (lat: number, lng: number) => `${lat.toFixed(6)},${lng.toFixed(6)}`;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: RequestInit) => {
  if (String(url) !== "https://routes.googleapis.com/directions/v2:computeRoutes") throw new Error(`no network in this test: ${String(url)}`);
  const body = JSON.parse(String(init.body));
  const o = body.origin.location.latLng, d = body.destination.location.latLng;
  const toAirport = d.latitude === AIRPORT.lat && d.longitude === AIRPORT.lng;
  const place = toAirport ? o : d;
  const h = init.headers as Record<string, string>;
  google.push({ place: placeKey(place.latitude, place.longitude), toAirport, mode: body.travelMode, departureTime: body.departureTime, fieldMask: h["X-Goog-FieldMask"]!, key: h["X-Goog-Api-Key"]! });
  const json = body.travelMode === "WALK" ? fixture("walk.json")
    : toAirport ? (returnFor.get(placeKey(place.latitude, place.longitude)) ?? fixture("drive-alternatives-return.json"))
    : fixture("drive-alternatives-outbound.json");
  return { ok: true, status: 200, json: async () => json } as unknown as Response;
}) as unknown as typeof fetch;

const { _setTestClient } = await import("../lib/http.js");
const airportRouter = (await import("../routes/airport.js")).default;
const { makeLayoverDb, airportRow, sessionRow } = await import("./helpers/fakeLayoverDb.js");
const express = (await import("express")).default;

const USER = "33333333-3333-4333-8333-333333333333";
const TOKEN = "routed-token";
const HOUR = 3_600_000;
const pid = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, "0")}`;

// ── the real spend function on PGlite ────────────────────────────────────────
let pg: any;
async function pgCount(sql: string): Promise<number> { return Number((await pg.query(sql)).rows[0]?.n ?? 0); }

let server: http.Server;
let base = "";
let tables: Record<string, any[]>;
let sessionSeq = 0;

/** A 6-hour visa-free international layover, landed 10 minutes ago, at a verified airport with curated places due east. */
async function stage(opts: { places: Array<{ n: number; km: number; dwell?: number | null; ret?: unknown }>; flagOn?: boolean; wantsToLeave?: boolean }) {
  const now = Date.now();
  const session = `55555555-5555-4555-8555-${String(++sessionSeq).padStart(12, "0")}`;
  await pg.query("INSERT INTO public.layover_sessions VALUES ($1, $2) ON CONFLICT DO NOTHING", [session, USER]);
  const places = opts.places.map((p) => {
    const lng = AIRPORT.lng + p.km * KM_LNG;
    const lat = AIRPORT.lat + sessionSeq * 0.002; // ~220 m north per scenario: the singleton's memo is process-wide and keys to ~11 m
    if (p.ret !== undefined) returnFor.set(placeKey(lat, lng), p.ret);
    return { id: pid(p.n), name: `Place ${p.n}`, place_type: "cafe", category: "food", neighborhood: "Zhongli", blurb: "x", verified: true, city: "Taoyuan", status: "active", lat, lng, canonical_location_id: null, dwell: p.dwell };
  });
  tables = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_safety_engine_enabled", enabled: true },
      { flag: "passport_entry_intelligence_enabled", enabled: true },
      { flag: "layover_place_dwell_enabled", enabled: true },
      { flag: "layover_routed_corridor_enabled", enabled: opts.flagOn !== false },
    ],
    airport_profiles: [airportRow({ verified: true })],
    layover_sessions: [sessionRow({
      id: session, user_id: USER, trip_id: "66666666-6666-4666-8666-666666666666", status: "active",
      arrival_time: new Date(now - 10 * 60_000).toISOString(), departure_time: new Date(now + 6 * HOUR).toISOString(),
      flight_type: "international", immigration_required: false, checked_bags: false, wants_to_leave: opts.wantsToLeave !== false,
    })],
    traveler_passports: [{ user_id: USER, issuing_country: "US", is_primary: true, created_at: "2026-01-01T00:00:00Z" }],
    entry_requirements: [{ passport_country: "US", destination_country: "TW", status: "visa_free", max_stay_days: 90, notes: null, source_url: "https://example.test", last_verified_at: "2026-10-01T00:00:00Z" }],
    discovery_places: places.map(({ dwell: _d, ...p }) => p),
    layover_place_dwell: places.filter((p) => p.dwell).map((p) => ({ place_id: p.id, activity_min: p.dwell, source_class: "venue_stated", confidence: "MEDIUM", evidence: "the venue's own suggested visit" })),
    layover_recommendations: [], layover_plan_stops: [], layover_events: [], layover_checkpoints: [],
  };
  const fake: any = makeLayoverDb(tables, { users: { [TOKEN]: USER } });
  fake.rpc = async (fn: string, args: Record<string, unknown>) => {
    if (fn !== "routes_api_try_spend_layover") throw new Error(`unexpected rpc ${fn} — a layover call must never reach the Trips gate`);
    const names = Object.keys(args);
    await pg.exec("SET ROLE service_role");
    try {
      const r = await pg.query(`SELECT public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) AS v`, names.map((n) => args[n]));
      return { data: r.rows[0].v, error: null };
    } catch (e) { return { data: null, error: { message: String((e as Error).message) } }; } finally { await pg.exec("RESET ROLE"); }
  };
  _setTestClient(fake, true);
  google.length = 0;
  return { session, places };
}

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: Number(new URL(base).port), path, method: "GET", headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
      let acc = ""; res.setEncoding("utf8"); res.on("data", (c) => (acc += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: acc ? JSON.parse(acc) : null }));
    });
    req.on("error", reject); req.end();
  });
}

before(async () => {
  const runtime = await import(process.env.DISCOVERY_PGLITE_MODULE ?? import.meta.resolve("@electric-sql/pglite"));
  pg = new runtime.PGlite();
  await pg.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE public.feature_flags (flag text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false, description text);
    CREATE TABLE public.layover_sessions (id uuid PRIMARY KEY, user_id uuid NOT NULL);
    GRANT USAGE ON SCHEMA public TO service_role;`);
  await pg.exec(readFileSync(new URL("../migrations/3971_trip_routes_api_spend_gate.sql", import.meta.url), "utf8"));
  await pg.exec(readFileSync(new URL("../migrations/3856_layover_routes_session_budget.sql", import.meta.url), "utf8"));
  await pg.query("INSERT INTO auth.users VALUES ($1)", [USER]);
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", airportRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => { server?.close(); _setTestClient(null as any, false); globalThis.fetch = realFetch; await pg?.close(); });

const ferryOnly = () => { const f = fixture("drive-ferry-return.json"); return { routes: [f.routes[0]] }; };
/** The documented return fixture with every duration ×7: an evening way back of ~4 hours. */
const crawling = () => { const f = fixture("drive-alternatives-return.json"); for (const r of f.routes) r.duration = `${Number(r.duration.slice(0, -1)) * 7}s`; return f; };

describe("L221 / L60 / L65 / L68–L71 / L282 / L260 / R5 — a 6h visa-free international layover, routed, over the real router", () => {
  let res: { status: number; body: any };
  let staged: Awaited<ReturnType<typeof stage>>;

  before(async () => {
    staged = await stage({ places: [
      { n: 2, km: 12.3, dwell: 60, ret: fixture("drive-single-return.json") },  // L69 one way back — read FIRST, so only the ranking can put #1 above it
      { n: 1, km: 12, dwell: 60 },                                              // three independent ways back
      { n: 3, km: 12.6, dwell: 60, ret: fixture("drive-ferry-return.json") },   // L70 a ferry on the fastest way back
      { n: 4, km: 12.9, dwell: 60, ret: ferryOnly() },                          // L282 one way back AND a ferry
      { n: 5, km: 13.2, dwell: 60, ret: fixture("drive-fallback-return.json") },// Google's traffic-unaware fallback
      { n: 6, km: 0.8, dwell: 30 },                                             // walking distance
      { n: 7, km: 400, dwell: 30 },                                             // L260 provably out of reach
    ] });
    res = await get(`/api/airport/sessions/${staged.session}/recommendations`);
  });
  const card = (n: number) => res.body.recommendations.find((c: any) => c.placeId === pid(n));

  it("R1. landside is open for a 6h visa-free international layover, and the routed cards come back (L221's first half)", async () => {
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 400));
    const safety = await get(`/api/airport/sessions/${staged.session}/safety`);
    assert.equal(safety.body.advice.verdict, "yes", "visa-free + time → yes");
    assert.equal(safety.body.landsideGate.status ?? (safety.body.landsideGate.open ? "open" : "closed"), "open");
    for (const n of [1, 2, 3, 4, 6]) assert.ok(card(n), `card ${n} served`);
  });

  it("R2. L221: every routed landside card carries a return contract WITH its route — when to leave, and how", () => {
    for (const n of [1, 2, 3, 4, 6]) {
      const c = card(n);
      const rc = c.routing.returnContract;
      assert.ok(rc && rc.route, `card ${n}: a route back`);
      assert.ok(Date.parse(rc.leaveBy) <= Date.parse(rc.hardReturnBy), "leave-by is before the hard return");
      assert.ok(rc.route.minutes > 0 && rc.route.conservativeMinutes >= rc.route.minutes);
      assert.ok(rc.route.conveyances.length >= 1, "the route says how: its conveyances");
      assert.equal(rc.route.forecast, true);
    }
    assert.equal(card(6).routing.returnContract.route.mode, "walk", "walking distance is asked as a walk");
    assert.equal(card(1).routing.returnContract.route.mode, "drive");
  });

  it("R3. L60: the way out and the way back are separate requests at separate instants; the way back is priced at arrival + dwell", () => {
    const p1 = staged.places.find((p) => p.id === pid(1))!;
    const k1 = placeKey(p1.lat, p1.lng);
    const out = google.filter((g) => g.place === k1 && !g.toAirport);
    const back = google.filter((g) => g.place === k1 && g.toAirport);
    assert.equal(out.length, 1, "the outbound asked first is answered from the memo inside the bidirectional ask — billed once");
    assert.equal(back.length, 1);
    assert.equal(back[0]!.departureTime, card(1).routing.returnContract.route.departAt, "the request Google priced is the instant the card publishes");
    assert.equal(Date.parse(back[0]!.departureTime!) - Date.parse(out[0]!.departureTime!), (card(1).routing.outboundMinutes + 60) * 60_000, "out + dwell, not out × 2");
    assert.equal(card(1).routing.outboundMinutes, 21);
    assert.equal(card(1).routing.returnMinutes, 33, "the evening way back (33) is not the morning way out (21)");
    for (const g of google) { assert.equal(g.key, "test-placeholder-not-a-key"); assert.match(g.fieldMask, /routes\.legs\.steps\.navigationInstruction\.maneuver/); }
  });

  it("R4. L65: the card is rated on outbound + dwell + conservative return; its travel is a MEASURED leg with provenance", () => {
    const c = card(1);
    assert.equal(c.travelTimeSource, "measured");
    assert.equal(c.travelTimeMin, 21);
    assert.equal(c.activityTimeMin, 60, "the curated dwell is the minimum experience duration");
    assert.equal(c.routing.conservativeReturnMinutes, Math.ceil(33 * 1.25), "LOW confidence (every production record today): the way back held back 25%");
    assert.equal(c.safetyRating, "safe");
    assert.equal(c.routing.state, "FEASIBLE");
    assert.equal(c.routing.band, "SAFE");
    assert.equal(c.feasibility.band, "SAFE", "the pin carries the routed band");
    const row = tables.layover_recommendations.find((r: any) => r.place_id === pid(1));
    assert.equal(row?.travel_time_source, "measured", "the row persists the provenance (2745's column)");
  });

  it("R5. L69/L70/L282: the fragile, the ferry and the fragile+ferry ways back each carry their penalty, none of them SAFE", () => {
    const fragile = card(2).routing, ferry = card(3).routing, both = card(4).routing, robust = card(1).routing;
    assert.equal(fragile.signals.fragileCorridor, true);
    assert.ok(fragile.conservativeReturnMinutes > robust.conservativeReturnMinutes, "same way back in minutes, larger allowance");
    assert.equal(fragile.band, "TIGHT");
    assert.equal(ferry.signals.nonInterruptible, true);
    assert.equal(ferry.band, "TIGHT");
    assert.deepEqual(both.reasonCodes, ["RETURN_ROUTE_UNRELIABLE"], "one way back that cannot be left part-way");
    assert.equal(both.signals.returnRouteUnreliable, true);
    assert.deepEqual(robust.reasonCodes, []);
  });

  it("R6. L68: with the same way out, the robust corridor is ranked above the fragile one", () => {
    const order = res.body.recommendations.map((c: any) => c.placeId);
    assert.ok(order.indexOf(pid(1)) < order.indexOf(pid(2)), order.join(","));
    assert.ok(card(1).routing.preference > card(2).routing.preference);
  });

  it("R7. a traffic-unaware fallback is a named absence: no measured leg on the card, the pin keeps its straight-line verdict", () => {
    const c = card(5);
    assert.equal(c.routing.state, "UNMEASURED");
    assert.equal(c.routing.absence, "return_forecast_unavailable");
    assert.equal(c.travelTimeMin, null, "the static figure is never presented as a forecast");
    assert.equal(c.safetyRating, "not_recommended");
    assert.equal(c.feasibility.band, "UNCERTIFIED");
  });

  it("R8. L260: the provably unreachable place is never asked of Google (and, as before, not served)", () => {
    const far = staged.places.find((p) => p.id === pid(7))!;
    assert.equal(google.filter((g) => g.place === placeKey(far.lat, far.lng)).length, 0);
    assert.equal(card(7), undefined);
  });

  it("R9. L61/L66: the response carries the routed union — certified inward, per-sector reach — and the disc stays the outer bound", () => {
    const env = res.body.routedEnvelope;
    assert.equal(env.basis, "routed_union");
    assert.equal(env.certifiedInward, true);
    const members = env.members.map((m: any) => m.key).sort();
    assert.deepEqual(members, [1, 2, 3, 4, 6].map((n) => `place:${pid(n)}`).sort());
    assert.ok(env.outerBound && env.outerBound.basis === "straight_line_lower_bound");
    assert.ok(env.sectors.some((s: any) => s.measured && s.reachMetres > 10_000));
  });

  it("R10. R5: every billed call is charged to the layover SESSION and the person — counted by the real function — and never to the trip", async () => {
    const billed = google.length;
    assert.equal(billed, 12, "six routed candidates × two directions");
    assert.equal(await pgCount(`SELECT calls AS n FROM public.routes_api_layover_session_usage WHERE session_id = '${staged.session}'`), billed);
    assert.equal(await pgCount(`SELECT calls AS n FROM public.routes_api_layover_user_daily_usage WHERE user_id = '${USER}'`), billed);
    assert.equal(await pgCount("SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'routes_api_try_spend_scoped'"), 0, "the Trips share function is not even present here; a call to it would have thrown");
  });
});

describe("fail closed on the traveller's path", () => {
  it("R11. L65 decides the CARD's rating: out + dwell + 2 × out would fit, the routed conservative return does not → not recommended, and still SHOWN with its reason (blocked stays visible)", async () => {
    const s2 = await stage({ places: [{ n: 8, km: 12, dwell: 60, ret: crawling() }] });
    const crawlRes = await get(`/api/airport/sessions/${s2.session}/recommendations`);
    const c = crawlRes.body.recommendations.find((x: any) => x.placeId === pid(8));
    assert.ok(c, "the blocked card is still served, as unavailable");
    assert.equal(c.routing.state, "INFEASIBLE");
    assert.equal(c.routing.band, "BLOCKED");
    assert.equal(c.feasibility.band, "BLOCKED");
    assert.equal(c.safetyRating, "not_recommended", "rated on the way back as measured at its instant, not the way out doubled");
    assert.match(c.warningReason, /You'd need \d+ min but only have \d+ min usable/);
  });

  it("X1. Routes not enabled in this deployment: nothing is fetched, no leg is measured, every pin is exactly the straight-line one", async () => {
    const saved = process.env.LAYOVER_ROUTED_CORRIDOR_ENABLED;
    delete process.env.LAYOVER_ROUTED_CORRIDOR_ENABLED;
    try {
      const s = await stage({ places: [{ n: 21, km: 12, dwell: 60 }] });
      const r = await get(`/api/airport/sessions/${s.session}/recommendations`);
      assert.equal(r.status, 200);
      const c = r.body.recommendations.find((x: any) => x.placeId === pid(21));
      assert.equal(google.length, 0);
      assert.equal(c.travelTimeMin, null);
      assert.equal(c.travelTimeSource, "unmeasured");
      assert.equal(c.routing.absence, "PROVIDER_NOT_ENABLED");
      assert.equal(c.feasibility.band, "UNCERTIFIED");
      assert.equal(c.feasibility.reason, null, "the pin is the straight-line verdict, unchanged");
    } finally { process.env.LAYOVER_ROUTED_CORRIDOR_ENABLED = saved; }
  });
  it("X2. the kill switch (layover_routed_corridor_enabled FALSE): Google is never asked, nothing is counted", async () => {
    const s = await stage({ places: [{ n: 22, km: 12, dwell: 60 }], flagOn: false });
    const before = await pgCount("SELECT coalesce(sum(calls), 0)::int AS n FROM public.routes_api_layover_session_usage");
    const r = await get(`/api/airport/sessions/${s.session}/recommendations`);
    const c = r.body.recommendations.find((x: any) => x.placeId === pid(22));
    assert.equal(google.length, 0);
    assert.equal(c.routing.absence, "PROVIDER_REJECTED");
    assert.equal(c.travelTimeMin, null);
    assert.equal(await pgCount("SELECT coalesce(sum(calls), 0)::int AS n FROM public.routes_api_layover_session_usage"), before);
  });
  it("X4. a traveller staying airside: nothing landside is evaluated — no request, no routed geometry", async () => {
    const s = await stage({ places: [{ n: 41, km: 12, dwell: 60 }], wantsToLeave: false });
    const r = await get(`/api/airport/sessions/${s.session}/recommendations`);
    assert.equal(r.status, 200);
    assert.equal(google.length, 0);
    assert.equal(r.body.routedEnvelope, null);
  });
  it("X3. a spent session cap: the calls inside it are made, every one after it is a named absence (no stand-in figure)", async () => {
    process.env.LAYOVER_ROUTES_SESSION_CAP = "4";
    try {
      const s = await stage({ places: [1, 2, 3, 4].map((i) => ({ n: 30 + i, km: 10 + i, dwell: 45 })) });
      const r = await get(`/api/airport/sessions/${s.session}/recommendations`);
      const routed = r.body.recommendations.filter((x: any) => x.routing?.state === "FEASIBLE");
      const capped = r.body.recommendations.filter((x: any) => x.routing?.absence === "PROVIDER_REJECTED");
      assert.equal(google.length, 4, "the cap is four calls for this session, and not one more reaches Google");
      // Candidates are routed three at a time, so at the very edge of a cap a candidate's way OUT can be granted and its
      // way BACK refused: bounded waste (at most concurrency − 1 calls, once per session), never a half-measured card.
      assert.ok(routed.length >= 1, "the calls inside the cap measured a whole candidate");
      assert.equal(routed.length + capped.length, 4);
      for (const c of routed) assert.ok(c.routing.returnContract?.route, "a routed card has both legs");
      for (const c of capped) assert.equal(c.travelTimeMin, null);
      assert.equal(await pgCount(`SELECT calls AS n FROM public.routes_api_layover_session_usage WHERE session_id = '${s.session}'`), 4);
    } finally { delete process.env.LAYOVER_ROUTES_SESSION_CAP; }
  });
});
