/**
 * census-layover L190 — `LayoverDecisionService.diff(previousSnapshotId,
 * nextSnapshotId)`, the half a traveller is shown: "what changed since the last
 * answer" (the spec's north star).
 *
 * `travellerChangesOf` reports each field a traveller acts on with its value in
 * both stored answers, and reports usable time only when neither the clock nor
 * the moved deadline explains it. The route serves it as `changes` beside the
 * existing `diff`, over the same resolution as `diffSnapshots`.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 *   - the clock reported as a change (every refresh "changed");
 *   - a moved deadline reported without its values or its direction;
 *   - a later arrival (the window's start moving) hidden as clock;
 *   - the route dropping `changes`, or answering for another session's snapshot,
 *     or diffing an unreadable ledger as empty, or reading with persistence OFF.
 *
 * Run: node --import tsx/esm --test src/test/layoverDecisionChanges.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { certifySessionFeasibility, type FeasibilityAirport, type FeasibilitySession } from "../services/airport/LayoverFeasibility.js";
import { decisionRecordFor, type DecisionRecord } from "../services/airport/layoverLedger.js";
import { DECISION_PERSISTENCE_FLAG, persistDecision } from "../services/layover/LayoverDecisionStore.js";
import {
  USABLE_ROUNDING_TOLERANCE_MIN,
  diffSnapshotsForTraveller,
  travellerChangesOf,
} from "../services/layover/LayoverDecisionService.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const ARRIVAL = Date.parse("2026-09-13T02:00:00.000Z");
/** Well after the exit: the window starts at "now", so usable time loses every minute that passes. */
const OUT = ARRIVAL + 3 * HOUR;

function airport(): FeasibilityAirport {
  return {
    id: "airport-tpe", iataCode: "TPE", timezone: "Asia/Taipei", verified: true,
    domesticBufferMin: 60, internationalBufferMin: 120,
    immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
  };
}

function session(over: Partial<FeasibilitySession> = {}, id = "session-1"): FeasibilitySession {
  return {
    id,
    arrivalTime: new Date(ARRIVAL).toISOString(),
    departureTime: new Date(ARRIVAL + 9 * HOUR).toISOString(),
    boardingTime: null,
    flightType: "international",
    immigrationRequired: true,
    checkedBags: false,
    wantsToLeave: true,
    ...over,
  };
}

function answer(nowMs: number, over: Partial<FeasibilitySession> = {}, id = "session-1"): DecisionRecord {
  return decisionRecordFor(id, certifySessionFeasibility(airport(), session(over, id), { nowMs, liveConditions: null }));
}

const fields = (cs: Array<{ field: string }>) => cs.map((c) => c.field);

describe("L190 — travellerChangesOf: what a traveller is told changed", () => {
  it("an answer compared with itself changes nothing", () => {
    const a = answer(OUT);
    assert.deepEqual(travellerChangesOf(a, a), []);
  });

  it("the CLOCK is not a change: ten minutes later, usable time is ten minutes shorter and nothing is reported", () => {
    const a = answer(OUT);
    const b = answer(OUT + 10 * MIN);
    assert.equal(b.result.usableMinutes, a.result.usableMinutes - 10, "precondition: the window starts at now");
    assert.equal(a.result.hardReturnTime, b.result.hardReturnTime);
    assert.deepEqual(travellerChangesOf(a, b), []);
  });

  it("before the exit the clock moves nothing either", () => {
    const a = answer(ARRIVAL);
    const b = answer(ARRIVAL + 5 * MIN);
    assert.equal(b.result.usableMinutes, a.result.usableMinutes, "precondition: the window starts at the exit");
    assert.deepEqual(travellerChangesOf(a, b), []);
  });

  it("a departure moved an hour EARLIER: the deadline is reported with both values and how far it moved, usable time is not repeated", () => {
    const a = answer(OUT);
    const b = answer(OUT + 2 * MIN, { departureTime: new Date(ARRIVAL + 8 * HOUR).toISOString() });
    const cs = travellerChangesOf(a, b);
    const deadline = cs.find((c) => c.field === "hardReturnTime");
    assert.ok(deadline, `expected a deadline change, got ${JSON.stringify(cs)}`);
    assert.equal(deadline.previous, a.result.hardReturnTime);
    assert.equal(deadline.next, b.result.hardReturnTime);
    // The deadline is the departure less the return buffer, and the return leg is rated at its own hour, so
    // an hour earlier can move it by more than sixty minutes. The number is the two stored deadlines' own gap.
    assert.equal(deadline.minutesMoved, Math.round((Date.parse(b.result.hardReturnTime) - Date.parse(a.result.hardReturnTime)) / MIN));
    assert.ok((deadline.minutesMoved ?? 0) <= -60, "earlier by at least the hour the flight moved");
    assert.ok(!fields(cs).includes("usableMinutes"), "the deadline explains the usable change");
  });

  it("a departure moved LATER is reported as a later deadline (+45)", () => {
    const a = answer(OUT);
    const b = answer(OUT, { departureTime: new Date(ARRIVAL + 9 * HOUR + 45 * MIN).toISOString() });
    const deadline = travellerChangesOf(a, b).find((c) => c.field === "hardReturnTime");
    assert.equal(deadline?.minutesMoved, 45);
  });

  it("a LATER ARRIVAL (the window's start moved) is reported as usable time, with both values", () => {
    const a = answer(ARRIVAL);
    const b = answer(ARRIVAL + MIN, { arrivalTime: new Date(ARRIVAL + 50 * MIN).toISOString() });
    assert.equal(a.result.hardReturnTime, b.result.hardReturnTime, "precondition: the deadline did not move");
    const usable = travellerChangesOf(a, b).find((c) => c.field === "usableMinutes");
    assert.ok(usable, "a shrink the clock cannot explain must be told");
    assert.equal(usable.previous, a.result.usableMinutes);
    assert.equal(usable.next, b.result.usableMinutes);
    assert.ok((usable.next as number) < (usable.previous as number));
  });

  it("a verdict that changed is reported first, with both values", () => {
    const a = answer(OUT);
    const b = answer(OUT, { departureTime: new Date(OUT + 2 * HOUR + 30 * MIN).toISOString() });
    assert.notEqual(a.result.verdict, b.result.verdict, "precondition: the shorter connection changes the verdict");
    const cs = travellerChangesOf(a, b);
    assert.equal(cs[0]?.field, "verdict");
    assert.deepEqual([cs[0]?.previous, cs[0]?.next], [a.result.verdict, b.result.verdict]);
  });

  it("the return state moving toward the deadline is reported (it is what to do now)", () => {
    const a = answer(OUT);
    const late = Date.parse(a.result.hardReturnTime) - 20 * MIN;
    const b = answer(late);
    assert.notEqual(a.result.returnState, b.result.returnState, "precondition: 20 minutes before the hard return is past NORMAL");
    const rs = travellerChangesOf(a, b).find((c) => c.field === "returnState");
    assert.deepEqual([rs?.previous, rs?.next], [a.result.returnState, b.result.returnState]);
  });

  it("the explained band is exact: one minute of rounding on either side, and not one minute more", () => {
    const a = answer(OUT);
    const at = (deltaMin: number, elapsedMin: number): DecisionRecord => ({
      ...a,
      computedAt: new Date(Date.parse(a.computedAt) + elapsedMin * MIN).toISOString(),
      result: { ...a.result, usableMinutes: a.result.usableMinutes + deltaMin },
    });
    const told = (r: DecisionRecord) => fields(travellerChangesOf(a, r)).includes("usableMinutes");
    // Two whole-minute figures (Math.round each) differ by at most one minute of rounding: the band is ±1, not wider.
    assert.equal(USABLE_ROUNDING_TOLERANCE_MIN, 1);
    assert.equal(told(at(-11, 10)), false, "−elapsed−1: rounding");
    assert.equal(told(at(-12, 10)), true, "−elapsed−2: more than the clock");
    assert.equal(told(at(1, 10)), false, "+1: rounding");
    assert.equal(told(at(2, 10)), true, "+2: the window grew");
  });

  it("an unreadable deadline never hides a usable change as clock", () => {
    const a = answer(OUT);
    const b: DecisionRecord = { ...a, computedAt: new Date(Date.parse(a.computedAt) + 10 * MIN).toISOString(), result: { ...a.result, usableMinutes: a.result.usableMinutes - 10, hardReturnTime: "not a time" } };
    assert.ok(fields(travellerChangesOf(a, b)).includes("usableMinutes"));
  });

  it("a confidence that changed is reported with both values", () => {
    const a = answer(OUT);
    const b: DecisionRecord = { ...a, result: { ...a.result, confidence: a.result.confidence === "LOW" ? "MEDIUM" : "LOW" } as DecisionRecord["result"] };
    const c = travellerChangesOf(a, b).find((x) => x.field === "confidence");
    assert.deepEqual([c?.previous, c?.next], [a.result.confidence, b.result.confidence]);
  });
});

// ── the resolution: the same boundaries as diffSnapshots ─────────────────────

const flags = (...on: string[]) => on.map((flag) => ({ flag, enabled: true }));
const ledgerTables = ["layover_certified_computations", "layover_time_budgets", "layover_return_plans"];

async function stored(t: Record<string, any[]>, nowMs: number, over: Partial<FeasibilitySession> = {}, id = "session-1"): Promise<string> {
  const rec = certifySessionFeasibility(airport(), session(over, id), { nowMs, liveConditions: null });
  const out = await persistDecision(makeLayoverDb(t) as any, "user-1", id, rec);
  assert.equal(out.ok, true);
  return out.ok ? out.snapshotId : "";
}

describe("L190 — diffSnapshotsForTraveller resolves like diffSnapshots", () => {
  it("two stored answers of the session: the diff AND the traveller's changes", async () => {
    const t: Record<string, any[]> = { feature_flags: flags(DECISION_PERSISTENCE_FLAG) };
    const a = await stored(t, OUT);
    const b = await stored(t, OUT + 2 * MIN, { departureTime: new Date(ARRIVAL + 8 * HOUR).toISOString() });
    const out = await diffSnapshotsForTraveller(makeLayoverDb(t) as any, "session-1", a, b);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.diff.previousSnapshotId, a);
    assert.equal(out.diff.nextSnapshotId, b);
    const deadline = out.changes.find((c) => c.field === "hardReturnTime");
    assert.ok(deadline && (deadline.minutesMoved ?? 0) <= -60);
    assert.equal(deadline?.minutesMoved, Math.round((Date.parse(String(deadline?.next)) - Date.parse(String(deadline?.previous))) / MIN));
  });

  it("clock-only: the diff says materiallyChanged (usable time moved) and the traveller is told nothing", async () => {
    const t: Record<string, any[]> = { feature_flags: flags(DECISION_PERSISTENCE_FLAG) };
    const a = await stored(t, OUT);
    const b = await stored(t, OUT + 10 * MIN);
    const out = await diffSnapshotsForTraveller(makeLayoverDb(t) as any, "session-1", a, b);
    assert.equal(out.ok && out.diff.materiallyChanged, true);
    assert.deepEqual(out.ok && out.changes, []);
  });

  it("another session's snapshot is not_found, like a missing one", async () => {
    const t: Record<string, any[]> = { feature_flags: flags(DECISION_PERSISTENCE_FLAG) };
    const mine = await stored(t, OUT);
    const theirs = await stored(t, OUT, {}, "session-2");
    assert.deepEqual(await diffSnapshotsForTraveller(makeLayoverDb(t) as any, "session-1", mine, theirs), { ok: false, reason: "not_found" });
    assert.deepEqual(await diffSnapshotsForTraveller(makeLayoverDb(t) as any, "session-1", "snap:" + "0".repeat(32), mine), { ok: false, reason: "not_found" });
  });

  it("OFF: not stored, and no ledger table is read", async () => {
    const t: Record<string, any[]> = { feature_flags: [] };
    const touched: string[] = [];
    const db = makeLayoverDb(t) as any;
    const spy = { ...db, from: (name: string) => { touched.push(name); return db.from(name); } };
    assert.deepEqual(await diffSnapshotsForTraveller(spy, "session-1", "snap:a", "snap:b"), { ok: false, reason: "persistence_disabled" });
    assert.ok(!touched.includes("layover_certified_computations"));
  });

  it("an unreadable ledger is read_failed, never an empty list of changes", async () => {
    const t: Record<string, any[]> = { feature_flags: flags(DECISION_PERSISTENCE_FLAG) };
    const a = await stored(t, OUT);
    const db = makeLayoverDb(t, { failures: { "layover_certified_computations:select": { message: "down" } } }) as any;
    assert.deepEqual(await diffSnapshotsForTraveller(db, "session-1", a, a), { ok: false, reason: "read_failed" });
  });
});

// ── the route the app calls ──────────────────────────────────────────────────

describe("L190 — GET /airport/sessions/:id/decisions/diff carries `changes`", () => {
  let server: http.Server;
  let base: string;
  const TOKEN = "changes-token";
  const USER_ID = "changes-user";

  const get = (path: string): Promise<{ status: number; body: any }> =>
    new Promise((resolve, reject) => {
      const url = new URL(path, base);
      const r = http.request(
        { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method: "GET", headers: { authorization: `Bearer ${TOKEN}` } },
        (res) => {
          let raw = "";
          res.on("data", (c) => (raw += c));
          res.on("end", () => {
            let p: any;
            try { p = JSON.parse(raw); } catch { p = raw; }
            resolve({ status: res.statusCode ?? 0, body: p });
          });
        },
      );
      r.on("error", reject);
      r.end();
    });

  async function stage(fl: Array<{ flag: string; enabled: boolean }>, failLedger = false) {
    const ledger: Record<string, any[]> = { feature_flags: flags(DECISION_PERSISTENCE_FLAG) };
    const a = await stored(ledger, OUT);
    const moved = await stored(ledger, OUT + 2 * MIN, { departureTime: new Date(ARRIVAL + 8 * HOUR).toISOString() });
    const tick = await stored(ledger, OUT + 10 * MIN);
    const other = await stored(ledger, OUT, {}, "session-2");
    const tables: Record<string, any[]> = {
      feature_flags: [{ flag: "airport_mode_enabled", enabled: true }, ...fl],
      airport_profiles: [airportRow()],
      layover_sessions: [sessionRow({ user_id: USER_ID, id: "session-1" }), sessionRow({ user_id: "someone-else", id: "session-2" })],
    };
    for (const name of ledgerTables) tables[name] = ledger[name];
    const opts: any = { users: { [TOKEN]: USER_ID } };
    if (failLedger) opts.failures = { "layover_certified_computations:select": { message: "down" } };
    _setTestClient(makeLayoverDb(tables, opts), true);
    return { a, moved, tick, other };
  }

  before(() => {
    const app = express();
    app.use(express.json());
    app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
    app.use("/api", airportRouter);
    return new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
    });
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("the owner gets the diff AND the changes a traveller is told", async () => {
    const { a, moved } = await stage(flags(DECISION_PERSISTENCE_FLAG));
    const r = await get(`/api/airport/sessions/session-1/decisions/diff?from=${a}&to=${moved}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "stored");
    assert.equal(r.body.diff.previousSnapshotId, a);
    const deadline = (r.body.changes as any[]).find((c) => c.field === "hardReturnTime");
    assert.ok(deadline && deadline.minutesMoved <= -60, JSON.stringify(r.body.changes));
  });

  it("a clock-only pair answers an EMPTY changes list (the app shows nothing)", async () => {
    const { a, tick } = await stage(flags(DECISION_PERSISTENCE_FLAG));
    const r = await get(`/api/airport/sessions/session-1/decisions/diff?from=${a}&to=${tick}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.changes, []);
  });

  it("another traveller's snapshot is a 404", async () => {
    const { a, other } = await stage(flags(DECISION_PERSISTENCE_FLAG));
    assert.equal((await get(`/api/airport/sessions/session-1/decisions/diff?from=${a}&to=${other}`)).status, 404);
  });

  it("an unreadable ledger is a 503, never an empty list", async () => {
    const { a, moved } = await stage(flags(DECISION_PERSISTENCE_FLAG), true);
    const r = await get(`/api/airport/sessions/session-1/decisions/diff?from=${a}&to=${moved}`);
    assert.equal(r.status, 503);
    assert.equal(r.body.changes, undefined);
  });

  it("persistence OFF: not_stored, no changes", async () => {
    const { a, moved } = await stage([]);
    const r = await get(`/api/airport/sessions/session-1/decisions/diff?from=${a}&to=${moved}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "not_stored");
    assert.equal(r.body.changes, undefined);
  });
});
