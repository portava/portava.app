/**
 * census-layover L175 — `LayoverFeasibilityService.evaluate(sessionId)`
 * (layover lane 5, 2026-10-18).
 *
 * The session-scoped entry point that certifies ONE owned session and stores
 * the certified evaluation in the §20 ledger (2700 + 2992 + 3792, behind
 * `layover_decision_persistence_enabled`). Both halves pinned:
 *   - persistence ON in the double: a certified, STORED evaluation whose
 *     snapshot id resolves to the stored row;
 *   - persistence ABSENT (production today) / OFF / UNREADABLE: the certified
 *     record is still returned, storage is a named refusal, NO ledger table is
 *     touched and no snapshot id is handed out;
 *   - every read failure is a named refusal, never a certification against
 *     defaults.
 *
 * Run: node --import tsx/esm --test src/test/layoverFeasibilityServiceEvaluate.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js"; import { attachConstraintContext } from "../services/layover/LayoverConstraintStore.js";
import { evaluate } from "../services/airport/LayoverFeasibilityService.js";
import { snapshotIdFor } from "../services/airport/layoverLedger.js";
import { certifySessionFeasibility } from "../services/airport/LayoverFeasibility.js";
import { airportRowToProfile } from "../services/airport/AirportProfileService.js";

const NOW = Date.parse("2026-09-13T02:00:00.000Z");
const PERSIST = "layover_decision_persistence_enabled";
const LEDGER = ["layover_certified_computations", "layover_time_budgets", "layover_return_plans"];

function tables(flags: Array<{ flag: string; enabled: boolean }>, sessionOver: Record<string, any> = {}): Record<string, any[]> {
  return {
    feature_flags: flags,
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({ ...sessionOver }, { nowMs: NOW })],
    layover_events: [],
  };
}

function spied(t: Record<string, any[]>, opts: Parameters<typeof makeLayoverDb>[1] = {}) {
  const db = makeLayoverDb(t, opts) as any;
  const touched: string[] = [];
  return { touched, db: { ...db, from: (name: string) => { touched.push(name); return db.from(name); } } };
}

describe("L175 — evaluate(sessionId) with the ledger ON: a certified, STORED evaluation", () => {
  it("certifies the owned session and stores it; the snapshot id resolves to exactly the stored row", async () => {
    const t = tables([{ flag: PERSIST, enabled: true }]);
    const out = await evaluate(makeLayoverDb(t) as any, "user-1", "session-1", { nowMs: NOW });
    assert.equal(out.ok, true, JSON.stringify(out));
    if (!out.ok) return;
    assert.equal(out.sessionId, "session-1");
    assert.equal(out.storage.stored, true, JSON.stringify(out.storage));
    if (!out.storage.stored) return;
    assert.equal(out.storage.state, "recorded");
    assert.deepEqual(out.storage.unwritten, []);
    assert.equal(out.storage.snapshotId, snapshotIdFor("session-1", out.record.inputHash));
    assert.equal(t.layover_certified_computations.length, 1);
    assert.equal(t.layover_certified_computations[0].snapshot_id, out.storage.snapshotId);
    assert.equal(t.layover_certified_computations[0].input_hash, out.record.inputHash);
    assert.equal(t.layover_time_budgets.length, 1);
    assert.equal(t.layover_return_plans.length, 1);
    assert.equal(out.certification.inputHash, out.record.inputHash);
    assert.equal(out.certification.verdict, out.record.verdict);
  });

  it("is the house's ONE derivation: the record equals certifySessionFeasibility over the same session, airport and instant", async () => {
    const t = tables([{ flag: PERSIST, enabled: true }]);
    const out = await evaluate(makeLayoverDb(t) as any, "user-1", "session-1", { nowMs: NOW });
    assert.ok(out.ok);
    if (!out.ok) return;
    const direct = certifySessionFeasibility(airportRowToProfile(airportRow()), await attachConstraintContext(makeLayoverDb(t) as any, out.record.inputs.session as any), { nowMs: NOW, entry: out.record.inputs.entry ?? null });
    assert.equal(out.record.inputHash, direct.inputHash);
    assert.equal(out.record.deadline.hardReturnTime.toISOString(), direct.deadline.hardReturnTime.toISOString());
  });

  it("the same session at the same instant is one stored computation, not two", async () => {
    const t = tables([{ flag: PERSIST, enabled: true }]);
    const a = await evaluate(makeLayoverDb(t) as any, "user-1", "session-1", { nowMs: NOW });
    const b = await evaluate(makeLayoverDb(t) as any, "user-1", "session-1", { nowMs: NOW });
    assert.ok(a.ok && b.ok && a.storage.stored && b.storage.stored);
    assert.equal(b.ok && b.storage.stored && b.storage.state, "already_recorded");
    assert.equal(t.layover_certified_computations.length, 1);
  });

  it("ON but the ledger refuses the write: the record is still returned, storage names persistDecision's reason, NO snapshot id", async () => {
    const t = tables([{ flag: PERSIST, enabled: true }]);
    const out = await evaluate(makeLayoverDb(t, { failures: { "layover_certified_computations:insert": { message: "check violation" } } }) as any, "user-1", "session-1", { nowMs: NOW });
    assert.ok(out.ok);
    assert.deepEqual(out.ok && out.storage, { stored: false, reason: "write_failed" });
  });
});

describe("L175 — evaluate(sessionId) without the press: certified, NOT stored, nothing written", () => {
  for (const [label, flags, reason] of [
    ["ABSENT (production today)", [], "persistence_disabled"],
    ["OFF", [{ flag: PERSIST, enabled: false }], "persistence_disabled"],
  ] as Array<[string, Array<{ flag: string; enabled: boolean }>, string]>) {
    it(`persistence ${label}: storage is ${reason}, the record is real, and no ledger table is touched`, async () => {
      const t = tables(flags);
      const { db, touched } = spied(t);
      const out = await evaluate(db, "user-1", "session-1", { nowMs: NOW });
      assert.ok(out.ok);
      assert.deepEqual(out.ok && out.storage, { stored: false, reason });
      assert.equal(out.ok && typeof out.record.inputHash, "string");
      for (const name of LEDGER) assert.ok(!touched.includes(name), `${name} touched without the press`);
      assert.equal(t.layover_events.length, 0, "evaluate writes no event");
    });
  }

  it("persistence flag UNREADABLE: flag_unreadable — not 'off' — and no ledger table is touched", async () => {
    const t = tables([{ flag: PERSIST, enabled: true }]);
    const { db, touched } = spied(t, { failures: { "feature_flags:select": { message: "down" } } });
    const out = await evaluate(db, "user-1", "session-1", { nowMs: NOW });
    assert.ok(out.ok);
    assert.deepEqual(out.ok && out.storage, { stored: false, reason: "flag_unreadable" });
    for (const name of LEDGER) assert.ok(!touched.includes(name));
  });
});

describe("L175 — evaluate(sessionId) refuses rather than certifying the wrong thing", () => {
  it("another user's session is not_found, and nothing is certified or stored", async () => {
    const t = tables([{ flag: PERSIST, enabled: true }]);
    assert.deepEqual(await evaluate(makeLayoverDb(t) as any, "user-2", "session-1", { nowMs: NOW }), { ok: false, reason: "not_found" });
    assert.equal((t.layover_certified_computations ?? []).length, 0);
  });

  it("an unreadable session is session_unreadable, never not_found", async () => {
    const t = tables([{ flag: PERSIST, enabled: true }]);
    const db = makeLayoverDb(t, { failures: { "layover_sessions:select": { message: "down" } } }) as any;
    assert.deepEqual(await evaluate(db, "user-1", "session-1", { nowMs: NOW }), { ok: false, reason: "session_unreadable" });
  });

  it("an unreadable airport profile is airport_unreadable — never a certification against the generic buffers", async () => {
    const t = tables([{ flag: PERSIST, enabled: true }]);
    const db = makeLayoverDb(t, { failures: { "airport_profiles:select": { message: "down" } } }) as any;
    assert.deepEqual(await evaluate(db, "user-1", "session-1", { nowMs: NOW }), { ok: false, reason: "airport_unreadable" });
    assert.equal((t.layover_certified_computations ?? []).length, 0);
  });

  it("an ENDED session (terminal status, departure passed) is refused before any write", async () => {
    const t = tables([{ flag: PERSIST, enabled: true }], {
      status: "completed",
      arrival_time: new Date(NOW - 9 * 3_600_000).toISOString(),
      departure_time: new Date(NOW - 3_600_000).toISOString(),
    });
    assert.deepEqual(await evaluate(makeLayoverDb(t) as any, "user-1", "session-1", { nowMs: NOW }), { ok: false, reason: "session_ended" });
    assert.equal((t.layover_certified_computations ?? []).length, 0);
  });
});
