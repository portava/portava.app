/**
 * §22 L249 — "Enable features per airport maturity", wired.
 *
 * node:test + node:assert (NOT vitest). Fake table-backed DB, no network.
 *
 * ── THE ROW, AND WHY IT WAS `N` ──────────────────────────────────────────────
 * census-layover L249 reads NOT-BUILT: *"The maturity model classifies and
 * states policy; nothing consults it before generating a landside
 * recommendation."* `layoverMaturity.ts` says the same thing about itself in
 * its own header — *"IT IS NOT WIRED … that decision lives in
 * `LayoverRecommendationService.ts`, which this work does not own."*
 *
 * It is wired now, and the wiring is DELIBERATELY UNREACHABLE on every database
 * that exists. `layover_maturity_gate_enabled` is seeded FALSE by migration
 * 2977 and may only be turned on through `toggle_feature_flag_with_audit`.
 * Turning it on WITHDRAWS landside recommendations from every airport below
 * L1_MAPPED — which is all 3,206 production rows, none of them verified and
 * none carrying `terminal_info` — and that is L243's "airport-side guidance
 * only by default", an OWNER decision, not a deployment step.
 *
 * ── SO THE FIRST PROPERTY THIS FILE PROVES IS THAT NOTHING MOVED ─────────────
 * With the flag off, or absent, or unreadable, the decision is `allowed: true`
 * AND no observation read happens at all. A gate that quietly costs a database
 * round trip per dashboard load while doing nothing is not free, and a gate
 * that changes a traveller's cards while seeded off is a lie about its own
 * seeding.
 *
 * ── AND THE SECOND IS THAT IT IS A REAL GATE WHEN ON ─────────────────────────
 * A positive control, because "return L0 and refuse everything" passes every
 * refusal assertion forever: an airport that HAS cleared L1 must be allowed.
 *
 * ── RED FIRST ────────────────────────────────────────────────────────────────
 * Every case here failed before `layoverMaturityGate.ts` existed (module not
 * found). The two that failed on BEHAVIOUR rather than on absence, against a
 * first implementation that classified without reading the corpus, are
 * "an unreadable corpus cannot PROMOTE a rung" and "the flag being off costs no
 * read" — the first published L3 off an unreadable corpus, the second read the
 * corpus unconditionally.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverMaturityGate.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import {
  LAYOVER_MATURITY_GATE_FLAG,
  landsideMaturityDecision,
  maturitySignalsFor,
} from "../services/airport/layoverMaturityGate.js";
import { airportMaturity, featureAllowedAt } from "../services/airport/layoverMaturity.js";
import { MIN_DISTINCT_OBSERVERS_PER_BAND } from "../services/layover/LayoverObservationAggregate.js";
import { travellerObserverHandle } from "../services/layover/LayoverObservationService.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";

const NOW = Date.parse("2026-09-13T02:00:00.000Z");
const MIN = 60_000;

process.env.LAYOVER_OBSERVER_PEPPER ??= "test-pepper-not-a-secret";

const AIRPORT: AirportProfile = {
  id: "airport-tpe", iataCode: "TPE", name: "Taoyuan Intl", city: "Taoyuan",
  country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei", lat: 25.07, lng: 121.23,
  domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180,
  immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20, verified: false,
};

const airport = (over: Partial<AirportProfile> = {}): AirportProfile => ({ ...AIRPORT, ...over });

let seq = 0;
function observationRows(distinctObservers: number, perObserver = 2) {
  const rows = [];
  for (let i = 0; i < distinctObservers; i++) {
    for (let k = 0; k < perObserver; k++) {
      seq += 1;
      const at = NOW - (5 + k) * MIN;
      rows.push({
        id: `obs-${seq}`,
        airport_ref: "TPE",
        fact_type: "queue_report_minutes",
        fact_class: "TRAVELER_OBSERVATION",
        value: 10 + i,
        observer_kind: "community",
        observer_id: travellerObserverHandle(`user-${i}`, "TPE"),
        observer_trust: null,
        source_ref: "portava:layover/traveller-report",
        observed_at: new Date(at).toISOString(),
        expires_at: new Date(at + 45 * MIN).toISOString(),
        created_at: new Date(at).toISOString(),
        submission_token: `tok-${seq}`,
      });
    }
  }
  return rows;
}

function db(opts: { on?: boolean | "absent"; rows?: any[]; failObservations?: boolean } = {}) {
  const flags =
    opts.on === "absent"
      ? []
      : [{ flag: LAYOVER_MATURITY_GATE_FLAG, enabled: Boolean(opts.on) }];
  const reads: string[] = [];
  const base = makeLayoverDb(
    { feature_flags: flags, airport_fact_observations: opts.rows ?? [] },
    opts.failObservations
      ? { failures: { "airport_fact_observations:select": { message: "boom" } } }
      : {},
  );
  const spy = {
    ...base,
    from(table: string) {
      reads.push(table);
      return (base as any).from(table);
    },
  };
  return { client: spy as any, reads };
}

describe("L249 — the gate is OFF, and OFF means nothing changed", () => {
  it("a FALSE flag allows landside and reads no observation", async () => {
    const { client, reads } = db({ on: false });
    const d = await landsideMaturityDecision(client, airport(), NOW);
    assert.equal(d.flagOn, false);
    assert.equal(d.allowed, true);
    assert.equal(d.observationCount, null);
    assert.equal(reads.includes("airport_fact_observations"), false,
      "the flag being off must cost no observation read");
  });

  it("an ABSENT flag row behaves exactly like a FALSE one", async () => {
    const { client } = db({ on: "absent" });
    const d = await landsideMaturityDecision(client, airport(), NOW);
    assert.equal(d.flagOn, false);
    assert.equal(d.allowed, true);
  });

  it("an UNREADABLE feature_flags table leaves the gate off, not on", async () => {
    const base = makeLayoverDb(
      { feature_flags: [{ flag: LAYOVER_MATURITY_GATE_FLAG, enabled: true }] },
      { failures: { "feature_flags:select": { message: "boom" } } },
    );
    const d = await landsideMaturityDecision(base as any, airport(), NOW);
    assert.equal(d.flagOn, false);
    assert.equal(d.allowed, true);
  });

  it("the level and the disclosure are published even with the gate off", async () => {
    // The classification is free — it reads fields already in hand — and L250
    // is about a surface being ABLE to say which rung it is on. Withholding the
    // rung because the ENFORCEMENT is off would conflate two requirements.
    const { client } = db({ on: false });
    const d = await landsideMaturityDecision(client, airport(), NOW);
    assert.equal(d.level, "L0_GENERIC");
    assert.equal(d.disclosure.confidence, "limited");
    assert.equal(d.disclosure.reasonCode, "AIRPORT_MATURITY_LIMITED");
    assert.ok(d.cappedBy && d.cappedBy.length > 0);
  });
});

describe("L249 — the gate is ON, and ON is a real gate", () => {
  it("an L0_GENERIC airport is REFUSED landside recommendations", async () => {
    const { client } = db({ on: true });
    const d = await landsideMaturityDecision(client, airport({ verified: false }), NOW);
    assert.equal(d.flagOn, true);
    assert.equal(d.level, "L0_GENERIC");
    assert.equal(d.allowed, false);
  });

  it("the generic FALLBACK profile (no row at all) is refused for a different reason", async () => {
    const { client } = db({ on: true });
    const d = await landsideMaturityDecision(client, airport({ id: null }), NOW);
    assert.equal(d.allowed, false);
    assert.match(String(d.cappedBy), /airport_profiles row/i);
  });

  it("POSITIVE CONTROL: an airport that has cleared L1 IS allowed", async () => {
    const { client } = db({ on: true });
    const mapped = airport({
      verified: true,
      terminalInfo: { terminals: [{ code: "T1" }] },
    });
    const d = await landsideMaturityDecision(client, mapped, NOW, {
      routedTransportModelAvailable: true,
    });
    assert.equal(d.level, "L1_MAPPED");
    assert.equal(d.allowed, true);
    assert.equal(featureAllowedAt("landside_recommendations", d.level), true);
  });

  it("an EMPTY terminal_info is not a topology — `{}` must not promote a rung", async () => {
    const { client } = db({ on: true });
    const d = await landsideMaturityDecision(client, airport({ verified: true, terminalInfo: {} }), NOW, {
      routedTransportModelAvailable: true,
    });
    assert.equal(d.level, "L0_GENERIC");
    assert.equal(d.allowed, false);
  });
});

describe("L246 — the observation signal, and what an outage may NOT do", () => {
  it("a corroborated corpus reaches the ladder as a count", async () => {
    const { client } = db({ on: true, rows: observationRows(MIN_DISTINCT_OBSERVERS_PER_BAND) });
    const d = await landsideMaturityDecision(client, airport({ verified: true, terminalInfo: { t: 1 } }), NOW, {
      routedTransportModelAvailable: true,
    });
    assert.equal(d.observationCount, MIN_DISTINCT_OBSERVERS_PER_BAND * 2);
    assert.equal(d.signalsReadable, true);
  });

  it("an UNCORROBORATED corpus reaches it as zero, not as its row count", async () => {
    const { client } = db({ on: true, rows: observationRows(1, 6) });
    const d = await landsideMaturityDecision(client, airport({ verified: true, terminalInfo: { t: 1 } }), NOW, {
      routedTransportModelAvailable: true,
    });
    assert.equal(d.observationCount, 0);
  });

  it("an unreadable corpus cannot PROMOTE a rung — it counts as zero and says so", async () => {
    const { client } = db({ on: true, failObservations: true });
    const d = await landsideMaturityDecision(client, airport({ verified: true, terminalInfo: { t: 1 } }), NOW, {
      routedTransportModelAvailable: true,
      hasExternalLiveFeed: true,
    });
    assert.equal(d.signalsReadable, false);
    assert.equal(d.observationCount, 0);
    // With a live feed asserted, the ladder would reach L3 on 20 observations.
    // An unreadable corpus must never be one of them.
    assert.equal(d.level, "L2_EXTERNAL_LIVE");
    assert.equal(d.allowed, true, "an outage must not also withdraw a rung the airport had earned");
  });
});

describe("maturitySignalsFor — the signals are FACTS ABOUT DATA", () => {
  it("nothing on this tree supplies an external live feed, and the signal says so", () => {
    const s = maturitySignalsFor(airport({ verified: true, terminalInfo: { t: 1 } }), {
      observationCount: 500,
      routedTransportModelAvailable: true,
    });
    assert.equal(s.hasExternalLiveFeed, false);
    assert.equal(s.hasCalibration, false);
    // …so even a dense corpus cannot climb past L1 on this tree.
    assert.equal(airportMaturity(s).level, "L1_MAPPED");
  });

  it("a null profile id is 'no airport row', which is the fallback profile", () => {
    assert.equal(maturitySignalsFor(airport({ id: null }), { observationCount: 0 }).hasAirportRow, false);
    assert.equal(maturitySignalsFor(airport(), { observationCount: 0 }).hasAirportRow, true);
  });
});
