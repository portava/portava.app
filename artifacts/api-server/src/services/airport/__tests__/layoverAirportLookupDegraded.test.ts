/**
 * census L294 — "C2. Never swallow a schema/data error into plausible empty
 * operational state **without structured logging and degraded confidence**."
 *
 * §19.2 named three things still true of this row after its write half closed.
 * The third was the widest:
 *
 *   > The swallows this pass enumerated are the `catch` ones. A read that
 *   > returns `?? []` on an unbound error is the same defect without the
 *   > keyword, and no exhaustive sweep of THAT shape was done.
 *
 * The sweep was run for this suite. Every supabase read in `services/airport/`,
 * `services/safeReturn/` and `routes/airport.ts` binds and checks its error —
 * there is no unbound `?? []` left. What the sweep DID find is the same defect
 * in a third shape, and it is the worst one on this surface because it does not
 * lose information, it MANUFACTURES it:
 *
 *     const { data, error } = await db.from("airport_profiles")…
 *     if (error) noteFallback("resolveByIata", error);   // logged, and then…
 *     if (data) return rowToProfile(data);
 *     // …fall through to the STATIC dataset, with DEFAULT buffers
 *
 * `resolveByIata` / `resolveByCity` / `resolveByGps` / `searchAirports` log the
 * failure and then answer with a static profile whose every buffer is a generic
 * constant: 60 / 120 / 30 / 15 / 20. That answer is INDISTINGUISHABLE from the
 * honest one for an airport this product has simply never curated — the §22 L0
 * tier, which is a designed state, not a fault.
 *
 * WHY IT MATTERS MORE THAN A LOG LINE. `POST /airport/sessions` takes the
 * profile these functions return and, when it has no id, calls
 * `upsertAirportProfile` — which WRITES the generic defaults into
 * `airport_profiles` and links the session to that row. `routes/airport.ts`
 * already spells out the harm, on the ONE branch that was guarded:
 *
 *   > "A session created while `airport_profiles` was unreadable is stored with
 *   >  airport_id = null, and EVERY later hard-return time for it is computed
 *   >  from the generic buffer defaults — permanently, long after the database
 *   >  recovers. The transient failure would have been baked into the row."
 *
 * That reasoning was applied to the `airportId` branch and to neither of the
 * other two. A traveller who picked their airport by IATA code or typed a city
 * during a five-second outage got a layover whose return deadline is computed
 * from constants for the rest of its life — and no surface anywhere says so.
 *
 * Run: node --import tsx/esm --test src/services/airport/__tests__/layoverAirportLookupDegraded.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../../../lib/http.js";
import airportRouter from "../../../routes/airport.js";
import { makeLayoverDb, airportRow } from "../../../test/helpers/fakeLayoverDb.js";
import {
  lookupByIata,
  lookupByCity,
  lookupByGps,
  lookupAirports,
  resolveByIata,
  resolveByCity,
} from "../AirportProfileService.js";

let server: http.Server;
let base: string;
const TOKEN = "airport-lookup-token";
const USER_ID = "user-1";

function req(method: string, path: string, body?: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { let p: any; try { p = JSON.parse(raw); } catch { p = raw; } resolve({ status: res.statusCode ?? 0, body: p }); });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function db(failures: Record<string, { message: string }> = {}, profiles: any[] = [airportRow()]) {
  return makeLayoverDb(
    {
      feature_flags: [{ flag: "airport_mode_enabled", enabled: true }],
      airport_profiles: profiles,
      layover_sessions: [], layover_events: [], layover_plan_stops: [],
      trip_plan_items: [], blocks: [], profiles: [], location_preferences: [], trips: [],
    },
    { users: { [TOKEN]: USER_ID }, failures },
  );
}

const UNREADABLE = { "airport_profiles:select": { message: "relation \"airport_profiles\" does not exist" } };

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", airportRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

// ── The lookups themselves ───────────────────────────────────────────────────

describe("an unreadable airport_profiles is not 'we have never curated this airport'", () => {
  it("lookupByIata: a failed read is DEGRADED, and names the table", async () => {
    const r = await lookupByIata(db(UNREADABLE) as any, "TPE");
    assert.equal(r.degraded, true, "a read that failed must not answer like a read that found nothing");
    assert.deepEqual(r.degradedReasons, ["airport_profiles_unreadable"]);
    // The static answer is still SERVED — refusing the whole lookup would take
    // the airport picker away entirely. It is the silence that was wrong.
    assert.ok(r.airport, "the static dataset still answers; it is just no longer passed off as the curated row");
    assert.equal(r.fromStatic, true);
  });

  it("lookupByIata: a curated row is neither degraded nor static", async () => {
    const r = await lookupByIata(db() as any, "TPE");
    assert.equal(r.degraded, false);
    assert.deepEqual(r.degradedReasons, []);
    assert.equal(r.fromStatic, false);
    assert.ok(r.airport?.id, "a curated row carries its id");
  });

  it("lookupByIata: an airport that is genuinely not curated is STATIC but NOT degraded", async () => {
    // A clean read that matched nothing. This is the §22 L0 tier — a designed
    // state — and calling it degraded would make the flag meaningless.
    const r = await lookupByIata(db({}, []) as any, "TPE");
    assert.equal(r.degraded, false, "a successful read that found nothing is a measurement");
    assert.deepEqual(r.degradedReasons, []);
    assert.equal(r.fromStatic, true, "…and the answer is still honestly marked as coming from the static set");
  });

  it("lookupByCity and lookupByGps degrade on the same failure", async () => {
    const c = await lookupByCity(db(UNREADABLE) as any, "Taoyuan");
    assert.equal(c.degraded, true);
    assert.deepEqual(c.degradedReasons, ["airport_profiles_unreadable"]);
    const g = await lookupByGps(db(UNREADABLE) as any, 25.07, 121.23);
    assert.equal(g.degraded, true);
    assert.deepEqual(g.degradedReasons, ["airport_profiles_unreadable"]);
  });

  it("lookupAirports: a failed search degrades and still serves the static matches", async () => {
    const r = await lookupAirports(db(UNREADABLE) as any, "Taoyuan");
    assert.equal(r.degraded, true);
    assert.deepEqual(r.degradedReasons, ["airport_profiles_unreadable"]);
    assert.ok(Array.isArray(r.airports));
  });

  it("the old resolvers keep their exact shape — src/test/airport.test.ts binds them", async () => {
    const a = await resolveByIata(db() as any, "TPE");
    assert.ok(a && typeof a === "object" && "iataCode" in a, "resolveByIata still answers a profile or null");
    const b = await resolveByCity(db({}, []) as any, "Nowhere-at-all");
    assert.ok(b === null || (b && "iataCode" in b));
  });
});

// ── The wire ─────────────────────────────────────────────────────────────────

describe("GET /airport/search — static results are labelled, not passed off", () => {
  it("an unreadable table degrades the search answer", async () => {
    _setTestClient(db(UNREADABLE), true);
    const r = await req("GET", "/api/airport/search?iata=TPE");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.degraded, true, "these buffers are constants, and the client is entitled to know");
    assert.ok((r.body.degradedReasons ?? []).includes("airport_profiles_unreadable"),
      JSON.stringify(r.body.degradedReasons));
  });

  it("positive control: a readable table degrades nothing", async () => {
    _setTestClient(db(), true);
    const r = await req("GET", "/api/airport/search?iata=TPE");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.degraded ?? false, false);
    assert.deepEqual(r.body.degradedReasons ?? [], []);
  });

  it("a free-text query degrades on the same failure", async () => {
    _setTestClient(db(UNREADABLE), true);
    const r = await req("GET", "/api/airport/search?q=Taoyuan");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.degraded, true);
  });
});

/**
 * RELATIVE TO NOW, not a fixed date — and that is the whole point.
 *
 * These four cases used to pin `2026-09-14T08:00Z` / `18:00Z`. The route refuses
 * a layover that has already departed ("This layover has already departed — set
 * a departure time in the future"), so on 2026-09-14 the fixture started
 * returning `400 invalid_payload` where the case asserts `201`, and it will do
 * so on every run from here. The two cases it broke are the POSITIVE CONTROLS —
 * the ones that prove the 503s above are a refusal about READABILITY and not a
 * route that refuses everything — so the failure quietly disarmed the half of
 * this file that gives the other half meaning.
 *
 * A test whose correctness depends on the wall clock passing a literal is a test
 * with an expiry date. Anchoring to `Date.now()` removes it.
 */
const FUTURE_ARRIVAL   = new Date(Date.now() +  2 * 60 * 60 * 1000).toISOString();
const FUTURE_DEPARTURE = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();

describe("POST /airport/sessions — a transient outage is not baked into the row", () => {
  it("an IATA-picked session REFUSES while airport_profiles is unreadable", async () => {
    _setTestClient(db(UNREADABLE), true);
    const r = await req("POST", "/api/airport/sessions", {
      iata: "TPE",
      arrivalTime:   FUTURE_ARRIVAL,
      departureTime: FUTURE_DEPARTURE,
      flightType: "international",
    });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable",
      "creating it anyway writes generic buffers into the row for the life of the layover");
  });

  it("a manual-city session refuses on the same failure", async () => {
    _setTestClient(db(UNREADABLE), true);
    const r = await req("POST", "/api/airport/sessions", {
      manualCity: "Taoyuan",
      manualAirportName: "Taoyuan International",
      arrivalTime:   FUTURE_ARRIVAL,
      departureTime: FUTURE_DEPARTURE,
      flightType: "international",
    });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("positive control: an uncurated airport on a READABLE table still creates the session", async () => {
    // The §22 L0 tier. A clean read that matched nothing must not be turned
    // into a refusal — that would be closing this row by taking the product
    // away from every airport the database does not carry.
    _setTestClient(db({}, []), true);
    const r = await req("POST", "/api/airport/sessions", {
      iata: "TPE",
      arrivalTime:   FUTURE_ARRIVAL,
      departureTime: FUTURE_DEPARTURE,
      flightType: "international",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.session, "a layover at an uncurated airport is still a layover");
  });

  it("positive control: a curated airport on a readable table creates the session", async () => {
    _setTestClient(db(), true);
    const r = await req("POST", "/api/airport/sessions", {
      iata: "TPE",
      arrivalTime:   FUTURE_ARRIVAL,
      departureTime: FUTURE_DEPARTURE,
      flightType: "international",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.session);
  });
});
