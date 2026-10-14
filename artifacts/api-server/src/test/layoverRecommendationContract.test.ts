/**
 * census-layover L216 (`recommendation_contract_violation`, target 0) and the
 * replay half of L217 (`decision_replay_mismatch`, target 0) — B58 lane LAY-2.
 *
 *   L216  every card `generateRecommendations` WRITES is checked against the
 *         one certified record it was rated with (layoverContractMonitor), the
 *         tally goes into the `recommendation_generated` audit event, and the
 *         admin route folds those tallies per window.
 *   L217  `replayStoredComputation` replays a STORED row — the decision columns
 *         as written — against its own stored inputs. `decisionsInWindow`
 *         cannot do it: it rebuilds a record by replaying, so it would compare a
 *         recomputation with a recomputation (positive control below).
 *
 * POSITIVE CONTROLS throughout: every "clean" assertion is paired with a planted
 * violation that must be named, and only it.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverRecommendationContract.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import {
  CONTRACT_CHECKS,
  LAYOVER_CONTRACT_MONITOR_VERSION,
  RATING_CERTIFIES_FIT,
  checkRecommendationContract,
  monitorRecommendationContract,
  recommendationContractCounters,
  recommendationContractWindow,
  _resetRecommendationContractCounters,
  type ContractCheck,
  type ContractRow,
} from "../services/airport/layoverContractMonitor.js";
import { computeLayoverMetrics } from "../services/airport/layoverObservability.js";
import {
  REPLAY_COMPARED_COLUMNS,
  replayStoredComputation,
  replayStoredComputations,
  type StoredComputationRow,
} from "../services/airport/layoverReplay.js";
import { certifySessionFeasibility, type FeasibilityAirport, type FeasibilitySession } from "../services/airport/LayoverFeasibility.js";
import { snapshotIdFor } from "../services/airport/layoverLedger.js";
import { LAYOVER_ENGINE_VERSION } from "../services/airport/LayoverSafetyEngine.js";
import type { EntryEligibility } from "../services/airport/layoverEntryGate.js";
import {
  DECISION_PERSISTENCE_FLAG,
  RECOMMENDATION_SNAPSHOT_FLAG,
  certifiedComputationRowFor,
  decisionsInWindow,
  storedComputationsInWindow,
} from "../services/layover/LayoverDecisionStore.js";
import { generateRecommendations, recommendationKey } from "../services/airport/LayoverRecommendationService.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-14T02:00:00.000Z");
const PERMITTED: EntryEligibility = { state: "permitted", status: "visa_free", corridor: { passportCountry: "GB", destinationCountry: "TW" } };

function feasAirport(): FeasibilityAirport {
  return {
    id: "airport-tpe", iataCode: "TPE", timezone: "Asia/Taipei", verified: true,
    domesticBufferMin: 60, internationalBufferMin: 120,
    immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
  };
}

function feasSession(hours: number, over: Partial<FeasibilitySession> = {}): FeasibilitySession {
  return {
    id: "session-1",
    arrivalTime: new Date(NOW).toISOString(),
    departureTime: new Date(NOW + hours * HOUR).toISOString(),
    boardingTime: null,
    flightType: "international",
    immigrationRequired: true,
    checkedBags: false,
    wantsToLeave: true,
    ...over,
  } as FeasibilitySession;
}

/** A 10-hour international layover with a permitted border: verdict `yes`, gate open. */
const OPEN = certifySessionFeasibility(feasAirport(), feasSession(10), { nowMs: NOW, entry: PERMITTED });
/** The same, but the traveller is staying airside: the landside gate is closed. */
const AIRSIDE = certifySessionFeasibility(feasAirport(), feasSession(10, { wantsToLeave: false }), { nowMs: NOW, entry: PERMITTED });

function row(record: typeof OPEN, over: Partial<ContractRow> = {}): ContractRow {
  return {
    safety_rating: "safe",
    travel_time_min: 0,
    activity_time_min: 30,
    return_buffer_min: record.deadline.breakdown.totalBuffer,
    hard_return_time: record.deadline.hardReturnTime.toISOString(),
    inside_airport: true,
    ...over,
  };
}

/** A landside card that is certified AND genuinely fits: 2 × 20 + 60 = 100 minutes. */
const fittingLandside = (record: typeof OPEN, over: Partial<ContractRow> = {}) =>
  row(record, { inside_airport: false, travel_time_min: 20, activity_time_min: 60, ...over });

function check(record: typeof OPEN, rows: ContractRow[], opts: { bands?: Map<string, { band: string }>; stamp?: string | null } = {}) {
  return checkRecommendationContract({
    sessionId: "session-1",
    record,
    rows,
    keys: rows.map((_, i) => `k${i}`),
    bands: opts.bands ?? new Map(),
    stampSnapshotId: opts.stamp ?? null,
  });
}

const checksOf = (r: ReturnType<typeof check>) => [...new Set(r.violations.map((v) => v.check))].sort();

// ── the checks, pure ─────────────────────────────────────────────────────────

describe("L216 — checkRecommendationContract: each check fires on its own violation and only it", () => {
  it("preconditions the cases below rest on (verdict yes / gate open; stay-airside closes it; the window is wide)", () => {
    assert.equal(OPEN.verdict, "yes");
    assert.equal(AIRSIDE.verdict, "stay_airside");
    assert.ok(OPEN.envelope.usableMinutes >= 100, `usable ${OPEN.envelope.usableMinutes}`);
  });

  it("CONTROL: a clean generation — airside, a fitting landside card, a refused landside card — checks every card and finds nothing", () => {
    const rows = [row(OPEN), fittingLandside(OPEN), row(OPEN, { inside_airport: false, safety_rating: "not_recommended", travel_time_min: 0, activity_time_min: 0 })];
    const r = check(OPEN, rows);
    assert.equal(r.checked, 3);
    assert.equal(r.violating, 0, JSON.stringify(r.violations));
    assert.deepEqual(r.byCheck, {});
  });

  it("instants, not strings: the certified deadline in PostgreSQL's spelling is the same deadline", () => {
    const pg = OPEN.deadline.hardReturnTime.toISOString().replace(/\.000Z$/, "+00:00");
    assert.notEqual(pg, OPEN.deadline.hardReturnTime.toISOString());
    assert.equal(check(OPEN, [row(OPEN, { hard_return_time: pg })]).violating, 0);
  });

  const cases: Array<{ check: ContractCheck; record: typeof OPEN; rows: ContractRow[]; bands?: Map<string, { band: string }>; stamp?: string | null }> = [
    { check: "HARD_RETURN_DIVERGES", record: OPEN, rows: [row(OPEN, { hard_return_time: new Date(OPEN.deadline.hardReturnTime.getTime() + 60_000).toISOString() })] },
    { check: "HARD_RETURN_DIVERGES", record: OPEN, rows: [row(OPEN, { hard_return_time: "not a time" })] },
    { check: "RETURN_BUFFER_DIVERGES", record: OPEN, rows: [row(OPEN, { return_buffer_min: OPEN.deadline.breakdown.totalBuffer + 1 })] },
    { check: "CERTIFIED_ON_UNSTATED_TIME", record: OPEN, rows: [fittingLandside(OPEN, { travel_time_min: 0 })] },
    { check: "CERTIFIED_ON_UNSTATED_TIME", record: OPEN, rows: [fittingLandside(OPEN, { safety_rating: "possible_but_risky", activity_time_min: 0 })] },
    { check: "CERTIFIED_ON_UNSTATED_TIME", record: OPEN, rows: [row(OPEN, { activity_time_min: 0 })] },
    { check: "EXCEEDS_CERTIFIED_WINDOW", record: OPEN, rows: [fittingLandside(OPEN, { travel_time_min: Math.ceil(OPEN.envelope.usableMinutes / 2) })] },
    { check: "LANDSIDE_PAST_CLOSED_GATE", record: AIRSIDE, rows: [row(AIRSIDE, { inside_airport: false, safety_rating: "airport_only", travel_time_min: 0, activity_time_min: 0 })] },
    { check: "ENVELOPE_BLOCKED_CANDIDATE", record: OPEN, rows: [row(OPEN, { inside_airport: false, safety_rating: "not_recommended", travel_time_min: 0, activity_time_min: 0 })], bands: new Map([["k0", { band: "BLOCKED" }]]) },
    { check: "SNAPSHOT_CITATION_DIVERGES", record: OPEN, rows: [row(OPEN, { snapshot_id: "snapshot-of-another-computation" })], stamp: snapshotIdFor("session-1", OPEN.inputHash) },
    { check: "SNAPSHOT_CITATION_DIVERGES", record: OPEN, rows: [row(OPEN, { snapshot_id: snapshotIdFor("session-1", OPEN.inputHash) })], stamp: null },
    { check: "SNAPSHOT_CITATION_DIVERGES", record: OPEN, rows: [row(OPEN)], stamp: snapshotIdFor("session-1", OPEN.inputHash) },
    { check: "SNAPSHOT_CITATION_DIVERGES", record: OPEN, rows: [row(OPEN, { snapshot_id: "stamp-for-another-record" })], stamp: "stamp-for-another-record" },
  ];
  for (const [i, c] of cases.entries()) {
    it(`${c.check} (#${i}) — named, and nothing else`, () => {
      const r = check(c.record, c.rows, { bands: c.bands, stamp: c.stamp });
      assert.deepEqual(checksOf(r), [c.check], JSON.stringify(r.violations));
      assert.equal(r.violating, 1);
    });
  }

  it("every check in the vocabulary has a planted case above", () => {
    assert.deepEqual([...new Set(cases.map((c) => c.check))].sort(), [...CONTRACT_CHECKS].sort());
  });

  it("CONTROL for the citation: a card citing exactly this request's stored snapshot is clean", () => {
    const id = snapshotIdFor("session-1", OPEN.inputHash);
    assert.equal(check(OPEN, [row(OPEN, { snapshot_id: id })], { stamp: id }).violating, 0);
  });

  it("CONTROL for the gate: the same landside card under the OPEN record is clean; a BLOCKED band on another key is not this card's", () => {
    const card = row(OPEN, { inside_airport: false, safety_rating: "airport_only", travel_time_min: 0, activity_time_min: 0 });
    assert.equal(check(OPEN, [card], { bands: new Map([["other", { band: "BLOCKED" }], ["k0", { band: "UNCERTIFIED" }]]) }).violating, 0);
  });

  it("CONTROL for the window: an out-and-back of exactly the certified usable minutes fits", () => {
    const usable = OPEN.envelope.usableMinutes;
    const leg = Math.floor((usable - 30) / 2);
    const card = fittingLandside(OPEN, { travel_time_min: leg, activity_time_min: usable - 2 * leg });
    assert.equal(2 * leg + (usable - 2 * leg), usable);
    assert.equal(check(OPEN, [card]).violating, 0);
    assert.deepEqual(checksOf(check(OPEN, [{ ...card, activity_time_min: usable - 2 * leg + 1 }])), ["EXCEEDS_CERTIFIED_WINDOW"]);
  });

  it("a refusal certifies nothing: unstated or overlong terms on a not_recommended / airport_only card are not violations", () => {
    for (const safety_rating of ["not_recommended", "airport_only"]) {
      const unstated = row(OPEN, { inside_airport: false, safety_rating, travel_time_min: 0, activity_time_min: 0 });
      const overlong = row(OPEN, { inside_airport: false, safety_rating, travel_time_min: OPEN.envelope.usableMinutes, activity_time_min: 60 });
      assert.equal(check(OPEN, [unstated, overlong]).violating, 0, safety_rating);
    }
  });

  it("a card that breaks two checks is ONE violating card, counted under both checks", () => {
    const r = check(OPEN, [row(OPEN, { return_buffer_min: 1, hard_return_time: "x" }), row(OPEN)]);
    assert.equal(r.checked, 2);
    assert.equal(r.violating, 1);
    assert.deepEqual(r.byCheck, { HARD_RETURN_DIVERGES: 1, RETURN_BUFFER_DIVERGES: 1 });
  });

  it("RATING_CERTIFIES_FIT: only safe and possible_but_risky certify", () => {
    assert.deepEqual(Object.entries(RATING_CERTIFIES_FIT).filter(([, v]) => v).map(([k]) => k).sort(), ["possible_but_risky", "safe"]);
  });
});

// ── the emission ─────────────────────────────────────────────────────────────

describe("L216 — monitorRecommendationContract counts, and never throws", () => {
  beforeEach(() => _resetRecommendationContractCounters());

  it("bumps the in-process counter by card and by check, and returns the tally the audit event stores", () => {
    const tally = monitorRecommendationContract({
      sessionId: "session-1", record: OPEN, rows: [row(OPEN, { return_buffer_min: 1 }), row(OPEN)], keys: ["a", "b"], bands: new Map(), stampSnapshotId: null,
    });
    assert.deepEqual(tally, { monitorVersion: LAYOVER_CONTRACT_MONITOR_VERSION, checked: 2, violating: 1, byCheck: { RETURN_BUFFER_DIVERGES: 1 } });
    const c = recommendationContractCounters();
    assert.deepEqual(c, { generations: 1, checked: 2, violating: 1, monitorFailures: 0, byCheck: { RETURN_BUFFER_DIVERGES: 1 } });
  });

  it("a monitor that throws reports `failed` — the cards are UNCHECKED, not clean — and the caller carries on", () => {
    const tally = monitorRecommendationContract({
      sessionId: "session-1", record: null as never, rows: [row(OPEN)], keys: ["a"], bands: new Map(), stampSnapshotId: null,
    });
    assert.deepEqual(tally, { monitorVersion: LAYOVER_CONTRACT_MONITOR_VERSION, failed: true });
    assert.equal(recommendationContractCounters().monitorFailures, 1);
    assert.equal(recommendationContractCounters().checked, 0);
  });
});

// ── the real producer ────────────────────────────────────────────────────────

const AIRPORT: AirportProfile = {
  id: "airport-tpe", iataCode: "TPE", name: "Taoyuan Intl", city: "Taoyuan",
  country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei", lat: 25.07, lng: 121.23,
  domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180,
  immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20, verified: false,
};

function liveSession(over: Partial<LayoverSession> = {}): LayoverSession {
  const now = Date.now();
  return {
    id: "session-1", userId: "user-1", airportId: "airport-tpe", tripId: null,
    arrivalTime: new Date(now + 5 * 60_000).toISOString(),
    departureTime: new Date(now + 9 * HOUR).toISOString(),
    boardingTime: null, layoverMinutes: 535,
    flightType: "international", immigrationRequired: false, checkedBags: false,
    loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate", vibeChips: ["food", "shopping", "culture"],
    manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
    canonicalCityId: null, shareCityStatus: false, returnReminderAt: null, status: "active",
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    ...over,
  } as LayoverSession;
}

/** A place 2,000 km away: the §8 envelope BLOCKS it at the straight-line lower bound. */
const FAR_PLACE = { id: "place-far", name: "Far Taoyuan Annex", place_type: "museum", category: "culture", neighborhood: null, blurb: null, verified: true, city: "Taoyuan", status: "active", lat: 43.06, lng: 141.35 };

function genTables(flags: string[] = []): Record<string, any[]> {
  return {
    feature_flags: flags.map((flag) => ({ flag, enabled: true })),
    discovery_places: [
      { id: "place-1", name: "Night Market", place_type: "attraction", category: "food", neighborhood: "Zhongli", blurb: "Snacks", verified: true, city: "Taoyuan", status: "active", lat: 24.96, lng: 121.22 },
      { id: "place-2", name: "Riverside Cafe", place_type: "cafe", category: "food", neighborhood: null, blurb: "Coffee", verified: false, city: "Taoyuan", status: "active", lat: null, lng: null },
      FAR_PLACE,
    ],
    layover_recommendations: [],
    layover_plan_stops: [],
    layover_events: [],
  };
}

const generatedEvent = (t: Record<string, any[]>) => {
  const evts = t.layover_events.filter((e) => e.event_type === "recommendation_generated");
  assert.equal(evts.length, 1, "one generation, one audit event");
  return evts[0];
};

describe("L216 — generateRecommendations checks every card it WRITES, and the audit event carries the tally", () => {
  beforeEach(() => _resetRecommendationContractCounters());

  for (const stableIds of [true, false]) {
    it(`stableIds=${stableIds}: tally.checked equals the rows written; the producer's own cards break nothing`, async () => {
      const t = genTables();
      const out = await generateRecommendations(makeLayoverDb(t) as never, AIRPORT, liveSession(), Date.now(), { stableIds });
      assert.equal(out.ok, true);
      const written = t.layover_recommendations.length;
      assert.ok(written >= 5, `inside + discovery + escape cards expected, got ${written}`);
      assert.ok(t.layover_recommendations.some((r) => r.inside_airport === false), "a landside card must be in the checked set, or the landside checks were never exercised");
      const { contract } = generatedEvent(t).metadata;
      assert.deepEqual(contract, { monitorVersion: LAYOVER_CONTRACT_MONITOR_VERSION, checked: written, violating: 0, byCheck: {} });
      assert.deepEqual(recommendationContractCounters(), { generations: 1, checked: written, violating: 0, monitorFailures: 0, byCheck: {} });
    });
  }

  it("the envelope's BLOCKED place is not written — the scenario the ENVELOPE_BLOCKED_CANDIDATE check guards is live here", async () => {
    const t = genTables();
    await generateRecommendations(makeLayoverDb(t) as never, AIRPORT, liveSession(), Date.now(), { stableIds: true });
    const keys = t.layover_recommendations.map((r) => r.rec_key);
    assert.ok(keys.includes("place:place-1"), "the near place is a card");
    assert.ok(!keys.includes(recommendationKey({ recType: "activity", title: FAR_PLACE.name, insideAirport: false, placeId: FAR_PLACE.id })), "the far place was blocked");
    assert.equal(generatedEvent(t).metadata.contract.violating, 0);
  });

  it("a traveller staying airside: no landside card, nothing violated (the scenario LANDSIDE_PAST_CLOSED_GATE guards)", async () => {
    const t = genTables();
    await generateRecommendations(makeLayoverDb(t) as never, AIRPORT, liveSession({ wantsToLeave: false }), Date.now(), { stableIds: true });
    assert.ok(t.layover_recommendations.length > 0);
    assert.ok(t.layover_recommendations.every((r) => r.inside_airport === true), "airside only");
    assert.deepEqual(generatedEvent(t).metadata.contract.violating, 0);
  });

  it("3623 ON: every card cites this request's stored snapshot, and the citation check passes on the real path", async () => {
    const t = genTables([RECOMMENDATION_SNAPSHOT_FLAG, DECISION_PERSISTENCE_FLAG]);
    await generateRecommendations(makeLayoverDb(t) as never, AIRPORT, liveSession(), Date.now(), { stableIds: true });
    assert.ok(t.layover_recommendations.every((r) => typeof r.snapshot_id === "string"), "every row cites");
    const { contract } = generatedEvent(t).metadata;
    assert.equal(contract.checked, t.layover_recommendations.length);
    assert.equal(contract.violating, 0, JSON.stringify(contract));
  });
});

// ── the window fold and the metric ───────────────────────────────────────────

const tallyOf = (checked: number, violating: number, byCheck: Record<string, number> = {}) =>
  ({ contract: { monitorVersion: LAYOVER_CONTRACT_MONITOR_VERSION, checked, violating, byCheck } });

describe("L216 — the window: tallies fold, the unreadable is never skipped silently", () => {
  it("sums the tallies; a generation from before the monitor is UNCHECKED and out of the denominator", () => {
    const w = recommendationContractWindow([tallyOf(6, 0), tallyOf(5, 2, { HARD_RETURN_DIVERGES: 2, RETURN_BUFFER_DIVERGES: 1 }), { count: 4 }], false);
    assert.equal(w.generations, 3);
    assert.equal(w.checkedGenerations, 2);
    assert.equal(w.unchecked, 1);
    assert.equal(w.malformed, 0);
    assert.equal(w.checked, 11);
    assert.equal(w.violating, 2);
    assert.equal(w.byCheck.HARD_RETURN_DIVERGES, 2);
    assert.equal(w.byCheck.RETURN_BUFFER_DIVERGES, 1);
    assert.equal(w.byCheck.SNAPSHOT_CITATION_DIVERGES, 0, "every check is reported, zeros included");
  });

  const bad: Array<[string, unknown]> = [
    ["a failed monitor", { contract: { monitorVersion: "x", failed: true } }],
    ["a failed monitor that also carries counts", { contract: { monitorVersion: "x", failed: true, checked: 4, violating: 0, byCheck: {} } }],
    ["null", { contract: null }],
    ["a string", { contract: "ok" }],
    ["violating > checked", tallyOf(1, 2)],
    ["a negative count", tallyOf(-1, 0)],
    ["a fractional count", tallyOf(1.5, 0)],
    ["an unknown check", tallyOf(2, 1, { NOT_A_CHECK: 1 })],
    ["a non-integer byCheck", tallyOf(2, 1, { HARD_RETURN_DIVERGES: "1" as never })],
    ["byCheck missing", { contract: { monitorVersion: "x", checked: 1, violating: 0 } }],
  ];
  for (const [name, m] of bad) {
    it(`MALFORMED, never skipped: ${name}`, () => {
      const w = recommendationContractWindow([tallyOf(3, 0), m], false);
      assert.equal(w.malformed, 1);
      assert.equal(w.checked, 3);
    });
  }

  it("computeLayoverMetrics: not read → UNPRODUCIBLE; nothing checked → UNPRODUCIBLE naming the unchecked; malformed → UNPRODUCIBLE; else the count of violating cards", () => {
    const metric = (contract: ReturnType<typeof recommendationContractWindow> | null) =>
      computeLayoverMetrics({ events: [], decisions: [], replay: null, contract }).find((m) => m.name === "recommendation_contract_violation")!;
    const none = metric(null);
    assert.equal(none.status, "UNPRODUCIBLE");
    assert.equal(none.value, null);
    assert.match(none.blockedBy!, /recommendation_generated/);

    const unchecked = metric(recommendationContractWindow([{ count: 3 }, { count: 2 }], false));
    assert.equal(unchecked.status, "UNPRODUCIBLE");
    assert.equal(unchecked.value, null, "zero checks is not zero violations");
    assert.match(unchecked.blockedBy!, /2 written before layoverContractMonitor/);

    const malformed = metric(recommendationContractWindow([tallyOf(10, 0), { contract: { failed: true } }], false));
    assert.equal(malformed.status, "UNPRODUCIBLE");
    assert.equal(malformed.value, null, "a failed generation could hide the violation");

    const clean = metric(recommendationContractWindow([tallyOf(7, 0), { count: 1 }], false));
    assert.deepEqual([clean.status, clean.value, clean.sampleSize, clean.target], ["OK", 0, 7, 0]);

    const dirty = metric(recommendationContractWindow([tallyOf(7, 0), tallyOf(4, 3, { EXCEEDS_CERTIFIED_WINDOW: 3 })], false));
    assert.deepEqual([dirty.status, dirty.value, dirty.sampleSize], ["OK", 3, 11]);
  });
});

// ── L217 — replaying STORED rows ─────────────────────────────────────────────

/** PostgreSQL's spelling of a timestamptz, as PostgREST returns it. */
const pgTs = (iso: string) => new Date(iso).toISOString().replace(/(\.000)?Z$/, "+00:00");

/** A row as the production writer builds it, through a JSONB round trip and PostgREST's timestamp spelling. */
function storedRow(record = OPEN, sessionId = "session-1"): StoredComputationRow {
  const r = JSON.parse(JSON.stringify(certifiedComputationRowFor("user-1", sessionId, record))) as Record<string, any>;
  for (const k of ["computed_at", "cutoff_at", "hard_return_time"]) r[k] = pgTs(r[k]);
  return r as StoredComputationRow;
}

describe("L217 — replayStoredComputation compares the decision AS WRITTEN with its own inputs", () => {
  it("CONTROL: a row from the production writer, through JSONB and PostgreSQL's timestamps, replays clean", () => {
    for (const rec of [OPEN, AIRSIDE, certifySessionFeasibility(feasAirport(), feasSession(3), { nowMs: NOW, entry: null })]) {
      const r = replayStoredComputation(storedRow(rec));
      assert.equal(r.status, "match", JSON.stringify(r));
      assert.deepEqual(r.mismatchedFields, []);
    }
  });

  const tamper: Record<(typeof REPLAY_COMPARED_COLUMNS)[number], (r: Record<string, any>) => void> = {
    input_hash: (r) => { r.input_hash = "sha256:" + "0".repeat(64); },
    snapshot_id: (r) => { r.snapshot_id = "snapshot-of-another-computation"; },
    computed_at: (r) => { r.computed_at = pgTs(new Date(Date.parse(r.computed_at) + 1000).toISOString()); },
    verdict: (r) => { r.verdict = r.verdict === "yes" ? "tight" : "yes"; },
    confidence: (r) => { r.confidence = r.confidence === "HIGH" ? "LOW" : "HIGH"; },
    buffer_percentile: (r) => { r.buffer_percentile = r.buffer_percentile === "p50" ? "p90" : "p50"; },
    cutoff_at: (r) => { r.cutoff_at = pgTs(new Date(Date.parse(r.cutoff_at) + 60_000).toISOString()); },
    hard_return_time: (r) => { r.hard_return_time = pgTs(new Date(Date.parse(r.hard_return_time) + 60_000).toISOString()); },
    total_buffer_min: (r) => { r.total_buffer_min += 1; },
    usable_minutes: (r) => { r.usable_minutes += 1; },
    breakdown: (r) => { r.breakdown = { ...r.breakdown, totalBuffer: r.breakdown.totalBuffer + 1 }; },
    reason_codes: (r) => { r.reason_codes = [...r.reason_codes, "RETURN_ROUTE_UNRELIABLE"]; },
    rules_applied: (r) => { r.rules_applied = r.rules_applied.slice(1); },
  };
  for (const col of REPLAY_COMPARED_COLUMNS) {
    it(`POSITIVE CONTROL: a tampered ${col} is a mismatch naming ${col}, and only it`, () => {
      const r = storedRow() as Record<string, any>;
      tamper[col](r);
      const out = replayStoredComputation(r as StoredComputationRow);
      assert.equal(out.status, "mismatch");
      assert.deepEqual(out.mismatchedFields, [col]);
    });
  }

  it("a dropped rule is reported as one the replay ADDS back", () => {
    const r = storedRow() as Record<string, any>;
    const dropped = r.rules_applied[0];
    r.rules_applied = r.rules_applied.slice(1);
    assert.deepEqual(replayStoredComputation(r as StoredComputationRow).rulesAdded, [dropped]);
  });

  it("refuses — never a mismatch — a row from other arithmetic or another record shape, and an unusable input set", () => {
    const eng = storedRow() as Record<string, any>; eng.engine_version = "1999.01.01-0";
    const engIn = storedRow() as Record<string, any>; engIn.inputs.engineVersion = "1999.01.01-0";
    const shape = storedRow() as Record<string, any>; shape.feasibility_version = "1999.01.01-0";
    const none = storedRow() as Record<string, any>; none.inputs = null;
    const junk = storedRow() as Record<string, any>; junk.inputs = { ...junk.inputs, session: null };
    assert.equal(replayStoredComputation(eng as StoredComputationRow).refusal, "ENGINE_VERSION_CHANGED");
    assert.equal(replayStoredComputation(engIn as StoredComputationRow).refusal, "ENGINE_VERSION_CHANGED");
    assert.equal(replayStoredComputation(shape as StoredComputationRow).refusal, "RECORD_SHAPE_CHANGED");
    assert.equal(replayStoredComputation(none as StoredComputationRow).refusal, "INPUTS_UNUSABLE");
    assert.equal(replayStoredComputation(junk as StoredComputationRow).refusal, "INPUTS_UNUSABLE");
    assert.equal(LAYOVER_ENGINE_VERSION === "1999.01.01-0", false);
  });

  it("the summary keeps refusals out of the denominator", () => {
    const bad = storedRow() as Record<string, any>; bad.usable_minutes += 5;
    const old = storedRow() as Record<string, any>; old.engine_version = "1999.01.01-0";
    const s = replayStoredComputations([storedRow(), bad as StoredComputationRow, old as StoredComputationRow]);
    assert.deepEqual([s.read, s.replayed, s.matched, s.mismatched, s.refused, s.mismatchRate], [3, 2, 1, 1, 1, 0.5]);
  });
});

describe("L217 — why the replay needs the stored COLUMNS: decisionsInWindow cannot see a tampered decision", () => {
  it("POSITIVE CONTROL: a forged hard_return_time is invisible to decisionsInWindow and named by the stored-row replay", async () => {
    const row = certifiedComputationRowFor("user-1", "session-1", OPEN);
    row.hard_return_time = new Date(OPEN.deadline.hardReturnTime.getTime() + 30 * 60_000).toISOString();
    const t = { layover_certified_computations: [row] };
    const db = makeLayoverDb(t) as never;
    const from = new Date(NOW - HOUR).toISOString();
    const to = new Date(NOW + HOUR).toISOString();

    const replayedRead = await decisionsInWindow(db, from, to);
    assert.equal(replayedRead.ok, true);
    if (!replayedRead.ok) return;
    assert.equal(replayedRead.value.records[0]!.result.hardReturnTime, OPEN.deadline.hardReturnTime.toISOString(),
      "decisionsInWindow rebuilds the record from its inputs — the forged column never reaches it");

    const stored = await storedComputationsInWindow(db, from, to);
    assert.equal(stored.ok, true);
    if (!stored.ok) return;
    const s = replayStoredComputations(stored.value.rows);
    assert.equal(s.mismatched, 1);
    assert.deepEqual(s.results[0]!.mismatchedFields, ["hard_return_time"]);
  });

  it("an unreadable table is a refusal, never an empty window", async () => {
    const db = makeLayoverDb({ layover_certified_computations: [] }, { failures: { "layover_certified_computations:select": { message: "down" } } }) as never;
    const r = await storedComputationsInWindow(db, new Date(NOW - HOUR).toISOString(), new Date(NOW).toISOString());
    assert.equal(r.ok, false);
  });
});
