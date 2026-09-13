/**
 * §11 event-driven replanning — the envelope, the vocabulary, and the eight
 * numbered pipeline steps.
 *
 * node:test + node:assert/strict (NOT vitest). No DB, no network. The verdict
 * is the EXIT CODE.
 *
 * ── THE HONEST FRAME ─────────────────────────────────────────────────────────
 * NOTHING ON THIS TREE EMITS A LAYOVER EVENT. There is no flight feed, no
 * airport feed, no ingest route, and `layover_external_events` is written and
 * unapplied. Every test below hands the pipeline an event by hand. What is
 * being asserted is what the pipeline DOES with one, which is a different claim
 * from "sessions are replanned in production" — the census states both.
 *
 * ── WHAT IS DELIBERATELY NOT ASSERTED ────────────────────────────────────────
 * §11.1 step 4 is "create a new immutable snapshot". `ReplanOutcome` reports
 * `snapshotPersisted: false` with `snapshotUnavailableReason:
 * "no_snapshot_storage"`, and the test below asserts that it says so rather
 * than asserting that a snapshot exists. A test that mocked a store and then
 * asserted the mock was called would be a test of the mock.
 *
 * ── RED-FIRST RECORD ─────────────────────────────────────────────────────────
 * Every mutation was made to PRODUCTION code in
 * `src/services/airport/LayoverEventReplanner.ts`, measured, and reverted.
 *
 * GREEN, unmutated: 50 pass / 0 fail. M1-M7 were measured out of 48, before the
 * two §21.1 scenario tests were added; M8 and M9 out of 50.
 *
 *   M1  `normalizeEvent` — build the dedup key from the eventId as well
 *       (`${source}:${sourceEventId}:${raw.eventId}`), the mistake §24 names:
 *       a producer minting a fresh uuid per delivery then defeats dedup
 *       entirely.
 *       MEASURED: 46 pass / 2 fail.
 *
 *   M2  `normalizeEvent` — skip payload validation (`const payloadError = null`),
 *       so a `flight.departure_delayed` with no minutes is accepted and the
 *       recompute silently reads NaN.
 *       MEASURED: 44 pass / 4 fail.
 *
 *   M3  `impactedSessions` — drop the `occurredMs > cutoffMs` window test, so
 *       an airport-wide event fans out to sessions whose flight has already
 *       left.
 *       MEASURED: 47 pass / 1 fail.
 *
 *   M4  `handleEvent` — remove the `nodes.length === 0` skip, so every event
 *       type re-certifies whether or not it can move a single named input.
 *       MEASURED: 47 pass / 1 fail.
 *
 *   M5  `opportunityEventFor` — return an opportunity unconditionally (build
 *       it even when `why` is empty), the "notify on every recompute" storm
 *       §24 forbids.
 *       MEASURED: 47 pass / 1 fail.
 *
 *   M6  `shouldNotify` — notify whenever an opportunity exists (`return
 *       { notify: true, priority: "normal", … }` as the fallback), collapsing
 *       step 8 into step 7.
 *       MEASURED: 47 pass / 1 fail.
 *
 *   M7  `disruptionEventFor` — map `airport.security_wait_changed` to a delay
 *       event, so a queue report drives a session into the flight-disruption
 *       chain.
 *       MEASURED: 47 pass / 1 fail.
 *
 *   M8  `LAYOVER_EVENT_TYPES` — drop `layover.airport_reentered`, so the
 *       vocabulary silently stops being the spec's eleven.
 *       MEASURED: 47 pass / 3 fail (out of 50).
 *
 *   M9  `diffActionUniverse` — return `candidatesLost: []` unconditionally, so
 *       a plan that stopped fitting is invisible to steps 7 and 8. This is the
 *       one that matters: with it, the high-priority notification for "your
 *       plan no longer fits" never fires and nothing else changes.
 *       MEASURED: 48 pass / 2 fail (out of 50).
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverEventReplanner.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CONSTRAINT_NODES,
  EVENT_AFFECTS,
  LAYOVER_EVENT_TYPES,
  MATERIALITY,
  actionUniverseOf,
  affectedConstraintNodes,
  applyEventToInputs,
  candidateFits,
  dedupeEvents,
  diffActionUniverse,
  disruptionAfter,
  disruptionEventFor,
  handleEvent,
  impactedSessions,
  invalidateRecommendations,
  normalizeEvent,
  opportunityEventFor,
  shouldNotify,
  type LayoverEventEnvelope,
  type LayoverEventType,
  type RawLayoverEvent,
  type ReplanCandidate,
  type ReplanSession,
} from "../services/airport/LayoverEventReplanner.js";
import {
  certifySessionFeasibility,
  type FeasibilityAirport,
  type FeasibilitySession,
} from "../services/airport/LayoverFeasibility.js";

const MIN = 60_000;
const NOW = Date.parse("2030-06-15T04:00:00.000Z");

function airport(over: Partial<FeasibilityAirport> = {}): FeasibilityAirport {
  return {
    id: "airport-tpe", iataCode: "TPE", timezone: "Asia/Taipei", verified: false,
    domesticBufferMin: 60, internationalBufferMin: 120,
    immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
    ...over,
  };
}

function session(over: Partial<FeasibilitySession> = {}): FeasibilitySession {
  return {
    id: "session-1",
    arrivalTime: "2030-06-15T02:00:00.000Z",
    departureTime: "2030-06-15T14:00:00.000Z",
    boardingTime: null,
    flightType: "international",
    immigrationRequired: true,
    checkedBags: false,
    wantsToLeave: true,
    ...over,
  };
}

function replanSession(over: Partial<ReplanSession> = {}): ReplanSession {
  return { session: session(), airportRef: "TPE", status: "active", ...over };
}

function raw(over: Partial<RawLayoverEvent> = {}): RawLayoverEvent {
  return {
    eventId: "evt-1",
    eventType: "flight.departure_delayed",
    occurredAt: new Date(NOW - 5 * MIN).toISOString(),
    source: "acme-flightfeed",
    sourceEventId: "acme-9001",
    subjectRefs: [{ kind: "session", ref: "session-1" }],
    payload: { delayMinutes: 90 },
    confidence: "HIGH",
    ...over,
  };
}

function envelope(over: Partial<RawLayoverEvent> = {}): LayoverEventEnvelope {
  const r = normalizeEvent(raw(over), { receivedAtMs: NOW });
  assert.ok(r.ok, `fixture failed to normalize: ${r.ok ? "" : r.reason + " " + r.detail}`);
  return r.event;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. §11 — the vocabulary and the envelope
// ═══════════════════════════════════════════════════════════════════════════

describe("§11 — the canonical vocabulary", () => {
  it("is exactly the eleven the specification lists, in its order", () => {
    // Transcribed from docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt
    // §11 "Examples:" block. Not imported from the module under test — a
    // vocabulary test that reads its expectation out of the thing it is
    // checking asserts nothing.
    assert.deepEqual([...LAYOVER_EVENT_TYPES], [
      "flight.arrival_delayed",
      "flight.departure_delayed",
      "flight.gate_changed",
      "flight.cancelled",
      "airport.security_wait_changed",
      "airport.immigration_wait_changed",
      "mobility.route_degraded",
      "weather.condition_changed",
      "layover.checkpoint_observed",
      "layover.return_started",
      "layover.airport_reentered",
    ]);
  });

  it("a twelfth type cannot be introduced by writing one", () => {
    const r = normalizeEvent(raw({ eventType: "flight.diverted" }), { receivedAtMs: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "unknown_event_type");
  });

  it("the envelope carries all ten members the spec names", () => {
    const e = envelope();
    for (const k of [
      "eventId", "eventType", "occurredAt", "receivedAt", "source",
      "sourceEventId", "subjectRefs", "payload", "dedupKey", "confidence",
    ]) {
      assert.ok(k in e, `envelope is missing ${k}`);
    }
    assert.equal(e.receivedAt, new Date(NOW).toISOString());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. §11.1 step 1 — normalise and deduplicate
// ═══════════════════════════════════════════════════════════════════════════

describe("§11.1 step 1 — normalise: every rejection has a named reason", () => {
  const cases: Array<[string, Partial<RawLayoverEvent>, string]> = [
    ["unknown type", { eventType: "nope" }, "unknown_event_type"],
    ["no event id", { eventId: "" }, "missing_event_id"],
    ["no source", { source: undefined }, "missing_source"],
    ["unparseable occurredAt", { occurredAt: "yesterday" }, "bad_occurred_at"],
    ["future dated", { occurredAt: new Date(NOW + MIN).toISOString() }, "occurred_in_future"],
    ["no subject", { subjectRefs: [] }, "no_subject"],
    ["subjects of an unknown kind", { subjectRefs: [{ kind: "spaceship", ref: "x" }] }, "no_subject"],
    ["bad confidence", { confidence: "PRETTY_SURE" }, "bad_confidence"],
    ["delay with no minutes", { payload: {} }, "bad_payload"],
    ["delay with a non-numeric", { payload: { delayMinutes: "90" } }, "bad_payload"],
    ["delay outside the plausible range", { payload: { delayMinutes: 99999 } }, "bad_payload"],
    [
      "gate change with no gate",
      { eventType: "flight.gate_changed", payload: {} },
      "bad_payload",
    ],
  ];

  for (const [name, over, reason] of cases) {
    it(`rejects ${name} as ${reason}`, () => {
      const r = normalizeEvent(raw(over), { receivedAtMs: NOW });
      assert.equal(r.ok, false, `${name} was accepted`);
      assert.equal(r.ok === false && r.reason, reason);
    });
  }

  it("every event type has a payload validator, and a valid payload passes it", () => {
    const valid: Record<LayoverEventType, Record<string, unknown>> = {
      "flight.arrival_delayed": { delayMinutes: 30 },
      "flight.departure_delayed": { delayMinutes: 30 },
      "flight.gate_changed": { gate: "B7" },
      "flight.cancelled": {},
      "airport.security_wait_changed": { waitMinutes: 40 },
      "airport.immigration_wait_changed": { waitMinutes: 40 },
      "mobility.route_degraded": { extraMinutes: 15 },
      "weather.condition_changed": { condition: "thunderstorm" },
      "layover.checkpoint_observed": { checkpoint: "T1-security" },
      "layover.return_started": {},
      "layover.airport_reentered": {},
    };
    for (const t of LAYOVER_EVENT_TYPES) {
      const r = normalizeEvent(raw({ eventType: t, payload: valid[t] }), { receivedAtMs: NOW });
      assert.ok(r.ok, `${t} rejected a valid payload`);
    }
  });
});

describe("§11.1 step 1 / §23 / §24 — deduplication by a stable source key", () => {
  it("the key is source:sourceEventId when the producer supplied one", () => {
    assert.equal(envelope().dedupKey, "acme-flightfeed:acme-9001");
  });

  it("the same upstream event delivered twice with different eventIds collapses", () => {
    const a = envelope({ eventId: "delivery-a" });
    const b = envelope({ eventId: "delivery-b" });
    assert.equal(a.dedupKey, b.dedupKey);
    const { kept, dropped } = dedupeEvents([a, b]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.eventId, "delivery-a", "first occurrence wins");
    assert.equal(dropped.length, 1);
  });

  it("with no sourceEventId the key is a content digest — same content collapses", () => {
    const a = envelope({ eventId: "x", sourceEventId: undefined });
    const b = envelope({ eventId: "y", sourceEventId: undefined });
    assert.ok(a.dedupKey.startsWith("sha256:"));
    assert.equal(a.dedupKey, b.dedupKey);
  });

  it("the content digest does not depend on the order subjects were listed", () => {
    const subjects = [
      { kind: "airport", ref: "TPE" },
      { kind: "session", ref: "session-1" },
    ];
    const a = envelope({ sourceEventId: undefined, subjectRefs: subjects });
    const b = envelope({ sourceEventId: undefined, subjectRefs: [...subjects].reverse() });
    assert.equal(a.dedupKey, b.dedupKey);
  });

  it("genuinely different content does NOT collapse", () => {
    const a = envelope({ sourceEventId: undefined, payload: { delayMinutes: 90 } });
    const b = envelope({ sourceEventId: undefined, payload: { delayMinutes: 91 } });
    assert.notEqual(a.dedupKey, b.dedupKey);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. §11.1 step 2 — impacted sessions
// ═══════════════════════════════════════════════════════════════════════════

describe("§11.1 step 2 — identify impacted ACTIVE sessions", () => {
  const airportEvent = () => envelope({
    eventType: "airport.security_wait_changed",
    payload: { waitMinutes: 55 },
    subjectRefs: [{ kind: "airport", ref: "TPE" }],
  });

  it("a session named directly is impacted", () => {
    const out = impactedSessions(envelope(), [replanSession()]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.via, "session_subject");
  });

  it("an airport event fans out to that airport's active sessions", () => {
    const out = impactedSessions(airportEvent(), [
      replanSession(),
      replanSession({ session: session({ id: "s2" }), airportRef: "HND" }),
    ]);
    assert.deepEqual(out.map((o) => o.session.session.id), ["session-1"]);
    assert.equal(out[0]!.via, "airport_subject");
  });

  it("a closed session is never impacted, however it is named", () => {
    for (const status of ["cancelled", "expired", "completed"]) {
      assert.equal(impactedSessions(envelope(), [replanSession({ status })]).length, 0, status);
      assert.equal(impactedSessions(airportEvent(), [replanSession({ status })]).length, 0, status);
    }
  });

  it("an airport event after the flight's cutoff does not reach that session", () => {
    const lateMs = Date.parse("2030-06-15T13:00:00.000Z");
    const r = normalizeEvent(
      raw({
        eventType: "airport.security_wait_changed",
        payload: { waitMinutes: 55 },
        subjectRefs: [{ kind: "airport", ref: "TPE" }],
        occurredAt: new Date(lateMs).toISOString(),
      }),
      { receivedAtMs: lateMs + 1000 },
    );
    assert.ok(r.ok);
    const already = replanSession({
      session: session({ departureTime: "2030-06-15T12:00:00.000Z" }),
    });
    const stillFlying = replanSession({
      session: session({ id: "s3", departureTime: "2030-06-15T18:00:00.000Z" }),
    });
    const out = impactedSessions(r.event, [already, stillFlying]);
    assert.deepEqual(out.map((o) => o.session.session.id), ["s3"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. §11.1 step 3 — affected constraint nodes
// ═══════════════════════════════════════════════════════════════════════════

describe("§11.1 step 3 — recompute only what the event can move", () => {
  it("the node map is total over the vocabulary and names only declared nodes", () => {
    for (const t of LAYOVER_EVENT_TYPES) {
      const nodes = affectedConstraintNodes(t);
      assert.ok(Array.isArray(nodes), `${t} has no entry`);
      for (const n of nodes) {
        assert.ok((CONSTRAINT_NODES as readonly string[]).includes(n), `${t} names undeclared node ${n}`);
      }
    }
    assert.equal(Object.keys(EVENT_AFFECTS).length, LAYOVER_EVENT_TYPES.length);
  });

  it("the five event types this tree has no term for move nothing", () => {
    for (const t of [
      "flight.gate_changed",
      "weather.condition_changed",
      "layover.checkpoint_observed",
      "layover.return_started",
      "layover.airport_reentered",
    ] as const) {
      assert.deepEqual([...affectedConstraintNodes(t)], [], `${t} claims to move a node`);
    }
  });

  it("applying an event moves the named node and only the named node", () => {
    const s = session();
    const delayed = applyEventToInputs(envelope({ payload: { delayMinutes: 90 } }), s, null);
    assert.equal(
      Date.parse(delayed.session.departureTime) - Date.parse(s.departureTime),
      90 * MIN,
    );
    assert.equal(delayed.session.arrivalTime, s.arrivalTime, "an untouched node moved");
    assert.equal(delayed.live, null);

    const spike = applyEventToInputs(
      envelope({ eventType: "airport.security_wait_changed", payload: { waitMinutes: 35 } }),
      s,
      null,
    );
    assert.equal(spike.session.departureTime, s.departureTime, "a schedule node moved on a queue event");
    assert.equal(spike.live!.securityWaitExtraMin, 35);
    assert.equal(spike.live!.immigrationWaitExtraMin, 0);
  });

  it("a cancelled flight does not invent a replacement departure time", () => {
    const s = session();
    const out = applyEventToInputs(envelope({ eventType: "flight.cancelled", payload: {} }), s, null);
    assert.equal(out.session.departureTime, s.departureTime);
    assert.equal(out.session.boardingTime, s.boardingTime);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. §11.1 steps 5-8 over a real recompute
// ═══════════════════════════════════════════════════════════════════════════

const CANDIDATES: ReplanCandidate[] = [
  { id: "near", travelTimeMin: 15, activityTimeMin: 30, insideAirport: false },
  { id: "far", travelTimeMin: 60, activityTimeMin: 90, insideAirport: false },
  { id: "lounge", travelTimeMin: 0, activityTimeMin: 60, insideAirport: true },
];

describe("§11.1 step 5 — the action universe, diffed", () => {
  it("a security spike that shrinks the window drops the options that no longer fit", () => {
    const a = airport();
    const s = session();
    const before = certifySessionFeasibility(a, s, { nowMs: NOW });
    const spike = applyEventToInputs(
      envelope({
        eventType: "airport.security_wait_changed",
        payload: { waitMinutes: 240 },
        subjectRefs: [{ kind: "airport", ref: "TPE" }],
      }),
      s,
      null,
    );
    const after = certifySessionFeasibility(a, spike.session, {
      nowMs: NOW, liveConditions: spike.live,
    });
    const diff = diffActionUniverse(
      actionUniverseOf(before, CANDIDATES),
      actionUniverseOf(after, CANDIDATES),
    );
    assert.ok(diff.usableMinutesDelta < 0);
    assert.ok(diff.deadlineDeltaMinutes < 0);
    assert.ok(diff.candidatesLost.includes("far"), "the long trip should have stopped fitting");
    assert.deepEqual(diff.candidatesGained, []);
  });

  it("a delay that widens the window gains options rather than losing them", () => {
    const a = airport();
    const s = session({ departureTime: "2030-06-15T08:30:00.000Z" });
    const before = certifySessionFeasibility(a, s, { nowMs: NOW });
    const moved = applyEventToInputs(envelope({ payload: { delayMinutes: 300 } }), s, null);
    const after = certifySessionFeasibility(a, moved.session, { nowMs: NOW });
    const diff = diffActionUniverse(
      actionUniverseOf(before, CANDIDATES),
      actionUniverseOf(after, CANDIDATES),
    );
    assert.ok(diff.usableMinutesDelta > 0);
    assert.deepEqual(diff.candidatesLost, []);
    assert.ok(diff.candidatesGained.length > 0);
  });

  it("§21.1 — an arrival delay shrinks the freedom window", () => {
    const a = airport();
    // `nowMs` before the (delayed) arrival, so the window is bounded by
    // wheels-down + exit delay rather than by the clock — which is the only
    // configuration in which an arrival delay can bite at all.
    const early = Date.parse("2030-06-15T01:00:00.000Z");
    const s = session();
    const before = certifySessionFeasibility(a, s, { nowMs: early });
    const late = applyEventToInputs(
      envelope({ eventType: "flight.arrival_delayed", payload: { delayMinutes: 120 } }),
      s, null,
    );
    const after = certifySessionFeasibility(a, late.session, { nowMs: early });
    assert.ok(
      after.envelope.usableMinutes < before.envelope.usableMinutes,
      `usable did not shrink: ${before.envelope.usableMinutes} -> ${after.envelope.usableMinutes}`,
    );
    // The deadline is anchored on the DEPARTURE, which the arrival did not move.
    assert.equal(
      after.deadline.hardReturnTime.getTime(),
      before.deadline.hardReturnTime.getTime(),
      "an arrival delay must not move the return deadline — that is the departure's job",
    );
  });

  it("§21.1 — a traffic spike moves the return deadline earlier", () => {
    const a = airport();
    const s = session();
    const before = certifySessionFeasibility(a, s, { nowMs: NOW });
    const degraded = applyEventToInputs(
      envelope({ eventType: "mobility.route_degraded", payload: { extraMinutes: 35 } }),
      s, null,
    );
    const after = certifySessionFeasibility(a, degraded.session, {
      nowMs: NOW, liveConditions: degraded.live,
    });
    assert.equal(
      before.deadline.hardReturnTime.getTime() - after.deadline.hardReturnTime.getTime(),
      35 * MIN,
    );
    assert.equal(after.deadline.breakdown.liveExtra, 35);
    assert.equal(
      after.deadline.breakdown.trafficExtra,
      before.deadline.breakdown.trafficExtra,
      "the airport's static traffic figure must not be overwritten by a live one",
    );
  });

  it("candidateFits is the certified window, not a category guess", () => {
    const r = certifySessionFeasibility(airport(), session(), { nowMs: NOW });
    for (const c of CANDIDATES) {
      const cost = (c.insideAirport ? 0 : c.travelTimeMin * 2) + c.activityTimeMin;
      assert.equal(candidateFits(r, c), cost <= r.envelope.usableMinutes, c.id);
    }
  });
});

describe("§11.1 step 6 — invalidation decides, it does not delete", () => {
  it("names both the infeasible candidates and the ones certified under another hash", () => {
    const a = airport();
    const s = session();
    const spike = applyEventToInputs(
      envelope({ eventType: "airport.security_wait_changed", payload: { waitMinutes: 240 } }),
      s, null,
    );
    const after = certifySessionFeasibility(a, spike.session, { nowMs: NOW, liveConditions: spike.live });
    const decision = invalidateRecommendations(after, CANDIDATES, [
      { id: "rec-current", inputHash: after.inputHash },
      { id: "rec-old", inputHash: "sha256:" + "0".repeat(64) },
    ]);
    assert.ok(decision.noLongerFeasible.includes("far"));
    assert.deepEqual(decision.staleCertification, ["rec-old"]);
    assert.equal(decision.newInputHash, after.inputHash);
  });
});

describe("§11.1 step 7 — an OpportunityEvent only on a material change", () => {
  const a = airport();
  const s = session();
  const before = certifySessionFeasibility(a, s, { nowMs: NOW });

  function diffAfterDelay(minutes: number) {
    const moved = applyEventToInputs(envelope({ payload: { delayMinutes: minutes } }), s, null);
    const after = certifySessionFeasibility(a, moved.session, { nowMs: NOW });
    return diffActionUniverse(actionUniverseOf(before, CANDIDATES), actionUniverseOf(after, CANDIDATES));
  }

  it("an immaterial move emits nothing", () => {
    const diff = diffAfterDelay(1);
    assert.ok(Math.abs(diff.usableMinutesDelta) < MATERIALITY.usableMinutes);
    assert.ok(Math.abs(diff.deadlineDeltaMinutes) < MATERIALITY.deadlineMinutes);
    assert.equal(opportunityEventFor("session-1", envelope(), diff), null);
  });

  it("a material move emits one, with the reason spelled out", () => {
    const diff = diffAfterDelay(240);
    const op = opportunityEventFor("session-1", envelope({ payload: { delayMinutes: 240 } }), diff);
    assert.ok(op);
    assert.ok(op.why.length > 0);
    assert.equal(op.causedByEventType, "flight.departure_delayed");
  });

  it("FLIGHT_DELAY_CREATED_OPPORTUNITY only when the delay actually widened the window", () => {
    const wide = diffAfterDelay(240);
    const op = opportunityEventFor("session-1", envelope({ payload: { delayMinutes: 240 } }), wide);
    assert.ok(op!.reasonCodes.includes("FLIGHT_DELAY_CREATED_OPPORTUNITY"));

    // A queue spike is material and is NOT a delay opportunity.
    const spike = applyEventToInputs(
      envelope({ eventType: "airport.security_wait_changed", payload: { waitMinutes: 240 } }), s, null);
    const after = certifySessionFeasibility(a, spike.session, { nowMs: NOW, liveConditions: spike.live });
    const sd = diffActionUniverse(actionUniverseOf(before, CANDIDATES), actionUniverseOf(after, CANDIDATES));
    const sop = opportunityEventFor(
      "session-1",
      envelope({ eventType: "airport.security_wait_changed", payload: { waitMinutes: 240 } }),
      sd,
    );
    assert.ok(sop);
    assert.ok(!sop.reasonCodes.includes("FLIGHT_DELAY_CREATED_OPPORTUNITY"));
  });

  it("FLIGHT_MOVED_EARLIER is a claim about a FLIGHT, not about any earlier deadline", () => {
    // A queue spike moves the deadline earlier and must NOT claim the flight moved.
    const spike = applyEventToInputs(
      envelope({ eventType: "airport.security_wait_changed", payload: { waitMinutes: 240 } }), s, null);
    const after = certifySessionFeasibility(a, spike.session, { nowMs: NOW, liveConditions: spike.live });
    const sd = diffActionUniverse(actionUniverseOf(before, CANDIDATES), actionUniverseOf(after, CANDIDATES));
    assert.ok(sd.deadlineDeltaMinutes < 0);
    const sop = opportunityEventFor(
      "session-1",
      envelope({ eventType: "airport.security_wait_changed", payload: { waitMinutes: 240 } }),
      sd,
    );
    assert.ok(!sop!.reasonCodes.includes("FLIGHT_MOVED_EARLIER"));

    // A flight brought forward does.
    const earlier = applyEventToInputs(envelope({ payload: { delayMinutes: -180 } }), s, null);
    const ea = certifySessionFeasibility(a, earlier.session, { nowMs: NOW });
    const ed = diffActionUniverse(actionUniverseOf(before, CANDIDATES), actionUniverseOf(ea, CANDIDATES));
    const eop = opportunityEventFor("session-1", envelope({ payload: { delayMinutes: -180 } }), ed);
    assert.ok(eop!.reasonCodes.includes("FLIGHT_MOVED_EARLIER"));
  });
});

describe("§11.1 step 8 — notify only when the traveller should act differently", () => {
  it("no opportunity, no notification", () => {
    assert.deepEqual(shouldNotify(null), { notify: false, reason: "no material change" });
  });

  it("step 8 is STRICTLY narrower than step 7 — a material change that needs no action", () => {
    const a = airport();
    const s = session({ departureTime: "2030-06-15T09:00:00.000Z" });
    const before = certifySessionFeasibility(a, s, { nowMs: NOW });
    // A seven-minute delay: the DEADLINE moves materially (>= 5 min, so step 7
    // fires) while the usable window moves by less than the opportunity
    // threshold and the verdict, the state, the tier and every candidate's fit
    // all hold. There is nothing here for the traveller to do differently.
    const moved = applyEventToInputs(envelope({ payload: { delayMinutes: 7 } }), s, null);
    const after = certifySessionFeasibility(a, moved.session, { nowMs: NOW });
    const diff = diffActionUniverse(
      actionUniverseOf(before, CANDIDATES), actionUniverseOf(after, CANDIDATES));
    const op = opportunityEventFor("session-1", envelope({ payload: { delayMinutes: 7 } }), diff);
    assert.ok(op, "positive control: this IS material");
    assert.ok(Math.abs(diff.deadlineDeltaMinutes) >= MATERIALITY.deadlineMinutes);
    assert.ok(Math.abs(diff.usableMinutesDelta) < MATERIALITY.usableMinutes);
    assert.deepEqual(diff.candidatesLost, []);
    assert.equal(diff.verdictChanged, false);
    assert.equal(shouldNotify(op).notify, false);
  });

  it("a planned option that stopped fitting is a high-priority notification", () => {
    const a = airport();
    const s = session();
    const before = certifySessionFeasibility(a, s, { nowMs: NOW });
    const spike = applyEventToInputs(
      envelope({ eventType: "airport.security_wait_changed", payload: { waitMinutes: 240 } }), s, null);
    const after = certifySessionFeasibility(a, spike.session, { nowMs: NOW, liveConditions: spike.live });
    const diff = diffActionUniverse(
      actionUniverseOf(before, CANDIDATES), actionUniverseOf(after, CANDIDATES));
    const op = opportunityEventFor(
      "session-1",
      envelope({ eventType: "airport.security_wait_changed", payload: { waitMinutes: 240 } }),
      diff,
    );
    const n = shouldNotify(op);
    assert.equal(n.notify, true);
    assert.equal(n.notify && n.priority, "high");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. §18 handleEvent — the pipeline end to end
// ═══════════════════════════════════════════════════════════════════════════

describe("§18 LayoverReplanner.handleEvent", () => {
  const ctx = () => ({
    airport: airport(),
    sessions: [replanSession(), replanSession({ session: session({ id: "s2" }), airportRef: "HND" })],
    candidates: { "session-1": CANDIDATES },
    nowMs: NOW,
  });

  it("replans the impacted session and reports the snapshot it could not persist", () => {
    const out = handleEvent(envelope({ payload: { delayMinutes: 240 } }), ctx());
    assert.equal(out.impacted, 1);
    assert.equal(out.replanned.length, 1);
    const r = out.replanned[0]!;
    assert.equal(r.sessionId, "session-1");
    assert.notEqual(r.before.inputHash, r.after.inputHash);
    assert.equal(r.snapshotPersisted, false);
    assert.equal(r.snapshotUnavailableReason, "no_snapshot_storage");
  });

  it("an event that can move no named input is SKIPPED, not recertified", () => {
    const out = handleEvent(
      envelope({ eventType: "flight.gate_changed", payload: { gate: "B7" } }),
      ctx(),
    );
    assert.equal(out.impacted, 1);
    assert.equal(out.replanned.length, 0);
    assert.deepEqual(out.skipped.map((s) => s.reason), ["no_affected_constraint_node"]);
  });

  it("a session at another airport is neither replanned nor skipped", () => {
    const out = handleEvent(
      envelope({
        eventType: "airport.security_wait_changed",
        payload: { waitMinutes: 60 },
        subjectRefs: [{ kind: "airport", ref: "TPE" }],
      }),
      ctx(),
    );
    assert.equal(out.impacted, 1);
    assert.ok(!out.replanned.some((r) => r.sessionId === "s2"));
    assert.ok(!out.skipped.some((r) => r.sessionId === "s2"));
  });

  it("the notification count is the step-8 decision, not the step-7 count", () => {
    const out = handleEvent(envelope({ payload: { delayMinutes: 25 } }), ctx());
    assert.equal(out.notifications, out.replanned.filter((r) => r.notify.notify).length);
    assert.ok(out.notifications <= out.replanned.filter((r) => r.opportunity !== null).length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. §15.2 — the disruption machine, driven by an event at last
// ═══════════════════════════════════════════════════════════════════════════

describe("§15.2 — an event drives the disruption state", () => {
  it("a cancellation cancels", () => {
    assert.equal(disruptionAfter("CONNECTION", envelope({ eventType: "flight.cancelled", payload: {} })), "CANCELLED");
  });

  it("delay magnitude picks the rung", () => {
    assert.equal(disruptionAfter("CONNECTION", envelope({ payload: { delayMinutes: 45 } })), "DELAYED");
    assert.equal(disruptionAfter("CONNECTION", envelope({ payload: { delayMinutes: 200 } })), "SEVERE_DELAY");
    assert.equal(disruptionAfter("CONNECTION", envelope({ payload: { delayMinutes: 600 } })), "OVERNIGHT");
  });

  it("a queue report is not a flight disruption", () => {
    const e = envelope({ eventType: "airport.security_wait_changed", payload: { waitMinutes: 90 } });
    assert.equal(disruptionEventFor(e), null);
    assert.equal(disruptionAfter("DELAYED", e), "DELAYED");
  });

  it("no flight event leaves the state exactly where it was, for every type", () => {
    const payloads: Partial<Record<LayoverEventType, Record<string, unknown>>> = {
      "flight.gate_changed": { gate: "B7" },
      "weather.condition_changed": { condition: "fog" },
      "layover.checkpoint_observed": { checkpoint: "T1" },
      "layover.return_started": {},
      "layover.airport_reentered": {},
      "mobility.route_degraded": { extraMinutes: 20 },
      "airport.immigration_wait_changed": { waitMinutes: 50 },
    };
    for (const [t, payload] of Object.entries(payloads)) {
      const e = envelope({ eventType: t as LayoverEventType, payload });
      assert.equal(disruptionAfter("SEVERE_DELAY", e), "SEVERE_DELAY", t);
    }
  });
});
