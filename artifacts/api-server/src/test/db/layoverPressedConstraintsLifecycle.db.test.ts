/**
 * Lane B1-P — constraints, lifecycle, checkpoints and outcomes (triage presses
 * P2 and P3, and 2992's checkpoint/outcome halves), PRESSED, against the real
 * migrated schema.
 *
 * Rows: L4, L35, L172 (P2: 2992 + 3640 → layover_constraints_enabled), L40 (P3:
 * 3632 → layover_lifecycle_machine_enabled, with 2992 + the persistence flag for
 * its snapshot side effect), L194 (2992's checkpoints, written behind the
 * persistence flag), L174 and L195 (2992's outcomes, same flag), and L12 (the
 * session owning lifecycle, constraints and snapshots at once).
 *
 * THE PRESS (this file): 2700 → 2992 → 3623 → 3792 → 3640 → 3632, then
 * `layover_constraints_enabled`, `layover_decision_persistence_enabled` and
 * `layover_lifecycle_machine_enabled` ON. Every one is seeded FALSE by its own
 * migration. Each row's own subset is named in the lane handback.
 *
 * Falsified by B1P_ARM=flag-off and B1P_ARM=absent: every PRESSED case goes red.
 *
 * Run (loopback; unsandboxed):
 *   LAYOVER_PGLITE_ROOT=<…> node --import tsx/esm --test src/test/db/layoverPressedConstraintsLifecycle.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PRESSED_SKIP_REASON, PRESS_ARM, applyPress, openForPress, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, seedConfirmedCorridor, seedCuratedAirport, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";

const PRESS = {
  migrations: ["2700", "2992", "3623", "3792", "3640", "3632"],
  flags: { layover_constraints_enabled: true, layover_decision_persistence_enabled: true, layover_lifecycle_machine_enabled: true },
} as const;

let db: PressedDb;
let app: PressedApp;
let ana: PressedUser, bob: PressedUser, cy: PressedUser;
const seeds: Record<string, boolean | "absent"> = {};
const constraintsOf = (sid: string) => db.query<any>(`SELECT * FROM public.layover_constraints WHERE session_id = '${sid}' ORDER BY version`);
const put = (u: PressedUser, sid: string, body: unknown) => app.call("PUT", `/api/airport/sessions/${sid}/constraints`, u, body);
const getC = (u: PressedUser, sid: string) => app.call("GET", `/api/airport/sessions/${sid}/constraints`, u);

describe("B1-P constraints / lifecycle / checkpoints / outcomes (P2, P3)", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openForPress(PRESS);
    for (const f of Object.keys(PRESS.flags)) seeds[f] = await db.flag(f);
    await productionBaseFlags(db);
    await applyPress(db, PRESS);
    app = await startPressedLayoverApp(db);
    ana = await db.seedUser("ana");
    bob = await db.seedUser("bob");
    cy = await db.seedUser("cy");
    for (const u of [ana, bob, cy]) await seedConfirmedCorridor(db, u.id, "US", "SG"); await seedCuratedAirport(app, db, "SIN"); // 3874 + the 2026-10-18 maturity decision: landside opens only at a curated airport
  });
  after(async () => { await app?.close(); await db?.close(); });

  describe(`PRESSED [${PRESS_ARM}]`, () => {
    it("C0 the press: every flag is seeded FALSE by its own migration (3640, 2992, 3632) — turning each ON is the owner's flip", () => {
      for (const f of Object.keys(PRESS.flags)) assert.equal(seeds[f], false, `${f} = ${String(seeds[f])}`);
    });

    it("C1 L35 L172 — updateConstraint: BaggageMode UNKNOWN is a stored, versioned declaration; a change appends, a repeat appends nothing; the store is immutable", async () => {
      const sid = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 10 })).id;
      const r1 = await put(ana, sid, { baggageMode: "UNKNOWN" });
      assert.equal(r1.status, 200, r1.raw);
      assert.equal(r1.body.stored, "versioned", r1.raw);
      assert.equal(r1.body.constraints?.baggageMode, "UNKNOWN");
      let rows = await constraintsOf(sid);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].baggage_mode, "UNKNOWN", "L35: the spec's UNKNOWN is a stored member, not a missing value");
      assert.equal(Number(rows[0].version), 1);
      const r2 = await put(ana, sid, { baggageMode: "CARRY_ON_ONLY", airportChangeRequired: false, recheckRequired: false });
      assert.equal(r2.status, 200, r2.raw);
      rows = await constraintsOf(sid);
      assert.equal(rows.length, 2, "L172: an update appends a new version");
      assert.equal(rows[0].baggage_mode, "UNKNOWN", "the earlier version is kept as it was");
      assert.equal(rows[1].baggage_mode, "CARRY_ON_ONLY");
      const r3 = await put(ana, sid, { baggageMode: "CARRY_ON_ONLY" });
      assert.equal(r3.status, 200, r3.raw);
      assert.equal(r3.body.unchanged, true);
      assert.equal((await constraintsOf(sid)).length, 2, "an unchanged declaration appends nothing");
      const g = await getC(ana, sid);
      assert.equal(g.body.storage, "versioned");
      assert.deepEqual([...g.body.declarable].sort(), ["airportChangeRequired", "baggageMode", "recheckRequired"]);
      await assert.rejects(db.exec(`UPDATE public.layover_constraints SET baggage_mode = 'CHECKED_THROUGH' WHERE session_id = '${sid}'`), /immutable|not permitted|refus|append/i);
      await assert.rejects(db.exec(`INSERT INTO public.layover_constraints (session_id, version, baggage_mode) VALUES ('${sid}', 9, 'BOGUS')`), (e: any) => e?.code === "23514");
    });

    it("C2 L4 — an unknown critical fact reduces confidence and FAILS CLOSED for landside, and one question lifts it", async () => {
      const sid = (await startSession(app, bob, { iata: "SIN" }, { departsInH: 12 })).id;
      const g = await getC(bob, sid);
      assert.equal(g.status, 200, g.raw);
      assert.equal(g.body.landsideGate.status, "closed", `gate: ${JSON.stringify(g.body.landsideGate)}`);
      assert.ok(g.body.landsideGate.closedBy.some((c: string) => /unknown/.test(c)), JSON.stringify(g.body.landsideGate.closedBy));
      assert.equal(g.body.confidence, "INSUFFICIENT", "an unknown that decides the verdict is INSUFFICIENT confidence");
      assert.ok(g.body.question, "§12.1: exactly one question is asked");
      const r = await put(bob, sid, { baggageMode: "CARRY_ON_ONLY", airportChangeRequired: false, recheckRequired: false });
      assert.equal(r.status, 200, r.raw);
      assert.notEqual(r.body.landsideGate.status, "closed", `declared: ${JSON.stringify(r.body.landsideGate)}`);
      assert.notEqual(r.body.confidence, "INSUFFICIENT");
    });

    it("C3 L40 L12 — EVALUATING → LANDSIDE_AVAILABLE only when the guard holds, with its side effects: a stored snapshot, a safe envelope, a candidate set", async () => {
      const sid = (await startSession(app, cy, { iata: "SIN" }, { departsInH: 12 })).id;
      const closed = await app.call("GET", `/api/airport/sessions/${sid}/overview`, cy);
      assert.equal(closed.status, 200, closed.raw);
      assert.ok(closed.body.lifecycle, "3632's flag ON publishes the lifecycle");
      assert.notEqual(closed.body.lifecycle.state, "LANDSIDE_AVAILABLE", "an undeclared airport change is a critical unknown: the guard must fail");
      assert.ok(closed.body.lifecycle.guardFailures.length > 0);
      assert.equal((await put(cy, sid, { baggageMode: "CARRY_ON_ONLY", airportChangeRequired: false, recheckRequired: false })).status, 200);
      const open = await app.call("GET", `/api/airport/sessions/${sid}/overview`, cy);
      const lc = open.body.lifecycle;
      assert.equal(lc.state, "LANDSIDE_AVAILABLE", JSON.stringify(lc));
      assert.deepEqual(lc.guardFailures, []);
      assert.deepEqual(lc.intents, ["CREATE_SNAPSHOT", "CREATE_SAFE_ENVELOPE", "CREATE_CANDIDATE_SET"]);
      // the side effects, really there:
      assert.equal(open.body.persisted.state, "recorded", "CREATE_SNAPSHOT: the snapshot is stored");
      const snap = await db.query<any>(`SELECT snapshot_id FROM public.layover_certified_computations WHERE snapshot_id = '${open.body.snapshotId}'`);
      assert.equal(snap.length, 1);
      assert.ok(open.body.safeEnvelope, "CREATE_SAFE_ENVELOPE");
      const recs = await app.call("GET", `/api/airport/sessions/${sid}/recommendations`, cy);
      assert.ok(Array.isArray(recs.body.recommendations) && recs.body.recommendations.length > 0, "CREATE_CANDIDATE_SET");
      // L12: the session owns its lifecycle, its constraints and its snapshots
      assert.ok((await constraintsOf(sid)).length >= 1);
      assert.ok((await db.query<any>(`SELECT 1 FROM public.layover_certified_computations WHERE session_id = '${sid}'`)).length >= 1);
    });

    it("C4 L194 — checkpoints are stored with their dedup key: a retried tap is ONE row, and the unique index is the arbiter", async () => {
      const sid = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 8 })).id;
      const op = `op-${randomUUID()}`;
      const a = await app.call("POST", `/api/airport/sessions/${sid}/checkpoints`, ana, { type: "LANDSIDE_EXIT", operationId: op });
      assert.equal(a.status, 201, a.raw);
      const b = await app.call("POST", `/api/airport/sessions/${sid}/checkpoints`, ana, { type: "LANDSIDE_EXIT", operationId: op });
      assert.equal(b.status, 200, b.raw);
      assert.equal(b.body.duplicate, true);
      const rows = await db.query<any>(`SELECT * FROM public.layover_checkpoints WHERE session_id = '${sid}'`);
      assert.equal(rows.length, 1);
      await assert.rejects(
        db.exec(`INSERT INTO public.layover_checkpoints SELECT * FROM public.layover_checkpoints WHERE session_id = '${sid}' LIMIT 0; INSERT INTO public.layover_checkpoints (${Object.keys(rows[0]).filter((k) => k !== "id" && k !== "created_at").map((k) => `"${k}"`).join(", ")}) SELECT ${Object.keys(rows[0]).filter((k) => k !== "id" && k !== "created_at").map((k) => `"${k}"`).join(", ")} FROM public.layover_checkpoints WHERE session_id = '${sid}'`),
        (e: any) => e?.code === "23505", "UNIQUE(session_id, dedup_key) must refuse the duplicate",
      );
      const g = await app.call("GET", `/api/airport/sessions/${sid}/checkpoints`, ana);
      assert.equal(g.body.available, true);
      assert.equal(g.body.airportPresence, "landside");
    });

    it("C5 L174 L195 — close(sessionId, outcome): the traveller's outcome is stored in layover_outcomes", async () => {
      const sid = (await startSession(app, bob, { iata: "SIN" }, { departsInH: 7 })).id;
      const r = await app.call("DELETE", `/api/airport/sessions/${sid}`, bob, { outcome: "completed" });
      assert.equal(r.status, 200, r.raw);
      assert.equal(r.body.outcomeRecord.recorded, true, JSON.stringify(r.body.outcomeRecord));
      const rows = await db.query<any>(`SELECT * FROM public.layover_outcomes WHERE session_id = '${sid}'`);
      assert.equal(rows.length, 1);
      assert.ok(JSON.stringify(rows[0]).includes("completed"));
    });
  });

  describe("ALWAYS (any arm)", () => {
    it("A1 constraints flag OFF → declarations are not versioned (session booleans only) and nothing reaches layover_constraints", async () => {
      await db.setFlag("layover_constraints_enabled", false);
      const sid = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 9 })).id;
      const r = await put(ana, sid, { baggageMode: "CARRY_ON_ONLY" });
      assert.equal(r.status, 200, r.raw);
      assert.equal(r.body.storage, "session_booleans_only");
      if (await db.hasTable("layover_constraints")) assert.equal((await constraintsOf(sid)).length, 0);
    });

    it("A2 constraints flag UNREADABLE → the landside gate CLOSES (constraints_unreadable), never reads as 'off'", async () => {
      await db.setFlag("layover_constraints_enabled", true);
      const sid = (await startSession(app, cy, { iata: "SIN" }, { departsInH: 9 })).id;
      const fault = (req: any) => (req.target === "feature_flags" && String(req.params.get("flag") ?? "").includes("layover_constraints_enabled") ? { status: 500, body: { code: "XX000", message: "injected", details: null, hint: null } } : null);
      db.bridge.faults.push(fault);
      try {
        const o = await app.call("GET", `/api/airport/sessions/${sid}/overview`, cy);
        assert.ok(o.status === 503 || (o.body?.landsideGate?.closedBy ?? []).includes("constraints_unreadable"), o.raw.slice(0, 400));
      } finally { db.bridge.faults.splice(db.bridge.faults.indexOf(fault), 1); }
    });

    it("A3 persistence flag OFF → checkpoints refuse 404 feature_disabled and the close records no outcome (and says so)", async () => {
      await db.setFlag("layover_decision_persistence_enabled", false);
      const sid = (await startSession(app, bob, { iata: "SIN" }, { departsInH: 9 })).id;
      const c = await app.call("POST", `/api/airport/sessions/${sid}/checkpoints`, bob, { type: "LANDSIDE_EXIT", operationId: `op-${randomUUID()}` });
      assert.equal(c.status, 404); assert.equal(c.body.error, "feature_disabled");
      const d = await app.call("DELETE", `/api/airport/sessions/${sid}`, bob, { outcome: "completed" });
      assert.equal(d.status, 200, d.raw);
      assert.deepEqual(d.body.outcomeRecord, { recorded: false, reason: "persistence_disabled" });
    });

    it("A4 owner-scoped: another traveller cannot read or declare constraints, or report a checkpoint, on this session", async () => {
      const sid = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 9 })).id;
      assert.equal((await getC(bob, sid)).status, 404);
      assert.equal((await put(bob, sid, { baggageMode: "UNKNOWN" })).status, 404);
      assert.equal((await app.call("POST", `/api/airport/sessions/${sid}/checkpoints`, bob, { type: "LANDSIDE_EXIT", operationId: "op-x-123" })).status, 404);
      assert.equal((await app.call("DELETE", `/api/airport/sessions/${sid}`, bob, { outcome: "completed" })).status, 404);
    });

    it("A5 the bridge saw no unmodelled request shape", () => { assert.deepEqual(db.bridge.unmodelled, []); });
  });
});
