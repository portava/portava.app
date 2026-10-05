/**
 * LAY-01 — the declared constraint set, from the row to the consumers.
 *
 * `src/test/layoverConstraintGate.test.ts` proves what a constraint context
 * DOES to a certified record. This file proves the context gets there: that the
 * session loaders attach it, that a declaration appends an immutable version,
 * and that the two production consumers which decide whether a traveller is
 * offered a city — the snapshot and the recommendation generator — close on it.
 *
 * ── THE THREE READ ANSWERS ARE THE POINT ────────────────────────────────────
 * `declared`, `undeclared` and `unreadable` are staged separately and asserted
 * separately. The defect this guards against is the one census L35 names: an
 * unreadable store coming back as "nothing declared" would hand the engine the
 * boolean on the row, which is the optimistic reading.
 *
 * ── STATE, NOT RETURN VALUES ────────────────────────────────────────────────
 * Every write is asserted by reading the table afterwards.
 *
 * Run: node --import tsx/esm --test src/services/layover/__tests__/layoverConstraintStore.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeLayoverDb, airportRow, sessionRow } from "../../../test/helpers/fakeLayoverDb.js";
import {
  getSession,
  getActiveSession,
  listSessions,
  readSessionsByIds,
  syncSessionBaggage,
} from "../../airport/LayoverSessionService.js";
import { airportRowToProfile } from "../../airport/AirportProfileService.js";
import { certifySessionFeasibility } from "../../airport/LayoverFeasibility.js";
import { certifiedLayoverSnapshot } from "../../airport/LayoverSnapshot.js";
import { generateRecommendations } from "../../airport/LayoverRecommendationService.js";
import { snapshotIdFor } from "../../airport/layoverLedger.js";
import { constraintsPayload, declareLayoverConstraints, readLandsidePlan } from "../LayoverConstraintService.js";
import { LAYOVER_CONSTRAINT_FLAGS, readLatestConstraints } from "../LayoverConstraintStore.js";

const USER = "user-constraints";
const SESSION = "session-constraints";
const HOUR = 3_600_000;
/** 10:00 in Taipei — clear of the night band on every machine. */
const NOW = Date.parse("2030-06-15T02:00:00.000Z");
const AIRPORT = airportRowToProfile(airportRow({ verified: false }));

const PLACES = [
  { id: "place-1", name: "Night Market", place_type: "attraction", category: "food", neighborhood: "Zhongli", blurb: "Snacks", verified: true, city: "Taoyuan", status: "active" },
  { id: "place-2", name: "Riverside Cafe", place_type: "cafe", category: "food", neighborhood: null, blurb: "Coffee", verified: false, city: "Taoyuan", status: "active" },
];

function world(opts: {
  storage?: boolean;
  entryPolicy?: boolean;
  minutes?: number;
  session?: Record<string, unknown>;
  constraints?: Array<Record<string, unknown>>;
  failures?: Record<string, { message: string; code?: string }>;
} = {}) {
  const flags: Array<{ flag: string; enabled: boolean }> = [];
  if (opts.storage !== undefined) flags.push({ flag: LAYOVER_CONSTRAINT_FLAGS.storage, enabled: opts.storage });
  if (opts.entryPolicy !== undefined) flags.push({ flag: LAYOVER_CONSTRAINT_FLAGS.entryForbidsLandside, enabled: opts.entryPolicy });
  const tables: Record<string, any[]> = {
    feature_flags: flags,
    airport_profiles: [airportRow({ verified: false })],
    layover_sessions: [
      sessionRow({
        id: SESSION, user_id: USER, status: "active",
        arrival_time: new Date(NOW).toISOString(),
        departure_time: new Date(NOW + (opts.minutes ?? 600) * 60_000).toISOString(),
        flight_type: "international", immigration_required: true, checked_bags: false,
        ...opts.session,
      }),
    ],
    layover_events: [],
    layover_plan_stops: [],
    layover_recommendations: [],
    discovery_places: PLACES.map((p) => ({ ...p })),
  };
  if (opts.constraints) tables.layover_constraints = opts.constraints.map((r) => ({ session_id: SESSION, ...r }));
  const db = makeLayoverDb(tables, { failures: opts.failures });
  return { db, tables };
}

async function owned(db: any) {
  const r = await getSession(db, SESSION, USER);
  assert.ok(r.ok && r.session, "fixture: the session did not load");
  return r.session;
}

/** A layover length on which one bag flips the verdict, found rather than assumed. */
function decisiveMinutes(): number {
  for (let m = 200; m < 900; m += 1) {
    const s = { id: "x", arrivalTime: new Date(NOW).toISOString(), departureTime: new Date(NOW + m * 60_000).toISOString(), boardingTime: null, flightType: "international" as const, immigrationRequired: true, wantsToLeave: true };
    const a = certifySessionFeasibility(AIRPORT, { ...s, checkedBags: false } as never, { nowMs: NOW }).verdict;
    const b = certifySessionFeasibility(AIRPORT, { ...s, checkedBags: true } as never, { nowMs: NOW }).verdict;
    if (a !== b && a !== "no" && b !== "no") return m;
  }
  throw new Error("fixture: no decisive window");
}
const DECISIVE = decisiveMinutes();

// ═══════════════════════════════════════════════════════════════════════════
describe("the loaders attach the context — and attach NOTHING when both flags are off", () => {
  it("flags absent or FALSE: the session has no `constraints` key and the table is never touched", async () => {
    for (const w of [world(), world({ storage: false, entryPolicy: false })]) {
      const s = await owned(w.db);
      assert.equal("constraints" in s, false, "a flag-off session gained a constraints key — responses that serialise it changed");
      assert.equal("layover_constraints" in w.tables, false, "the store was read with layover_constraints_enabled off");
    }
  });

  it("storage ON, nothing declared: `undeclared`", async () => {
    const s = await owned(world({ storage: true }).db);
    assert.deepEqual(s.constraints, { read: "undeclared", set: null, entryForbidsLandside: false });
  });

  it("storage ON, two versions: the LATEST is the declared set", async () => {
    const { db } = world({
      storage: true,
      constraints: [
        { version: 1, baggage_mode: "UNKNOWN", recheck_required: null, airport_change_required: null, created_at: "2030-06-15T01:00:00.000Z" },
        { version: 2, baggage_mode: "CHECKED_THROUGH", recheck_required: true, airport_change_required: false, created_at: "2030-06-15T01:30:00.000Z" },
      ],
    });
    const s = await owned(db);
    assert.equal(s.constraints?.read, "declared");
    assert.deepEqual(s.constraints?.set, {
      version: 2, baggageMode: "CHECKED_THROUGH", recheckRequired: true, airportChangeRequired: false,
      declaredAt: "2030-06-15T01:30:00.000Z",
    });
  });

  it("storage ON, the read FAILS: `unreadable`, the session still loads, and the engine takes the cautious case", async () => {
    const { db } = world({ storage: true, minutes: DECISIVE, failures: { "layover_constraints:select": { message: "relation does not exist" } } });
    const s = await owned(db);
    assert.deepEqual(s.constraints, { read: "unreadable", set: null, entryForbidsLandside: false });
    const record = certifySessionFeasibility(AIRPORT, s, { nowMs: NOW, entry: { state: "permitted", status: "visa_free", corridor: { passportCountry: "GB", destinationCountry: "TW" } } });
    assert.equal(record.deadline.breakdown.bagsExtra, 15, "an unreadable store was read as the row's `checked_bags: false`");
    assert.equal(record.landsideGate.open, false);
  });

  it("a row outside this build's vocabulary is unreadable, never coerced", async () => {
    const { db } = world({ storage: true, constraints: [{ version: 1, baggage_mode: "TELEPORTED", recheck_required: null, airport_change_required: null }] });
    assert.equal((await readLatestConstraints(db, SESSION)).state, "unreadable");
  });

  it("only the entry policy ON: `storage_off` with the policy carried, and the table still untouched", async () => {
    const w = world({ entryPolicy: true });
    const s = await owned(w.db);
    assert.deepEqual(s.constraints, { read: "storage_off", set: null, entryForbidsLandside: true });
    assert.equal("layover_constraints" in w.tables, false);
  });

  it("every loader attaches it: active, list and the crew's batch read", async () => {
    const { db } = world({ storage: true, constraints: [{ version: 1, baggage_mode: "COLLECT_RECHECK", recheck_required: null, airport_change_required: null }] });
    const active = await getActiveSession(db, USER);
    const list = await listSessions(db, USER);
    const batch = await readSessionsByIds(db, [SESSION]);
    assert.ok(active.ok && list.ok && batch.ok);
    for (const s of [active.session, list.sessions[0], batch.sessions[0]]) {
      assert.equal(s?.constraints?.set?.baggageMode, "COLLECT_RECHECK");
    }
  });

  it("the batch read reports a failure per session, not an empty map", async () => {
    const { db } = world({ storage: true, failures: { "layover_constraints:select": { message: "boom" } } });
    const batch = await readSessionsByIds(db, [SESSION]);
    assert.ok(batch.ok);
    assert.equal(batch.sessions[0]?.constraints?.read, "unreadable");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("L172 — a declaration appends an immutable version", () => {
  it("storage ON: version 1, then version 2 beside it; version 1 is not rewritten", async () => {
    const { db, tables } = world({ storage: true });
    const first = await declareLayoverConstraints(db, {
      session: await owned(db), airport: AIRPORT, nowMs: NOW, entry: null,
      patch: { baggageMode: "UNKNOWN", recheckRequired: true },
    });
    assert.ok(first.ok, JSON.stringify(first));
    assert.equal(first.stored, "versioned");
    const v1 = { ...tables.layover_constraints[0] };
    assert.equal(v1.version, 1);
    assert.equal(v1.baggage_mode, "UNKNOWN");
    assert.equal(v1.recheck_required, true);
    assert.equal(v1.airport_change_required, null);
    assert.equal(v1.entry_permission_state, "UNKNOWN");
    // The row names the computation it was certified under — the record the
    // caller is handed, not a second one.
    assert.equal(v1.snapshot_id, snapshotIdFor(SESSION, first.record.inputHash));

    const second = await declareLayoverConstraints(db, {
      session: await owned(db), airport: AIRPORT, nowMs: NOW, entry: null,
      patch: { baggageMode: "CHECKED_THROUGH" },
    });
    assert.ok(second.ok && second.stored === "versioned");
    assert.equal(tables.layover_constraints.length, 2);
    assert.deepEqual(tables.layover_constraints[0], v1, "version 1 was rewritten — 2992 raises on UPDATE");
    assert.equal(tables.layover_constraints[1].version, 2);
    assert.equal(tables.layover_constraints[1].baggage_mode, "CHECKED_THROUGH");
    assert.equal(tables.layover_constraints[1].recheck_required, true, "an unnamed field was reset by the second declaration");
  });

  it("the `checked_bags` mirror follows the mode, conservatively, with one audited event", async () => {
    const { db, tables } = world({ storage: true });
    const out = await declareLayoverConstraints(db, {
      session: await owned(db), airport: AIRPORT, nowMs: NOW, entry: null, patch: { baggageMode: "UNKNOWN" },
    });
    assert.ok(out.ok && out.sessionSynced);
    assert.equal(tables.layover_sessions[0].checked_bags, true, "UNKNOWN was mirrored as 'no checked bags'");
    const events = tables.layover_events.filter((e) => e.event_type === "session_updated");
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].metadata, {
      kind: "constraints_declared", stored: "versioned", version: 1,
      baggageMode: "UNKNOWN", recheckRequired: null, airportChangeRequired: null,
    });

    await declareLayoverConstraints(db, {
      session: await owned(db), airport: AIRPORT, nowMs: NOW, entry: null, patch: { baggageMode: "CARRY_ON_ONLY" },
    });
    assert.equal(tables.layover_sessions[0].checked_bags, false);
  });

  it("the record handed back is the record a fresh load recomputes", async () => {
    const { db } = world({ storage: true, minutes: DECISIVE });
    const out = await declareLayoverConstraints(db, {
      session: await owned(db), airport: AIRPORT, nowMs: NOW, entry: null, patch: { baggageMode: "COLLECT_RECHECK" },
    });
    assert.ok(out.ok);
    const fresh = certifySessionFeasibility(AIRPORT, await owned(db), { nowMs: NOW, entry: null });
    assert.equal(fresh.inputHash, out.record.inputHash);
    assert.equal(fresh.verdict, out.record.verdict);
  });

  it("the critical unknown is stored with the version that produced it", async () => {
    const { db, tables } = world({ storage: true, minutes: DECISIVE });
    const out = await declareLayoverConstraints(db, {
      session: await owned(db), airport: AIRPORT, nowMs: NOW,
      entry: { state: "permitted", status: "visa_free", corridor: { passportCountry: "GB", destinationCountry: "TW" } },
      patch: { baggageMode: "UNKNOWN" },
    });
    assert.ok(out.ok);
    assert.deepEqual(tables.layover_constraints[0].critical_unknowns, ["baggage_mode"]);
    assert.equal(tables.layover_constraints[0].entry_permission_state, "CONFIRMED_ALLOWED");
    assert.equal(out.record.landsideGate.needsInfo, "baggageMode");
  });

  it("an UNREADABLE latest set refuses the declaration — it does not lay a patch over nothing", async () => {
    const { db, tables } = world({ storage: true, failures: { "layover_constraints:select": { message: "boom" } } });
    const session = await owned(db);
    const out = await declareLayoverConstraints(db, { session, airport: AIRPORT, nowMs: NOW, entry: null, patch: { recheckRequired: true } });
    assert.equal(out.ok, false);
    assert.ok(!out.ok && out.reason === "constraints_unreadable" && out.retryable);
    assert.equal((tables.layover_constraints ?? []).length, 0);
  });

  it("a refused INSERT is reported and nothing is mirrored", async () => {
    const { db, tables } = world({ storage: true, failures: { "layover_constraints:insert": { message: "permission denied" } } });
    const out = await declareLayoverConstraints(db, { session: await owned(db), airport: AIRPORT, nowMs: NOW, entry: null, patch: { baggageMode: "UNKNOWN" } });
    assert.ok(!out.ok && out.reason === "write_failed" && out.retryable);
    assert.equal(tables.layover_sessions[0].checked_bags, false, "the mirror was written for a version that was not stored");
    assert.equal(tables.layover_events.length, 0);
  });

  it("a version collision is retried, and reported if it persists", async () => {
    const { db } = world({ storage: true, failures: { "layover_constraints:insert": { message: "duplicate key", code: "23505" } } });
    const out = await declareLayoverConstraints(db, { session: await owned(db), airport: AIRPORT, nowMs: NOW, entry: null, patch: { baggageMode: "UNKNOWN" } });
    assert.ok(!out.ok && out.reason === "write_failed");
  });

  it("the mirror's own predicate refuses a layover that closed between the load and the write", async () => {
    // `declareLayoverConstraints` checks the status it was HANDED. The row can
    // have been closed since; the write must not re-open the question.
    const { db, tables } = world({ storage: true, session: { status: "completed", checked_bags: false } });
    const r = await syncSessionBaggage(db, SESSION, USER, true, { kind: "constraints_declared" });
    assert.deepEqual(r, { ok: true, session: null });
    assert.equal(tables.layover_sessions[0].checked_bags, false, "a completed layover's row was rewritten");
    assert.equal(tables.layover_events.length, 0);
  });

  it("a closed session and an empty patch are refused and nothing is written", async () => {
    const closed = world({ storage: true, session: { status: "cancelled" } });
    const a = await declareLayoverConstraints(closed.db, { session: await owned(closed.db), airport: AIRPORT, nowMs: NOW, entry: null, patch: { baggageMode: "UNKNOWN" } });
    assert.ok(!a.ok && a.reason === "session_closed");
    const open = world({ storage: true });
    const b = await declareLayoverConstraints(open.db, { session: await owned(open.db), airport: AIRPORT, nowMs: NOW, entry: null, patch: {} });
    assert.ok(!b.ok && b.reason === "nothing_declared");
    for (const w of [closed, open]) {
      assert.equal((w.tables.layover_constraints ?? []).length, 0);
      assert.equal(w.tables.layover_events.length, 0);
      assert.equal(w.tables.layover_sessions[0].checked_bags, false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("L35 on the schema that exists today — storage OFF keeps the cautious boolean", () => {
  it("each mode is kept as its conservative boolean, and `layover_constraints` is never touched", async () => {
    for (const [mode, bags] of [["UNKNOWN", true], ["COLLECT_RECHECK", true], ["CHECKED_THROUGH", false], ["CARRY_ON_ONLY", false]] as const) {
      const w = world({ session: { checked_bags: !bags } });
      const out = await declareLayoverConstraints(w.db, { session: await owned(w.db), airport: AIRPORT, nowMs: NOW, entry: null, patch: { baggageMode: mode } });
      assert.ok(out.ok, mode);
      assert.equal(out.stored, "session_booleans_only", mode);
      assert.equal(w.tables.layover_sessions[0].checked_bags, bags, mode);
      assert.equal(out.record.deadline.breakdown.bagsExtra, bags ? 15 : 0, mode);
      assert.equal("layover_constraints" in w.tables, false, mode);
    }
  });

  it("what a boolean cannot hold is NAMED as unsaved, and a patch of only those is refused", async () => {
    const w = world();
    const both = await declareLayoverConstraints(w.db, {
      session: await owned(w.db), airport: AIRPORT, nowMs: NOW, entry: null,
      patch: { baggageMode: "UNKNOWN", recheckRequired: true, airportChangeRequired: true },
    });
    assert.ok(both.ok);
    assert.deepEqual(both.unsaved, ["recheckRequired", "airportChangeRequired"]);

    const only = await declareLayoverConstraints(w.db, { session: await owned(w.db), airport: AIRPORT, nowMs: NOW, entry: null, patch: { airportChangeRequired: true } });
    assert.ok(!only.ok && only.reason === "nothing_storable" && !only.retryable);
  });

  it("the wire payload says which posture it is and offers only what it can keep", async () => {
    const off = world();
    const sOff = await owned(off.db);
    const pOff = constraintsPayload({ session: sOff, record: certifySessionFeasibility(AIRPORT, sOff, { nowMs: NOW, entry: null }), plan: await readLandsidePlan(off.db, SESSION) });
    assert.equal(pOff.storage, "session_booleans_only");
    assert.deepEqual(pOff.declarable, ["baggageMode"]);
    assert.equal(pOff.constraints, null);
    assert.equal(pOff.baggageCharged, false);

    const on = world({ storage: true, constraints: [{ version: 3, baggage_mode: "UNKNOWN", recheck_required: null, airport_change_required: null }] });
    const sOn = await owned(on.db);
    const pOn = constraintsPayload({ session: sOn, record: certifySessionFeasibility(AIRPORT, sOn, { nowMs: NOW, entry: null }), plan: await readLandsidePlan(on.db, SESSION) });
    assert.equal(pOn.storage, "versioned");
    assert.deepEqual(pOn.declarable, ["baggageMode", "recheckRequired", "airportChangeRequired"]);
    assert.equal(pOn.constraints?.version, 3);
    assert.equal(pOn.baggageCharged, true, "UNKNOWN is charged, and the payload must say so");
    assert.equal(pOn.layoverStateUnavailableReason, null);
  });

  it("an unreadable plan withholds the lifecycle state instead of guessing one", async () => {
    const w = world({ storage: true, failures: { "layover_plan_stops:select": { message: "boom" } } });
    const s = await owned(w.db);
    const p = constraintsPayload({ session: s, record: certifySessionFeasibility(AIRPORT, s, { nowMs: NOW, entry: null }), plan: await readLandsidePlan(w.db, SESSION) });
    assert.equal(p.layoverState, null);
    assert.equal(p.layoverStateUnavailableReason, "plan_unreadable");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("L40 / L77 / L230 — the two consumers that offer a city close on the gate", () => {
  const landside = (r: { ok: true; recommendations: any[] } | { ok: false; message: string }) => {
    if (!r.ok) assert.fail(`expected recommendations, got a refusal: ${r.message}`);
    return r.recommendations.filter((x) => !x.insideAirport);
  };

  it("CONTROL: with nothing declared the same session is offered landside places", async () => {
    const { db } = world({ storage: true });
    const got = landside(await generateRecommendations(db, AIRPORT, await owned(db), NOW));
    assert.ok(got.length > 0, "fixture: the ungated session was offered nothing landside, so the cases below would pass vacuously");
    const snap = await certifiedLayoverSnapshot(db, USER, { sessionId: SESSION, nowMs: NOW });
    assert.ok(snap.ok && snap.snapshot.landsideOpen);
  });

  it("an airport change: no landside recommendation, and the snapshot closes", async () => {
    const { db } = world({ storage: true, constraints: [{ version: 1, baggage_mode: "CARRY_ON_ONLY", recheck_required: null, airport_change_required: true }] });
    assert.equal(landside(await generateRecommendations(db, AIRPORT, await owned(db), NOW)).length, 0);
    const snap = await certifiedLayoverSnapshot(db, USER, { sessionId: SESSION, nowMs: NOW });
    assert.ok(snap.ok);
    assert.equal(snap.snapshot.landsideOpen, false);
    assert.ok(snap.snapshot.reasonCodes.includes("AIRPORT_CHANGE_REQUIRED"));
  });

  it("L230 — the entry policy ON with an unconfirmed corridor: no landside recommendation", async () => {
    const { db } = world({ entryPolicy: true });
    assert.equal(landside(await generateRecommendations(db, AIRPORT, await owned(db), NOW)).length, 0,
      "a traveller whose entry is unconfirmed was offered a city with the policy on");
    const snap = await certifiedLayoverSnapshot(db, USER, { sessionId: SESSION, nowMs: NOW });
    assert.ok(snap.ok);
    assert.equal(snap.snapshot.landsideOpen, false);
    assert.equal(snap.snapshot.verdict, "no");
  });

  it("L230 CONTROL — the policy OFF: the same session keeps its city (production behaviour does not move)", async () => {
    const { db } = world({ entryPolicy: false });
    assert.ok(landside(await generateRecommendations(db, AIRPORT, await owned(db), NOW)).length > 0);
    const snap = await certifiedLayoverSnapshot(db, USER, { sessionId: SESSION, nowMs: NOW });
    assert.ok(snap.ok && snap.snapshot.landsideOpen);
    assert.equal(snap.snapshot.verdict, "entry_unverified");
  });
});
