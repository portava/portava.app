/**
 * census-layover §83 — the two snapshot rows batch 2 builds, as pure contracts:
 *
 *   L24  layover_return_plans.recommended_return_by is spec §5's "recommended return threshold" — the instant the
 *        certified return state turns RETURN_SOON (hard return − RETURN_SOON_LEAD_MIN), which is also the instant the
 *        one stored reminder fires. It used to be the hard return itself. latest_activity_departure_at stays NULL
 *        (its ordering against 2992's CHECK is an open ruling, §83).
 *   L25  layover_certified_computations.safe_envelope_ref (3951) is the content hash of the envelope GET /overview
 *        publishes for the snapshot, or env:withheld:<why>; written only under layover_snapshot_envelope_ref_enabled.
 *
 * The real-schema half (3951 on the migrated chain, the router's served envelope hashed against the stored ref) is
 * src/test/db/layoverRetestRows20261023.db.test.ts.
 *
 * Run: node --import tsx/esm --test src/test/layoverSnapshotMembers.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { certifySessionFeasibility, type FeasibilityAirport, type FeasibilitySession, type LayoverFeasibilityRecord } from "../services/airport/LayoverFeasibility.js";
import { RETURN_SOON_LEAD_MIN, computeReturnState } from "../services/airport/LayoverSafetyEngine.js";
import { safeEnvelope } from "../services/airport/LayoverEnvelope.js";
import { returnPlanRowFor } from "../services/layover/LayoverDecisionStore.js";
import {
  SAFE_ENVELOPE_REF_PATTERN,
  SNAPSHOT_ENVELOPE_REF_FLAG,
  publishedEnvelopeOf,
  safeEnvelopeRefFor,
  safeEnvelopeRefOfServed,
  snapshotEnvelopeRefColumn,
} from "../services/layover/LayoverSnapshotEnvelopeRef.js";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-13T02:00:00.000Z");
const AIRPORT: FeasibilityAirport = {
  id: "airport-tpe", iataCode: "TPE", timezone: "Asia/Taipei", verified: true, lat: 25.0797, lng: 121.2342,
  domesticBufferMin: 60, internationalBufferMin: 120, immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
};
function session(hours: number): FeasibilitySession {
  return {
    id: "session-1", arrivalTime: new Date(NOW).toISOString(), departureTime: new Date(NOW + hours * HOUR).toISOString(), boardingTime: null,
    flightType: "international", immigrationRequired: true, checkedBags: false, wantsToLeave: true,
  };
}
const record = (hours: number, airport: FeasibilityAirport = AIRPORT) => certifySessionFeasibility(airport, session(hours), { nowMs: NOW });
const opened = (r: LayoverFeasibilityRecord): LayoverFeasibilityRecord => ({ ...r, verdict: "yes", landsideGate: { ...r.landsideGate, open: true, status: "open", closedBy: [], cautions: [] } });
const closed = (r: LayoverFeasibilityRecord): LayoverFeasibilityRecord => ({ ...r, verdict: "no" });

describe("L24 — recommended_return_by is the certified RETURN_SOON instant", () => {
  for (const hours of [3, 6, 9, 14]) {
    it(`${hours} h layover: hard − ${RETURN_SOON_LEAD_MIN} min, never after the hard return, and exactly where the return state turns RETURN_SOON`, () => {
      const r = record(hours);
      const row = returnPlanRowFor("snap:" + "0".repeat(32), "session-1", r);
      const hard = r.deadline.hardReturnTime.getTime();
      const rec = Date.parse(String(row.recommended_return_by));
      assert.equal(row.hard_return_by, r.deadline.hardReturnTime.toISOString());
      assert.equal(rec, hard - RETURN_SOON_LEAD_MIN * 60_000);
      assert.ok(rec < hard, "2992's CHECK recommended <= hard, strictly here");
      assert.equal(computeReturnState(hard, r.deadline.breakdown, rec - 1), "NORMAL");
      assert.equal(computeReturnState(hard, r.deadline.breakdown, rec), "RETURN_SOON");
      assert.equal(row.latest_activity_departure_at, null, "an open ruling (§83), never a guess");
    });
  }
});

describe("L25 — safe_envelope_ref names the envelope the overview publishes", () => {
  it("open: env:<sha256> of the canonical envelope, equal to the hash of the same envelope as served (JSON round trip)", () => {
    const r = opened(record(9));
    const p = publishedEnvelopeOf(r);
    assert.equal(p.withheld, null);
    const expected = safeEnvelope(r.envelope.usableMinutes, { lat: AIRPORT.lat!, lng: AIRPORT.lng! }, r.confidence);
    assert.deepEqual(p.envelope, expected);
    const ref = safeEnvelopeRefFor(r);
    assert.match(ref, SAFE_ENVELOPE_REF_PATTERN);
    assert.match(ref, /^env:[a-f0-9]{64}$/);
    assert.equal(ref, safeEnvelopeRefOfServed(JSON.parse(JSON.stringify(expected))));
    const shuffled = Object.fromEntries(Object.entries(expected!).reverse());
    assert.equal(safeEnvelopeRefOfServed(shuffled), ref, "key order is not part of the identity");
  });

  it("a different window is a different envelope, so a different ref; the same record is the same ref", () => {
    assert.equal(safeEnvelopeRefFor(opened(record(9))), safeEnvelopeRefFor(opened(record(9))));
    assert.notEqual(safeEnvelopeRefFor(opened(record(9))), safeEnvelopeRefFor(opened(record(12))));
  });

  it("caution publishes the envelope too (the overview draws it without the word safe), so it is hashed", () => {
    const r: LayoverFeasibilityRecord = { ...record(9), verdict: "yes", landsideGate: { ...record(9).landsideGate, open: false, status: "caution", closedBy: [] } };
    assert.match(safeEnvelopeRefFor(r), /^env:[a-f0-9]{64}$/);
  });

  it("closed: env:withheld:landside_closed — no envelope was drawn", () => {
    assert.equal(safeEnvelopeRefFor(closed(record(9))), "env:withheld:landside_closed");
  });

  it("no airport coordinate: env:withheld:no_airport_coordinate", () => {
    const { lat: _lat, lng: _lng, ...noPoint } = AIRPORT;
    assert.equal(safeEnvelopeRefFor(opened(record(9, noPoint as FeasibilityAirport))), "env:withheld:no_airport_coordinate");
  });

  for (const [label, rows] of [["OFF", [{ flag: SNAPSHOT_ENVELOPE_REF_FLAG, enabled: false }]], ["absent", []]] as const) {
    it(`flag ${label}: the insert gains nothing (byte-for-byte the pre-3951 payload)`, async () => {
      assert.deepEqual(await snapshotEnvelopeRefColumn(makeLayoverDb({ feature_flags: [...rows] }) as any, opened(record(9))), {});
    });
  }
  it("flag unreadable: nothing (fail closed)", async () => {
    const db = makeLayoverDb({ feature_flags: [{ flag: SNAPSHOT_ENVELOPE_REF_FLAG, enabled: true }] }, { failures: { "feature_flags:select": { message: "down" } } });
    assert.deepEqual(await snapshotEnvelopeRefColumn(db as any, opened(record(9))), {});
  });
  it("flag ON: exactly the column, with the ref", async () => {
    const r = opened(record(9));
    assert.deepEqual(await snapshotEnvelopeRefColumn(makeLayoverDb({ feature_flags: [{ flag: SNAPSHOT_ENVELOPE_REF_FLAG, enabled: true }] }) as any, r), { safe_envelope_ref: safeEnvelopeRefFor(r) });
  });

  it("3951: a nullable column with the exact vocabulary as a CHECK, and the flag seeded FALSE with a postcondition", () => {
    const sql = readFileSync(new URL("../migrations/3951_layover_snapshot_safe_envelope_ref.sql", import.meta.url), "utf8");
    assert.match(sql, /ADD COLUMN IF NOT EXISTS safe_envelope_ref TEXT;/);
    assert.ok(sql.includes(`'^env:([a-f0-9]{64}|withheld:(landside_closed|no_airport_coordinate))$'`), "the CHECK spells the service's pattern");
    assert.equal(SAFE_ENVELOPE_REF_PATTERN.source, "^env:([a-f0-9]{64}|withheld:(landside_closed|no_airport_coordinate))$");
    assert.match(sql, /'layover_snapshot_envelope_ref_enabled',\s*false,/);
    assert.match(sql, /ON CONFLICT \(flag\) DO NOTHING/);
    assert.match(sql, /POSTCONDITION FAILED \(3951\): layover_snapshot_envelope_ref_enabled is ON/);
    assert.doesNotMatch(sql, /\bUPDATE\s+public\.layover_certified_computations\b/i, "nothing rewrites a stored snapshot (3896)");
  });

  it("the writer: persistDecision's one INSERT spreads the column helper, and nothing else names the column", () => {
    const src = readFileSync(new URL("../services/layover/LayoverDecisionStore.ts", import.meta.url), "utf8");
    assert.match(src, /\.insert\(\{ \.\.\.certifiedComputationRowFor\(userId, sessionId, record\), \.\.\.cas\.column, \.\.\.\(await snapshotEnvelopeRefColumn\(db, record\)\) \}\)/);
    assert.equal(src.includes("safe_envelope_ref:"), false);
  });
});
