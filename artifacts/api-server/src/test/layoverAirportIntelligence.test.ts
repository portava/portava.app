/**
 * §2.1 "missing live intelligence degrades VISIBLY" · §22 "do not imply
 * equivalent intelligence globally" — census L9 and L250.
 *
 * Both rows name the SAME gap in the same words. L9: *"`publicAirport` still
 * exposes only a `verified` boolean and a generic-buffer session is still
 * indistinguishable from a curated one at the client."* L250: *"the airport's
 * own data maturity is never disclosed, so a curated airport and a
 * generic-fallback one present identical confidence."*
 *
 * The fallback LADDER has been real since the first census (DB row → static
 * dataset → `buildFallbackProfile`), and §16 closed the "never fabricate
 * freshness" half by deleting the invented travel times. What was still
 * missing is the word VISIBLY: three different provenances produced one
 * indistinguishable answer, so a traveller at an airport nobody has ever
 * curated read the same numbers, with the same confidence, as one at an
 * airport an admin had configured by hand.
 *
 * WHAT THIS PINS, and why each assertion is not vacuous.
 *
 * 1. THE DISCLOSURE IS DERIVED, NOT DECLARED. `airportIntelligence` reads the
 *    record's own `estimates` — the same objects the arithmetic was built out
 *    of — so it cannot drift from what the buffer actually used. A test that
 *    asserted a hand-set field would pass over a disclosure that lied.
 *
 * 2. THE THREE PROVENANCES DIFFER. The whole of L250 is that they must not
 *    present identically, so the assertion is an INEQUALITY between two real
 *    records certified from two real profiles, not a shape check on one.
 *
 * 3. IT REACHES A CLIENT. Server-side truth nothing publishes is exactly the
 *    reachability `W` this census has spent three passes on, so the route
 *    assertions go through the REAL router: `GET /overview` and
 *    `GET /safety` must both carry the block.
 *
 * 4. THE ABSENCE OF LIVE INTELLIGENCE IS STATED, not implied by silence.
 *    `liveObserved` is false on every request this tree can make, and the
 *    disclosure says so rather than leaving the field off.
 *
 * FALSE GREENS CONSIDERED. `liveObserved: false` is asserted TOGETHER with a
 * positive control that flips it when live conditions ARE supplied — otherwise
 * the field could be hard-coded `false` and every case would still pass. The
 * route cases assert exact status 200 and exact field values, never
 * `status !== 500`, and `req.log` is installed so a handler throw cannot
 * masquerade as a considered refusal.
 *
 * Run: node --import tsx/esm --test src/test/layoverAirportIntelligence.test.ts
 *
 * ── MUTATION LOG ─────────────────────────────────────────────────────────────
 * Recorded after the fix, in §17.4 of docs/architecture/census-layover.md.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import {
  airportIntelligence,
  certifySessionFeasibility,
  type AirportIntelligenceDisclosure,
} from "../services/airport/LayoverFeasibility.js";
import {
  airportRowToProfile,
  buildFallbackProfile,
  type AirportProfile,
} from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";

let server: http.Server;
let base: string;
const TOKEN = "intel-token";
const USER_ID = "user-1";

function req(method: string, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { let p: any; try { p = JSON.parse(raw); } catch { p = raw; } resolve({ status: res.statusCode ?? 0, body: p }); });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

function stage(airport: Record<string, any> | null, sessionOver: Record<string, any> = {}) {
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_safety_engine_enabled", enabled: true },
    ],
    airport_profiles: airport ? [airport] : [],
    layover_sessions: [sessionRow({
      user_id: USER_ID,
      airport_id: airport ? airport.id : null,
      manual_iata: airport ? null : "ZZZ",
      manual_city: airport ? null : "Nowhere",
      ...sessionOver,
    })],
    layover_events: [],
    layover_plan_stops: [],
    trip_plan_items: [],
  };
  _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: USER_ID } }), true);
  return tables;
}

/** A session shaped like the one `sessionRow` stages, for the direct calls. */
function session(): LayoverSession {
  const now = Date.now();
  return {
    id: "session-1", userId: USER_ID, airportId: "airport-tpe", tripId: null,
    arrivalTime: new Date(now + 5 * 60_000).toISOString(),
    departureTime: new Date(now + 8 * 3_600_000).toISOString(),
    boardingTime: null, layoverMinutes: 475,
    flightType: "international", immigrationRequired: true, checkedBags: false,
    loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate", vibeChips: ["food"],
    manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
    canonicalCityId: null, shareCityStatus: false, returnReminderAt: null,
    status: "active",
    createdAt: new Date(now - 60_000).toISOString(),
    updatedAt: new Date(now - 60_000).toISOString(),
  } as LayoverSession;
}

function disclose(airport: AirportProfile): AirportIntelligenceDisclosure {
  return airportIntelligence(certifySessionFeasibility(airport, session(), { nowMs: Date.now() }));
}

const CURATED  = airportRowToProfile(airportRow({ verified: true }));
const UNCURATED = airportRowToProfile(airportRow({ verified: false }));
const GENERIC  = buildFallbackProfile({ iataCode: "zzz", city: "Nowhere" });

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

describe("airportIntelligence — the provenance of the numbers, read off the estimates", () => {
  it("a generic fallback profile discloses GENERIC and says nothing about the airport went in", () => {
    const d = disclose(GENERIC);
    assert.equal(d.tier, "GENERIC");
    assert.equal(d.airportAddressable, false);
    assert.equal(d.airportVerified, false);
    assert.equal(d.bufferSourceClass, "STATIC_DEFAULT");
    assert.equal(d.bufferFallbackLevel, 3);
    // The refs must name the CONSTANT, not a column that was never read.
    assert.ok(
      d.sourceRefs.every((r) => !r.startsWith("airport_profiles.")),
      `a generic profile claimed an airport_profiles column: ${JSON.stringify(d.sourceRefs)}`,
    );
  });

  it("an UNVERIFIED airport_profiles row discloses AIRPORT_RECORD — addressable, not curated", () => {
    const d = disclose(UNCURATED);
    assert.equal(d.tier, "AIRPORT_RECORD");
    assert.equal(d.airportAddressable, true);
    assert.equal(d.airportVerified, false);
    assert.equal(d.bufferSourceClass, "AIRPORT_PROFILE");
    assert.equal(d.bufferFallbackLevel, 2);
    assert.ok(
      d.sourceRefs.includes("airport_profiles.international_buffer_min"),
      `the refs do not name the column the buffer came from: ${JSON.stringify(d.sourceRefs)}`,
    );
  });

  it("a VERIFIED row discloses VERIFIED_RECORD", () => {
    const d = disclose(CURATED);
    assert.equal(d.tier, "VERIFIED_RECORD");
    assert.equal(d.airportAddressable, true);
    assert.equal(d.airportVerified, true);
  });

  // ── L250, stated as the inequality it is ──────────────────────────────────
  it("a curated airport and a generic-fallback one no longer present identically", () => {
    const curated = disclose(CURATED);
    const generic = disclose(GENERIC);
    assert.notEqual(curated.tier, generic.tier);
    assert.notEqual(curated.bufferFallbackLevel, generic.bufferFallbackLevel);
    assert.notEqual(curated.bufferSourceClass, generic.bufferSourceClass);
    assert.notDeepEqual(curated.sourceRefs, generic.sourceRefs);
    // And the uncurated row is a THIRD answer, not a rounding of either.
    const uncurated = disclose(UNCURATED);
    assert.notEqual(uncurated.tier, curated.tier);
    assert.notEqual(uncurated.tier, generic.tier);
  });

  /**
   * MEASURED, AND IT IS WHY THE SCALAR WAS NEVER ENOUGH.
   *
   * `record.confidence` is `worstConfidence` folded over EVERY estimate behind
   * the verdict, and two of those — `exitDelay` (the 45/25/15/+20 constants)
   * and `timeOfDayExtra` (the band ramp) — are STATIC_DEFAULT/LOW at every
   * airport on earth by construction. So the record's confidence is LOW for a
   * verified airport and LOW for a generic fallback, and it always will be
   * until one of those two constants gets a producer.
   *
   * A disclosure built on the scalar would therefore have closed L250 by
   * reporting a number that cannot move. This case is the pin that says so: if
   * someone later "fixes" the disclosure by publishing `confidence` alone, this
   * assertion is the one that records that it distinguishes nothing.
   */
  it("the record's single confidence scalar canNOT tell the two apart — the per-term provenance is the answer", () => {
    assert.equal(disclose(CURATED).confidence, disclose(GENERIC).confidence);
    assert.equal(disclose(CURATED).confidence, "LOW");
  });

  /**
   * THE TWO FOLDS ARE CORRECT BY CONSTRUCTION AND WERE PINNED BY NOTHING.
   *
   * MEASURED, and this case exists because of it: turning
   * `bufferFallbackLevel`'s worst-wins reduce into a BEST-wins one left the
   * whole file at 9/9. `bufferEstimates` gives all four airport-supplied terms
   * the same `rowClass`/`rowLevel`, so max and min are the same number on every
   * record this tree can build, and the direction of the fold was unobservable
   * through the certifier — exactly as §13.6 records for the `rankActivities`
   * deadline parameter.
   *
   * The fold becomes load-bearing the day one term gets a producer the others
   * do not (a live immigration wait, a historical traffic aggregate), and a
   * disclosure that then reported the BEST rung would tell a traveller the
   * numbers were better sourced than they are. So it is pinned HERE, on the
   * function, over a record whose terms deliberately disagree — which is the
   * only place the difference is reachable today.
   */
  it("a single weak term drags BOTH folds down — worst wins, not best", () => {
    const base = certifySessionFeasibility(CURATED, session(), { nowMs: Date.now() });
    assert.equal(airportIntelligence(base).bufferFallbackLevel, 2, "fixture precondition: a row record is level 2");
    assert.equal(airportIntelligence(base).bufferSourceClass, "AIRPORT_PROFILE");

    const mixed = {
      ...base,
      estimates: {
        ...base.estimates,
        // One of the four terms falls back to a code constant while the other
        // three keep the airport's own row.
        trafficExtra: { ...base.estimates.trafficExtra, sourceClass: "STATIC_DEFAULT" as const, fallbackLevel: 3 as const },
      },
    };
    const d = airportIntelligence(mixed);
    assert.equal(d.bufferFallbackLevel, 3, "the worst fallback level did not win");
    assert.equal(d.bufferSourceClass, "STATIC_DEFAULT", "the weakest source class did not win");
    // And the tier follows the same rule: three curated columns and one
    // constant is NOT a curated airport.
    assert.equal(d.airportAddressable, false);
    assert.equal(d.tier, "GENERIC");
  });

  it("the absence of live intelligence is stated, and the field is not hard-coded false", () => {
    assert.equal(disclose(CURATED).liveObserved, false, "a request with no live conditions claimed a live reading");

    // POSITIVE CONTROL. Without this, `liveObserved: false` could be a literal
    // and every case above would still pass.
    const observed = new Date().toISOString();
    const live = airportIntelligence(certifySessionFeasibility(CURATED, session(), {
      nowMs: Date.now(),
      liveConditions: {
        securityWaitExtraMin: 40,
        immigrationWaitExtraMin: 0,
        groundTransportExtraMin: 0,
        reasonCodes: [],
        observedAt: observed,
        expiresAt: new Date(Date.parse(observed) + 20 * 60_000).toISOString(),
      },
    }));
    assert.equal(live.liveObserved, true, "a supplied live observation did not reach the disclosure");
    assert.equal(live.tier, "LIVE");
  });
});

describe("the disclosure reaches a client — GET /overview and GET /safety", () => {
  it("GET /overview publishes airportIntelligence for a generic-fallback session", async () => {
    stage(null);
    const r = await req("GET", "/api/airport/sessions/session-1/overview");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.airportIntelligence, "the overview carries no airportIntelligence block at all");
    assert.equal(r.body.airportIntelligence.tier, "GENERIC");
    assert.equal(r.body.airportIntelligence.airportAddressable, false);
    assert.equal(r.body.airportIntelligence.liveObserved, false);
  });

  it("GET /overview discloses a VERIFIED airport differently from a generic one", async () => {
    stage(airportRow({ verified: true }));
    const r = await req("GET", "/api/airport/sessions/session-1/overview");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.airportIntelligence.tier, "VERIFIED_RECORD");
    assert.equal(r.body.airportIntelligence.airportAddressable, true);
    assert.equal(r.body.airportIntelligence.airportVerified, true);
  });

  it("GET /safety publishes the same block", async () => {
    stage(airportRow({ verified: false }));
    const r = await req("GET", "/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.airportIntelligence.tier, "AIRPORT_RECORD");
    assert.equal(r.body.airportIntelligence.bufferSourceClass, "AIRPORT_PROFILE");
  });
});

// ── THE RUNG A PRODUCTION TRAVELLER ACTUALLY SEES ────────────────────────────
//
// TRIPWIRE, NOT A FIX. Nothing below changes behaviour; it pins what the
// four-rung disclosure resolves to on the data this product actually has, so
// that the day the rung starts meaning something else, a test says so.
//
// The rung is genuinely DERIVED — `airportIntelligence` reads `record.estimates`
// and the separating signal is `a.id === null` in `bufferEstimates` — but the
// evidence it reads is ADDRESSABILITY, never CURATION:
//
//   * `AIRPORT_RECORD` means "an `airport_profiles` row supplied every buffer
//     term". 0127 declares those columns `NOT NULL DEFAULT 60/90/120/180/30/15/20`,
//     and `upsertAirportProfile` writes exactly those defaults for an airport
//     nobody has configured — so a row supplying a term and a row supplying
//     NOTHING ABOUT THIS AIRPORT are the same row.
//   * Production, from this repository's own committed measurement
//     (`src/lib/capability/layover-cutover-measurement.json`): 3,206
//     `airport_profiles` rows, 0 verified, 0 with any non-default buffer. So
//     `VERIFIED_RECORD` is unreached, `LIVE` has no producer anywhere on this
//     tree, and every session created through `POST /airport/sessions` gets an
//     `airport_id` — which leaves `AIRPORT_RECORD` as the only rung a traveller
//     can be shown.
//
// Whether the GENERIC rung should instead be reached by an uncurated row — or
// should WITHHOLD landside guidance, census L243/L249 — is an OWNER DECISION
// recorded in the census and deliberately not taken here.
describe("the four rungs, measured against the airports this product has", () => {
  it("an uncurated row and a generic fallback publish DIFFERENT rungs and IDENTICAL minutes", () => {
    const s = session();
    const now = Date.now();
    const uncuratedRec = certifySessionFeasibility(UNCURATED, s, { nowMs: now });
    const genericRec   = certifySessionFeasibility(GENERIC,   s, { nowMs: now });

    // The disclosure is not vacuous: it does separate the two.
    assert.equal(airportIntelligence(uncuratedRec).tier, "AIRPORT_RECORD");
    assert.equal(airportIntelligence(genericRec).tier, "GENERIC");

    // And what it separates is not the advice. Compare the four terms the
    // AIRPORT is said to supply, by value, rather than asserting constants.
    const terms = (r: typeof uncuratedRec) => ({
      baseBuffer:       r.estimates.baseBuffer.valueMinutes,
      immigrationExtra: r.estimates.immigrationExtra.valueMinutes,
      bagsExtra:        r.estimates.bagsExtra.valueMinutes,
      trafficExtra:     r.estimates.trafficExtra.valueMinutes,
    });
    assert.deepEqual(
      terms(uncuratedRec), terms(genericRec),
      "an uncurated airport_profiles row no longer holds the generic defaults — the rung may now mean curation, and this tripwire is stale",
    );
    assert.equal(
      new Date(uncuratedRec.deadline.hardReturnTime).getTime(),
      new Date(genericRec.deadline.hardReturnTime).getTime(),
      "the two rungs now produce different deadlines — re-read the rung's contract",
    );
  });

  it("a CURATED row is the control: when a value really differs, the minutes differ too", () => {
    const s = session();
    const now = Date.now();
    const curated = airportRowToProfile(airportRow({ verified: true, international_buffer_min: 200 }));
    const a = certifySessionFeasibility(curated, s, { nowMs: now });
    const b = certifySessionFeasibility(GENERIC, s, { nowMs: now });
    assert.notEqual(a.estimates.baseBuffer.valueMinutes, b.estimates.baseBuffer.valueMinutes,
      "the control that stops the case above from passing because the arithmetic ignores the row entirely");
  });

  it("three of the four rungs are unreached on this tree, and the reasons are different", () => {
    // VERIFIED_RECORD: reachable in code, empty in production (0 of 3,206).
    assert.equal(airportIntelligence(certifySessionFeasibility(CURATED, session(), { nowMs: Date.now() })).tier,
      "VERIFIED_RECORD");
    // LIVE: no producer anywhere outside src/test/ — liveConditions is null on
    // every request this tree can make, which the suite above pins positively.
    assert.equal(
      airportIntelligence(certifySessionFeasibility(UNCURATED, session(), { nowMs: Date.now() })).liveObserved,
      false,
    );
  });
});
