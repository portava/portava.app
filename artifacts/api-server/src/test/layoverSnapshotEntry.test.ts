/**
 * census-discovery §56.12 / §56.14 — the certified LayoverSnapshot certifies with
 * the SAME entry input the airport routes pass.
 *
 * Before: `certifiedLayoverSnapshot` called `certifySessionFeasibility(airport,
 * session, { nowMs })` with no `entry`, while every airport route passes
 * `entry: await sessionEntry(sc, airport, session)`. A traveller whose border
 * is refused (`visa_required`) read `no` on the dashboard and
 * `entry_unverified`, landside OPEN, in every snapshot consumer — Discovery's
 * Layover mode, the Hidden Gems layover paths and Compass's tools.
 *
 * What each case pins:
 *   - a refused corridor certifies `no`, landside closed, in the snapshot;
 *   - a permitted corridor does not close landside (the fix cannot only close);
 *   - an unreadable passport table or corridor, or the entry flag off, is
 *     `entry_unverified` — a data gap is never a refusal and never a permit;
 *   - revocation both ways: the corridor changing between two reads changes the
 *     next snapshot (no cache keeps serving the old answer);
 *   - retries: the same world read twice gives the same snapshotId;
 *   - the snapshot's certified entry input is exactly what the airport routes'
 *     `resolveLayoverEntry` answers for the same traveller and airport.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { certifiedLayoverSnapshot } from "../services/airport/LayoverSnapshot.js";
import { resolveLayoverEntry, layoverAirportCountry } from "../services/airport/layoverEntryGate.js";
import { ENTRY_FLAG } from "../lib/entryRequirements.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";

const USER = "aa000000-0000-4000-8000-0000000000e1";
const NOW = Date.now();

function corridor(status: string) {
  return {
    id: `corr-${status}`, passport_country: "US", destination_country: "TW", status,
    allowed_stay_days: null, passport_validity_rule: null, fee_text: null, processing_time_text: null,
    official_source_url: null, notes: null, confidence: "high", last_verified_at: "2026-09-01T00:00:00.000Z",
  };
}

function world(over: { flag?: boolean; passport?: boolean; corridor?: string | null } = {}) {
  return {
    feature_flags: [{ flag: ENTRY_FLAG, enabled: over.flag ?? true }],
    layover_sessions: [sessionRow({
      id: "sess-entry", user_id: USER,
      arrival_time: new Date(NOW - 10 * 60_000).toISOString(),
      departure_time: new Date(NOW + 10 * 3_600_000).toISOString(),
      layover_minutes: 610,
    })],
    airport_profiles: [airportRow()],
    traveler_passports: over.passport === false ? [] : [
      { user_id: USER, issuing_country: "US", is_primary: true, created_at: "2026-01-01T00:00:00.000Z" },
    ],
    entry_requirements: over.corridor === null ? [] : [corridor(over.corridor ?? "visa_required")],
  } as Record<string, any[]>;
}

async function snap(tables: Record<string, any[]>, failures: Record<string, { message: string }> = {}) {
  const db = makeLayoverDb(tables, { failures });
  const r = await certifiedLayoverSnapshot(db, USER, { nowMs: NOW });
  assert.ok(r.ok, `fixture: a certified snapshot must exist (${JSON.stringify(r)})`);
  return { db, s: r.snapshot };
}

describe("certifiedLayoverSnapshot certifies with the airport routes' entry input", () => {
  it("a REFUSED corridor (visa_required) certifies `no` with landside CLOSED — the dashboard's answer", async () => {
    const { s } = await snap(world({ corridor: "visa_required" }));
    assert.equal(s.verdict, "no");
    assert.equal(s.landsideOpen, false);
    assert.match(String(s.landsideClosedReason), /"no"/);
    assert.equal((s.certifiedRecord as any).inputs.entry.state, "refused");
  });

  it("a PERMITTED corridor (visa_free) does not close landside — the fix is not a blanket closure", async () => {
    const { s } = await snap(world({ corridor: "visa_free" }));
    assert.notEqual(s.verdict, "no");
    assert.equal(s.landsideOpen, true);
    assert.equal((s.certifiedRecord as any).inputs.entry.state, "permitted");
  });

  it("a data gap is `entry_unverified`, never a refusal and never a permit: flag off, no passport, no corridor row, unreadable tables", async () => {
    const cases: Array<[string, Record<string, any[]>, Record<string, { message: string }>, string]> = [
      ["entry flag off",               world({ flag: false }),        {}, "entry_intelligence_disabled"],
      ["no passport on file",          world({ passport: false }),    {}, "no_passport_on_file"],
      ["no curated corridor",          world({ corridor: null }),     {}, "no_data_for_corridor"],
      ["traveler_passports unreadable", world(), { "traveler_passports:select": { message: "down" } }, "corridor_unreadable"],
      ["entry_requirements unreadable", world(), { "entry_requirements:select": { message: "down" } }, "corridor_unreadable"],
      // LAY-FIX: `feature_flags unreadable` was the sixth row here, asserted `entry_unverified` with landside OPEN. It is its own case at the foot of this file — the two landside-constraint flags live in that table, and an unreadable one must CLOSE the gate. (Kept as a comment line: line 99 below is cited.)
    ];
    for (const [label, tables, failures, reason] of cases) {
      const { s } = await snap(tables, failures);
      assert.equal(s.verdict, "entry_unverified", label);
      assert.equal(s.landsideStatus, "caution", `${label}: a data gap must not close landside on its own`); assert.equal(s.landsideOpen, false, `${label}: …and it is not an OPEN gate either — not forbidden is not confirmed`); assert.deepEqual(s.landsideCautions, ["entry_unconfirmed"], label);
      assert.deepEqual((s.certifiedRecord as any).inputs.entry, { state: "unresolved", reason }, label);
    }
  });

  it("revocation both ways: the corridor changing between two reads changes the NEXT snapshot", async () => {
    const tables = world({ corridor: "visa_free" });
    const first = await snap(tables);
    assert.equal(first.s.landsideOpen, true);

    tables.entry_requirements = [corridor("visa_required")];
    const closed = await snap(tables);
    assert.equal(closed.s.verdict, "no");
    assert.equal(closed.s.landsideOpen, false);
    assert.notEqual(closed.s.snapshotId, first.s.snapshotId, "a different entry input is a different certification");

    tables.entry_requirements = [corridor("visa_free")];
    const reopened = await snap(tables);
    assert.equal(reopened.s.landsideOpen, true);
    assert.equal(reopened.s.snapshotId, first.s.snapshotId, "the same inputs certify the same snapshot");
  });

  it("retries: the same world read twice certifies the same snapshotId and verdict", async () => {
    const tables = world({ corridor: "visa_required" });
    const a = await snap(tables);
    const b = await snap(tables);
    assert.equal(a.s.snapshotId, b.s.snapshotId);
    assert.equal(a.s.verdict, b.s.verdict);
  });

  it("the snapshot's entry input is exactly what the airport routes resolve for the same traveller and airport", async () => {
    for (const status of ["visa_required", "visa_free", null] as const) {
      const tables = world({ corridor: status });
      const { db, s } = await snap(tables);
      const routeEntry = await resolveLayoverEntry(db, USER, layoverAirportCountry({ countryCode: "TW", country: "Taiwan" }));
      const expected = routeEntry.state === "unresolved"
        ? { state: "unresolved", reason: routeEntry.reason }
        : { state: routeEntry.state, status: routeEntry.status, corridor: routeEntry.corridor };
      assert.deepEqual((s.certifiedRecord as any).inputs.entry, expected, String(status));
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// LAY-FIX — appended at the foot: line 99 above is cited and may not move.
// ═════════════════════════════════════════════════════════════════════════════
describe("an unreadable `feature_flags` is not a data gap that leaves landside open", () => {
  // MOVED OUT OF THE "data gap" TABLE, where it was asserted `entry_unverified`
  // with `landsideOpen === true`. An unreadable `feature_flags` is not only an
  // ENTRY data gap: the two landside-constraint flags are in the same table,
  // and for both ON is the restrictive state — so "could not read" was being
  // taken as "nothing declared, nothing forbidden" (PR #588 blocker 3). The
  // entry half is unchanged and still asserted; the gate now closes, by name,
  // instead of standing open on a failed read.
  it("the entry input is the same unresolved one, and the gate CLOSES on the constraint flags it could not read", async () => {
    const { s } = await snap(world(), { "feature_flags:select": { message: "down" } });
    assert.deepEqual((s.certifiedRecord as any).inputs.entry, { state: "unresolved", reason: "entry_intelligence_disabled" });
    assert.equal(s.verdict, "no");
    assert.equal(s.landsideOpen, false);
    assert.ok((s.certifiedRecord as any).landsideGate.closedBy.includes("constraints_unreadable"));
    assert.equal((s.certifiedRecord as any).landsideGate.constraintsRead, "unreadable");
  });

  it("CONTROL: the same world with the flags READABLE is the data gap it always was — `entry_unverified`, landside not forbidden", async () => {
    const { s } = await snap(world({ flag: false }));
    assert.equal(s.verdict, "entry_unverified");
    assert.equal(s.landsideStatus, "caution"); assert.equal(s.landsideOpen, false);
    assert.deepEqual((s.certifiedRecord as any).landsideGate.closedBy, []);
    assert.equal((s.certifiedRecord as any).landsideGate.open, false, "not forbidden is not affirmed");
  });
});
