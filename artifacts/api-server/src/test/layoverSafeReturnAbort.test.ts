/**
 * Layover §15 / §15.1 / §15.2: the escalation posture, the one-tap abort, and
 * disruption recompute.
 *
 * node:test + node:assert/strict. Table-backed fake Supabase for the abort's
 * three writes; pure functions elsewhere. The verdict is the EXIT CODE.
 *
 * ── WHAT THE FAKE CANNOT SEE, SAID UP FRONT ─────────────────────────────────
 * `fakeLayoverDb` has no schema knowledge, so it CANNOT model the two CHECK
 * constraints this feature depends on: `layover_sessions.status` (0127:85-86)
 * and `layover_events.event_type` (0127:198-208). A green test here is NOT
 * evidence that either write would be accepted by Postgres. What is evidence is
 * `npm run check:enum-literals`, which reads the migrations and compares every
 * literal in the tree against the column's declared vocabulary — it FAILED on
 * `safe_return_aborted` before this suite ever ran, which is exactly why
 * migration 2741 widens both constraints. That gate, not this file, is the
 * proof the writes are legal.
 *
 * ── TRAPS AVOIDED ───────────────────────────────────────────────────────────
 *  - A DELETE with no `.select()` returns 204 with an empty body, so affected
 *    rows are unknowable. The abort's delete chains `.select("id")` and the
 *    tests assert the IDS, not merely that the call happened.
 *  - Every failure test asserts `ok === false` AND the named effect, so an
 *    abort that swallows a failed delete and reports success cannot pass.
 *  - Every failure test is paired with a success control on the same path.
 *  - The airside stop must SURVIVE the abort; that is asserted by reading the
 *    table back, not by trusting the returned id list.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverSafeReturnAbort.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeLayoverDb, sessionRow } from "./helpers/fakeLayoverDb.js";
import { certifySessionFeasibility } from "../services/airport/LayoverFeasibility.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import {
  sendReturnDeadlineReminder,
  shouldSuggestSafeReturn,
} from "../services/airport/LayoverNotificationService.js";
import { formatLocalTime } from "../services/airport/AirportTime.js";
import {
  safeReturnPosture,
  buildReturnContract,
  abortToAirport,
  nextDisruptionState,
  recomputeForDisruption,
  DISRUPTION_STATES,
  SEVERE_DELAY_MIN,
  OVERNIGHT_DELAY_MIN,
  LAYOVER_SAFE_RETURN_VERSION,
  type DisruptionState,
} from "../services/airport/LayoverSafeReturnService.js";

const NOW = Date.UTC(2026, 8, 8, 6, 0, 0);
const USER = "user-1";
const SESSION_ID = "session-1";

const AIRPORT: AirportProfile = {
  id: "airport-tpe", iataCode: "TPE", name: "Taiwan Taoyuan International Airport",
  city: "Taoyuan", country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei",
  lat: 25.0797, lng: 121.2342,
  domesticBufferMin: 60, domesticBufferMax: 90,
  internationalBufferMin: 120, internationalBufferMax: 180,
  immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
  verified: false, terminalInfo: null,
};

function session(over: Partial<LayoverSession> = {}): LayoverSession {
  const row = sessionRow({
    id: SESSION_ID, user_id: USER,
    arrival_time: new Date(NOW).toISOString(),
    departure_time: new Date(NOW + 8 * 3_600_000).toISOString(),
  });
  return {
    id: row.id, userId: row.user_id, airportId: row.airport_id, tripId: null,
    arrivalTime: row.arrival_time, departureTime: row.departure_time, boardingTime: null,
    layoverMinutes: 480, flightType: "international", immigrationRequired: false,
    checkedBags: false, loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate",
    vibeChips: [], manualAirportName: null, manualCity: null, manualCountry: null,
    manualIata: null, canonicalCityId: null, shareCityStatus: false,
    returnReminderAt: null, status: "active",
    createdAt: row.created_at, updatedAt: row.updated_at,
    ...over,
  };
}

function record(s: LayoverSession, nowMs = NOW) {
  return certifySessionFeasibility(AIRPORT, s, { nowMs });
}

function stage(opts: { stops?: any[]; failures?: Record<string, { message: string }>; sessionStatus?: string } = {}) {
  const tables: Record<string, any[]> = {
    layover_sessions: [sessionRow({ id: SESSION_ID, user_id: USER, status: opts.sessionStatus ?? "active" })],
    layover_plan_stops: opts.stops ?? [],
    layover_events: [],
  };
  return { tables, db: makeLayoverDb(tables, { failures: opts.failures ?? {} }) };
}

const STOPS = [
  { id: "stop-airside", session_id: SESSION_ID, title: "Lounge", inside_airport: true, stop_order: 0 },
  { id: "stop-city-1", session_id: SESSION_ID, title: "Night market", inside_airport: false, stop_order: 1 },
  { id: "stop-city-2", session_id: SESSION_ID, title: "Temple", inside_airport: false, stop_order: 2 },
];

// ─────────────────────────────────────────────────────────────────────────────

describe("§15 what happens AT each escalation state", () => {
  const s = session();

  function postureAt(minutesBeforeHardReturn: number) {
    const base = record(s);
    const at = base.deadline.hardReturnTime.getTime() - minutesBeforeHardReturn * 60_000;
    return safeReturnPosture(record(s, at));
  }

  it("NORMAL explores; nothing collapses", () => {
    const p = postureAt(240);
    assert.equal(p.returnState, "NORMAL");
    assert.equal(p.explorationCollapsed, false);
    assert.equal(p.returnRoutePrimary, false);
    assert.equal(p.pinTerminalContext, false);
    assert.equal(p.offerRecoveryHelp, false);
    assert.equal(p.primaryAction, "explore");
    assert.equal(p.notifyCrew, false);
  });

  it("RETURN_SOON notifies the crew before anything else changes", () => {
    const p = postureAt(10);
    assert.equal(p.returnState, "RETURN_SOON");
    assert.equal(p.notifyCrew, true, "a crew told at RETURN_NOW is told too late to change their own plan");
    assert.equal(p.explorationCollapsed, false);
    assert.equal(p.primaryAction, "plan_return");
  });

  it("RETURN_NOW collapses exploration, makes the route primary and pins the terminal", () => {
    const p = postureAt(-1);
    assert.equal(p.returnState, "RETURN_NOW");
    assert.equal(p.explorationCollapsed, true);
    assert.equal(p.returnRoutePrimary, true);
    assert.equal(p.pinTerminalContext, true);
    assert.equal(p.primaryAction, "return_now");
    assert.equal(p.offerRecoveryHelp, false, "recovery help belongs to CONNECTION_AT_RISK");
  });

  it("CONNECTION_AT_RISK adds recovery help", () => {
    const p = postureAt(-120);
    assert.equal(p.returnState, "CONNECTION_AT_RISK");
    assert.equal(p.explorationCollapsed, true);
    assert.equal(p.offerRecoveryHelp, true);
    assert.equal(p.primaryAction, "recover_connection");
  });

  it("§15.1: the abort control is offered in EVERY state, including NORMAL", () => {
    for (const m of [600, 240, 10, -1, -120]) {
      assert.equal(postureAt(m).abortAvailable, true, `abortAvailable must hold at ${m} minutes`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("§15.1 the return contract never fabricates a route", () => {
  it("carries the certified deadline and an explicit route refusal", () => {
    const s = session();
    const c = buildReturnContract(AIRPORT, record(s));
    assert.equal(c.safeReturnVersion, LAYOVER_SAFE_RETURN_VERSION);
    assert.equal(c.hardReturnTime, record(s).deadline.hardReturnTime.toISOString());
    assert.equal(c.route, null);
    assert.equal(c.routeUnavailableReason, "no_routing_provider");
    assert.ok(c.certification.inputHash.startsWith("sha256:"));
    assert.equal(c.airport.terminalInfo, null, "no curated terminal data exists; none is invented");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("§15.1 one-tap abort", () => {
  it("cancels ONLY the landside stops and reports the ids it actually removed", async () => {
    const { tables, db } = stage({ stops: [...STOPS] });
    const s = session();
    const r = await abortToAirport(db, {
      session: s, airport: AIRPORT, record: record(s), userId: USER, nowMs: NOW, statusEnabled: false,
    });
    assert.equal(r.ok, true, `effects: ${r.effects.join(",")}`);
    assert.deepEqual(r.cancelledStopIds.sort(), ["stop-city-1", "stop-city-2"]);
    assert.ok(r.effects.includes("itinerary_cancelled"));
    // Read the table back — the airside stop must still be there.
    assert.deepEqual(tables.layover_plan_stops.map((x) => x.id), ["stop-airside"]);
  });

  it("says 'nothing to cancel' rather than 'cancelled' for an empty plan", async () => {
    const { db } = stage({ stops: [] });
    const s = session();
    const r = await abortToAirport(db, {
      session: s, airport: AIRPORT, record: record(s), userId: USER, nowMs: NOW, statusEnabled: false,
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.cancelledStopIds, []);
    assert.ok(r.effects.includes("itinerary_nothing_to_cancel"));
    assert.equal(r.effects.includes("itinerary_cancelled"), false);
  });

  it("records the transition in the decision ledger, with certification", async () => {
    const { tables, db } = stage({ stops: [...STOPS] });
    const s = session();
    const rec = record(s);
    const r = await abortToAirport(db, {
      session: s, airport: AIRPORT, record: rec, userId: USER, nowMs: NOW, statusEnabled: false,
    });
    assert.ok(r.effects.includes("ledger_recorded"));
    assert.equal(tables.layover_events.length, 1);
    const ev = tables.layover_events[0];
    assert.equal(ev.event_type, "safe_return_aborted");
    assert.equal(ev.session_id, SESSION_ID);
    assert.equal(ev.user_id, USER);
    assert.equal(ev.metadata.inputHash, rec.inputHash);
    assert.equal(ev.metadata.engineVersion, rec.engineVersion);
    assert.deepEqual(ev.metadata.cancelledStopIds.sort(), ["stop-city-1", "stop-city-2"]);
  });

  it("FLAG OFF leaves the session status untouched and says so", async () => {
    const { tables, db } = stage({ stops: [...STOPS] });
    const s = session();
    const r = await abortToAirport(db, {
      session: s, airport: AIRPORT, record: record(s), userId: USER, nowMs: NOW, statusEnabled: false,
    });
    assert.equal(r.statusApplied, false);
    assert.ok(r.effects.includes("status_unchanged_flag_off"));
    assert.equal(tables.layover_sessions[0].status, "active", "the status must not move while the flag is off");
  });

  it("FLAG ON marks the session returning", async () => {
    const { tables, db } = stage({ stops: [...STOPS] });
    const s = session();
    const r = await abortToAirport(db, {
      session: s, airport: AIRPORT, record: record(s), userId: USER, nowMs: NOW, statusEnabled: true,
    });
    assert.equal(r.statusApplied, true, `effects: ${r.effects.join(",")}`);
    assert.ok(r.effects.includes("status_marked_returning"));
    assert.equal(tables.layover_sessions[0].status, "returning");
  });

  it("FLAG ON with no active row is reported as such, NOT as 'flag off' and NOT as success", async () => {
    const { db } = stage({ stops: [], sessionStatus: "cancelled" });
    const s = session();
    const r = await abortToAirport(db, {
      session: s, airport: AIRPORT, record: record(s), userId: USER, nowMs: NOW, statusEnabled: true,
    });
    assert.equal(r.statusApplied, false);
    assert.ok(r.effects.includes("status_unchanged_no_active_row"));
    assert.equal(r.effects.includes("status_unchanged_flag_off"), false, "the wrong cause must not be named");
    assert.equal(r.effects.includes("status_marked_returning"), false);
  });

  it("a FAILED stop delete is reported, not swallowed", async () => {
    const { db } = stage({
      stops: [...STOPS],
      failures: { "layover_plan_stops:delete": { message: "deadlock detected" } },
    });
    const s = session();
    const r = await abortToAirport(db, {
      session: s, airport: AIRPORT, record: record(s), userId: USER, nowMs: NOW, statusEnabled: false,
    });
    assert.equal(r.ok, false, "an abort that could not clear the plan is not a successful abort");
    assert.ok(r.effects.includes("itinerary_cancel_failed"));
    assert.deepEqual(r.cancelledStopIds, []);
  });

  it("a FAILED ledger write is reported, not swallowed", async () => {
    const { db } = stage({
      stops: [...STOPS],
      failures: { "layover_events:insert": { message: "check violation" } },
    });
    const s = session();
    const r = await abortToAirport(db, {
      session: s, airport: AIRPORT, record: record(s), userId: USER, nowMs: NOW, statusEnabled: false,
    });
    assert.equal(r.ok, false);
    assert.ok(r.effects.includes("ledger_write_failed"));
    assert.equal(r.effects.includes("ledger_recorded"), false);
  });

  it("a FAILED status write is reported, not swallowed", async () => {
    const { db } = stage({
      stops: [],
      failures: { "layover_sessions:update": { message: "check violation on status" } },
    });
    const s = session();
    const r = await abortToAirport(db, {
      session: s, airport: AIRPORT, record: record(s), userId: USER, nowMs: NOW, statusEnabled: true,
    });
    assert.equal(r.ok, false);
    assert.ok(r.effects.includes("status_write_failed"));
    assert.equal(r.statusApplied, false);
  });

  it("never claims a crew was notified", async () => {
    const { db } = stage({ stops: [] });
    const s = session();
    const r = await abortToAirport(db, {
      session: s, airport: AIRPORT, record: record(s), userId: USER, nowMs: NOW, statusEnabled: false,
    });
    assert.deepEqual(r.crewNotified, []);
    assert.equal(r.crewNotifyUnavailableReason, "no_crew_storage");
    assert.ok(r.effects.includes("crew_notify_unavailable"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("§15.2 disruption state machine", () => {
  it("walks the delay chain by TOTAL delay, not by accumulation", () => {
    assert.equal(nextDisruptionState("CONNECTION", { kind: "delay", delayMinutes: 45 }), "DELAYED");
    assert.equal(nextDisruptionState("DELAYED", { kind: "delay", delayMinutes: SEVERE_DELAY_MIN }), "SEVERE_DELAY");
    assert.equal(nextDisruptionState("SEVERE_DELAY", { kind: "delay", delayMinutes: OVERNIGHT_DELAY_MIN }), "OVERNIGHT");
    // Two 90-minute events do NOT add up to a severe delay: the event carries
    // the total, so the state is a function of the total.
    assert.equal(nextDisruptionState("DELAYED", { kind: "delay", delayMinutes: 90 }), "DELAYED");
  });

  it("a recovered schedule walks back to CONNECTION", () => {
    assert.equal(nextDisruptionState("SEVERE_DELAY", { kind: "on_time" }), "CONNECTION");
    assert.equal(nextDisruptionState("DELAYED", { kind: "delay", delayMinutes: 0 }), "CONNECTION");
  });

  it("walks the cancellation chain, and never re-enters the delay chain", () => {
    assert.equal(nextDisruptionState("DELAYED", { kind: "cancellation" }), "CANCELLED");
    assert.equal(nextDisruptionState("CANCELLED", { kind: "rebooking_offered" }), "REBOOKING");
    assert.equal(nextDisruptionState("REBOOKING", { kind: "rebooking_confirmed" }), "RECOVERY");
    // A cancelled flight is not merely delayed, whatever arrives next.
    for (const ev of [
      { kind: "delay" as const, delayMinutes: 30 },
      { kind: "on_time" as const },
    ]) {
      assert.equal(nextDisruptionState("CANCELLED", ev), "CANCELLED");
      assert.equal(nextDisruptionState("RECOVERY", ev), "RECOVERY");
    }
  });

  it("rebooking events do nothing outside the cancellation chain", () => {
    assert.equal(nextDisruptionState("DELAYED", { kind: "rebooking_offered" }), "DELAYED");
    assert.equal(nextDisruptionState("CONNECTION", { kind: "rebooking_confirmed" }), "CONNECTION");
  });

  it("is total over every declared state and event kind", () => {
    const events = [
      { kind: "delay" as const, delayMinutes: 60 },
      { kind: "cancellation" as const },
      { kind: "rebooking_offered" as const },
      { kind: "rebooking_confirmed" as const },
      { kind: "on_time" as const },
    ];
    for (const st of DISRUPTION_STATES) {
      for (const ev of events) {
        const out = nextDisruptionState(st, ev);
        assert.ok(DISRUPTION_STATES.includes(out), `${st} + ${ev.kind} left the state set: ${out}`);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("§15.2 recompute, do NOT append delay minutes", () => {
  const engineSession = {
    id: SESSION_ID,
    arrivalTime: new Date(NOW).toISOString(),
    departureTime: new Date(NOW + 4 * 3_600_000).toISOString(),
    boardingTime: null,
    flightType: "international" as const,
    immigrationRequired: false,
    checkedBags: false,
    wantsToLeave: true,
  };
  const engineAirport = {
    id: AIRPORT.id, iataCode: AIRPORT.iataCode, timezone: AIRPORT.timezone, verified: AIRPORT.verified,
    domesticBufferMin: AIRPORT.domesticBufferMin, internationalBufferMin: AIRPORT.internationalBufferMin,
    immigrationExtraMin: AIRPORT.immigrationExtraMin, checkedBagsExtraMin: AIRPORT.checkedBagsExtraMin,
    trafficExtraMin: AIRPORT.trafficExtraMin,
  };

  it("a 120-minute delay does NOT add 120 usable minutes", () => {
    // Measured against this engine: a delay that pushes the return into the
    // time-of-day band adds buffer, so the window grows by LESS than the delay.
    // An appender produces exactly the delay, every time, and cannot produce this.
    const r = recomputeForDisruption(engineAirport, engineSession, {
      state: "DELAYED",
      newDepartureTime: new Date(NOW + 4 * 3_600_000 + 120 * 60_000).toISOString(),
      nowMs: NOW,
    });
    assert.equal(r.scheduleDeltaMinutes, 120);
    assert.notEqual(r.usableMinutesDelta, 120, "an appended delay would be exactly 120");
    assert.ok(r.usableMinutesDelta < 120, `window grew by ${r.usableMinutesDelta}, not the full delay`);
    assert.equal(r.recomputedNotAppended, true);
    assert.ok(
      r.after.deadline.breakdown.timeOfDayExtra > r.before.deadline.breakdown.timeOfDayExtra,
      "and the reason is a real buffer term moving, not an arbitrary fudge",
    );
  });

  it("a flight moved EARLIER shrinks the window — the spec's other direction", () => {
    const r = recomputeForDisruption(engineAirport, engineSession, {
      state: "CONNECTION",
      newDepartureTime: new Date(NOW + 4 * 3_600_000 - 90 * 60_000).toISOString(),
      nowMs: NOW,
    });
    assert.equal(r.scheduleDeltaMinutes, -90);
    assert.ok(r.usableMinutesDelta < 0, "the freedom window must shrink");
    assert.ok(
      r.after.envelope.usableMinutes < r.before.envelope.usableMinutes,
      "control: read straight off the two certified records",
    );
  });

  it("the recompute is a FULL re-certification, not a patched record", () => {
    const r = recomputeForDisruption(engineAirport, engineSession, {
      state: "DELAYED",
      newDepartureTime: new Date(NOW + 5 * 3_600_000).toISOString(),
      nowMs: NOW,
    });
    assert.notEqual(r.after.inputHash, r.before.inputHash, "different inputs must hash differently");
    assert.equal(r.after.engineVersion, r.before.engineVersion);
    assert.equal(
      r.after.inputs.session.departureTime,
      new Date(NOW + 5 * 3_600_000).toISOString(),
      "the new schedule must be IN the certified inputs, not applied afterwards",
    );
  });

  it("delays both EXPAND and SHRINK the window relative to an appender", () => {
    // MEASURED, and it corrected a wrong assumption in the first draft of this
    // test, which asserted the window can never grow by MORE than the delay.
    // It can: a delay of 480 minutes at a 08:00 base moved the return OUT of
    // the night-time band, so the time-of-day buffer FELL and the window grew
    // by 490. That is precisely §15.2's "disruption may EXPAND or shrink the
    // FreedomWindow", and it is only reachable by recomputing.
    let grewMore = 0;
    let grewLess = 0;
    let exact = 0;
    let total = 0;
    for (let baseH = 4; baseH <= 12; baseH++) {
      const s = { ...engineSession, departureTime: new Date(NOW + baseH * 3_600_000).toISOString() };
      for (let d = 30; d <= 480; d += 30) {
        total++;
        const r = recomputeForDisruption(engineAirport, s, {
          state: "DELAYED",
          newDepartureTime: new Date(NOW + baseH * 3_600_000 + d * 60_000).toISOString(),
          nowMs: NOW,
        });
        assert.equal(r.scheduleDeltaMinutes, d);
        assert.equal(r.recomputedNotAppended, r.usableMinutesDelta !== d);
        if (r.usableMinutesDelta > d) grewMore++;
        else if (r.usableMinutesDelta < d) grewLess++;
        else exact++;
        // The buffer breakdown must be the reason, every time: an appender
        // cannot move a buffer term.
        if (r.usableMinutesDelta !== d) {
          assert.notEqual(
            r.after.deadline.breakdown.totalBuffer,
            r.before.deadline.breakdown.totalBuffer,
            `delay ${d} at base ${baseH}h diverged from the appender with an UNCHANGED buffer — ` +
              "that would be arithmetic drift, not a recompute",
          );
        }
      }
    }
    assert.ok(total > 100, "the sweep must actually sweep");
    assert.ok(grewLess > 20, `only ${grewLess}/${total} delays bought less time than they cost`);
    assert.ok(grewMore > 0, `no delay ever bought MORE than its length (${total} cases) — §15.2's expand case is unexercised`);
    assert.ok(exact > 0, "vacuity guard: an appender must still be right sometimes, or the sweep is degenerate");
  });

  it("a disruption can change the escalation state, and the record says so", () => {
    const tight = { ...engineSession, departureTime: new Date(NOW + 150 * 60_000).toISOString() };
    const r = recomputeForDisruption(engineAirport, tight, {
      state: "DELAYED",
      newDepartureTime: new Date(NOW + 8 * 3_600_000).toISOString(),
      nowMs: NOW,
    });
    assert.equal(r.returnStateChanged, r.before.envelope.returnState !== r.after.envelope.returnState);
    assert.equal(r.before.envelope.returnState, "RETURN_SOON");
    assert.equal(r.after.envelope.returnState, "NORMAL");
    assert.equal(r.returnStateChanged, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("§15 the return reminder — the two defects, not the delivery question", () => {
  // The DELIVERY question (server push vs client-scheduled local notification)
  // is an OPEN OWNER DECISION, `LAYOVER_RETURN_REMINDER_DELIVERY` in
  // docs/architecture/blocker-ledger.md. Nothing here asserts anything about
  // it: no push is sent by this code and none is asserted. What is asserted is
  // that the two things that were WRONG are no longer wrong.

  function reminderDb(opts: { token?: string | null; failures?: Record<string, { message: string }> } = {}) {
    const tables: Record<string, any[]> = {
      profiles: opts.token === undefined
        ? [{ id: USER, expo_push_token: "ExponentPushToken[abc]" }]
        : opts.token === null ? [{ id: USER }] : [{ id: USER, expo_push_token: opts.token }],
      layover_events: [],
    };
    return { tables, db: makeLayoverDb(tables, { failures: opts.failures ?? {} }) };
  }

  it("names the deadline in the AIRPORT's timezone, not the server's", async () => {
    const { db } = reminderDb();
    const s = session();
    const r = await sendReturnDeadlineReminder(db, s, AIRPORT, 15, NOW);
    assert.equal(r.ok, true);
    const expected = formatLocalTime(AIRPORT.timezone, record(s).deadline.hardReturnTime);
    assert.ok((r as any).body.includes(expected), `body "${(r as any).body}" must name ${expected}`);
    // Control: the server-locale rendering of the same instant is DIFFERENT
    // here, so this assertion is not satisfied by both spellings at once.
    const serverLocale = record(s).deadline.hardReturnTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    assert.notEqual(serverLocale, expected, "control: the fixture must actually distinguish the two clocks");
    assert.equal((r as any).body.includes(serverLocale), false);
  });

  it("an UNREADABLE profiles row is NOT reported as 'this traveller has no device'", async () => {
    const { db } = reminderDb({ failures: { "profiles:select": { message: "connection reset" } } });
    const r = await sendReturnDeadlineReminder(db, session(), AIRPORT, 15, NOW);
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "push_token_unreadable");
  });

  it("a traveller with genuinely no token is a SUCCESSFUL skip, and says which", async () => {
    const { db } = reminderDb({ token: null });
    const r = await sendReturnDeadlineReminder(db, session(), AIRPORT, 15, NOW);
    assert.equal(r.ok, true);
    assert.equal((r as any).skipped, true);
    assert.equal((r as any).reason, "no_push_token");
  });

  it("records the intent with certification, and never the token", async () => {
    const { tables, db } = reminderDb();
    const s = session();
    await sendReturnDeadlineReminder(db, s, AIRPORT, 30, NOW);
    assert.equal(tables.layover_events.length, 1);
    const ev = tables.layover_events[0];
    assert.equal(ev.event_type, "return_deadline_set");
    assert.equal(ev.metadata.inputHash, record(s).inputHash);
    assert.equal(JSON.stringify(ev.metadata).includes("ExponentPushToken"), false);
  });

  it("a failed intent write is reported, not swallowed", async () => {
    const { db } = reminderDb({ failures: { "layover_events:insert": { message: "check violation" } } });
    const r = await sendReturnDeadlineReminder(db, session(), AIRPORT, 15, NOW);
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "event_write_failed");
  });

  it("shouldSuggestSafeReturn is unchanged and still reason-driven", () => {
    const quiet = shouldSuggestSafeReturn(session({ immigrationRequired: false, flightType: "domestic" }), {});
    assert.equal(quiet.suggest, false);
    const loud = shouldSuggestSafeReturn(session(), { isNightLayover: true });
    assert.equal(loud.suggest, true);
    assert.ok(loud.reasons.length > 0);
  });
});
