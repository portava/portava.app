/**
 * §21.1 — the half of the minimum deterministic scenario matrix that needs an
 * EVENT or a LIVE CONDITION, which `src/test/layoverScenarioMatrix.test.ts`
 * could not write.
 *
 * That file covers the scenarios computable from a session and an airport
 * alone: L219 (2h domestic), L220 (4h international by airport model), L221
 * (6h landside), L223 (overnight), and the three the schema cannot express at
 * all (L222, L224, L229). This file covers the six that need something to
 * HAPPEN:
 *
 *   L225 arrival delay      -> freedom shrinks
 *   L226 departure delay    -> freedom may expand after recompute
 *   L227 security spike     -> envelope contracts MONOTONICALLY
 *   L228 traffic spike      -> return deadline moves EARLIER
 *   L231 flight cancellation-> transition to disruption/recovery
 *   L230 unknown entry      -> no landside recommendation  (still unrepresentable)
 *
 * and records where L232 (crew) and L233 (offline) actually stand rather than
 * restating a census line.
 *
 * ── WHY THESE ARE WRITABLE NOW AND WERE NOT WHEN THE CENSUS WAS TAKEN ────────
 * The census scored L225–L228 NOT-BUILT with "no delay input and no test" and
 * "no security-wait input (L51)". Both inputs now exist on this tree:
 * `LayoverEventReplanner.applyEventToInputs` turns a normalised §11 event into
 * a new `(session, liveConditions)` pair, and `LiveConditions` is a named input
 * of the certified computation that lands in its `inputHash`. So the scenarios
 * can be driven end to end — event in, certified record out — instead of being
 * described.
 *
 * ── THE DIRECTION ASSERTIONS ARE THE POINT ───────────────────────────────────
 * Each scenario asserts a DIRECTION, not a number. "The deadline moved earlier"
 * survives a buffer-constant change; "the deadline is 18:35" does not, and a
 * matrix pinned to constants is one that gets updated to whatever the engine
 * says the next time it changes — which is how a scenario matrix stops being a
 * check on the engine and becomes a transcript of it.
 *
 * Every direction case is paired with a POSITIVE CONTROL in the opposite
 * direction or with a null event, so a harness that answered "shrank" to
 * everything would fail.
 *
 * Run: node --import tsx/esm --test src/test/layoverScenarioMatrixDisruption.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyEventToInputs,
  normalizeEvent,
  disruptionAfter,
  disruptionEventFor,
  type LayoverEventEnvelope,
} from "../services/airport/LayoverEventReplanner.js";
import {
  certifySessionFeasibility,
  type FeasibilityAirport,
  type FeasibilitySession,
} from "../services/airport/LayoverFeasibility.js";
import type { LiveConditions } from "../services/airport/LayoverSafetyEngine.js";

const HOUR = 3_600_000;
/** 10:00 Asia/Taipei — off every time-of-day band, so that term stays still. */
const NOW = Date.parse("2026-09-13T02:00:00.000Z");

function airport(over: Partial<FeasibilityAirport> = {}): FeasibilityAirport {
  return {
    id: "airport-tpe", iataCode: "TPE", timezone: "Asia/Taipei", verified: true,
    domesticBufferMin: 60, internationalBufferMin: 120,
    immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
    ...over,
  };
}

function session(hours: number, over: Partial<FeasibilitySession> = {}): FeasibilitySession {
  return {
    id: "session-1",
    arrivalTime: new Date(NOW).toISOString(),
    departureTime: new Date(NOW + hours * HOUR).toISOString(),
    boardingTime: null,
    flightType: "international",
    immigrationRequired: true,
    checkedBags: false,
    wantsToLeave: true,
    ...over,
  };
}

/** A normalised §11 event, built through the real validator, never by hand. */
function event(
  eventType: string,
  payload: Record<string, unknown>,
  occurredAtMs = NOW,
): LayoverEventEnvelope {
  const r = normalizeEvent(
    {
      eventId: `evt-${eventType}-${occurredAtMs}`,
      eventType,
      occurredAt: new Date(occurredAtMs).toISOString(),
      source: "test-harness",
      sourceEventId: `src-${eventType}`,
      subjectRefs: [{ kind: "session", ref: "session-1" }],
      payload,
      confidence: "MEDIUM",
    },
    { receivedAtMs: occurredAtMs },
  );
  assert.ok(r.ok, `the harness built an event the normaliser rejects: ${r.ok ? "" : r.reason}`);
  return r.event;
}

/** Certify a session at `nowMs`, optionally under live conditions. */
function certify(s: FeasibilitySession, live: LiveConditions | null = null, nowMs = NOW) {
  return certifySessionFeasibility(airport(), s, { nowMs, liveConditions: live });
}

/** Apply an event and certify what comes out. One line, so the cases read. */
function after(e: LayoverEventEnvelope, s: FeasibilitySession, live: LiveConditions | null = null) {
  const next = applyEventToInputs(e, s, live);
  return certify(next.session, next.live);
}

const usable = (r: ReturnType<typeof certify>) => r.envelope.usableMinutes;
const deadlineMs = (r: ReturnType<typeof certify>) => r.deadline.hardReturnTime.getTime();

// ── L225 — arrival delay shrinks freedom ─────────────────────────────────────

describe("§21.1 L225 — an arrival delay shrinks the usable window", () => {
  it("90 minutes late is 90 fewer minutes in the city, and the deadline does not move", () => {
    const base = certify(session(6));
    const delayed = after(event("flight.arrival_delayed", { delayMinutes: 90 }), session(6));
    assert.ok(usable(delayed) < usable(base));
    assert.equal(usable(base) - usable(delayed), 90);
    // The DEADLINE is anchored at the departure end and must not move: a late
    // arrival does not buy a later return. Asserting this is what separates
    // "the window shrank" from "the arithmetic shifted".
    assert.equal(deadlineMs(delayed), deadlineMs(base));
  });

  it("POSITIVE CONTROL: a zero-minute delay changes nothing at all", () => {
    const base = certify(session(6));
    const noop = after(event("flight.arrival_delayed", { delayMinutes: 0 }), session(6));
    assert.equal(usable(noop), usable(base));
    assert.equal(noop.inputHash, base.inputHash, "a no-op event must not produce a new computation");
  });

  it("a delay large enough closes the window entirely, and says by how much", () => {
    const delayed = after(event("flight.arrival_delayed", { delayMinutes: 5 * 60 }), session(6));
    assert.equal(usable(delayed), 0);
    assert.equal(delayed.envelope.freedomWindow, null);
    assert.ok((delayed.envelope.shortfallMinutes ?? 0) > 0);
    assert.equal(delayed.verdict, "no");
  });
});

// ── L226 — departure delay may expand freedom ────────────────────────────────

describe("§21.1 L226 — a departure delay can expand the window after recompute", () => {
  it("two hours later is a later deadline and more usable time", () => {
    const base = certify(session(4));
    const delayed = after(event("flight.departure_delayed", { delayMinutes: 120 }), session(4));
    assert.ok(deadlineMs(delayed) > deadlineMs(base));
    assert.ok(usable(delayed) > usable(base));
    assert.equal((deadlineMs(delayed) - deadlineMs(base)) / 60_000, 120);
  });

  it("the tier can improve — this is the scenario where an answer gets BETTER", () => {
    const base = certify(session(4));
    const delayed = after(event("flight.departure_delayed", { delayMinutes: 180 }), session(4));
    assert.equal(base.verdict, "no");
    assert.notEqual(delayed.verdict, "no");
    assert.notEqual(base.envelope.tier, delayed.envelope.tier);
  });

  it("POSITIVE CONTROL: the boarding anchor moves with it, so the gain is not fictitious", () => {
    const withBoarding = session(6, { boardingTime: new Date(NOW + 5.5 * HOUR).toISOString() });
    const base = certify(withBoarding);
    const delayed = after(event("flight.departure_delayed", { delayMinutes: 60 }), withBoarding);
    // The cutoff is the BOARDING time when there is one. If boarding did not
    // shift with the departure, the extra hour would be an hour the traveller
    // does not have.
    assert.equal((delayed.deadline.cutoffMs - base.deadline.cutoffMs) / 60_000, 60);
  });
});

// ── L227 — security spike contracts the envelope monotonically ───────────────

describe("§21.1 L227 — a security spike contracts the envelope monotonically", () => {
  /**
   * MONOTONIC means: over a rising sequence of observed waits, the usable
   * window never rises and the deadline never moves later. A single before/after
   * pair cannot show that — it is satisfied by an engine that inverts at 40
   * minutes — so this walks a ladder.
   */
  it("over a rising ladder of observed waits, freedom never increases", () => {
    const s = session(6);
    let prevUsable = Infinity;
    let prevDeadline = Infinity;
    const seen: number[] = [];
    for (const wait of [0, 5, 10, 20, 30, 45, 60, 90]) {
      const r = after(event("airport.security_wait_changed", { waitMinutes: wait }), s);
      assert.ok(usable(r) <= prevUsable, `usable rose from ${prevUsable} to ${usable(r)} at wait=${wait}`);
      assert.ok(deadlineMs(r) <= prevDeadline, `deadline moved later at wait=${wait}`);
      prevUsable = usable(r);
      prevDeadline = deadlineMs(r);
      seen.push(usable(r));
    }
    // POSITIVE CONTROL: the ladder must actually MOVE. A monotonicity check
    // over a constant sequence is satisfied by an engine that ignores its
    // input, which is exactly the vacuous pass this file exists to refuse.
    assert.ok(
      new Set(seen).size > 1,
      "the security wait changed nothing across a 0..90 minute ladder — the term is not wired",
    );
    assert.ok(seen[0] > seen[seen.length - 1]);
  });

  it("the contraction is exactly the observed minutes, charged once", () => {
    const s = session(6);
    const none = after(event("airport.security_wait_changed", { waitMinutes: 0 }), s);
    const spike = after(event("airport.security_wait_changed", { waitMinutes: 40 }), s);
    assert.equal(usable(none) - usable(spike), 40);
    assert.equal(spike.deadline.breakdown.liveExtra, 40);
    // Not folded into the airport's static traffic figure — a traveller must be
    // able to see that the change is an observed queue.
    assert.equal(spike.deadline.breakdown.trafficExtra, none.deadline.breakdown.trafficExtra);
  });

  /**
   * MEASURED: this property is guarded THREE TIMES INDEPENDENTLY, and removing
   * any one clamp leaves it green. Turning it red takes removing all three —
   * `withLiveTerm`'s `Math.max(0, observedMinutes)`, its `Math.max(base[term],
   * value)` monotone growth, and `liveExtraMinutes`' own `n > 0` term filter.
   * That is defence in depth rather than a redundant test, and it is recorded
   * here so nobody later reads this case as a single-mutation proof of any one
   * of them.
   */
  it("POSITIVE CONTROL: a NEGATIVE observed wait cannot buy time", () => {
    const s = session(6);
    const none = after(event("airport.security_wait_changed", { waitMinutes: 0 }), s);
    const forged = after(event("airport.security_wait_changed", { waitMinutes: -60 }), s);
    assert.equal(usable(forged), usable(none), "a negative queue handed the traveller extra minutes");
  });
});

// ── L228 — traffic spike moves the return deadline earlier ───────────────────

describe("§21.1 L228 — a traffic spike moves the return deadline EARLIER", () => {
  it("a degraded ground route pulls the deadline in by the observed minutes", () => {
    const s = session(6);
    const base = certify(s);
    const degraded = after(event("mobility.route_degraded", { extraMinutes: 25 }), s);
    assert.ok(deadlineMs(degraded) < deadlineMs(base));
    assert.equal((deadlineMs(base) - deadlineMs(degraded)) / 60_000, 25);
  });

  it("POSITIVE CONTROL: the census's own finding — the STATIC term still never moves", () => {
    const s = session(6);
    const base = certify(s);
    const degraded = after(event("mobility.route_degraded", { extraMinutes: 25 }), s);
    // Census L228: "`traffic_extra_min` is a static admin constant; nothing
    // moves it." That remains true, and it is the right design — the live
    // observation is a SEPARATE term. This pins both halves so the claim cannot
    // drift in either direction.
    assert.equal(degraded.deadline.breakdown.trafficExtra, base.deadline.breakdown.trafficExtra);
    assert.equal(degraded.deadline.breakdown.liveExtra, 25);
  });

  it("two live terms accumulate rather than one masking the other", () => {
    const s = session(6);
    const security = after(event("airport.security_wait_changed", { waitMinutes: 30 }), s);
    const both = applyEventToInputs(
      event("mobility.route_degraded", { extraMinutes: 20 }),
      s,
      applyEventToInputs(event("airport.security_wait_changed", { waitMinutes: 30 }), s, null).live,
    );
    const r = certify(both.session, both.live);
    assert.equal(r.deadline.breakdown.liveExtra, 50);
    assert.ok(deadlineMs(r) < deadlineMs(security));
  });
});

// ── L231 — cancellation transitions to disruption ────────────────────────────

describe("§21.1 L231 — a cancellation transitions to disruption", () => {
  it("the state machine moves, and the schedule is NOT invented", () => {
    const s = session(6);
    const e = event("flight.cancelled", {});
    const next = applyEventToInputs(e, s, null);
    // Appendix C1: a cancelled flight has no replacement departure time, and
    // only the airline has one. The schedule must be left exactly as it was.
    assert.equal(next.session.departureTime, s.departureTime);
    assert.equal(next.session.arrivalTime, s.arrivalTime);
    // The DISRUPTION carries the fact instead.
    assert.deepEqual(disruptionEventFor(e), { kind: "cancellation" });
    const state = disruptionAfter("none", e);
    assert.notEqual(state, "none");
  });

  it("POSITIVE CONTROL: a security event is NOT a disruption", () => {
    const e = event("airport.security_wait_changed", { waitMinutes: 60 });
    assert.equal(disruptionEventFor(e), null);
    assert.equal(disruptionAfter("none", e), "none");
  });

  it("a departure delay is a disruption of a different kind, carrying its minutes", () => {
    const e = event("flight.departure_delayed", { delayMinutes: 120 });
    assert.deepEqual(disruptionEventFor(e), { kind: "delay", delayMinutes: 120 });
  });
});

// ── L230 — unknown entry permission ──────────────────────────────────────────

describe("§21.1 L230 — unknown entry permission, and why it cannot gate anything", () => {
  /**
   * L230 asks that an unknown entry permission produce NO LANDSIDE
   * RECOMMENDATION. It cannot be satisfied on this tree and it cannot even be
   * parameterised: no field of a session or an airport carries entry
   * permission (census L34, L48), so "unknown" is the only state there is, and
   * a gate on it would refuse every traveller at every airport forever.
   *
   * What the engine does instead is DISCLOSE. This case pins that the
   * disclosure is unconditional — present on the permissive answer, which is
   * the one where a missing caveat would actually mislead someone.
   */
  it("every landside verdict still carries ENTRY_NOT_CONFIRMED", () => {
    const permissive = certify(session(8));
    assert.equal(permissive.verdict, "yes");
    assert.ok(permissive.reasonCodes.includes("ENTRY_NOT_CONFIRMED"));
    assert.ok(permissive.unknowns.some((u) => /visa|transit-permit/i.test(u)));
  });

  it("POSITIVE CONTROL: no input in the whole certified set can express entry permission", () => {
    const r = certify(session(8));
    const keys = [
      ...Object.keys(r.inputs.airport).map((k) => `airport.${k}`),
      ...Object.keys(r.inputs.session).map((k) => `session.${k}`),
    ];
    for (const k of keys) {
      assert.ok(
        !/entry|visa|permit|nationality|passport/i.test(k),
        `${k} exists — L230 is now parameterisable and this scenario must be rewritten as a real gate`,
      );
    }
  });
});

// ── L232, L233 — where they actually stand ───────────────────────────────────

describe("§21.1 L232 / L233 — the two this file does not close", () => {
  /**
   * Stated as assertions rather than prose so the matrix reports its own
   * incompleteness on every run instead of a reader having to go and check.
   */
  it("L232 crew mixed departures: the event vocabulary has no crew subject kind", () => {
    const e = event("flight.departure_delayed", { delayMinutes: 30 });
    for (const ref of e.subjectRefs) {
      assert.notEqual(ref.kind, "crew");
    }
    // A shared constraint would need several sessions to be one subject. The
    // replanner's fanout is per-session and per-airport only (impactedSessions),
    // so "earliest departure wins for the whole crew" has nowhere to live. The
    // crew solver itself is covered by src/test/layoverCrewConstraints.test.ts;
    // what is missing is its connection to an EVENT.
  });

  it("L233 offline cached return plan: no event says the traveller went offline", () => {
    const r = normalizeEvent(
      {
        eventId: "e1", eventType: "layover.went_offline",
        occurredAt: new Date(NOW).toISOString(), source: "client",
        sourceEventId: "s1", subjectRefs: [{ kind: "session", ref: "session-1" }],
        payload: {}, confidence: "MEDIUM",
      },
      { receivedAtMs: NOW },
    );
    assert.equal(r.ok, false);
    assert.equal(r.ok === false ? r.reason : null, "unknown_event_type");
    // The vocabulary is closed (LAYOVER_EVENT_TYPES), which is correct — but it
    // means the offline scenario cannot be driven from the event side at all.
  });
});
