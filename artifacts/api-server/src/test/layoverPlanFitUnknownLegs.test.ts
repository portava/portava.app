/**
 * layoverPlanFitUnknownLegs — census-layover L47, "an unknown leg costs zero
 * minutes".
 *
 * THE ROW'S OWN WORDS (§9.5, the last statement made about L47):
 *   "`computePlanFit` still sums `(durationMin ?? 0) + (travelMin ?? 0)`."
 * and, from the body row it revises:
 *   "the plan-level check launders unknowns into the optimistic value … so a
 *    stop with no travel time reports `fitsWindow: true`."
 *
 * WHY THAT IS A DEFECT A TRAVELLER HITS, not a bookkeeping complaint. `planFit`
 * is the verdict the mini-plan card renders — a green meter and the sentence
 * "fits with room", or "Over by N". `layover_plan_stops.travel_min` is
 * `INTEGER NOT NULL DEFAULT 0` (migration 0127), so the database cannot hold
 * "nobody said how long it takes to get there": an unstated journey is stored
 * as the number zero, and zero minutes to a place OUTSIDE the airport is not a
 * travel time, it is the absence of one. The plan form offers that value in one
 * tap — the travel chip labelled "none" — and `POST /stops` used to accept a
 * landside stop with no `travelMin` at all, because the schema carried
 * `.default(0)`. The traveller was then told an itinerary fits a window it was
 * never measured against, and told it TWICE: the outbound leg was free and the
 * ride back, approximated from that same leg, was free as well.
 *
 * WHAT IS PINNED HERE.
 *   A. `computePlanFit`, through the routes that publish it — a stop whose
 *      journey is not a stated figure can REFUSE a plan (the lower bound
 *      already overflows) but can never CERTIFY one.
 *   B. the write boundary — a landside stop with no travel time is refused
 *      rather than stored as zero, on all three writers (`POST /stops`,
 *      `POST /stops/from-recommendation`, `PATCH /stops/:stopId`).
 *
 * Block B exists because block A alone would be a verdict computed over rows
 * whose unknown-ness had already been thrown away, and because the row's
 * companion sentence is "stop writes stop laundering `null` into `0`".
 *
 * SEEN GOING RED FIRST: 17 cases, 13 failed against the unfixed tree.
 *
 * ── MUTATIONS RUN, each against PRODUCTION code, reverted and `cmp`-verified ─
 * 17 pass / 0 fail unmutated.
 *   1. an unstated landside leg charged 0 again (L47's own defect) ....... 3 failed
 *   2. the verdict certifying on a lower bound (`unknown` → `fits`) ...... 3 failed
 *   3. `landsideTravelRefusal` opened — the write boundary accepts it .... 5 failed
 *   4. `stopRowToJson` substituting a 30-minute duration again ........... 1 failed
 *   5. PATCH no longer validating the MERGED row ........................ 2 failed
 *   6. from-recommendation copying the card's silence into the plan ..... 1 failed
 *   7. the ride back borrowing an EARLIER stated leg ..................... 1 failed
 *   8. the ride back dropped entirely ................................... 1 failed
 *   9. an airside stop's 0 no longer a fact (OVER-refusal guard) ......... 2 failed
 *
 * ONE ATTEMPTED MUTATION WAS NOT ONE, and it is recorded rather than counted:
 * rewriting `statedTravelMin(lastOutside) ?? 0` as `Number(lastOutside.travelMin) || 0`
 * failed NOTHING — correctly, because `lastOutside` is by construction a stop
 * that is NOT inside the airport, and on that domain the two expressions agree
 * for every value the column's `CHECK (travel_min BETWEEN 0 AND 240)` permits.
 * It is a refactor, not a behaviour change. 7 and 8 above are the mutations
 * that actually reach the return leg.
 *
 * Runtime: node:test + node:assert/strict (NOT vitest). Express + the layover
 * database double. No network.
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverPlanFitUnknownLegs.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";

const TOKEN = "plan-fit-token";
const USER_ID = "user-1";
const SESSION = "session-1";

let server: http.Server;
let base: string;

function call(method: string, p: string, body?: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(p, base);
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname, method,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let parsed: any; try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** A stop row shaped like `layover_plan_stops`. */
function stopRow(over: Record<string, any> = {}): Record<string, any> {
  return {
    id: "stop-1", session_id: SESSION, title: "A stop", description: null,
    stop_order: 0, duration_min: 30, travel_min: 20,
    place_id: null, recommendation_id: null, lat: null, lng: null,
    location_label: null, inside_airport: false, source: "user",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...over,
  };
}

function stage(opts: { stops?: any[]; recs?: any[] } = {}) {
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_safety_engine_enabled", enabled: true },
      { flag: "layover_plans_enabled", enabled: true },
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({ id: SESSION, user_id: USER_ID })],
    layover_plan_stops: opts.stops ?? [],
    layover_recommendations: opts.recs ?? [],
    layover_events: [],
    discovery_places: [],
    blocks: [],
    profiles: [],
  };
  _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: USER_ID } }) as any, true);
  return tables;
}

const getStops = () => call("GET", `/api/airport/sessions/${SESSION}/stops`);

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { error() {}, info() {}, warn() {}, debug() {} };
    next();
  });
  app.use("/api", airportRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as any).port}`;
      resolve();
    });
  });
});

after(() => { server?.close(); _setTestClient(null as any, false); });

/* ── A. the verdict ──────────────────────────────────────────────────────── */

describe("A. computePlanFit — an unstated leg can refuse a plan, never certify one", () => {
  it("A0 — vacuity: the fixture really does have a window big enough to fit a short stop", async () => {
    stage({ stops: [stopRow({ duration_min: 30, travel_min: 20 })] });
    const r = await getStops();
    assert.equal(r.status, 200);
    assert.ok(
      r.body.planFit.usableMinutes > 90,
      `every other case below is meaningless if the window is already too small; saw ${r.body.planFit.usableMinutes}`,
    );
  });

  it("A1 — THE DEFECT: a landside stop with no travel time is NOT a fit", async () => {
    // One tap: the plan form's travel chip labelled "none" on a stop outside
    // the airport. Before the fix this answered `fitsWindow: true` — the
    // traveller was told a journey nobody had measured fits.
    stage({ stops: [stopRow({ title: "Night market", duration_min: 60, travel_min: 0, inside_airport: false })] });
    const r = await getStops();

    assert.equal(r.status, 200);
    assert.equal(r.body.planFit.fitsWindow, false,
      "a stop outside the airport reached in zero minutes is not a travel time, it is the absence of one");
    assert.equal(r.body.planFit.fit, "unknown",
      "and the answer is UNKNOWN, not OVER — the plan may well fit, nobody has measured it");
    assert.equal(r.body.planFit.unstatedTravelStops, 1);
    assert.equal(r.body.planFit.neededMinIsLowerBound, true);
  });

  it("A2 — an INSIDE-airport stop with zero travel still fits: 0 there is a fact", async () => {
    // The refusal must be about the unknown, not about the number 0. A lounge
    // is airside; its travel time is zero by construction, and a rule that
    // refused it would have made every airport-only plan unverifiable.
    stage({ stops: [stopRow({ title: "Lounge", duration_min: 60, travel_min: 0, inside_airport: true })] });
    const r = await getStops();

    assert.equal(r.body.planFit.fit, "fits");
    assert.equal(r.body.planFit.fitsWindow, true);
    assert.equal(r.body.planFit.unstatedTravelStops, 0);
    assert.equal(r.body.planFit.neededMinIsLowerBound, false);
  });

  it("A3 — a landside stop WITH a stated travel time still fits, and the ride back is charged", async () => {
    stage({ stops: [stopRow({ title: "Din Tai Fung", duration_min: 60, travel_min: 25, inside_airport: false })] });
    const r = await getStops();

    assert.equal(r.body.planFit.fit, "fits");
    assert.equal(r.body.planFit.totalPlannedMin, 85, "60 dwell + 25 out");
    assert.equal(r.body.planFit.returnTravelMin, 25, "the ride back, approximated from the last outside leg");
    assert.equal(r.body.planFit.neededMin, 110);
  });

  it("A4 — a LOWER BOUND CAN REFUSE: an unknown leg plus a certain overflow is `over`", async () => {
    // The distinction the requirement turns on. Ignoring an unstated leg makes
    // `neededMin` too SMALL; if even that figure does not fit, the refusal is
    // sound and must not be softened into "unknown".
    stage({
      stops: [
        stopRow({ id: "s1", title: "All-day hike", stop_order: 0, duration_min: 700, travel_min: 0, inside_airport: false }),
      ],
    });
    const r = await getStops();

    assert.equal(r.body.planFit.fit, "over");
    assert.equal(r.body.planFit.fitsWindow, false);
    assert.ok(r.body.planFit.overflowMin > 0);
    assert.equal(r.body.planFit.unstatedTravelStops, 1,
      "the unknown is still reported — the refusal is certain, the size of the overflow is not");
  });

  it("A5 — the unstated leg is EXCLUDED from neededMin rather than counted as zero", async () => {
    // Counting it as 0 and omitting it produce the same integer; what separates
    // them is the claim attached to it. The known stop is charged in full, the
    // unknown one contributes its dwell only, and the total is labelled.
    stage({
      stops: [
        stopRow({ id: "s1", title: "Known", stop_order: 0, duration_min: 30, travel_min: 15, inside_airport: false }),
        stopRow({ id: "s2", title: "Unknown", stop_order: 1, duration_min: 45, travel_min: 0, inside_airport: false }),
      ],
    });
    const r = await getStops();

    assert.equal(r.body.planFit.totalPlannedMin, 90, "30 + 15 + 45, and NOTHING for the leg nobody stated");
    assert.equal(r.body.planFit.returnTravelMin, 0,
      "the ride back is approximated from the LAST outside stop, whose leg is unstated — so it is unstated too");
    assert.equal(r.body.planFit.neededMinIsLowerBound, true);
    assert.equal(r.body.planFit.fit, "unknown");
  });

  it("A6 — an empty plan is a fit, and says nothing is unstated", async () => {
    stage({ stops: [] });
    const r = await getStops();
    assert.equal(r.body.planFit.fit, "fits");
    assert.equal(r.body.planFit.neededMin, 0);
    assert.equal(r.body.planFit.unstatedTravelStops, 0);
  });

  it("A7 — a stop whose stored duration is missing is unstated too, not a fabricated 30 minutes", async () => {
    // `stopRowToJson` read `row.duration_min ?? 30`: a row with no duration was
    // given one. The column is NOT NULL today, so this is the defensive half —
    // but the substitution was the same shape as the travel one and is gone.
    stage({ stops: [stopRow({ title: "No duration", duration_min: null, travel_min: 20, inside_airport: false })] });
    const r = await getStops();

    assert.equal(r.body.stops[0].durationMin, 0, "0 means nobody said, and nothing pretends otherwise");
    assert.equal(r.body.planFit.fit, "unknown");
    assert.equal(r.body.planFit.unstatedDurationStops, 1);
  });
});

/* ── B. the write boundary ───────────────────────────────────────────────── */

describe("B. stop writes stop laundering an unstated leg into zero", () => {
  it("B1 — POST /stops: a landside stop with NO travelMin is refused, and nothing is written", async () => {
    // `travelMin: z.number()…optional().default(0)` is where the unknown died.
    const tables = stage();
    const r = await call("POST", `/api/airport/sessions/${SESSION}/stops`, {
      title: "Night market", durationMin: 60,
    });

    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
    assert.match(String(r.body.message), /travel time/i);
    assert.equal(tables.layover_plan_stops.length, 0,
      "storing it as 0 is what made the plan-fit verdict a guess a traveller could not see");
  });

  it("B2 — POST /stops: a landside stop with travelMin 0 is refused for the same reason", async () => {
    const tables = stage();
    const r = await call("POST", `/api/airport/sessions/${SESSION}/stops`, {
      title: "Night market", durationMin: 60, travelMin: 0, insideAirport: false,
    });

    assert.equal(r.status, 400);
    assert.equal(tables.layover_plan_stops.length, 0);
  });

  it("B3 — POST /stops: an INSIDE-airport stop needs no travel time and is stored at 0", async () => {
    const tables = stage();
    const r = await call("POST", `/api/airport/sessions/${SESSION}/stops`, {
      title: "Lounge", durationMin: 60, insideAirport: true,
    });

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(tables.layover_plan_stops.length, 1);
    assert.equal(tables.layover_plan_stops[0]!.travel_min, 0);
    assert.equal(r.body.planFit.fit, "fits");
  });

  it("B4 — POST /stops: a landside stop WITH a travel time is accepted (vacuity guard)", async () => {
    const tables = stage();
    const r = await call("POST", `/api/airport/sessions/${SESSION}/stops`, {
      title: "Din Tai Fung", durationMin: 60, travelMin: 25,
    });

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(tables.layover_plan_stops.length, 1);
    assert.equal(tables.layover_plan_stops[0]!.travel_min, 25);
  });

  it("B5 — from-recommendation: a landside card with no travel time is refused, not stored as 0", async () => {
    const tables = stage({
      recs: [{
        id: "rec-1", session_id: SESSION, rec_type: "near_airport", title: "A place",
        description: null, safety_rating: "safe", travel_time_min: 0, activity_time_min: 45,
        inside_airport: false, location_label: "Downtown", place_id: null, status: "active",
        source: "ai", sort_order: 0, created_at: new Date().toISOString(),
      }],
    });
    const r = await call("POST", `/api/airport/sessions/${SESSION}/stops/from-recommendation`, {
      recommendationId: "rec-1",
    });

    assert.equal(r.status, 400, `expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(tables.layover_plan_stops.length, 0,
      "`travel_time_min ?? 0` copied the card's silence into the plan as a measured zero");
  });

  it("B6 — from-recommendation: an inside-airport card is still addable with no travel time", async () => {
    const tables = stage({
      recs: [{
        id: "rec-2", session_id: SESSION, rec_type: "inside_airport", title: "Noodle bar",
        description: null, safety_rating: "safe", travel_time_min: 0, activity_time_min: 30,
        inside_airport: true, location_label: "Inside airport", place_id: null, status: "active",
        source: "ai", sort_order: 0, created_at: new Date().toISOString(),
      }],
    });
    const r = await call("POST", `/api/airport/sessions/${SESSION}/stops/from-recommendation`, {
      recommendationId: "rec-2",
    });

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(tables.layover_plan_stops.length, 1);
    assert.equal(tables.layover_plan_stops[0]!.travel_min, 0);
  });

  it("B7 — PATCH: moving a stop OUTSIDE the airport without giving it a travel time is refused", async () => {
    // The patch route validates one field at a time, so the rule has to be
    // checked against the MERGED row: `insideAirport: false` alone turns a
    // lawful airside 0 into an unstated landside one.
    const tables = stage({ stops: [stopRow({ id: "stop-1", travel_min: 0, inside_airport: true })] });
    const r = await call("PATCH", `/api/airport/sessions/${SESSION}/stops/stop-1`, {
      insideAirport: false,
    });

    assert.equal(r.status, 400, `expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(tables.layover_plan_stops[0]!.inside_airport, true, "the row must not have moved");
  });

  it("B8 — PATCH: setting a landside stop's travel time to 0 is refused", async () => {
    const tables = stage({ stops: [stopRow({ id: "stop-1", travel_min: 25, inside_airport: false })] });
    const r = await call("PATCH", `/api/airport/sessions/${SESSION}/stops/stop-1`, {
      travelMin: 0,
    });

    assert.equal(r.status, 400, `expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(tables.layover_plan_stops[0]!.travel_min, 25);
  });

  it("B9 — PATCH: a lawful edit still goes through (vacuity guard)", async () => {
    const tables = stage({ stops: [stopRow({ id: "stop-1", travel_min: 25, inside_airport: false })] });
    const r = await call("PATCH", `/api/airport/sessions/${SESSION}/stops/stop-1`, {
      travelMin: 35, durationMin: 45,
    });

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(tables.layover_plan_stops[0]!.travel_min, 35);
    assert.equal(tables.layover_plan_stops[0]!.duration_min, 45);
  });
});
