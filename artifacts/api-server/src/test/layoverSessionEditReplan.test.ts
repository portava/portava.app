/**
 * §11.1 reached from a route — the traveller as event producer.
 *
 * `LayoverEventReplanner.ts` is a complete eight-step pipeline whose own header
 * says nothing produces a layover event. `PATCH /api/airport/sessions/:id` now
 * does: a traveller moving their own flight time IS `flight.arrival_delayed` or
 * `flight.departure_delayed`, and the route runs steps 1-8 over it, publishes
 * the decision and writes a §20 record to `layover_events`.
 *
 * Everything below goes through the REAL router and a table-backed fake DB, so
 * a passing assertion is about a request a client can send, not about a
 * function a test can call.
 *
 * Run: node --import tsx/esm --test src/test/layoverSessionEditReplan.test.ts
 *
 * ── MUTATION LOG ─────────────────────────────────────────────────────────────
 * Every mutation below was applied to PRODUCTION code, measured, reverted, and
 * the file then compared with `cmp` against a pre-mutation copy. Unmutated:
 * 18 pass / 0 fail / 0 skipped.
 *
 *  1. `windowChangeEvent` — emit `delayMinutes: 0` on the departure path and
 *     keep the real `newDepartureTime`.                     → 3 failed.
 *     ONLY THREE, and the reason is worth reading: `applyEventToInputs`
 *     prefers `newDepartureTime` when the producer supplies one, so the
 *     departure itself still lands correctly and only the BOARDING shift goes
 *     wrong. The route case with a pinned boarding time is caught by the
 *     `inputs_diverged` guard. A weaker mutation than it looks.
 *  1b. `windowChangeEvent` — point `newDepartureTime` at `before.departureTime`
 *     instead of `after.departureTime`.                     → 6 failed,
 *     every route case refusing with `inputs_diverged`. This is the mutation
 *     that proves the guard: the event no longer reproduces the window the
 *     route is about to persist, and NOTHING is published rather than a
 *     confident replan of a session that never existed.
 *  2. `windowChangeEvent` — delete the `boarding_moved_independently` branch on
 *     the departure path.                                   → 1 failed.
 *     Defence in depth held: without the branch the same case is caught one
 *     layer down by `inputs_diverged`, so the wrong replan is still not
 *     published — the failure is the reason changing, not a leak.
 *  3. `windowChangeEvent` — replace the non-window comparison with `false`.
 *                                                           → 1 failed.
 *     A constraint edit starts reporting as a flight event.
 *  4. `invalidationReasonCodes` — return `[]` always.       → 1 failed.
 *     Appendix A `RECOMMENDATION_EXPIRED` stops being emitted on the one path
 *     that can emit it.
 *  5. `routes/airport.ts` `replanAfterSessionEdit` — read an unreadable
 *     `layover_plan_stops` as an empty plan.                → 1 failed.
 *     The replan then publishes "0 options lost" about a plan it could not
 *     read, which is exactly what `stopsOr503` exists to stop elsewhere.
 *  6. `routes/airport.ts` — stop calling `recordReplanDecision`. → 2 failed.
 *     The decision leaves no trace; §20's record is gone and `replan_rate` is
 *     no longer derivable from the ledger.
 *  7. `LayoverEventReplanner.EVENT_AFFECTS` — give `flight.arrival_delayed` an
 *     EMPTY node list so the pipeline skips it.             → 2 failed here,
 *     **and 0 failed in `src/test/layoverEventReplanner.test.ts` (50 pass).**
 *     That is a finding about the earlier pass, not about this one: the §11
 *     suite tests that the five no-op event types ARE skipped and never that
 *     the six real ones are NOT, so the node map's positive entries were
 *     unpinned until a route depended on them.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import {
  windowChangeEvent,
  SESSION_EDIT_EVENT_SOURCE,
} from "../services/airport/LayoverReplanService.js";
import type { FeasibilitySession } from "../services/airport/LayoverFeasibility.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";

let server: http.Server;
let base: string;
const TOKEN = "replan-token";
const USER_ID = "user-1";

function req(method: string, path: string, body?: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : null;
    const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
    if (payload) headers["content-length"] = Buffer.byteLength(payload).toString();
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { let p: any; try { p = JSON.parse(raw); } catch { p = raw; } resolve({ status: res.statusCode ?? 0, body: p }); });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function stopRow(over: Record<string, any> = {}): Record<string, any> {
  return {
    id: "stop-1", session_id: "session-1", title: "Old town walk", description: null,
    stop_order: 1, duration_min: 60, travel_min: 20, place_id: null, recommendation_id: null,
    lat: null, lng: null, location_label: null, inside_airport: false, source: "user",
    created_at: new Date().toISOString(),
    ...over,
  };
}

function stage(
  sessionOver: Record<string, any> = {},
  opts: { stops?: Record<string, any>[]; failures?: Record<string, { message: string; code?: string }> } = {},
) {
  const tables: Record<string, any[]> = {
    feature_flags: [{ flag: "airport_mode_enabled", enabled: true }],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({ user_id: USER_ID, ...sessionOver })],
    layover_events: [],
    layover_plan_stops: opts.stops ?? [],
    trip_plan_items: [],
  };
  _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: USER_ID }, failures: opts.failures }), true);
  return tables;
}

const shift = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

/** The replan block the route published, asserted to have actually run. */
function ranReplan(body: any): any {
  assert.ok(body.replan, "the PATCH response carries no replan block at all");
  assert.equal(body.replan.ran, true, `replan refused: ${body.replan.reason} — ${body.replan.detail}`);
  return body.replan;
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

describe("PATCH /airport/sessions/:id — the edit is a §11 event and the pipeline runs on it", () => {
  it("a departure delay becomes flight.departure_delayed and freedom expands (§21.1)", async () => {
    const t = stage();
    const dep = t.layover_sessions[0].departure_time as string;
    const r = await req("PATCH", "/api/airport/sessions/session-1", { departureTime: shift(dep, 120) });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const replan = ranReplan(r.body);
    assert.equal(replan.event.eventType, "flight.departure_delayed");
    assert.equal(replan.event.source, SESSION_EDIT_EVENT_SOURCE);
    assert.equal(replan.counts.impacted, 1);
    assert.equal(replan.counts.replanned, 1);
    assert.equal(replan.counts.skipped, 0);

    // §21.1 "Departure delay → freedom may expand after recompute". Here it does.
    // NOT asserted equal to the 120-minute shift: the return buffer is
    // airport-local-time dependent (overnight/traffic band), so a window that
    // slides across a band boundary moves the deadline by a few minutes more or
    // less than the flight did. Asserting equality would make this test's
    // colour depend on the wall-clock hour the suite happens to run at.
    assert.ok(replan.diff.deadlineDeltaMinutes > 0, `the hard return did not move later: ${replan.diff.deadlineDeltaMinutes}`);
    assert.ok(replan.diff.usableMinutesDelta > 0, `usable minutes did not grow: ${replan.diff.usableMinutesDelta}`);
    assert.ok(
      replan.opportunity?.reasonCodes.includes("FLIGHT_DELAY_CREATED_OPPORTUNITY"),
      JSON.stringify(replan.opportunity),
    );
    // A departure-only patch must NOT read as a constraint edit — the schema's
    // per-field defaults do not fill flightType/immigrationRequired on a PATCH.
    assert.equal(t.layover_sessions[0].flight_type, "international");
    assert.equal(t.layover_sessions[0].immigration_required, true);
  });

  it("an arrival delay shrinks freedom and leaves the deadline exactly where it was (§21.1)", async () => {
    const t = stage();
    const arr = t.layover_sessions[0].arrival_time as string;
    const r = await req("PATCH", "/api/airport/sessions/session-1", { arrivalTime: shift(arr, 120) });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const replan = ranReplan(r.body);
    assert.equal(replan.event.eventType, "flight.arrival_delayed");
    // The distinction that matters: an arrival delay is not a departure delay.
    assert.equal(replan.diff.deadlineDeltaMinutes, 0, "an arrival delay must not move the hard return");
    assert.ok(replan.diff.usableMinutesDelta < 0, `freedom did not shrink: ${replan.diff.usableMinutesDelta}`);
    assert.ok(!replan.reasonCodes.includes("FLIGHT_MOVED_EARLIER"));
  });

  it("step 8 is strictly narrower than step 7: options moved, no notification", async () => {
    const t = stage();
    const arr = t.layover_sessions[0].arrival_time as string;
    const r = await req("PATCH", "/api/airport/sessions/session-1", { arrivalTime: shift(arr, 120) });
    const replan = ranReplan(r.body);
    assert.ok(replan.opportunity, "step 7 should have emitted: usable time moved materially");
    assert.equal(replan.notify.notify, false, JSON.stringify(replan.notify));
    assert.equal(replan.counts.notifications, 0);
  });

  it("a planned stop that stops fitting is named, emits RECOMMENDATION_EXPIRED and notifies high", async () => {
    // Size the stop against the window this session actually has, rather than
    // against a number that would rot the first time a buffer constant moves.
    const probe = stage();
    let r = await req("GET", "/api/airport/sessions/session-1/overview");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const usable = r.body.window.usableMinutes as number;
    assert.ok(usable > 120, `staged session is too tight to test with: ${usable}`);
    void probe;

    // travel 10 (doubled = 20) + activity (usable - 25) = usable - 5 → fits.
    const t = stage({}, { stops: [stopRow({ travel_min: 10, duration_min: usable - 25 })] });
    const dep = t.layover_sessions[0].departure_time as string;
    r = await req("PATCH", "/api/airport/sessions/session-1", { departureTime: shift(dep, -60) });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const replan = ranReplan(r.body);
    assert.deepEqual(replan.diff.candidatesLost, ["stop-1"]);
    assert.deepEqual(replan.invalidation.noLongerFeasible, ["stop-1"]);
    assert.ok(replan.reasonCodes.includes("RECOMMENDATION_EXPIRED"), JSON.stringify(replan.reasonCodes));
    assert.ok(replan.reasonCodes.includes("FLIGHT_MOVED_EARLIER"), JSON.stringify(replan.reasonCodes));
    assert.equal(replan.notify.notify, true);
    assert.equal(replan.notify.priority, "high");
    assert.equal(replan.counts.notifications, 1);
    // Step 6 DECIDES and writes nothing: the stop is still in the plan.
    assert.equal(t.layover_plan_stops.length, 1);
  });

  it("the §20 DecisionRecord reaches the ledger, and says which member it cannot fill", async () => {
    const t = stage();
    const dep = t.layover_sessions[0].departure_time as string;
    const r = await req("PATCH", "/api/airport/sessions/session-1", { departureTime: shift(dep, 90) });
    assert.equal(r.status, 200);

    const withDecision = t.layover_events.filter(
      (e) => e.event_type === "session_updated" && e.metadata?.decision,
    );
    assert.equal(withDecision.length, 1, "exactly one ledger row carries the decision record");
    const d = withDecision[0].metadata.decision;

    assert.equal(d.sessionId, "session-1");
    assert.equal(d.snapshotId, null);
    assert.equal(d.snapshotUnavailableReason, "no_snapshot_storage");
    assert.equal(typeof d.engineVersion, "string");
    assert.equal(typeof d.inputHash, "string");
    assert.deepEqual(d.inputFacts.map((f: any) => f.node), ["session.departureTime"]);
    assert.ok(d.sourceRefs.some((s: string) => s.startsWith(`${SESSION_EDIT_EVENT_SOURCE}:`)));
    assert.ok(d.sourceRefs.some((s: string) => s.startsWith("dedupKey:")));
    assert.ok(d.rulesApplied.includes("11.1.5 diff action universe"));
    assert.ok(d.rulesApplied.includes("11.1.6 invalidate recommendations"));
    assert.equal(typeof d.result.usableMinutes, "number");
    assert.ok(Array.isArray(d.reasonCodes));
    assert.equal(typeof d.computedAt, "string");
    // §11.1 step 4 is not built and the publication says so rather than implying it.
    assert.equal(withDecision[0].metadata.replan.snapshotPersisted, false);
  });

  it("the ledger keeps the bare session_updated row too — two rows, and the query must know", async () => {
    const t = stage();
    const dep = t.layover_sessions[0].departure_time as string;
    await req("PATCH", "/api/airport/sessions/session-1", { departureTime: shift(dep, 90) });
    const updated = t.layover_events.filter((e) => e.event_type === "session_updated");
    assert.equal(updated.length, 2);
    assert.equal(updated.filter((e) => e.metadata?.replan).length, 1);
  });
});

describe("PATCH /airport/sessions/:id — refusals are named, and the edit still commits", () => {
  it("an edit that moves no feasibility input is window_unchanged", async () => {
    stage();
    const r = await req("PATCH", "/api/airport/sessions/session-1", { comfortLevel: "adventurous" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.replan.ran, false);
    assert.equal(r.body.replan.reason, "window_unchanged");
  });

  it("a constraint edit is non_window_fields_changed, not a fabricated flight event", async () => {
    const t = stage();
    const r = await req("PATCH", "/api/airport/sessions/session-1", { wantsToLeave: false });
    assert.equal(r.status, 200);
    assert.equal(r.body.replan.reason, "non_window_fields_changed");
    assert.equal(t.layover_sessions[0].wants_to_leave, false, "the edit itself still applied");
  });

  it("both ends moving is refused rather than described by one event", async () => {
    const t = stage();
    const arrivalNext = shift(t.layover_sessions[0].arrival_time as string, 30);
    const departureNext = shift(t.layover_sessions[0].departure_time as string, 30);
    const r = await req("PATCH", "/api/airport/sessions/session-1", {
      arrivalTime: arrivalNext,
      departureTime: departureNext,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.replan.reason, "both_ends_moved");
    assert.equal(t.layover_sessions[0].arrival_time, arrivalNext, "the edit itself still applied");
  });

  it("a departure move that leaves boarding behind is boarding_moved_independently", async () => {
    const now = Date.now();
    const t = stage({
      arrival_time: new Date(now + 5 * 60_000).toISOString(),
      departure_time: new Date(now + 8 * 3_600_000).toISOString(),
      boarding_time: new Date(now + 7.5 * 3_600_000).toISOString(),
    });
    const dep = t.layover_sessions[0].departure_time as string;
    const r = await req("PATCH", "/api/airport/sessions/session-1", { departureTime: shift(dep, 60) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.replan.ran, false);
    assert.equal(r.body.replan.reason, "boarding_moved_independently");
  });

  it("boarding shifted by the same minutes as departure IS the event", async () => {
    const now = Date.now();
    const t = stage({
      arrival_time: new Date(now + 5 * 60_000).toISOString(),
      departure_time: new Date(now + 8 * 3_600_000).toISOString(),
      boarding_time: new Date(now + 7.5 * 3_600_000).toISOString(),
    });
    const departureNext = shift(t.layover_sessions[0].departure_time as string, 60);
    const boardingNext = shift(t.layover_sessions[0].boarding_time as string, 60);
    const r = await req("PATCH", "/api/airport/sessions/session-1", {
      departureTime: departureNext,
      boardingTime: boardingNext,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const replan = ranReplan(r.body);
    assert.equal(replan.event.eventType, "flight.departure_delayed");
    // Later, but not necessarily by exactly 60 — see the note on the first test.
    assert.ok(replan.diff.deadlineDeltaMinutes > 0, String(replan.diff.deadlineDeltaMinutes));
    assert.equal(t.layover_sessions[0].boarding_time, boardingNext);
  });

  it("an unreadable plan refuses the replan instead of reporting 0 options lost", async () => {
    const t = stage({}, {
      stops: [stopRow()],
      failures: { "layover_plan_stops:select": { message: "canceling statement due to statement timeout", code: "57014" } },
    });
    const dep = t.layover_sessions[0].departure_time as string;
    const r = await req("PATCH", "/api/airport/sessions/session-1", { departureTime: shift(dep, 60) });
    assert.equal(r.status, 200, "the edit must still commit — the replan is additive");
    assert.equal(r.body.replan.ran, false);
    assert.equal(r.body.replan.reason, "plan_unreadable");
    assert.equal(t.layover_sessions[0].departure_time, shift(dep, 60));
  });
});

describe("windowChangeEvent — the vocabulary is closed, so most edits are not events", () => {
  const s = (over: Partial<FeasibilitySession> = {}): FeasibilitySession => ({
    id: "session-1",
    arrivalTime: "2026-09-13T00:00:00.000Z",
    departureTime: "2026-09-13T08:00:00.000Z",
    boardingTime: null,
    flightType: "international",
    immigrationRequired: true,
    checkedBags: false,
    wantsToLeave: true,
    ...over,
  });
  const opts = { nowMs: Date.parse("2026-09-13T01:00:00.000Z"), airportRef: "TPE" };

  it("an identical session is window_unchanged", () => {
    const r = windowChangeEvent(s(), s(), opts);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "window_unchanged");
  });

  it("a departure move carries the new instant, not only the delta", () => {
    const after = s({ departureTime: "2026-09-13T09:30:00.000Z" });
    const r = windowChangeEvent(s(), after, opts);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.raw.eventType, "flight.departure_delayed");
    assert.deepEqual(r.raw.payload, { delayMinutes: 90, newDepartureTime: "2026-09-13T09:30:00.000Z" });
  });

  it("a departure brought forward is a negative delay, not a refusal", () => {
    const after = s({ departureTime: "2026-09-13T07:00:00.000Z" });
    const r = windowChangeEvent(s(), after, opts);
    assert.equal(r.ok, true);
    assert.equal(r.ok && (r.raw.payload as any).delayMinutes, -60);
  });

  it("an arrival move that also drags boarding is refused", () => {
    const before = s({ boardingTime: "2026-09-13T07:30:00.000Z" });
    const after = s({ arrivalTime: "2026-09-13T00:30:00.000Z", boardingTime: "2026-09-13T07:45:00.000Z" });
    const r = windowChangeEvent(before, after, opts);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "boarding_moved_independently");
  });

  it("every event names the session AND the airport, so step 2 can match either way", () => {
    const r = windowChangeEvent(s(), s({ departureTime: "2026-09-13T09:00:00.000Z" }), opts);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.raw.subjectRefs, [
      { kind: "session", ref: "session-1" },
      { kind: "airport", ref: "TPE" },
    ]);
    assert.equal(r.raw.confidence, "HIGH");
    assert.equal(r.raw.occurredAt, "2026-09-13T01:00:00.000Z");
  });

  it("two edits made at two instants are two events — dedup must not swallow the second", () => {
    const after = s({ departureTime: "2026-09-13T09:00:00.000Z" });
    const a = windowChangeEvent(s(), after, opts);
    const b = windowChangeEvent(s(), after, { ...opts, nowMs: opts.nowMs + 60_000 });
    assert.equal(a.ok && b.ok, true);
    if (!a.ok || !b.ok) return;
    assert.notEqual(a.raw.occurredAt, b.raw.occurredAt);
    assert.notEqual(a.raw.eventId, b.raw.eventId);
  });
});
