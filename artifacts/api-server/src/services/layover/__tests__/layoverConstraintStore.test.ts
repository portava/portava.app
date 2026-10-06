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
import { constraintsPayload, declareLayoverConstraints, patchChangesSet, readLandsidePlan } from "../LayoverConstraintService.js";
import { LAYOVER_CONSTRAINT_FLAGS, readConstraintFlags, readLatestConstraints } from "../LayoverConstraintStore.js";
import { declareConstraintsAtCreation } from "../../../routes/layoverConstraints.js";
import { normalizeEvent, type LayoverEventEnvelope } from "../../airport/LayoverEventReplanner.js";
import { replanExternalEvent } from "../../airport/LayoverExternalReplanPort.js";
import { ENTRY_FLAG } from "../../../lib/entryRequirements.js";

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
  /** Stage a curated corridor that PERMITS entry (US passport → TW), with the entry flag on. */
  entryPermitted?: boolean;
} = {}) {
  const flags: Array<{ flag: string; enabled: boolean }> = [];
  if (opts.storage !== undefined) flags.push({ flag: LAYOVER_CONSTRAINT_FLAGS.storage, enabled: opts.storage });
  if (opts.entryPolicy !== undefined) flags.push({ flag: LAYOVER_CONSTRAINT_FLAGS.entryForbidsLandside, enabled: opts.entryPolicy });
  if (opts.entryPermitted) flags.push({ flag: ENTRY_FLAG, enabled: true });
  const tables: Record<string, any[]> = {
    feature_flags: flags,
    ...(opts.entryPermitted ? {
      traveler_passports: [{ user_id: USER, issuing_country: "US", is_primary: true, created_at: "2026-01-01T00:00:00.000Z" }],
      entry_requirements: [{
        id: "corr-visa-free", passport_country: "US", destination_country: "TW", status: "visa_free",
        allowed_stay_days: null, passport_validity_rule: null, fee_text: null, processing_time_text: null,
        official_source_url: null, notes: null, confidence: "high", last_verified_at: "2026-09-01T00:00:00.000Z",
      }],
    } : {}),
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
    const PERMITTED = { state: "permitted", status: "visa_free", corridor: { passportCountry: "GB", destinationCountry: "TW" } } as const;
    // The two connection questions are ANSWERED here, so the bag mode is the
    // only unknown. (They were left unstated, which used to be read as "no".)
    const { db, tables } = world({ storage: true, minutes: DECISIVE });
    const out = await declareLayoverConstraints(db, {
      session: await owned(db), airport: AIRPORT, nowMs: NOW, entry: PERMITTED,
      patch: { baggageMode: "UNKNOWN", recheckRequired: false, airportChangeRequired: false },
    });
    assert.ok(out.ok);
    assert.deepEqual(tables.layover_constraints[0].critical_unknowns, ["baggage_mode"]);
    assert.equal(tables.layover_constraints[0].entry_permission_state, "CONFIRMED_ALLOWED");
    assert.equal(out.record.landsideGate.needsInfo, "baggageMode");

    // …and a declaration that leaves them unstated stores THOSE unknowns too,
    // with the airport change — the one that closes landside outright — asked first.
    const bare = world({ storage: true, minutes: DECISIVE });
    const out2 = await declareLayoverConstraints(bare.db, {
      session: await owned(bare.db), airport: AIRPORT, nowMs: NOW, entry: PERMITTED, patch: { baggageMode: "UNKNOWN" },
    });
    assert.ok(out2.ok);
    assert.deepEqual(bare.tables.layover_constraints[0].critical_unknowns, ["airport_change_required", "baggage_mode", "recheck_required"]);
    assert.equal(out2.record.landsideGate.needsInfo, "airportChangeRequired");
    assert.equal(out2.record.landsideGate.open, false);
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
    // Flags off, the border unconfirmed: this was published as LANDSIDE_AVAILABLE.
    assert.equal(pOff.verdict, "entry_unverified");
    assert.equal(pOff.landsideGate.open, false);
    assert.equal(pOff.layoverState, null);
    assert.equal(pOff.layoverStateUnavailableReason, "landside_unconfirmed");

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

  /** A declared set with every question answered "no": nothing in it closes anything. */
  const ANSWERED = [{ version: 1, baggage_mode: "CARRY_ON_ONLY", recheck_required: false, airport_change_required: false }];

  // The control used to be `world({ storage: true })` — NOTHING declared — and
  // asserted that session was offered a city. That is the defect, not the
  // control: it is the next case now. The control is a traveller who answered.
  it("CONTROL: with everything answered the same session is offered landside places", async () => {
    const { db } = world({ storage: true, constraints: ANSWERED });
    const got = landside(await generateRecommendations(db, AIRPORT, await owned(db), NOW));
    assert.ok(got.length > 0, "fixture: the ungated session was offered nothing landside, so the cases below would pass vacuously");
    const snap = await certifiedLayoverSnapshot(db, USER, { sessionId: SESSION, nowMs: NOW });
    // Served, not affirmed: this world's border is unconfirmed, so the gate is a CAUTION.
    assert.ok(snap.ok && snap.snapshot.landsideStatus === "caution" && snap.snapshot.landsideOpen === false, JSON.stringify(snap.ok && snap.snapshot.landsideStatus));
  });

  it("NOTHING declared, where declarations are kept: no landside recommendation, the snapshot closes, one question", async () => {
    const { db } = world({ storage: true });
    assert.equal(landside(await generateRecommendations(db, AIRPORT, await owned(db), NOW)).length, 0,
      "a traveller who has not said whether they change airports was offered a city");
    const snap = await certifiedLayoverSnapshot(db, USER, { sessionId: SESSION, nowMs: NOW });
    assert.ok(snap.ok);
    assert.equal(snap.snapshot.landsideOpen, false);
    assert.equal(snap.snapshot.certifiedRecord.landsideGate.needsInfo, "airportChangeRequired");
  });

  it("an UNREADABLE store on a long window: no landside recommendation, and the snapshot closes", async () => {
    // 600 minutes — a window on which no bag term can change the verdict, so
    // the old gate left it open. The consumer-level half of blocker 2.
    const { db } = world({ storage: true, constraints: ANSWERED, failures: { "layover_constraints:select": { message: "connection reset" } } });
    const session = await owned(db);
    assert.equal(session.constraints?.read, "unreadable");
    assert.equal(landside(await generateRecommendations(db, AIRPORT, session, NOW)).length, 0,
      "landside recommendations were served on a declaration nobody could read");
    const snap = await certifiedLayoverSnapshot(db, USER, { sessionId: SESSION, nowMs: NOW });
    assert.ok(snap.ok);
    assert.equal(snap.snapshot.landsideOpen, false);
    assert.equal(snap.snapshot.verdict, "no");
    assert.ok(snap.snapshot.certifiedRecord.landsideGate.closedBy.includes("constraints_unreadable"));
  });

  it("\"Not sure\" on the airport change: no landside recommendation, and the snapshot closes", async () => {
    const { db } = world({ storage: true, constraints: [{ version: 1, baggage_mode: "CARRY_ON_ONLY", recheck_required: false, airport_change_required: null }] });
    assert.equal(landside(await generateRecommendations(db, AIRPORT, await owned(db), NOW)).length, 0);
    const snap = await certifiedLayoverSnapshot(db, USER, { sessionId: SESSION, nowMs: NOW });
    assert.ok(snap.ok);
    assert.equal(snap.snapshot.landsideOpen, false);
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
    assert.ok(snap.ok && snap.snapshot.landsideStatus === "caution" && snap.snapshot.landsideOpen === false);
    assert.equal(snap.snapshot.verdict, "entry_unverified");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("BLOCKER 3 — a failed FLAG read closes the gate; it is not read as 'off'", () => {
  const FLAGS_DOWN = { "feature_flags:select": { message: "connection reset by peer" } };

  it("`readConstraintFlags` is three-valued: on, off/absent, and UNREADABLE", async () => {
    assert.deepEqual(await readConstraintFlags(world().db as never), { readable: true, storage: false, entryForbidsLandside: false });
    assert.deepEqual(await readConstraintFlags(world({ storage: true, entryPolicy: true }).db as never), { readable: true, storage: true, entryForbidsLandside: true });
    assert.deepEqual(await readConstraintFlags(world({ storage: true, entryPolicy: true, failures: FLAGS_DOWN }).db as never), { readable: false });
    // A client that THROWS is the same fact as one that resolves with an error.
    const throwing = { from() { throw new Error("socket hang up"); } };
    assert.deepEqual(await readConstraintFlags(throwing as never), { readable: false });
  });

  it("the loaders attach `unreadable` — every loader — and the store is not consulted under a guess", async () => {
    // Both flags are ON in the table. The READ of them fails. `isFlagEnabled`
    // answered `false` for that, so the session loaded with NO context: the
    // declared airport change below was invisible and the gate stood open.
    const w = world({
      storage: true, entryPolicy: true, failures: FLAGS_DOWN,
      constraints: [{ version: 1, baggage_mode: "CARRY_ON_ONLY", recheck_required: false, airport_change_required: true }],
    });
    const expected = { read: "unreadable", set: null, entryForbidsLandside: true };
    const one = await owned(w.db);
    assert.deepEqual(one.constraints, expected, "a failed flag read attached no context — the legacy arm, with the gate open");
    const active = await getActiveSession(w.db, USER);
    const list = await listSessions(w.db, USER);
    const batch = await readSessionsByIds(w.db, [SESSION]);
    assert.ok(active.ok && list.ok && batch.ok);
    for (const s of [active.session, list.sessions[0], batch.sessions[0]]) assert.deepEqual(s?.constraints, expected);

    const record = certifySessionFeasibility(AIRPORT, one, { nowMs: NOW, entry: { state: "permitted", status: "visa_free", corridor: { passportCountry: "GB", destinationCountry: "TW" } } });
    assert.equal(record.landsideGate.open, false);
    assert.ok(record.landsideGate.closedBy.includes("constraints_unreadable"));
    assert.equal(record.verdict, "no");
  });

  it("the consumers close on it: no landside recommendation, and the snapshot closes", async () => {
    const { db } = world({ failures: FLAGS_DOWN, entryPermitted: true });
    const recs = await generateRecommendations(db, AIRPORT, await owned(db), NOW);
    assert.ok(recs.ok);
    assert.equal(recs.recommendations.filter((x: any) => !x.insideAirport).length, 0);
    const snap = await certifiedLayoverSnapshot(db, USER, { sessionId: SESSION, nowMs: NOW });
    assert.ok(snap.ok);
    assert.equal(snap.snapshot.landsideOpen, false);
  });

  it("CONTROL: the same world with the flags READABLE (and off) is offered a city", async () => {
    const { db } = world({ storage: false, entryPolicy: false });
    const recs = await generateRecommendations(db, AIRPORT, await owned(db), NOW);
    assert.ok(recs.ok && recs.recommendations.some((x: any) => !x.insideAirport), "fixture: the readable world serves nothing landside");
  });

  it("a declaration is REFUSED as retryable, and nothing is written under a guessed posture", async () => {
    const w = world({ storage: true, failures: FLAGS_DOWN });
    const out = await declareLayoverConstraints(w.db, {
      session: await owned(w.db), airport: AIRPORT, nowMs: NOW, entry: null, patch: { baggageMode: "UNKNOWN" },
    });
    assert.ok(!out.ok && out.reason === "constraints_unreadable" && out.retryable, JSON.stringify(out));
    assert.equal((w.tables.layover_constraints ?? []).length, 0);
    assert.equal(w.tables.layover_sessions[0].checked_bags, false, "the boolean mirror was written although the posture was unknown");
    assert.equal(w.tables.layover_events.length, 0);
  });

  it("at creation it is reported as NOT STORED, never as kept-as-a-boolean", async () => {
    const w = world({ storage: true, failures: FLAGS_DOWN });
    const got = await declareConstraintsAtCreation(w.db, await owned(w.db), { baggageMode: "UNKNOWN" });
    assert.equal(got.constraints?.stored, "not_stored");
    assert.ok(got.constraints?.stored === "not_stored" && got.constraints.reason === "constraints_unreadable" && got.constraints.retryable);
    assert.equal((w.tables.layover_constraints ?? []).length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("SHOULD-FIX 9 — an identical declaration is a no-op, not a new version", () => {
  it("the same patch twice: ONE row, ONE audited event, and the second answer says `unchanged`", async () => {
    const { db, tables } = world({ storage: true });
    const patch = { baggageMode: "COLLECT_RECHECK", recheckRequired: true, airportChangeRequired: false } as const;
    const first = await declareLayoverConstraints(db, { session: await owned(db), airport: AIRPORT, nowMs: NOW, entry: null, patch });
    assert.ok(first.ok && first.stored === "versioned" && first.unchanged !== true);
    const rowAfterFirst = JSON.stringify(tables.layover_constraints);
    const eventsAfterFirst = tables.layover_events.length;

    const second = await declareLayoverConstraints(db, { session: await owned(db), airport: AIRPORT, nowMs: NOW, entry: null, patch });
    assert.ok(second.ok && second.stored === "versioned", JSON.stringify(second));
    assert.equal(second.unchanged, true);
    assert.equal(tables.layover_constraints.length, 1, "an identical declaration appended a second version");
    assert.equal(JSON.stringify(tables.layover_constraints), rowAfterFirst);
    assert.equal(tables.layover_events.length, eventsAfterFirst, "an identical declaration wrote a second audit event");
    assert.equal(second.set.version, 1);
    // The answer is the one the stored set certifies to — the same computation.
    assert.equal(second.record.inputHash, first.record.inputHash);
    assert.deepEqual(second.record.landsideGate, first.record.landsideGate);
  });

  it("a subset of the stored set is also a no-op; a real change still appends", async () => {
    const { db, tables } = world({ storage: true, constraints: [{ version: 4, baggage_mode: "UNKNOWN", recheck_required: null, airport_change_required: false }] });
    for (const patch of [{ baggageMode: "UNKNOWN" }, { recheckRequired: null }, { airportChangeRequired: false }, { baggageMode: "UNKNOWN", recheckRequired: null }] as const) {
      const out = await declareLayoverConstraints(db, { session: await owned(db), airport: AIRPORT, nowMs: NOW, entry: null, patch });
      assert.ok(out.ok && out.stored === "versioned" && out.unchanged === true, JSON.stringify(patch));
      assert.equal(tables.layover_constraints.length, 1, JSON.stringify(patch));
    }
    const changed = await declareLayoverConstraints(db, { session: await owned(db), airport: AIRPORT, nowMs: NOW, entry: null, patch: { baggageMode: "UNKNOWN", recheckRequired: false } });
    assert.ok(changed.ok && changed.stored === "versioned" && changed.unchanged !== true);
    assert.equal(tables.layover_constraints.length, 2);
    assert.equal(tables.layover_constraints[1].version, 5);
    assert.equal(tables.layover_constraints[1].recheck_required, false);
  });

  it("`patchChangesSet` compares only the fields the patch names", () => {
    const set = { version: 1, baggageMode: "UNKNOWN" as const, recheckRequired: null, airportChangeRequired: true };
    assert.equal(patchChangesSet(set, { baggageMode: "UNKNOWN" }), false);
    assert.equal(patchChangesSet(set, { recheckRequired: null, airportChangeRequired: true }), false);
    assert.equal(patchChangesSet(set, { recheckRequired: false }), true, "null → false is a change: it is an answer");
    assert.equal(patchChangesSet(set, { airportChangeRequired: null }), true, "true → null is a change: it withdraws an answer");
    assert.equal(patchChangesSet(set, {}), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("SHOULD-FIX 6 — the external-event port certifies under the declared set", () => {
  function envelope(delayMinutes: number): LayoverEventEnvelope {
    const r = normalizeEvent(
      {
        eventId: `evt-delay-${delayMinutes}`, eventType: "flight.departure_delayed", occurredAt: new Date(NOW - 60_000).toISOString(),
        source: "test.feed", sourceEventId: `src-${delayMinutes}`, subjectRefs: [{ kind: "session", ref: SESSION }],
        payload: { delayMinutes }, confidence: "HIGH",
      },
      { receivedAtMs: NOW },
    );
    if (!r.ok) assert.fail(`envelope did not normalise: ${r.reason} ${r.detail}`);
    return r.event;
  }

  /**
   * A departure where the clock says `no` and an 8-minute delay makes it
   * `tight` without moving usable time by the materiality threshold — so the
   * ONLY reason the pipeline has to notify is "the landside verdict changed".
   */
  function thresholdDeparture(): number {
    for (let m = 120; m < 600; m += 1) {
      const at = (d: number) => certifySessionFeasibility(AIRPORT, {
        id: SESSION, arrivalTime: new Date(NOW).toISOString(), departureTime: new Date(NOW + d * 60_000).toISOString(),
        boardingTime: null, flightType: "international", immigrationRequired: true, checkedBags: false, wantsToLeave: true,
      } as never, { nowMs: NOW });
      const a = at(m); const b = at(m + 8);
      if (a.verdict === "no" && b.verdict === "tight" && b.envelope.usableMinutes - a.envelope.usableMinutes < 10) return m;
    }
    throw new Error("fixture: no threshold departure found");
  }

  async function notified(opts: Parameters<typeof world>[0]): Promise<number> {
    const { db } = world({ minutes: thresholdDeparture(), entryPermitted: true, ...opts });
    const r = await replanExternalEvent(db as never, envelope(8), { nowMs: NOW });
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return -1;
    assert.equal(r.impacted, 1);
    return r.notifications;
  }

  const answered = { baggage_mode: "CARRY_ON_ONLY", recheck_required: false, version: 1 };

  it("POSITIVE CONTROL — flags off, and a fully answered set: the delay changes the verdict and notifies", async () => {
    assert.equal(await notified({}), 1);
    assert.equal(await notified({ storage: true, constraints: [{ ...answered, airport_change_required: false }] }), 1);
  });

  it("a declared AIRPORT CHANGE: `no` stays `no`, so the delay tells nobody their landside verdict improved", async () => {
    // The port built its session from the raw row, with no `constraints`, and
    // re-certified this traveller as if nothing were declared.
    assert.equal(await notified({ storage: true, constraints: [{ ...answered, airport_change_required: true }] }), 0);
  });

  it("\"Not sure\", an unreadable store and unreadable flags all keep the gate closed through the port", async () => {
    assert.equal(await notified({ storage: true, constraints: [{ ...answered, airport_change_required: null }] }), 0);
    assert.equal(await notified({ storage: true, constraints: [{ ...answered, airport_change_required: false }], failures: { "layover_constraints:select": { message: "boom" } } }), 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PR #624 verification, follow-up 2 — the snapshot publishes the THREE-VALUED gate
// ═════════════════════════════════════════════════════════════════════════════
//
// `landsideOpen` was `!forbidden && !explorationCollapsed`: true for a
// cautionary gate, with nothing beside it to tell a caution from an open gate.
// General Compass built its context line from it and told the model "landside
// open" for a traveller whose border nobody had checked.
describe("FOLLOW-UP 2 — `landsideOpen` is true ONLY for an open gate, and the status says which of three it is", () => {
  async function snapOf(db: any) {
    const r = await certifiedLayoverSnapshot(db, USER, { sessionId: SESSION, nowMs: NOW });
    assert.ok(r.ok, `fixture: no snapshot (${JSON.stringify(r)})`);
    return r.snapshot;
  }
  const LANDSIDE_CANDIDATE = { id: "gem-landside", insideAirport: false, lat: 25.05, lng: 121.3, travelTimeMin: 20, returnTravelTimeMin: 20, activityTimeMin: 30 };
  const AIRSIDE_CANDIDATE = { id: "lounge", insideAirport: true, activityTimeMin: 30 };
  /** Every question answered "no": nothing in it closes anything. */
  const ANSWERED = [{ version: 1, baggage_mode: "CARRY_ON_ONLY", recheck_required: false, airport_change_required: false }];
  /** Ten hours, a confirmed border, and a constraint store that cannot be read: CLOSED with the whole window left. */
  const UNREADABLE_STORE = { storage: true, entryPermitted: true, failures: { "layover_constraints:select": { message: "down" } } };

  it("OPEN: a confirmed border and nothing unanswered — the one case the boolean is true", async () => {
    const s = await snapOf(world({ entryPermitted: true }).db);
    assert.equal(s.verdict, "yes");
    assert.equal(s.landsideStatus, "open");
    assert.equal(s.landsideOpen, true);
    assert.deepEqual(s.landsideCautions, []);
    assert.equal(s.landsideClosedReason, null);
    assert.equal(landsideContextPhrase(s), "open");
    assert.equal(landsideNotForbidden(s), true);
  });

  it("CAUTION: a border nobody confirmed is NOT `landsideOpen`, is not closed, and the model is told what it may not say", async () => {
    const s = await snapOf(world().db);
    assert.equal(s.verdict, "entry_unverified");
    assert.equal(s.landsideStatus, "caution");
    assert.equal(s.landsideOpen, false, "a cautionary gate was published as landsideOpen");
    assert.deepEqual(s.landsideCautions, ["entry_unconfirmed"]);
    assert.equal(s.landsideClosedReason, null, "a caution is not a closure and must not carry a closed reason");
    assert.equal(landsideNotForbidden(s), true);

    const phrase = landsideContextPhrase(s);
    assert.match(phrase, /^not forbidden, not confirmed \(entry_unconfirmed\)/);
    assert.match(phrase, /do NOT tell the traveller they can leave the airport/);
    assert.doesNotMatch(phrase, /^open\b|landside open|\bis open\b/);
  });

  it("CLOSED: a refusal, an unreadable store and a collapsed exploration are all `closed`, with the reason", async () => {
    const unreadable = await snapOf(world(UNREADABLE_STORE).db);
    assert.ok(unreadable.usableMinutes > 300, "fixture: this closure must be one the clock did not cause");
    assert.equal(unreadable.landsideStatus, "closed");
    assert.equal(unreadable.landsideOpen, false);
    assert.deepEqual(unreadable.landsideCautions, []);
    assert.match(String(unreadable.landsideClosedReason), /"no"/);
    assert.match(landsideContextPhrase(unreadable), /^closed \(/);
    assert.equal(landsideNotForbidden(unreadable), false);

    const short = await snapOf(world({ entryPermitted: true, minutes: 60 }).db);
    assert.equal(short.landsideStatus, "closed");
    assert.equal(short.landsideOpen, false);
  });

  it("EVERY world: the boolean is true exactly when the status is `open`, and `open` exactly when the verdict is `yes`", async () => {
    const worlds: Array<Parameters<typeof world>[0]> = [
      {}, { entryPermitted: true }, { entryPolicy: true }, { entryPolicy: false }, { storage: true }, { storage: true, entryPermitted: true },
      { storage: true, entryPermitted: true, constraints: ANSWERED }, { storage: true, constraints: ANSWERED },
      { entryPermitted: true, minutes: 60 }, { minutes: 60 }, { entryPermitted: true, session: { wants_to_leave: false } },
      { failures: { "feature_flags:select": { message: "down" } } },
      { storage: true, entryPermitted: true, failures: { "layover_constraints:select": { message: "down" } } },
    ];
    const seen = new Set<string>();
    for (const w of worlds) {
      const s = await snapOf(world(w).db);
      const where: string = JSON.stringify(w);
      seen.add(s.landsideStatus);
      assert.equal(s.landsideOpen, s.landsideStatus === "open", where);
      assert.equal(s.landsideStatus === "open", s.verdict === "yes" && !s.posture.explorationCollapsed, where);
      if (s.landsideStatus !== "caution") assert.deepEqual(s.landsideCautions, [], where);
      if (s.landsideStatus === "caution") assert.ok(s.landsideCautions.length > 0, `${where}: a caution that names nothing`);
      assert.equal(s.landsideClosedReason === null, s.landsideStatus !== "closed", where);
      if (s.landsideStatus !== "open") assert.notEqual(landsideContextPhrase(s), "open", where);
    }
    assert.deepEqual([...seen].sort(), ["caution", "closed", "open"], "NON-VACUITY: the worlds above did not reach all three statuses");
  });

  it("the action universe: landside is ADMITTED under open and caution, CLOSED under closed — and says which", async () => {
    const open = await snapOf(world({ entryPermitted: true }).db);
    const caution = await snapOf(world().db);
    const closed = await snapOf(world(UNREADABLE_STORE).db);

    const uOpen = await certifiedActionUniverse(open, [LANDSIDE_CANDIDATE, AIRSIDE_CANDIDATE]);
    assert.deepEqual(uOpen.admittedIds, ["gem-landside", "lounge"]);
    assert.equal(uOpen.landsideStatus, "open");
    assert.equal(uOpen.landsideOpen, true);

    // The owner's forbid policy is OFF: content is still served under a caution…
    const uCaution = await certifiedActionUniverse(caution, [LANDSIDE_CANDIDATE, AIRSIDE_CANDIDATE]);
    assert.deepEqual(uCaution.admittedIds, ["gem-landside", "lounge"]);
    // …and the universe no longer calls that open.
    assert.equal(uCaution.landsideStatus, "caution");
    assert.equal(uCaution.landsideOpen, false);

    const uClosed = await certifiedActionUniverse(closed, [LANDSIDE_CANDIDATE, AIRSIDE_CANDIDATE]);
    assert.deepEqual(uClosed.admittedIds, ["lounge"]);
    assert.deepEqual(uClosed.refusedIds, ["gem-landside"]);
    assert.equal(uClosed.actions.find((a) => a.id === "gem-landside")?.state, "CLOSED");

    // With the owner's policy ON the same unconfirmed border is a closure, and nothing landside is admitted.
    const policyOn = await snapOf(world({ entryPolicy: true }).db);
    assert.equal(policyOn.landsideStatus, "closed");
    assert.deepEqual((await certifiedActionUniverse(policyOn, [LANDSIDE_CANDIDATE, AIRSIDE_CANDIDATE])).admittedIds, ["lounge"]);
  });

  it("a snapshot with NO status (built by hand, or by an older build) is not served landside content", async () => {
    const open = await snapOf(world({ entryPermitted: true }).db);
    for (const status of [undefined, null, "OPEN", "", "some_future_status"]) {
      const handBuilt = { ...open, landsideOpen: true, landsideStatus: status as never };
      const u = await certifiedActionUniverse(handBuilt, [LANDSIDE_CANDIDATE, AIRSIDE_CANDIDATE]);
      assert.deepEqual(u.admittedIds, ["lounge"], `status=${String(status)}: landside admitted on a status nobody stated`);
      assert.equal(landsideNotForbidden(handBuilt), false, String(status));
      assert.match(landsideContextPhrase(handBuilt), /^closed/, String(status));
    }
  });

  it("the Compass snapshot tool hands the model the status, and NO reach under a closed gate", async () => {
    const cautioned: any = await toolGetLayoverSnapshot(world().db as never, USER);
    assert.equal(cautioned.snapshot.landsideStatus, "caution");
    assert.equal(cautioned.snapshot.landsideOpen, false);
    assert.ok(cautioned.snapshot.envelope, "fixture: a cautionary snapshot must still carry its envelope");

    // The snapshot itself still holds an envelope under this closure (banding needs it) — the TOOL withholds it.
    assert.ok((await snapOf(world(UNREADABLE_STORE).db)).envelope, "fixture: the closed snapshot must hold an envelope for the tool to withhold");
    const closed: any = await toolGetLayoverSnapshot(world(UNREADABLE_STORE).db as never, USER);
    assert.equal(closed.snapshot.landsideStatus, "closed");
    assert.equal(closed.snapshot.envelope, null, "a closed gate still handed the model an envelope to describe");
    assert.equal(closed.snapshot.envelopeUnavailableReason, "landside_closed");
    assert.equal("certifiedRecord" in closed.snapshot, false);
  });

  it("RATCHET: general Compass builds its context line from the three-valued phrase, not the boolean", () => {
    const src = readFileSync(new URL("../../../routes/compass.ts", import.meta.url), "utf8");
    assert.match(src, /landside \$\{landsideContextPhrase\(s\)\}/, "routes/compass.ts no longer phrases the gate through landsideContextPhrase");
    assert.doesNotMatch(src, /s\.landsideOpen \? "open"/, "routes/compass.ts tells the model `open` from the boolean again");
    // And every other production reader of the boolean is one this lane has looked at.
    const READERS_OF_THE_BOOLEAN = ["lib/discoveryLayoverMode.ts", "services/airport/LayoverSnapshot.ts", "compass/CompassClarification.ts"];
    const root = new URL("../../../", import.meta.url);
    const found: string[] = [];
    const walk = (dir: URL) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== "test" && e.name !== "__tests__" && e.name !== "node_modules" && e.name !== "migrations") walk(new URL(`${e.name}/`, dir)); continue; }
        if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
        const text = readFileSync(new URL(e.name, dir), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        if (/\blandsideOpen\b/.test(text)) found.push(new URL(e.name, dir).pathname.slice(root.pathname.length));
      }
    };
    walk(root);
    assert.deepEqual(found.sort(), [...READERS_OF_THE_BOOLEAN].sort(), "a production file reads or writes `landsideOpen` that is not on the reviewed list — read `landsideStatus` instead, or add it here with a reason");
  });
});

// At the tail (an ESM import is hoisted wherever it is written).
import { readFileSync, readdirSync } from "node:fs";
import { certifiedActionUniverse, landsideContextPhrase, landsideNotForbidden } from "../../airport/LayoverSnapshot.js";
import { toolGetLayoverSnapshot } from "../../../compass/CompassTools.js";
