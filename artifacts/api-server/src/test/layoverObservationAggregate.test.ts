/**
 * §17 L204 — "Aggregated airport intelligence must not leak raw user identifiers",
 * and the k-anonymity floor that makes the aggregate safe to publish at all.
 *
 * node:test + node:assert (NOT vitest). Fake table-backed DB, no network.
 *
 * ── WHY THIS ROW WAS `N` AND WHAT CHANGED UNDER IT ───────────────────────────
 * census-layover L204 reads NOT-BUILT with the reason "No aggregated airport
 * intelligence exists to leak from." That was true when it was written and it
 * is the weakest possible form of a prohibition: the census's own rule calls it
 * `∅`, "unguarded absence — the forbidden path simply does not exist and
 * nothing guards against it being added."
 *
 * The path exists now. `POST /airport/sessions/:id/observations` is live and
 * reachable (gated only by `airport_mode_enabled`, TRUE in production), it
 * writes `airport_fact_observations`, and migrations 2860 and 2982 are BOTH
 * APPLIED to production. So the moment anything folds those rows into a
 * per-airport number, there is something to leak from — and the guard has to
 * exist before the aggregate does, not after.
 *
 * ── THE TWO PROPERTIES PROVED HERE ───────────────────────────────────────────
 *  1. NO IDENTIFIER SURVIVES AGGREGATION. Not the raw `user_id` (which never
 *     reaches the table at all — 2860 forbids it), and not the pseudonymous
 *     `tv1-…` observer handle, which IS on every row and IS correlatable at one
 *     airport. `assertNoObserverIdentifiers` walks the finished aggregate and
 *     THROWS; the reader calls it before returning, so a future field that
 *     carried a handle would fail loudly instead of shipping.
 *
 *  2. A BAND BUILT BY ONE PERSON IS NOT PUBLISHED. `buildHistoricalModel`'s
 *     own floor is `MIN_SAMPLES_PER_BAND = 5` SAMPLES, which one traveller can
 *     satisfy alone: `OBSERVATION_RATE_LIMIT` permits 3 per 15 minutes, so five
 *     readings inside one local hour is a half-hour of button presses. A p90
 *     over one person's five readings is that person's afternoon, published as
 *     an airport-level fact and attributable to them by anyone who knows they
 *     were there. The distinct-OBSERVER floor is what this file pins.
 *
 * ── RED FIRST ────────────────────────────────────────────────────────────────
 * Case "a band five readings deep from ONE observer is withheld" was written
 * and run against a first implementation that forwarded `buildHistoricalModel`
 * directly, with only the sample floor. It FAILED (the band was published with
 * `samples: 5`). The distinct-observer floor is what turned it green.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverObservationAggregate.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import {
  MIN_DISTINCT_OBSERVERS_PER_BAND,
  assertNoObserverIdentifiers,
  readAirportObservationAggregate,
  type AirportObservationAggregate,
} from "../services/layover/LayoverObservationAggregate.js";
import { MIN_SAMPLES_PER_BAND } from "../services/airport/LayoverAirportTruth.js";
import { travellerObserverHandle } from "../services/layover/LayoverObservationService.js";

const TZ = "Asia/Taipei";
/** 10:00 local at TPE, so every observation below lands in one local hour. */
const NOW = Date.parse("2026-09-13T02:00:00.000Z");
const MIN = 60_000;

process.env.LAYOVER_OBSERVER_PEPPER ??= "test-pepper-not-a-secret";

let seq = 0;
function obs(over: {
  observerId: string;
  value: number;
  atMs?: number;
  factType?: string;
  airportRef?: string;
  observerKind?: string;
}) {
  seq += 1;
  const at = over.atMs ?? NOW - 10 * MIN;
  return {
    id: `obs-${seq}`,
    airport_ref: over.airportRef ?? "TPE",
    fact_type: over.factType ?? "queue_report_minutes",
    fact_class: "TRAVELER_OBSERVATION",
    value: over.value,
    observer_kind: over.observerKind ?? "community",
    observer_id: over.observerId,
    observer_trust: null,
    source_ref: "portava:layover/traveller-report",
    observed_at: new Date(at).toISOString(),
    expires_at: new Date(at + 45 * MIN).toISOString(),
    created_at: new Date(at).toISOString(),
    submission_token: `tok-${seq}`,
  };
}

/** n DISTINCT handles, each reporting once — the corroborated shape. */
function distinct(n: number, value = 12) {
  return Array.from({ length: n }, (_, i) =>
    obs({ observerId: travellerObserverHandle(`user-${i}`, "TPE"), value: value + i }),
  );
}

/** One handle reporting n times — the shape the sample floor cannot tell apart. */
function repeated(n: number, value = 12) {
  const handle = travellerObserverHandle("user-solo", "TPE");
  return Array.from({ length: n }, (_, i) =>
    obs({ observerId: handle, value: value + i, atMs: NOW - (10 + i) * MIN }),
  );
}

async function read(rows: any[], opts: Parameters<typeof makeLayoverDb>[1] = {}) {
  const db = makeLayoverDb({ airport_fact_observations: rows }, opts);
  return readAirportObservationAggregate(db as any, "TPE", TZ, NOW);
}

function ok(r: Awaited<ReturnType<typeof read>>): AirportObservationAggregate {
  if (!r.ok) assert.fail(`expected an aggregate, got refusal: ${r.reason}`);
  return r.aggregate;
}

const queueFact = (a: AirportObservationAggregate) =>
  a.facts.find((f) => f.factType === "queue_report_minutes")!;

describe("L204 — the aggregate carries no observer identity", () => {
  it("publishes a band from enough DISTINCT observers, and names no one", async () => {
    const a = ok(await read(distinct(MIN_SAMPLES_PER_BAND)));
    const fact = queueFact(a);
    assert.ok(fact.bands.length > 0, "expected a published band");
    assert.equal(fact.distinctObservers, MIN_SAMPLES_PER_BAND);

    // The whole serialised aggregate, searched for every identity that went in.
    const json = JSON.stringify(a);
    for (let i = 0; i < MIN_SAMPLES_PER_BAND; i++) {
      const handle = travellerObserverHandle(`user-${i}`, "TPE");
      assert.equal(json.includes(handle), false, `observer handle ${handle} leaked`);
      assert.equal(json.includes(`user-${i}`), false, `raw user id user-${i} leaked`);
    }
    assert.equal(json.includes("obs-"), false, "a row id leaked");
    assert.equal(json.includes("submission_token"), false, "an idempotency token leaked");
  });

  it("the guard is REAL: it throws on an aggregate that carries a handle", () => {
    const handle = travellerObserverHandle("user-1", "TPE");
    const poisoned = {
      airportRef: "TPE",
      truthVersion: "x",
      computedAt: new Date(NOW).toISOString(),
      minSamplesPerBand: MIN_SAMPLES_PER_BAND,
      minDistinctObserversPerBand: MIN_DISTINCT_OBSERVERS_PER_BAND,
      observations: 1,
      distinctObservers: 1,
      facts: [{ factType: "queue_report_minutes", observations: 1, distinctObservers: 1, bands: [], withheldBands: 0, topObserver: handle }],
    } as unknown as AirportObservationAggregate;
    assert.throws(() => assertNoObserverIdentifiers(poisoned), /identifier/i);
  });

  it("the guard refuses a bare UUID too — a profiles id is the thing 2860 forbids", () => {
    const poisoned = {
      airportRef: "TPE",
      truthVersion: "x",
      computedAt: new Date(NOW).toISOString(),
      minSamplesPerBand: MIN_SAMPLES_PER_BAND,
      minDistinctObserversPerBand: MIN_DISTINCT_OBSERVERS_PER_BAND,
      observations: 1,
      distinctObservers: 1,
      facts: [{ factType: "queue_report_minutes", observations: 1, distinctObservers: 1, bands: [], withheldBands: 0, reportedBy: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" }],
    } as unknown as AirportObservationAggregate;
    assert.throws(() => assertNoObserverIdentifiers(poisoned), /identifier/i);
  });

  it("POSITIVE CONTROL: the guard does NOT fire on an airportRef that is a profile UUID", async () => {
    // An airport without an IATA code is filed under its profile id. That id is
    // an AIRPORT's id, not a person's, and refusing it would make the guard
    // unusable for exactly the airports that need it most.
    const db = makeLayoverDb({ airport_fact_observations: [] });
    const r = await readAirportObservationAggregate(
      db as any, "3f2504e0-4f89-11d3-9a0c-0305e82c3301", TZ, NOW,
    );
    assert.equal(r.ok, true);
  });
});

describe("L204 — one person is not a distribution", () => {
  it("a band five readings deep from ONE observer is withheld", async () => {
    const rows = repeated(MIN_SAMPLES_PER_BAND);
    assert.ok(
      MIN_SAMPLES_PER_BAND >= 1 && rows.length === MIN_SAMPLES_PER_BAND,
      "the sample floor alone would publish this band",
    );
    const fact = queueFact(ok(await read(rows)));
    assert.equal(fact.distinctObservers, 1);
    assert.deepEqual(fact.bands, [], "a single traveller's afternoon was published as an airport fact");
    assert.ok(fact.withheldBands >= 1, "the withholding must be COUNTED, not silent");
  });

  it("the same five readings from five people ARE published", async () => {
    const fact = queueFact(ok(await read(distinct(MIN_SAMPLES_PER_BAND))));
    assert.equal(fact.bands.length, 1);
    assert.equal(fact.bands[0]!.samples, MIN_SAMPLES_PER_BAND);
    assert.equal(fact.withheldBands, 0);
  });

  it("the floor is a floor: one observer short and nothing is published", async () => {
    // Enough SAMPLES, one too few OBSERVERS. Built by padding a distinct set
    // back down with repeats so the sample count is held constant.
    const base = distinct(MIN_DISTINCT_OBSERVERS_PER_BAND - 1);
    const pad = Array.from({ length: MIN_SAMPLES_PER_BAND - base.length }, (_, i) =>
      obs({ observerId: base[0]!.observer_id, value: 30 + i, atMs: NOW - (20 + i) * MIN }),
    );
    const fact = queueFact(ok(await read([...base, ...pad])));
    assert.equal(fact.observations, MIN_SAMPLES_PER_BAND);
    assert.equal(fact.distinctObservers, MIN_DISTINCT_OBSERVERS_PER_BAND - 1);
    assert.deepEqual(fact.bands, []);
  });
});

describe("L204 — the read refuses rather than reporting an empty airport", () => {
  it("an unreadable corpus is `ok: false`, never a zero aggregate", async () => {
    const r = await read(distinct(MIN_SAMPLES_PER_BAND), {
      failures: { "airport_fact_observations:select": { message: "boom" } },
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "read_failed");
  });

  it("a genuinely empty airport is `ok: true` with zeroes — absence is not failure", async () => {
    const a = ok(await read([]));
    assert.equal(a.observations, 0);
    assert.equal(a.distinctObservers, 0);
    assert.ok(a.facts.length >= 1, "every submittable fact type is reported, even at zero");
    for (const f of a.facts) assert.deepEqual(f.bands, []);
  });
});

describe("L246 — the maturity SIGNAL the ladder reads", () => {
  it("an uncorroborated corpus contributes ZERO observations to the ladder", async () => {
    const a = ok(await read(repeated(MIN_SAMPLES_PER_BAND)));
    assert.equal(a.observations, MIN_SAMPLES_PER_BAND);
    // The rung is about an airport being OBSERVED, and one person is not the
    // travelling public. `maturityObservationCount` is the number the ladder
    // may use, and it is not the raw row count.
    assert.equal(a.maturityObservationCount, 0);
  });

  it("a corroborated corpus contributes its full count", async () => {
    const a = ok(await read(distinct(MIN_DISTINCT_OBSERVERS_PER_BAND)));
    assert.equal(a.distinctObservers, MIN_DISTINCT_OBSERVERS_PER_BAND);
    assert.equal(a.maturityObservationCount, MIN_DISTINCT_OBSERVERS_PER_BAND);
  });
});
