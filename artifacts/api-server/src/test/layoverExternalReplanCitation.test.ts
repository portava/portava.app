/**
 * census-layover L92 / L257 / L207 (C10) — layover round 2, lane B: the
 * EXTERNAL-event replan path (LayoverExternalReplanPort), unit by unit.
 *
 *   STEP 1 AT THE LAST DOOR. Every external event reaches a session through the
 *   port, so §11.1 step 1 runs there on the envelope the consumer claimed:
 *   `normalizeEvent` again (a row this code did not write is held to the same
 *   validators as a fresh POST, and its stored key must be its own stable source
 *   key), then `dedupeEvents` — which until this lane had no caller outside
 *   tests — over the events the port already let through.
 *
 *   THE SNAPSHOT CITATION (pass 10, C10). With `layover_decision_persistence_
 *   enabled` ON, each replanned session's §20 record goes through the SAME
 *   `recordReplanDecision` the traveller's PATCH replan uses: the certified record
 *   is stored by `persistDecision` and the record cites the stored snapshot.
 *   Absent (production today), off or unreadable: no record is built, nothing is
 *   written, and the port's report is unchanged — or names why.
 *
 * No loopback: the port is driven directly and through the consumer.
 * Run: node --import tsx/esm --test src/test/layoverExternalReplanCitation.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeLayoverDb, airportRow } from "./helpers/fakeLayoverDb.js";
import {
  layoverExternalReplanPort,
  replanExternalEvent,
  revalidateExternalEvent,
} from "../services/airport/LayoverExternalReplanPort.js";
import { normalizeEvent, type LayoverEventEnvelope } from "../services/airport/LayoverEventReplanner.js";
import {
  LAYOVER_EXTERNAL_REPLAN_WIRING_VERSION,
  replanForWindowChange,
} from "../services/airport/LayoverReplanService.js";
import { drainPendingExternalEvents } from "../services/layover/layoverExternalEventConsumer.js";
import { snapshotIdFor } from "../services/airport/layoverLedger.js";
import type { FeasibilityAirport, FeasibilitySession } from "../services/airport/LayoverFeasibility.js";

const NOW = Date.parse("2026-10-18T06:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const PERSIST = "layover_decision_persistence_enabled";
const STAMP = "layover_recommendation_snapshot_enabled";
const USER = "user-1";

function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: "evt-1",
    eventType: "flight.departure_delayed",
    occurredAt: new Date(NOW - 5 * MIN).toISOString(),
    source: "acme-flight-feed",
    sourceEventId: "acme-777",
    subjectRefs: [{ kind: "session", ref: "session-1" }],
    payload: { delayMinutes: 45 },
    confidence: "HIGH",
    ...over,
  };
}

function envelope(over: Record<string, unknown> = {}): LayoverEventEnvelope {
  const r = normalizeEvent(raw(over) as any, { receivedAtMs: NOW });
  if (!r.ok) assert.fail(`fixture did not normalise: ${r.reason} ${r.detail}`);
  return r.event;
}

/** `layover_external_events` as Postgres hands it back: instants spelled `+00:00`. */
function storedRow(e: LayoverEventEnvelope, over: Record<string, unknown> = {}): Record<string, unknown> {
  const pg = (iso: string) => iso.replace(/\.\d{3}Z$/, "+00:00");
  return {
    event_id: e.eventId, event_type: e.eventType, occurred_at: pg(e.occurredAt), received_at: pg(e.receivedAt),
    source: e.source, source_event_id: e.sourceEventId, subject_refs: e.subjectRefs, payload: e.payload,
    dedup_key: e.dedupKey, confidence: e.confidence, processed_at: null, ...over,
  };
}

function sessionRow(over: Record<string, unknown> = {}) {
  return {
    id: "session-1", user_id: USER, airport_id: "airport-tpe", manual_iata: null,
    arrival_time: new Date(NOW - HOUR).toISOString(), departure_time: new Date(NOW + 8 * HOUR).toISOString(),
    boarding_time: null, flight_type: "international", immigration_required: true, checked_bags: false,
    wants_to_leave: true, status: "active", ...over,
  };
}

/**
 * The world, with every table the path could touch recorded, and the flag reads
 * by name. `failFlag` makes ONE flag's read fail (the double's failure switch is
 * per table, and failing every flag would also close the constraint and entry
 * reads this case is not about).
 */
function world(opts: { flags?: Array<{ flag: string; enabled: boolean }>; failFlag?: string; rows?: Record<string, unknown>[]; sessions?: Record<string, unknown>[]; tables?: Record<string, any[]>; failures?: Record<string, { message: string; code?: string }> } = {}) {
  const tables: Record<string, any[]> = {
    feature_flags: opts.flags ?? [],
    layover_sessions: opts.sessions ?? [sessionRow()],
    airport_profiles: [{ ...airportRow(), terminal_info: {} }],
    layover_plan_stops: [],
    layover_external_events: opts.rows ?? [],
    ...(opts.tables ?? {}),
  };
  const fake = makeLayoverDb(tables, { failures: opts.failures });
  const touched: string[] = [];
  const flagReads: string[] = [];
  const client = {
    ...fake,
    from(table: string) {
      touched.push(table);
      const b = fake.from(table);
      if (table === "feature_flags") {
        let named: unknown = null;
        const eq = b.eq;
        b.eq = (col: string, v: unknown) => { if (col === "flag") { named = v; flagReads.push(String(v)); } return eq.call(b, col, v); };
        const maybeSingle = b.maybeSingle;
        b.maybeSingle = () => (opts.failFlag !== undefined && named === opts.failFlag
          ? Promise.resolve({ data: null, error: { message: "feature_flags unavailable" } })
          : maybeSingle.call(b));
      }
      return b;
    },
  } as any;
  return { tables, client, touched, flagReads };
}

const WRITTEN = ["layover_events", "layover_certified_computations", "layover_time_budgets", "layover_return_plans", "layover_recommendations"];
const decisionRows = (t: Record<string, any[]>) => (t.layover_events ?? []).filter((e) => e.metadata?.decision);

// ── step 1, validate half ────────────────────────────────────────────────────

describe("L257 — every external event is VALIDATED at the port, whatever wrote its row", () => {
  it("a stored row whose payload fails its type's validator is refused by name — no session is read, nothing is replanned", async () => {
    // rowToEnvelope only checks that `payload` is an object; `Number("90")` would
    // have replanned this as a 90-minute delay. A row written around the ingest
    // (a manual INSERT, a backfill) must meet the same validator a POST does.
    const e = envelope();
    const { client, touched } = world({ rows: [storedRow(e, { payload: { delayMinutes: "90" } })] });
    const report = await drainPendingExternalEvents(client, layoverExternalReplanPort(client, { nowMs: NOW }), { limit: 10, nowMs: NOW });
    assert.equal(report.drained.length, 0);
    assert.equal(report.failedAfterClaim.length, 1);
    assert.match(report.failedAfterClaim[0]!.reason, /^event_invalid: bad_payload: delayMinutes must be a finite number/);
    assert.equal(touched.includes("layover_sessions"), false, "a refused event never reads a session");
  });

  it("a stored row dated after its own receipt is refused `occurred_in_future`", async () => {
    const e = envelope();
    const r = await replanExternalEvent(world().client, { ...e, occurredAt: new Date(NOW + MIN).toISOString() }, { nowMs: NOW + HOUR });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /^event_invalid: occurred_in_future/);
  });

  it("a stored key that is not the event's own stable source key is refused `dedup_key_mismatch` — the index could not have deduped it", async () => {
    const e = envelope();
    const { client, touched } = world();
    const r = await replanExternalEvent(client, { ...e, dedupKey: "acme-flight-feed:something-else" }, { nowMs: NOW });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /^dedup_key_mismatch: stored acme-flight-feed:something-else is not this event's stable source key acme-flight-feed:acme-777/);
    assert.equal(touched.includes("layover_sessions"), false);
  });

  it("a digest-keyed event read back with Postgres's `+00:00` spelling re-derives the SAME key and replans", async () => {
    // The ingest hashed the producer's `…Z`; the store returns `+00:00`. If the
    // digest hashed the spelling, every content-keyed event would be refused here.
    const e = envelope({ sourceEventId: undefined, occurredAt: new Date(NOW - 5 * MIN).toISOString().replace(".000Z", "Z") });
    assert.match(e.dedupKey, /^sha256:/);
    const { client } = world({ rows: [storedRow(e)] });
    const report = await drainPendingExternalEvents(client, layoverExternalReplanPort(client, { nowMs: NOW }), { limit: 10, nowMs: NOW });
    assert.deepEqual(report.failedAfterClaim, []);
    assert.deepEqual(report.drained.map((d) => d.impacted), [1]);
  });

  it("re-validating an envelope `normalizeEvent` minted is the identity", () => {
    const e = envelope();
    const r = revalidateExternalEvent(e);
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.event, e);
  });
});

// ── step 1, deduplicate half ─────────────────────────────────────────────────

describe("L92 — every external event is DEDUPLICATED at the port by its stable key (`dedupeEvents`)", () => {
  it("first occurrence wins: the copy reads no session and reports `impacted: 0` with the first event's id", async () => {
    const { client, touched } = world();
    const port = layoverExternalReplanPort(client, { nowMs: NOW });
    const first = await port.replan(envelope());
    const sessionReads = touched.filter((t) => t === "layover_sessions").length;
    const copy = await port.replan(envelope({ eventId: "evt-2" }));
    assert.deepEqual([first.ok && first.impacted, first.ok && first.duplicateOf], [1, undefined]);
    assert.deepEqual(copy, { ok: true, impacted: 0, notifications: 0, duplicateOf: "evt-1" });
    assert.equal(touched.filter((t) => t === "layover_sessions").length, sessionReads, "the duplicate read no session");
  });

  it("eventId is NOT the key: two different facts under one eventId both replan", async () => {
    const { client } = world();
    const port = layoverExternalReplanPort(client, { nowMs: NOW });
    const a = await port.replan(envelope());
    const b = await port.replan(envelope({ sourceEventId: "acme-778", payload: { delayMinutes: 90 } }));
    assert.deepEqual([a.ok && a.impacted, b.ok && b.impacted], [1, 1]);
  });

  it("validation runs BEFORE dedup: a refused copy does not occupy the key, so the valid event after it still replans", async () => {
    const { client } = world();
    const port = layoverExternalReplanPort(client, { nowMs: NOW });
    const bad = await port.replan({ ...envelope(), payload: { delayMinutes: "soon" } });
    const good = await port.replan(envelope({ eventId: "evt-2" }));
    assert.equal(bad.ok, false);
    assert.equal(good.ok && good.impacted, 1);
  });

  it("the external path calls the spec's dedup function — pass 10's grep now finds a non-test caller", () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "services", "airport", "LayoverExternalReplanPort.ts"), "utf8");
    assert.match(src, /dedupeEvents\(\[\.\.\.admitted, checked\.event\]\)/);
    assert.match(src, /return replanFirstOccurrence\(db, event, admitted,/, "the port's replan goes through step 1");
  });
});

// ── L207 / C10 — the external replan cites its snapshot (persistence ON) ─────

async function replanOnce(w: ReturnType<typeof world>, e = envelope()) {
  const r = await replanExternalEvent(w.client, e, { nowMs: NOW });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) throw new Error("refused");
  return r;
}

describe("L207 — with persistence ON the external replan stores its snapshot and its §20 record CITES it", () => {
  it("one record per replanned session, through recordReplanDecision: snapshotId is the stored computation's, all ten members real", async () => {
    const w = world({ flags: [{ flag: PERSIST, enabled: true }] });
    const r = await replanOnce(w);

    assert.equal(w.tables.layover_certified_computations.length, 1, "the replan's certified record was stored");
    const stored = w.tables.layover_certified_computations[0];
    const rows = decisionRows(w.tables);
    assert.equal(rows.length, 1, "one ledger row carries the decision");
    assert.equal(rows[0].user_id, USER, "on the session owner's ledger");
    assert.equal(rows[0].event_type, "session_updated");
    const decision = rows[0].metadata.decision;
    const published = rows[0].metadata.replan;

    assert.equal(decision.snapshotId, snapshotIdFor("session-1", decision.inputHash));
    assert.equal(decision.snapshotId, stored.snapshot_id, "the record cites exactly the stored row");
    assert.equal(stored.input_hash, decision.inputHash);
    assert.ok(!("snapshotUnavailableReason" in decision));
    for (const k of ["sessionId", "snapshotId", "engineVersion", "inputHash", "inputFacts", "sourceRefs", "rulesApplied", "result", "reasonCodes", "computedAt"]) {
      assert.ok(decision[k] !== null && decision[k] !== undefined, `member ${k} is empty`);
    }
    assert.deepEqual(decision.sourceRefs, ["acme-flight-feed:evt-1", "dedupKey:acme-flight-feed:acme-777"], "the producer is named, not the traveller");
    assert.equal(decision.rulesApplied[0], "11.1.1 normalize+dedupe", "and that label is now true on this path");
    assert.deepEqual(decision.inputFacts.map((f: any) => f.node), ["session.departureTime"]);
    assert.equal(decision.inputFacts[0].after, new Date(NOW + 8 * HOUR + 45 * MIN).toISOString());

    assert.equal(published.wiringVersion, LAYOVER_EXTERNAL_REPLAN_WIRING_VERSION);
    assert.equal(published.snapshotPersisted, true);
    assert.equal(published.snapshotId, decision.snapshotId);
    assert.equal(published.event.source, "acme-flight-feed");

    assert.deepEqual(r.snapshots, [{ recorded: true, citations: [{ sessionId: "session-1", snapshotPersisted: true, snapshotId: decision.snapshotId }] }]);
  });

  it("a live-term event cites the fact it was decided on: the security queue, null → 40, read off the certified inputs", async () => {
    const w = world({ flags: [{ flag: PERSIST, enabled: true }] });
    await replanOnce(w, envelope({ eventType: "airport.security_wait_changed", sourceEventId: "q-1", subjectRefs: [{ kind: "airport", ref: "TPE" }], payload: { waitMinutes: 40 } }));
    const decision = decisionRows(w.tables)[0].metadata.decision;
    assert.deepEqual(decision.inputFacts, [{ node: "liveConditions.securityWaitExtraMin", before: null, after: 40 }]);
    assert.equal(decision.snapshotId, w.tables.layover_certified_computations[0].snapshot_id);
  });

  it("a session with no owner is NAMED `owner_unknown` and written to nobody's ledger", async () => {
    const w = world({ flags: [{ flag: PERSIST, enabled: true }], sessions: [sessionRow({ user_id: null })] });
    const r = await replanOnce(w);
    assert.deepEqual(r.snapshots, [{ recorded: true, citations: [{ sessionId: "session-1", snapshotPersisted: false, snapshotId: null, snapshotUnavailableReason: "owner_unknown" }] }]);
    for (const t of WRITTEN) assert.equal((w.tables[t] ?? []).length, 0, `${t} written for an ownerless session`);
  });

  it("persistDecision refuses: NO citation, its own reason recorded, and the replan still reports success", async () => {
    const w = world({ flags: [{ flag: PERSIST, enabled: true }], failures: { "layover_certified_computations:insert": { message: "check violation" } } });
    const r = await replanOnce(w);
    const decision = decisionRows(w.tables)[0].metadata.decision;
    assert.equal(decision.snapshotId, null);
    assert.equal(decision.snapshotUnavailableReason, "write_failed");
    assert.equal(r.impacted, 1);
    assert.deepEqual(r.snapshots, [{ recorded: true, citations: [{ sessionId: "session-1", snapshotPersisted: false, snapshotId: null, snapshotUnavailableReason: "write_failed" }] }]);
  });

  it("with 3623's stamp flag ON too, step 6 is APPLIED on this path as on the PATCH path: a stale citation is cleared and audited", async () => {
    const w = world({
      flags: [{ flag: PERSIST, enabled: true }, { flag: STAMP, enabled: true }],
      tables: { layover_recommendations: [{ id: "rec-stale", session_id: "session-1", rec_type: "food", title: "x", status: "active", snapshot_id: "snap:old" }] },
    });
    await replanOnce(w);
    assert.equal(w.tables.layover_recommendations[0].snapshot_id, null);
    const applied = decisionRows(w.tables)[0].metadata.replan.invalidationApplied;
    assert.equal(applied.applied, true);
    assert.deepEqual(applied.uncited.map((u: any) => u.recommendationId), ["rec-stale"]);
  });

  it("SHAPE PARITY: the external record and publication have exactly the PATCH replan's members", async () => {
    const w = world({ flags: [{ flag: PERSIST, enabled: true }] });
    await replanOnce(w);
    const ext = decisionRows(w.tables)[0].metadata;
    const airport: FeasibilityAirport = { id: "airport-tpe", iataCode: "TPE", timezone: "Asia/Taipei", verified: false, domesticBufferMin: 60, internationalBufferMin: 120, immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20 };
    const before = { id: "session-1", arrivalTime: new Date(NOW - HOUR).toISOString(), departureTime: new Date(NOW + 8 * HOUR).toISOString(), boardingTime: null, flightType: "international", immigrationRequired: true, checkedBags: false, wantsToLeave: true } as FeasibilitySession;
    const patch = replanForWindowChange({ airport, airportRef: "TPE", before, after: { ...before, departureTime: new Date(NOW + 9 * HOUR).toISOString() }, status: "active", candidates: [], nowMs: NOW });
    assert.equal(patch.ran, true);
    if (!patch.ran) return;
    const keys = (o: object) => Object.keys(o).sort();
    assert.deepEqual(keys(ext.decision).filter((k) => k !== "snapshotUnavailableReason"), keys(patch.decision).filter((k) => k !== "snapshotUnavailableReason"));
    const optional = new Set(["snapshotId", "snapshotUnavailableReason", "invalidationApplied"]);
    assert.deepEqual(keys(ext.replan).filter((k) => !optional.has(k)), keys(patch.publication).filter((k) => !optional.has(k)));
  });
});

// ── inert while persistence is unpressed ─────────────────────────────────────

describe("L207 — while persistence is unpressed the external path builds no record and writes nothing", () => {
  for (const [label, flags] of [
    ["ABSENT (production today: 2700/2992/3792 unapplied)", []],
    ["OFF", [{ flag: PERSIST, enabled: false }]],
  ] as Array<[string, Array<{ flag: string; enabled: boolean }>]>) {
    it(`persistence ${label}: the report is exactly what it was, ONE flag row is read, and nothing is written`, async () => {
      const w = world({ flags });
      const r = await replanOnce(w);
      assert.deepEqual(Object.keys(r).sort(), ["impacted", "notifications", "ok"], "no new key on the report");
      assert.equal(r.impacted, 1);
      assert.equal(w.flagReads.filter((f) => f === PERSIST).length, 1, "the one contact is the persistence flag");
      assert.equal(w.flagReads.includes(STAMP), false, "step 6's flag is not even read");
      for (const t of WRITTEN) assert.equal((w.tables[t] ?? []).length, 0, `${t} written without the press`);
    });
  }

  it("persistence flag UNREADABLE: nothing written, and the report NAMES it — unreadable is not off", async () => {
    const w = world({ flags: [{ flag: PERSIST, enabled: true }], failFlag: PERSIST });
    const r = await replanOnce(w);
    assert.deepEqual(r.snapshots, [{ recorded: false, reason: "persistence_flag_unreadable", sessions: ["session-1"] }]);
    for (const t of WRITTEN) assert.equal((w.tables[t] ?? []).length, 0, `${t} written on an unreadable flag`);
  });

  it("an event that replans nobody (a gate change moves no constraint node) reads no persistence flag at all", async () => {
    const w = world({ flags: [{ flag: PERSIST, enabled: true }] });
    const r = await replanOnce(w, envelope({ eventType: "flight.gate_changed", sourceEventId: "g-1", payload: { gate: "B7" } }));
    assert.deepEqual(r, { ok: true, impacted: 1, notifications: 0 });
    assert.equal(w.flagReads.includes(PERSIST), false);
    for (const t of WRITTEN) assert.equal((w.tables[t] ?? []).length, 0);
  });
});
