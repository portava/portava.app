/**
 * census-layover L210 / L211 / L213 / L215 — spec §20's metrics, computed from
 * what is persisted, behind an admin route; and the fallback ladder emitting
 * when it fires.
 *
 * The decisions the route reads are written by the PRODUCTION writer
 * (`persistDecision`) from records the production certifier produced, into
 * `fakeLayoverDb` — so the route is checked against the rows it will meet, not
 * against a hand-written row shape.
 *
 * Run: node --import tsx/esm --test src/test/adminLayoverMetrics.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import adminLayoverMetricsRouter, { metricsWindowDays } from "../routes/adminLayoverMetrics.js";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import { persistDecision, DECISION_PERSISTENCE_FLAG } from "../services/layover/LayoverDecisionStore.js";
import { certifySessionFeasibility, type FeasibilityAirport } from "../services/airport/LayoverFeasibility.js";
import type { EntryEligibility } from "../services/airport/layoverEntryGate.js";
import {
  buildFallbackProfile,
  lookupByIata,
  staleFallbackCounters,
  _resetStaleFallbackCounters,
} from "../services/airport/AirportProfileService.js"; import { LAYOVER_CONTRACT_MONITOR_VERSION, CONTRACT_CHECKS, _resetRecommendationContractCounters } from "../services/airport/layoverContractMonitor.js"; import { generateRecommendations } from "../services/airport/LayoverRecommendationService.js"; import type { AirportProfile } from "../services/airport/AirportProfileService.js"; import type { LayoverSession } from "../services/airport/LayoverSessionService.js"; // census L216/L217 (B58 LAY-2) — one line: :102/:116/:155 are cited

let server: http.Server;
let base: string;
const ADMIN = "admin-token";
const USER = "user-token";

function get(path: string, token: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    http.get({ hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, headers: { authorization: `Bearer ${token}` } }, (res) => {
      let raw = ""; res.on("data", (c) => (raw += c));
      res.on("end", () => { let p: any; try { p = JSON.parse(raw); } catch { p = raw; } resolve({ status: res.statusCode ?? 0, body: p }); });
    }).on("error", reject);
  });
}

function airport(): FeasibilityAirport {
  return {
    id: "airport-tpe", iataCode: "TPE", timezone: "Asia/Taipei", verified: false,
    domesticBufferMin: 60, internationalBufferMin: 120,
    immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
  };
}
const PERMITTED: EntryEligibility = { state: "permitted", status: "visa_free", corridor: { passportCountry: "GB", destinationCountry: "TW" } };
const UNRESOLVED: EntryEligibility = { state: "unresolved", reason: "no_data_for_corridor" };

function record(sessionId: string, entry: EntryEligibility, minutes: number, airportId: string | null = "airport-tpe", agoMs = 3_600_000) {
  const nowMs = Date.now() - agoMs;
  return certifySessionFeasibility({ ...airport(), id: airportId } as FeasibilityAirport, {
    id: sessionId, arrivalTime: new Date(nowMs).toISOString(), departureTime: new Date(nowMs + minutes * 60_000).toISOString(),
    boardingTime: null, flightType: "international", immigrationRequired: true, checkedBags: false, wantsToLeave: true,
  } as never, { nowMs, entry });
}

function tables(opts: { persistence?: boolean } = {}) {
  const recent = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const old = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
  return {
    feature_flags: opts.persistence ? [{ flag: DECISION_PERSISTENCE_FLAG, enabled: true }] : [],
    profiles: [{ id: "admin-1", role: "admin" }, { id: "user-1", role: "user" }],
    layover_events: [
      { session_id: "s1", user_id: "user-1", event_type: "session_created", created_at: recent, metadata: {} },
      { session_id: "s2", user_id: "user-1", event_type: "session_created", created_at: recent, metadata: {} },
      { session_id: "s2", user_id: "user-1", event_type: "session_updated", created_at: recent, metadata: {} },
      { session_id: "s0", user_id: "user-1", event_type: "session_created", created_at: old, metadata: {} },
    ],
    layover_certified_computations: [] as any[],
    layover_time_budgets: [] as any[],
    layover_return_plans: [] as any[],
  };
}

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", adminLayoverMetricsRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const P = "/api/admin/layover/metrics";
const byName = (body: any, name: string) => body.metrics.find((m: any) => m.name === name);

describe("§20 metrics over persisted data (L210, L211, L213, L215)", () => {
  it("is admin-only", async () => {
    _setTestClient(makeLayoverDb(tables(), { users: { [USER]: "user-1" } }), true);
    const r = await get(P, USER);
    assert.equal(r.status, 403, JSON.stringify(r.body));
  });

  it("persistence OFF: counters from layover_events, every decision rate UNPRODUCIBLE — never 0", async () => {
    _setTestClient(makeLayoverDb(tables(), { users: { [ADMIN]: "admin-1" } }), true);
    const r = await get(P, ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.sources.decisions.state, "persistence_off");
    assert.equal(byName(r.body, "layover_sessions_detected").value, 2, "the 30-day-old session is outside the 7-day window");
    for (const n of ["critical_unknown_rate", "landside_eligible_rate", "return_warning_rate", "stale_fallback_rate"]) {
      const m = byName(r.body, n);
      assert.equal(m.status, "UNPRODUCIBLE", n);
      assert.equal(m.value, null, n);
      assert.match(m.blockedBy, /layover_decision_persistence_enabled/);
    }
  });

  it("persistence ON: the four rates are computed from the stored decisions", async () => {
    const t = tables({ persistence: true });
    const db = makeLayoverDb(t, { users: { [ADMIN]: "admin-1" } });
    const permitted = record("s1", PERMITTED, 600);
    const unresolved = record("s2", UNRESOLVED, 600, null); // a fallback airport: no airport_profiles row
    assert.equal((await persistDecision(db as never, "user-1", "s1", permitted)).ok, true);
    assert.equal((await persistDecision(db as never, "user-1", "s2", unresolved)).ok, true);
    // Outside the 7-day window: stored, and not counted.
    assert.equal((await persistDecision(db as never, "user-1", "s3", record("s3", UNRESOLVED, 600, null, 30 * 24 * 3_600_000))).ok, true);
    assert.equal(t.layover_certified_computations.length, 3);
    _setTestClient(db, true);
    const r = await get(P, ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.sources.decisions.state, "read");
    assert.equal(r.body.sources.decisions.rows, 2);
    const critical = byName(r.body, "critical_unknown_rate");
    assert.equal(critical.status, "OK");
    assert.equal(critical.sampleSize, 2);
    assert.equal(critical.value, 0.5, "only the unconfirmed border carries ENTRY_NOT_CONFIRMED");
    assert.equal(byName(r.body, "landside_eligible_rate").value, 1, "yes and entry_unverified both tell the traveller they may go");
    assert.equal(byName(r.body, "return_warning_rate").value, 0);
    assert.equal(byName(r.body, "stale_fallback_rate").value, 0.5, "one decision ran on GENERIC airport numbers (no airport row)");
    // Aggregates only.
    assert.ok(!JSON.stringify(r.body).includes("user-1"));
  });

  it("an unreadable source is a 503, never an empty window", async () => {
    _setTestClient(makeLayoverDb(tables(), { users: { [ADMIN]: "admin-1" }, failures: { "layover_events:select": { message: "boom" } } }), true);
    assert.equal((await get(P, ADMIN)).status, 503);
    _setTestClient(makeLayoverDb(tables({ persistence: true }), { users: { [ADMIN]: "admin-1" }, failures: { "layover_certified_computations:select": { message: "boom" } } }), true);
    assert.equal((await get(P, ADMIN)).status, 503);
  });

  it("?days is an integer in 1..90, else 7", () => {
    assert.equal(metricsWindowDays("30"), 30);
    for (const bad of ["0", "91", "2.5", "x", undefined]) assert.equal(metricsWindowDays(bad), 7);
  });
});

describe("L215 — the fallback ladder emits when it fires", () => {
  beforeEach(() => _resetStaleFallbackCounters());

  it("an airport with no row falls to the static dataset and is counted as no_airport_row", async () => {
    const db = makeLayoverDb({ airport_profiles: [] }, {});
    const r = await lookupByIata(db as never, "TPE");
    assert.equal(r.fromStatic, true);
    assert.deepEqual(staleFallbackCounters(), { "static_dataset:lookupByIata:no_airport_row": 1 });
  });

  it("an unreadable airport_profiles is counted apart from an absent row", async () => {
    const db = makeLayoverDb({ airport_profiles: [] }, { failures: { "airport_profiles:select": { message: "down" } } });
    await lookupByIata(db as never, "TPE");
    assert.deepEqual(staleFallbackCounters(), { "static_dataset:lookupByIata:airport_profiles_unreadable": 1 });
  });

  it("a curated row does not fire the ladder", async () => {
    const db = makeLayoverDb({ airport_profiles: [{ id: "a", iata_code: "TPE", name: "Taoyuan", city: "Taoyuan", country: "Taiwan", country_code: "TW", lat: 25, lng: 121, timezone: "Asia/Taipei" }] }, {});
    const r = await lookupByIata(db as never, "TPE");
    assert.equal(r.fromStatic, false);
    assert.deepEqual(staleFallbackCounters(), {});
  });

  it("the generic fallback profile is counted", () => {
    buildFallbackProfile({ iataCode: "ZZZ" });
    assert.deepEqual(staleFallbackCounters(), { "fallback_profile:buildFallbackProfile:no_airport_row": 1 });
  });

  it("the admin route reports the counter", async () => {
    buildFallbackProfile({ iataCode: "ZZZ" });
    _setTestClient(makeLayoverDb(tables(), { users: { [ADMIN]: "admin-1" } }), true);
    const r = await get(P, ADMIN);
    assert.deepEqual(r.body.staleFallbackSinceStart, { "fallback_profile:buildFallbackProfile:no_airport_row": 1 });
  });
});

// ── census-layover L216 / L217 (B58 lane LAY-2) ──────────────────────────────

const recent = () => new Date(Date.now() - 2 * 3_600_000).toISOString();
const generation = (contract: unknown, created_at = recent()) =>
  ({ session_id: "s1", user_id: "user-1", event_type: "recommendation_generated", created_at, metadata: contract === undefined ? { count: 3 } : { count: 3, contract } });
const tally = (checked: number, violating: number, byCheck: Record<string, number> = {}) =>
  ({ monitorVersion: LAYOVER_CONTRACT_MONITOR_VERSION, checked, violating, byCheck });

describe("L216 — recommendation_contract_violation over the window's generation tallies", () => {
  it("folds the window's tallies: violating cards over checked cards, by check; older generations are reported, not counted", async () => {
    const t = tables();
    t.layover_events.push(
      generation(tally(6, 0)),
      generation(tally(4, 1, { HARD_RETURN_DIVERGES: 1 })),
      generation(undefined), // written before the monitor existed
      generation(tally(9, 9, { RETURN_BUFFER_DIVERGES: 9 }), new Date(Date.now() - 30 * 24 * 3_600_000).toISOString()), // outside the window
    );
    _setTestClient(makeLayoverDb(t, { users: { [ADMIN]: "admin-1" } }), true);
    const r = await get(P, ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const m = byName(r.body, "recommendation_contract_violation");
    assert.deepEqual([m.status, m.value, m.sampleSize, m.target], ["OK", 1, 10, 0]);
    assert.deepEqual(r.body.sources.recommendationGenerations, { rows: 3, checked: 2, unchecked: 1, malformed: 0, truncated: false });
    assert.equal(r.body.recommendationContract.byCheck.HARD_RETURN_DIVERGES, 1);
    assert.equal(r.body.recommendationContract.byCheck.RETURN_BUFFER_DIVERGES, 0, "the 30-day-old generation is outside the 7-day window");
    assert.deepEqual(Object.keys(r.body.recommendationContract.byCheck).sort(), [...CONTRACT_CHECKS].sort());
  });

  it("no generation was checked: UNPRODUCIBLE, never a green 0", async () => {
    const t = tables();
    t.layover_events.push(generation(undefined));
    _setTestClient(makeLayoverDb(t, { users: { [ADMIN]: "admin-1" } }), true);
    const m = byName((await get(P, ADMIN)).body, "recommendation_contract_violation");
    assert.equal(m.status, "UNPRODUCIBLE");
    assert.equal(m.value, null);
  });

  it("a failed or unreadable tally makes it UNPRODUCIBLE — it could be hiding the violation", async () => {
    const t = tables();
    t.layover_events.push(generation(tally(6, 0)), generation({ monitorVersion: "x", failed: true }));
    _setTestClient(makeLayoverDb(t, { users: { [ADMIN]: "admin-1" } }), true);
    const r = await get(P, ADMIN);
    assert.equal(byName(r.body, "recommendation_contract_violation").status, "UNPRODUCIBLE");
    assert.equal(r.body.sources.recommendationGenerations.malformed, 1);
  });

  it("END TO END: the production generator writes the tallies and the route reports them — 0 violations over every card written", async () => {
    _resetRecommendationContractCounters();
    const t: Record<string, any[]> = {
      ...tables(),
      discovery_places: [{ id: "place-1", name: "Night Market", place_type: "attraction", category: "food", neighborhood: "Zhongli", blurb: null, verified: true, city: "Taoyuan", status: "active", lat: 24.96, lng: 121.22 }],
      layover_recommendations: [], layover_plan_stops: [],
    };
    const db = makeLayoverDb(t, { users: { [ADMIN]: "admin-1" } });
    const now = Date.now();
    const airportProfile = {
      id: "airport-tpe", iataCode: "TPE", name: "Taoyuan Intl", city: "Taoyuan", country: "Taiwan", countryCode: "TW",
      timezone: "Asia/Taipei", lat: 25.07, lng: 121.23, domesticBufferMin: 60, domesticBufferMax: 90,
      internationalBufferMin: 120, internationalBufferMax: 180, immigrationExtraMin: 30, checkedBagsExtraMin: 15,
      trafficExtraMin: 20, verified: false,
    } as AirportProfile;
    const sess = {
      id: "s1", userId: "user-1", airportId: "airport-tpe", tripId: null,
      arrivalTime: new Date(now).toISOString(), departureTime: new Date(now + 9 * 3_600_000).toISOString(),
      boardingTime: null, layoverMinutes: 540, flightType: "international", immigrationRequired: false, checkedBags: false,
      loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate", vibeChips: ["food"],
      manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null, canonicalCityId: null,
      shareCityStatus: false, returnReminderAt: null, status: "active",
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    } as unknown as LayoverSession;
    for (const stableIds of [true, false]) {
      const out = await generateRecommendations(db as never, airportProfile, sess, now, { stableIds });
      assert.equal(out.ok, true);
    }
    const written = t.layover_events.filter((e) => e.event_type === "recommendation_generated")
      .reduce((n, e) => n + e.metadata.count, 0);
    assert.ok(written >= 6, `two generations' cards, got ${written}`);
    _setTestClient(db, true);
    const r = await get(P, ADMIN);
    const m = byName(r.body, "recommendation_contract_violation");
    assert.deepEqual([m.status, m.value, m.sampleSize], ["OK", 0, written]);
    assert.equal(r.body.recommendationContractSinceStart.generations, 2);
    assert.equal(r.body.recommendationContractSinceStart.checked, written);
  });

  it("an unreadable layover_events is a 503, never an empty window — including when ONLY the generation read fails", async () => {
    _setTestClient(makeLayoverDb(tables(), { users: { [ADMIN]: "admin-1" }, failures: { "layover_events:select": { message: "boom" } } }), true);
    assert.equal((await get(P, ADMIN)).status, 503);
    // The double fails per table; this wrapper fails only the `recommendation_generated` read, so the
    // counters' read above it succeeds and the 503 can only come from the L216 read.
    const db = makeLayoverDb(tables(), { users: { [ADMIN]: "admin-1" } }) as any;
    const failing: any = {
      gte: () => failing, lt: () => failing, order: () => failing, limit: () => failing,
      then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "boom" } }).then(ok),
    };
    const onlyGenerationsFail = new Proxy(db, {
      get(target, prop) {
        if (prop !== "from") return target[prop];
        return (table: string) => {
          const b = target.from(table);
          if (table !== "layover_events") return b;
          const eq = b.eq.bind(b);
          b.eq = (col: string, v: unknown) => (col === "event_type" && v === "recommendation_generated" ? failing : eq(col, v));
          return b;
        };
      },
    });
    _setTestClient(onlyGenerationsFail, true);
    assert.equal((await get(P, ADMIN)).status, 503);
  });
});

describe("L217 — decision_replay_mismatch replays the window's STORED rows (persistence ON only)", () => {
  it("persistence OFF: UNPRODUCIBLE — no replay pass ran — and the route says so", async () => {
    _setTestClient(makeLayoverDb(tables(), { users: { [ADMIN]: "admin-1" } }), true);
    const r = await get(P, ADMIN);
    const m = byName(r.body, "decision_replay_mismatch");
    assert.equal(m.status, "UNPRODUCIBLE");
    assert.match(m.blockedBy, /layover_decision_persistence_enabled/);
    assert.deepEqual(r.body.sources.replay, { state: "persistence_off", rows: 0, truncated: false });
    assert.equal(r.body.replay, null);
  });

  it("persistence ON: rows the production writer stored replay clean — 0, earned over the rows read", async () => {
    const t = tables({ persistence: true });
    const db = makeLayoverDb(t, { users: { [ADMIN]: "admin-1" } });
    assert.equal((await persistDecision(db as never, "user-1", "s1", record("s1", PERMITTED, 600))).ok, true);
    assert.equal((await persistDecision(db as never, "user-1", "s2", record("s2", UNRESOLVED, 600, null))).ok, true);
    // JSONB: the route reads what the database hands back, not the writer's objects.
    t.layover_certified_computations = JSON.parse(JSON.stringify(t.layover_certified_computations));
    _setTestClient(db, true);
    const r = await get(P, ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const m = byName(r.body, "decision_replay_mismatch");
    assert.deepEqual([m.status, m.value, m.sampleSize, m.target], ["OK", 0, 2, 0]);
    assert.deepEqual(r.body.sources.replay, { state: "replayed", rows: 2, truncated: false });
    assert.equal(r.body.replay.matched, 2);
  });

  it("POSITIVE CONTROL: a stored decision forged after the fact is a mismatch, named by column — and no row identifier leaves the route", async () => {
    const t = tables({ persistence: true });
    const db = makeLayoverDb(t, { users: { [ADMIN]: "admin-1" } });
    await persistDecision(db as never, "user-1", "s1", record("s1", PERMITTED, 600));
    await persistDecision(db as never, "user-1", "s2", record("s2", PERMITTED, 480));
    const forged = t.layover_certified_computations[1];
    forged.hard_return_time = new Date(Date.parse(forged.hard_return_time) + 45 * 60_000).toISOString();
    forged.usable_minutes += 45;
    _setTestClient(db, true);
    const r = await get(P, ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const m = byName(r.body, "decision_replay_mismatch");
    assert.deepEqual([m.status, m.value, m.sampleSize], ["OK", 0.5, 2]);
    assert.deepEqual(r.body.replay.mismatchedColumns, { hard_return_time: 1, usable_minutes: 1 });
    // The decision rates still read the REPLAYED record (decisionsInWindow), which is why they cannot see the forgery.
    assert.equal(r.body.sources.decisions.rows, 2);
    const body = JSON.stringify(r.body);
    for (const leak of ["user-1", "\"s1\"", "\"s2\"", forged.snapshot_id]) assert.ok(!body.includes(leak), `leaked ${leak}`);
  });

  it("a row from other arithmetic is REFUSED: out of the denominator, and the metric says nothing was replayable", async () => {
    const t = tables({ persistence: true });
    const db = makeLayoverDb(t, { users: { [ADMIN]: "admin-1" } });
    await persistDecision(db as never, "user-1", "s1", record("s1", PERMITTED, 600));
    t.layover_certified_computations[0].engine_version = "1999.01.01-0";
    _setTestClient(db, true);
    const r = await get(P, ADMIN);
    const m = byName(r.body, "decision_replay_mismatch");
    assert.equal(m.status, "UNPRODUCIBLE");
    assert.match(m.blockedBy, /ENGINE_VERSION_CHANGED 1/);
    assert.equal(r.body.replay.refusalsByReason.ENGINE_VERSION_CHANGED, 1);
  });
});
