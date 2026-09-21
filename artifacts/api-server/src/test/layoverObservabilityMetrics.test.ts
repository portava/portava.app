/**
 * §20 L208–L217 — the ten named layover metrics.
 *
 * The census scores one of them BUILT-BUT-WRONG ("the number is derivable by
 * query — but no metric is emitted, aggregated or reported anywhere") and the
 * other nine NOT-BUILT, each with a one-line reason of the form "there is no X
 * to count".
 *
 * ── THE ONE RULE THIS FILE ENFORCES ABOVE ALL OTHERS ─────────────────────────
 * A METRIC WHOSE INPUT DOES NOT EXIST MUST REPORT `null`, NEVER `0`.
 *
 * `replan_rate: 0` and `replan_rate: unproducible` look identical on a
 * dashboard and mean opposite things: the first says the replanner ran and
 * never replanned, the second says there is no replanner. Reporting the second
 * as the first is the fabricated-certainty Appendix C1 forbids, applied to
 * observability — and it is worse there than anywhere else, because the whole
 * point of a metric is to be believed without being re-derived.
 *
 * So `computeLayoverMetrics` returns `{ value: null, status: "UNPRODUCIBLE",
 * blockedBy: <the exact missing artifact> }` for six of the ten, and the
 * positive controls below fail if any of them ever quietly becomes a zero.
 *
 * ── THE OTHER POSITIVE CONTROL ───────────────────────────────────────────────
 * Every metric that IS producible must MOVE when its own input moves. A metric
 * computed from a field nothing varies is a constant with a name, and a suite
 * that only ever feeds it one corpus cannot tell the difference.
 *
 * Run: node --import tsx/esm --test src/test/layoverObservabilityMetrics.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LAYOVER_METRICS,
  LAYOVER_METRIC_NAMES,
  CRITICAL_UNKNOWN_CODES,
  computeLayoverMetrics,
  type LayoverMetricInput,
} from "../services/airport/layoverObservability.js";
import { decisionRecordFor } from "../services/airport/layoverLedger.js";
import { replayLedger } from "../services/airport/layoverReplay.js";
import {
  certifySessionFeasibility,
  feasibilityInputs,
  type FeasibilityAirport,
  type FeasibilitySession,
} from "../services/airport/LayoverFeasibility.js";

const HOUR = 3_600_000;
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
    boardingTime: null, flightType: "domestic", immigrationRequired: false,
    checkedBags: false, wantsToLeave: true,
    ...over,
  };
}

const INTL = { flightType: "international" as const, immigrationRequired: true };

function decision(
  sessionId: string,
  hours: number,
  sOver: Partial<FeasibilitySession> = {},
  aOver: Partial<FeasibilityAirport> = {},
  nowMs = NOW,
) {
  return decisionRecordFor(
    sessionId,
    certifySessionFeasibility(airport(aOver), session(hours, sOver), { nowMs }),
  );
}

function entry(sessionId: string, hours: number, sOver: Partial<FeasibilitySession> = {}) {
  return {
    sessionId,
    inputs: feasibilityInputs(airport(), session(hours, sOver), { nowMs: NOW }),
    decision: decision(sessionId, hours, sOver),
  };
}

const EMPTY: LayoverMetricInput = { events: [], decisions: [], replay: null };

// ── the vocabulary ───────────────────────────────────────────────────────────

describe("§20 L208–L217 — the metric vocabulary", () => {
  it("names exactly the ten metrics the spec lists", () => {
    assert.deepEqual([...LAYOVER_METRIC_NAMES].sort(), [
      "critical_unknown_rate",
      "decision_replay_mismatch",
      "landside_eligible_rate",
      "layover_sessions_detected",
      "layover_sessions_evaluated",
      "recommendation_contract_violation",
      "replan_rate",
      "return_warning_rate",
      "safe_return_completion_rate",
      "stale_fallback_rate",
    ]);
  });

  it("the two target-0 metrics are marked as such, and no others are", () => {
    const zeroTarget = LAYOVER_METRICS.filter((m) => m.target === 0).map((m) => m.name).sort();
    assert.deepEqual(zeroTarget, ["decision_replay_mismatch", "recommendation_contract_violation"]);
  });
});

// ── THE RULE: unproducible is null, never zero ───────────────────────────────

describe("§20 — a metric with no input reports null, not zero", () => {
  it("POSITIVE CONTROL: no metric reports a numeric 0 while being unproducible", () => {
    for (const input of [EMPTY, { events: [], decisions: [decision("s1", 6, INTL)], replay: null }]) {
      const out = computeLayoverMetrics(input);
      for (const m of out) {
        if (m.status === "UNPRODUCIBLE") {
          assert.equal(m.value, null, `${m.name} is unproducible but reports ${m.value}`);
        }
      }
    }
  });

  it("POSITIVE CONTROL: every unproducible metric names the exact artifact that is missing", () => {
    const out = computeLayoverMetrics(EMPTY);
    const blocked = out.filter((m) => m.status === "UNPRODUCIBLE");
    assert.ok(blocked.length >= 4, "if nothing is blocked, this file is measuring a tree it does not describe");
    for (const m of blocked) {
      assert.ok(m.blockedBy && m.blockedBy.length > 20, `${m.name} is blocked by "${m.blockedBy}"`);
      // A reason has to point at something checkable: a table, a column, an
      // enum literal or a named module. "not implemented" is not a reason.
      assert.match(
        m.blockedBy!,
        /layover_[a-z_]+|\.ts|event_type|snapshot_id/,
        `${m.name}'s blockedBy names nothing checkable: ${m.blockedBy}`,
      );
    }
  });

  it("the four the census scored NOT-BUILT for a schema reason are still blocked", () => {
    const out = computeLayoverMetrics({
      events: [{ sessionId: "s1", eventType: "session_created", at: new Date(NOW).toISOString() }],
      decisions: [decision("s1", 6, INTL)],
      replay: null,
    });
    const by = (n: string) => out.find((m) => m.name === n)!;
    assert.equal(by("replan_rate").status, "UNPRODUCIBLE");
    assert.equal(by("safe_return_completion_rate").status, "UNPRODUCIBLE");
    assert.equal(by("recommendation_contract_violation").status, "UNPRODUCIBLE");
    // …and each says why, in terms of the schema.
    assert.match(by("replan_rate").blockedBy!, /event_type/);
    assert.match(by("recommendation_contract_violation").blockedBy!, /snapshot_id/);
  });
});

// ── the producible ones, each proved to MOVE ─────────────────────────────────

describe("§20 L208 — layover_sessions_detected counts distinct sessions", () => {
  const ev = (sessionId: string, eventType: string) => ({
    sessionId, eventType, at: new Date(NOW).toISOString(),
  });

  it("counts a session once however many creation events it has", () => {
    const out = computeLayoverMetrics({
      events: [ev("s1", "session_created"), ev("s1", "session_created"), ev("s2", "session_created")],
      decisions: [], replay: null,
    });
    const m = out.find((x) => x.name === "layover_sessions_detected")!;
    assert.equal(m.status, "OK");
    assert.equal(m.value, 2);
  });

  it("POSITIVE CONTROL: it moves when a session is added, and ignores other event types", () => {
    const base = computeLayoverMetrics({ events: [ev("s1", "session_created")], decisions: [], replay: null });
    const more = computeLayoverMetrics({
      events: [ev("s1", "session_created"), ev("s2", "session_created")], decisions: [], replay: null,
    });
    const noise = computeLayoverMetrics({
      events: [ev("s1", "session_created"), ev("s9", "share_toggled")], decisions: [], replay: null,
    });
    const v = (o: ReturnType<typeof computeLayoverMetrics>) =>
      o.find((x) => x.name === "layover_sessions_detected")!.value;
    assert.equal(v(base), 1);
    assert.equal(v(more), 2);
    assert.equal(v(noise), 1, "a non-creation event must not count as a detection");
  });
});

describe("§20 L209 — layover_sessions_evaluated counts CERTIFIED sessions", () => {
  it("counts sessions with a decision, not sessions that merely exist", () => {
    const out = computeLayoverMetrics({
      events: [
        { sessionId: "s1", eventType: "session_created", at: new Date(NOW).toISOString() },
        { sessionId: "s2", eventType: "session_created", at: new Date(NOW).toISOString() },
      ],
      decisions: [decision("s1", 6, INTL)],
      replay: null,
    });
    const detected = out.find((m) => m.name === "layover_sessions_detected")!;
    const evaluated = out.find((m) => m.name === "layover_sessions_evaluated")!;
    assert.equal(detected.value, 2);
    assert.equal(evaluated.value, 1);
    // The gap between them is the point of having both.
    assert.notEqual(detected.value, evaluated.value);
  });

  it("POSITIVE CONTROL: two decisions for ONE session are one evaluated session", () => {
    const out = computeLayoverMetrics({
      events: [], replay: null,
      decisions: [decision("s1", 6, INTL), decision("s1", 7, INTL)],
    });
    assert.equal(out.find((m) => m.name === "layover_sessions_evaluated")!.value, 1);
  });
});

describe("§20 L210 — critical_unknown_rate", () => {
  it("is 1.0 on this tree, and that is the finding", () => {
    const out = computeLayoverMetrics({
      events: [], replay: null,
      decisions: [decision("s1", 6, INTL), decision("s2", 2), decision("s3", 20, INTL)],
    });
    const m = out.find((x) => x.name === "critical_unknown_rate")!;
    assert.equal(m.status, "OK");
    // ENTRY_NOT_CONFIRMED is emitted for every session because nothing on this
    // tree reads entry permission (census L48). The metric is therefore pinned
    // at 1.0 and says so, rather than being suppressed for being boring: it is
    // the number that makes the gap visible on a dashboard.
    assert.equal(m.value, 1);
    assert.ok(CRITICAL_UNKNOWN_CODES.includes("ENTRY_NOT_CONFIRMED"));
  });

  it("POSITIVE CONTROL: it falls below 1 when a decision carries no critical unknown", () => {
    const clean = { ...decision("s1", 6, INTL), reasonCodes: [] };
    const out = computeLayoverMetrics({
      events: [], replay: null,
      decisions: [clean, decision("s2", 6, INTL)],
    });
    assert.equal(out.find((x) => x.name === "critical_unknown_rate")!.value, 0.5);
  });
});

describe("§20 L211 — landside_eligible_rate", () => {
  it("is the fraction of decisions whose verdict permits leaving", () => {
    const out = computeLayoverMetrics({
      events: [], replay: null,
      // 6h international = yes; 2h domestic = no.
      decisions: [decision("s1", 6, INTL), decision("s2", 2)],
    });
    const m = out.find((x) => x.name === "landside_eligible_rate")!;
    assert.equal(m.status, "OK");
    assert.equal(m.value, 0.5);
  });

  it("POSITIVE CONTROL: it goes to 0 for a corpus that is refused everywhere", () => {
    const out = computeLayoverMetrics({
      events: [], replay: null,
      decisions: [decision("s1", 2), decision("s2", 2, { checkedBags: true })],
    });
    assert.equal(out.find((x) => x.name === "landside_eligible_rate")!.value, 0);
  });
});

describe("§20 L213 — return_warning_rate", () => {
  it("counts decisions at or past RETURN_SOON", () => {
    const out = computeLayoverMetrics({
      events: [], replay: null,
      decisions: [
        decision("s1", 6, INTL),                        // NORMAL, hours to go
        decision("s2", 6, INTL, {}, NOW + 5 * HOUR),    // past the deadline
      ],
    });
    const m = out.find((x) => x.name === "return_warning_rate")!;
    assert.equal(m.status, "OK");
    assert.equal(m.value, 0.5);
  });

  it("POSITIVE CONTROL: a corpus with nobody warned is 0, and with everybody warned is 1", () => {
    const none = computeLayoverMetrics({
      events: [], replay: null, decisions: [decision("s1", 6, INTL)],
    });
    const all = computeLayoverMetrics({
      events: [], replay: null, decisions: [decision("s1", 6, INTL, {}, NOW + 5 * HOUR)],
    });
    assert.equal(none.find((x) => x.name === "return_warning_rate")!.value, 0);
    assert.equal(all.find((x) => x.name === "return_warning_rate")!.value, 1);
  });
});

describe("§20 L215 — stale_fallback_rate", () => {
  it("counts decisions whose airport numbers came from no airport row", () => {
    const out = computeLayoverMetrics({
      events: [], replay: null,
      decisions: [
        decision("s1", 6, INTL),                            // curated row
        decision("s2", 6, INTL, { id: null }),          // generic fallback
      ],
    });
    const m = out.find((x) => x.name === "stale_fallback_rate")!;
    assert.equal(m.status, "OK");
    assert.equal(m.value, 0.5);
  });

  it("POSITIVE CONTROL: the production shape — every airport generic — reports 1", () => {
    // Measured 2026-09-07: 3,206 airport_profiles rows, 0 with a non-default
    // buffer. A fallback profile is `id: null` and this is what that corpus
    // scores.
    const out = computeLayoverMetrics({
      events: [], replay: null,
      decisions: [
        decision("s1", 6, INTL, { id: null }),
        decision("s2", 4, INTL, { id: null }),
      ],
    });
    assert.equal(out.find((x) => x.name === "stale_fallback_rate")!.value, 1);
  });
});

describe("§20 L217 — decision_replay_mismatch", () => {
  it("is UNPRODUCIBLE when nothing was replayable, not a green zero", () => {
    const out = computeLayoverMetrics({ events: [], decisions: [], replay: replayLedger([]) });
    const m = out.find((x) => x.name === "decision_replay_mismatch")!;
    assert.equal(m.status, "UNPRODUCIBLE");
    assert.equal(m.value, null);
  });

  it("is 0 when a real corpus replayed clean — the target, earned", () => {
    const out = computeLayoverMetrics({
      events: [], decisions: [],
      replay: replayLedger([entry("s1", 6, INTL), entry("s2", 7, INTL)]),
    });
    const m = out.find((x) => x.name === "decision_replay_mismatch")!;
    assert.equal(m.status, "OK");
    assert.equal(m.value, 0);
  });

  it("POSITIVE CONTROL: one tampered row moves it off target", () => {
    const bad = entry("s3", 8, INTL);
    const forged = {
      ...bad,
      decision: { ...bad.decision, result: { ...bad.decision.result, usableMinutes: 1 } },
    };
    const out = computeLayoverMetrics({
      events: [], decisions: [],
      replay: replayLedger([entry("s1", 6, INTL), forged]),
    });
    const m = out.find((x) => x.name === "decision_replay_mismatch")!;
    assert.equal(m.status, "OK");
    assert.equal(m.value, 0.5);
    assert.ok(m.value! > m.target!);
  });
});

// ── the whole report ─────────────────────────────────────────────────────────

describe("§20 — the report is complete and self-describing", () => {
  it("reports all ten metrics on every call, blocked ones included", () => {
    const out = computeLayoverMetrics(EMPTY);
    assert.equal(out.length, LAYOVER_METRIC_NAMES.length);
    assert.deepEqual(out.map((m) => m.name).sort(), [...LAYOVER_METRIC_NAMES].sort());
  });

  it("POSITIVE CONTROL: a rate metric with an EMPTY denominator is unproducible, not 0", () => {
    const out = computeLayoverMetrics(EMPTY);
    for (const name of ["critical_unknown_rate", "landside_eligible_rate", "return_warning_rate", "stale_fallback_rate"]) {
      const m = out.find((x) => x.name === name)!;
      assert.equal(m.status, "UNPRODUCIBLE", `${name} divided by zero decisions and reported ${m.value}`);
      assert.equal(m.value, null);
    }
  });

  it("a counter with an empty input IS zero — nothing detected is a fact", () => {
    const out = computeLayoverMetrics(EMPTY);
    const m = out.find((x) => x.name === "layover_sessions_detected")!;
    assert.equal(m.status, "OK");
    assert.equal(m.value, 0);
  });
});
