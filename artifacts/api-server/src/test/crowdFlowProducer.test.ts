/**
 * Map spec §10 Crowd Flow — the PRODUCER half (lib/crowdFlowProducer).
 *
 * lib/mapAggregation.deriveCrowdFlow already enforces §10's four gates; these
 * tests are about the thing that decides whether those gates are being handed
 * the truth. In particular:
 *
 *   * NO ACTOR ID AND NO GROUP KEY SURVIVES. The whole serialized output of the
 *     full producer → deriveCrowdFlow pipeline is walked for sentinel ids.
 *   * NO TRAJECTORY IS RECONSTRUCTIBLE. One traveller's A→B→C chain cannot be
 *     read back out, because every edge is independently gated at k.
 *   * OBSERVED AND INFERRED STAY APART. A cause-family signal is refused at
 *     intake; attaching a cause leaves the observed half deep-equal; a cause's
 *     confidence can never exceed the observation's, nor `provisional`.
 *   * COHORT ARITHMETIC MATCHES lib/intelProjectionAggregator exactly.
 *   * THE PRODUCER REFUSES TO READ consent-scoped data it cannot publish.
 *   * EVERY UNFED §10 FAMILY CARRIES A NAMED BLOCKER. `UNFED_FAMILY_BLOCKERS`
 *     records that `arrival` and `navigation_start` are blocked by missing
 *     CAPTURE (no source anywhere declares an ORIGIN), not by a missing
 *     producer — so wiring one cannot be mistaken for closing the gap.
 *
 * Pure and offline except for the two fake-client cases.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CAUSE_ONLY_SIGNAL_FAMILIES,
  CROWD_FLOW_FLAG,
  DECLARED_BUT_UNFED_FAMILIES,
  MAX_INFERRED_CAUSE_CONFIDENCE,
  OBSERVED_SIGNAL_FAMILIES,
  SECOND_FAMILY_EVIDENCE,
  SECOND_FAMILY_PRECONDITIONS,
  SIGNAL_FAMILY_INDEPENDENCE,
  SIGNAL_MAX_AGE_MINUTES,
  UNFED_FAMILY_BLOCKERS,
  WIRED_SIGNAL_SOURCES,
  attachCauseHypotheses,
  canProduceFlow,
  deriveZoneTransitions,
  readCrowdFlowSignals,
  produceZoneTransitions,
  type MovementSignal,
} from "../lib/crowdFlowProducer.js";
import {
  CROWD_FLOW_SIGNAL_FAMILIES,
  FLOW_DENSITY_BUCKET_MINUTES,
  MIN_SIGNAL_FAMILIES,
  deriveCrowdFlow,
} from "../lib/mapAggregation.js";
import { PRIVACY_THRESHOLD_V1 } from "../lib/intelContracts.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-08-31T12:00:00.000Z");
/** 15 minutes old: past the 10-minute publication delay, inside the 30-minute window. */
const OBSERVED = new Date(NOW - 15 * 60_000).toISOString();

const ZONES = new Map<string, { lat: number; lng: number }>([
  ["zone-A", { lat: 16.05, lng: 108.22 }],
  ["zone-B", { lat: 16.07, lng: 108.24 }],
  ["zone-C", { lat: 16.09, lng: 108.26 }],
]);

/** Deliberately distinctive so a substring scan of the output cannot miss them. */
const ACTOR = (n: number) => `ACTORSENTINEL${n}xyz`;
const GROUP = (n: number) => `GROUPSENTINEL${n}xyz`;

/**
 * A cohort that CLEARS every §10 gate: 20 distinct actors in 5 equal groups
 * (share 4/20 = 0.20, exactly the ceiling), two OBSERVED signal families.
 */
function publishableCohort(
  from = "zone-A",
  to = "zone-B",
  observedAt: string = OBSERVED,
): MovementSignal[] {
  const out: MovementSignal[] = [];
  for (let i = 0; i < 20; i++) {
    out.push({
      actorId: ACTOR(i),
      groupKey: GROUP(i % 5),
      // Two families so MIN_SIGNAL_FAMILIES is satisfiable. `arrival` is
      // SYNTHETIC here, and not merely unwired: UNFED_FAMILY_BLOCKERS records it
      // as `no_declared_origin` — no source in this repository states an ORIGIN
      // for an arrival, so no producer could supply this signal as written. The
      // test exercises the derivation, not a live feed.
      family: i % 2 === 0 ? "next_stop_contribution" : "arrival",
      fromZoneId: from,
      toZoneId: to,
      observedAt,
    });
  }
  return out;
}

const derive = (signals: readonly MovementSignal[], extra: Record<string, unknown> = {}) =>
  deriveZoneTransitions(signals, { now: NOW, zoneCentroids: ZONES, ...extra });

// ── §10 source honesty ────────────────────────────────────────────────────────

describe("§10 signal families — what this repository actually feeds", () => {
  it("TWO observed families are wired, which is exactly MIN_SIGNAL_FAMILIES", () => {
    // `accepted_plan` was wired on 2026-08-31 by closing all four of the
    // blockers the prior audit recorded against it (lib/routeHopSignal). If a
    // THIRD family is ever added, this test, the module header audit and
    // SIGNAL_FAMILY_INDEPENDENCE must all be updated together.
    assert.deepEqual([...WIRED_SIGNAL_SOURCES].sort(), ["accepted_plan", "next_stop_contribution"]);
    assert.equal(WIRED_SIGNAL_SOURCES.length, MIN_SIGNAL_FAMILIES);
    assert.equal(canProduceFlow(), true);
  });

  it("EVERY wired family carries an independence case naming a residual limitation", () => {
    // The load-bearing guard on this whole change. MIN_SIGNAL_FAMILIES is only
    // worth something if each family is genuinely a separate SOURCE, and that is
    // an argument, not a name. A family appended to WIRED_SIGNAL_SOURCES with no
    // written case — or with an empty residual — fails here.
    for (const family of WIRED_SIGNAL_SOURCES) {
      const c = SIGNAL_FAMILY_INDEPENDENCE[family];
      assert.ok(c, `${family} is wired with no independence case`);
      assert.equal(c.family, family);
      assert.ok(c.derivationPath.length >= 3, `${family}: the row->hop path must be traceable`);
      for (const field of ["actorPopulation", "correlationRisk", "failureMode", "separatenessArgument"] as const) {
        assert.ok(c[field].trim().length > 80, `${family}.${field} is too thin to review`);
      }
      assert.ok(
        c.residualCorrelation.trim().length > 80,
        `${family}: a family whose author could not name ONE limitation was not examined`,
      );
      assert.ok(c.evidence.length > 0, `${family}: a claim with no evidence is an assertion`);
    }
    // ...and nothing unwired is smuggled in beside them.
    assert.deepEqual(Object.keys(SIGNAL_FAMILY_INDEPENDENCE).sort(), [...WIRED_SIGNAL_SOURCES].sort());
  });

  it("the two families do NOT share a table or a consent record", () => {
    // The prior audit's bar, in code: a second claim type on intel_observations
    // would share both, and would be one family wearing two hats.
    const a = SIGNAL_FAMILY_INDEPENDENCE.next_stop_contribution.sourceTable;
    const b = SIGNAL_FAMILY_INDEPENDENCE.accepted_plan.sourceTable;
    assert.deepEqual(a.filter((t) => b.includes(t)), [], "the families must not share a source table");
    assert.ok(a.includes("intel_contribution_consent"));
    assert.ok(!b.includes("intel_contribution_consent"), "a shared consent record would collapse them into one");
  });

  it("the unfed register names every family §10 lists but nothing produces", () => {
    // `accepted_plan` is deliberately ABSENT: its finding was deleted when the
    // family was wired, which is the friction the register exists to create.
    assert.deepEqual([...DECLARED_BUT_UNFED_FAMILIES].sort(), [
      "aggregate_presence",
      "arrival",
      "coarse_transition",
      "navigation_start",
    ]);
    assert.ok(!DECLARED_BUT_UNFED_FAMILIES.includes("accepted_plan" as never));
  });

  it("event_context is cause-only and is NOT an observed family", () => {
    assert.deepEqual([...CAUSE_ONLY_SIGNAL_FAMILIES], ["event_context"]);
    assert.ok(!OBSERVED_SIGNAL_FAMILIES.includes("event_context"));
    // Observed ∪ cause-only == §10's full list; nothing is quietly missing.
    assert.deepEqual(
      [...OBSERVED_SIGNAL_FAMILIES, ...CAUSE_ONLY_SIGNAL_FAMILIES].sort(),
      [...CROWD_FLOW_SIGNAL_FAMILIES].sort(),
    );
  });

  it("canProduceFlow needs MIN_SIGNAL_FAMILIES *observed* families, not just any two", () => {
    assert.equal(canProduceFlow(["next_stop_contribution", "event_context"]), false);
    assert.equal(canProduceFlow(["next_stop_contribution", "arrival"]), true);
  });
});

// ── WHY each family is unfed — the audit as data, not prose ───────────────────
//
// These pin the 2026-08-31 re-audit. The point is not bookkeeping: the register
// records that `arrival` and `navigation_start` are blocked by MISSING CAPTURE
// (no source row anywhere declares an ORIGIN) rather than by a missing producer.
// Anyone who flips one into WIRED_SIGNAL_SOURCES must delete a specific named
// finding here, which is exactly the friction that stops MIN_SIGNAL_FAMILIES
// becoming a rubber stamp.

describe("§10 unfed families carry a NAMED blocker, not a shrug", () => {
  it("the register covers every unfed family and nothing else", () => {
    assert.deepEqual(
      Object.keys(UNFED_FAMILY_BLOCKERS).sort(),
      [...DECLARED_BUT_UNFED_FAMILIES].sort(),
      "UNFED_FAMILY_BLOCKERS must track DECLARED_BUT_UNFED_FAMILIES exactly — a family " +
        "wired without deleting its finding, or a finding left behind, both fail here",
    );
  });

  it("every finding names a recognized blocker and real evidence", () => {
    const KNOWN: readonly string[] = [
      "table_absent", "no_producer", "no_declared_origin", "purpose_mismatch", "party_scoped",
    ];
    for (const [family, finding] of Object.entries(UNFED_FAMILY_BLOCKERS)) {
      assert.ok(KNOWN.includes(finding.blocker), `${family}: unrecognized blocker ${finding.blocker}`);
      for (const b of finding.alsoBlockedBy) {
        assert.ok(KNOWN.includes(b), `${family}: unrecognized secondary blocker ${b}`);
        assert.notEqual(b, finding.blocker, `${family}: primary blocker repeated in alsoBlockedBy`);
      }
      assert.ok(finding.evidence.length > 0, `${family}: a blocker with no evidence is an assertion`);
      for (const e of finding.evidence) {
        assert.ok(e.trim().length > 20, `${family}: evidence '${e}' is too thin to review`);
      }
    }
  });

  it("arrival and navigation_start are blocked by MISSING CAPTURE, not a missing producer", () => {
    // The load-bearing claim of the audit. Both sources are destination-only by
    // construction: canonical_events carries ONE subject and its payload
    // allow-list has no origin key. Wiring a producer onto either would not
    // produce a hop — it would produce a destination, and the origin could then
    // only come from the actor's last known position, which is the trajectory
    // reconstruction §10 forbids.
    for (const family of ["arrival", "navigation_start"] as const) {
      assert.equal(
        UNFED_FAMILY_BLOCKERS[family]?.blocker,
        "no_declared_origin",
        `${family}: if this is now feedable, the capture that supplies the ORIGIN must be named here`,
      );
    }
    // Only the two infrastructure gaps are the kind effort alone closes.
    const byBlocker = (b: string) =>
      Object.entries(UNFED_FAMILY_BLOCKERS).filter(([, f]) => f.blocker === b).map(([k]) => k).sort();
    assert.deepEqual(byBlocker("table_absent"), ["coarse_transition"]);
    // `accepted_plan` used to be the sole purpose_mismatch entry. Its purpose
    // now exists (lib/locationPurposes 'route_plan_itinerary'), so the finding
    // is gone rather than downgraded.
    assert.deepEqual(byBlocker("purpose_mismatch"), []);
  });

  it("the preconditions for a second family are stated, and none is 'add another claim type'", () => {
    assert.ok(SECOND_FAMILY_PRECONDITIONS.length >= 4);
    for (const p of SECOND_FAMILY_PRECONDITIONS) {
      assert.ok(p.trim().length > 40, `precondition '${p}' is too thin to act on`);
    }
    // A second claim type on intel_observations would share the table, the
    // consent record and the actor population — one family wearing two hats.
    assert.ok(
      SECOND_FAMILY_PRECONDITIONS.some((p) => /origin/i.test(p)),
      "the origin requirement is the whole finding; it may not be dropped",
    );
  });

  it("EVERY precondition has recorded evidence — four out of five is not satisfied", () => {
    assert.equal(
      SECOND_FAMILY_EVIDENCE.length,
      SECOND_FAMILY_PRECONDITIONS.length,
      "a precondition with no evidence entry is a precondition nobody answered",
    );
    for (let i = 0; i < SECOND_FAMILY_PRECONDITIONS.length; i++) {
      assert.equal(
        SECOND_FAMILY_EVIDENCE[i].precondition,
        SECOND_FAMILY_PRECONDITIONS[i],
        "the evidence list must stay aligned with the preconditions, in order",
      );
      assert.ok(
        SECOND_FAMILY_EVIDENCE[i].satisfiedBy.trim().length > 80,
        `precondition ${i} is answered too thinly to check`,
      );
    }
    // The preconditions themselves are the STANDING bar and must not have been
    // softened to fit the family that was wired.
    assert.ok(SECOND_FAMILY_PRECONDITIONS.some((p) => /ZONE granularity/i.test(p)));
    assert.ok(SECOND_FAMILY_PRECONDITIONS.some((p) => /consent scope/i.test(p)));
    assert.ok(SECOND_FAMILY_PRECONDITIONS.some((p) => /group_key/i.test(p)));
  });

  it("a destination-only signal cannot become a transition — the origin rule, in code", () => {
    // The register's `no_declared_origin` is not merely a note: a signal with no
    // fromZoneId is refused at intake rather than being completed from anywhere.
    const { transitions, rejected } = derive([
      {
        actorId: ACTOR(1), groupKey: GROUP(0), family: "arrival",
        fromZoneId: "", toZoneId: "zone-B", observedAt: OBSERVED,
      },
    ]);
    assert.equal(transitions.length, 0);
    assert.deepEqual(rejected.map((r) => r.reason), ["invalid_input"]);
  });
});

// ── The load-bearing privacy proof ────────────────────────────────────────────

/** Every string that appears anywhere in a JSON-serializable value. */
function allStrings(v: unknown, acc: string[] = []): string[] {
  if (typeof v === "string") acc.push(v);
  else if (Array.isArray(v)) for (const x of v) allStrings(x, acc);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      acc.push(k);
      allStrings(x, acc);
    }
  }
  return acc;
}

describe("no actor id and no group key survives into the output", () => {
  it("the FULL pipeline output contains no sentinel actor or group id", () => {
    const signals = publishableCohort();
    const { transitions, rejected } = derive(signals);
    const result = deriveCrowdFlow(transitions, { now: NOW });

    // The flow really was published — otherwise this proves nothing.
    assert.equal(result.flows.length, 1, JSON.stringify(result.rejected));

    for (const bundle of [transitions, rejected, result]) {
      const blob = JSON.stringify(bundle);
      for (let i = 0; i < 20; i++) {
        assert.ok(!blob.includes(ACTOR(i)), `actor id ${ACTOR(i)} leaked into ${blob.slice(0, 200)}`);
      }
      for (let i = 0; i < 5; i++) {
        assert.ok(!blob.includes(GROUP(i)), `group key ${GROUP(i)} leaked`);
      }
      // Belt and braces: no string anywhere carries the sentinel marker at all.
      for (const s of allStrings(JSON.parse(blob))) {
        assert.ok(!s.includes("SENTINEL"), `identifier fragment survived: ${s}`);
      }
    }
  });

  it("the transition carries counts only — no field can hold an identifier", () => {
    const [t] = derive(publishableCohort()).transitions;
    assert.equal(t.distinctActors, 20);
    assert.equal(t.distinctGroups, 5);
    assert.equal(t.maxGroupShare, 0.2);
    // The key names are a closed, count-shaped set.
    assert.deepEqual(
      Object.keys(t).sort(),
      [
        "confidence", "distinctActors", "distinctGroups", "expiresAt", "from",
        "fromZoneId", "maxGroupShare", "observedAt", "privacyClass",
        "sensitiveSubject", "signalFamilies", "to", "toZoneId", "windowMinutes",
      ],
    );
  });
});

describe("no trajectory is reconstructible", () => {
  it("one traveller's A→B→C chain cannot be read back out: the second hop dies alone", () => {
    const walker = ACTOR(99);
    const signals: MovementSignal[] = [
      // A crowd on A→B.
      ...publishableCohort("zone-A", "zone-B"),
      // ...plus one person who continues B→C. Their own party, so they do not
      // tip the A→B cohort past the single-group ceiling.
      {
        actorId: walker, groupKey: GROUP(9), family: "next_stop_contribution",
        fromZoneId: "zone-A", toZoneId: "zone-B", observedAt: OBSERVED,
      },
      {
        actorId: walker, groupKey: GROUP(9), family: "arrival",
        fromZoneId: "zone-B", toZoneId: "zone-C", observedAt: OBSERVED,
      },
    ];
    const { transitions } = derive(signals);
    const result = deriveCrowdFlow(transitions, { now: NOW });

    const published = result.flows.map((f) => f.id);
    assert.deepEqual(published, ["flow:zone-A:zone-B"]);
    // The B→C edge was derived (so it is reported), but refused at the k floor.
    const bc = result.rejected.find((r) => r.fromZoneId === "zone-B" && r.toZoneId === "zone-C");
    assert.equal(bc?.reason, "below_actor_threshold");
    assert.ok(!JSON.stringify(result.flows).includes("zone-C"));
    assert.ok(!JSON.stringify(result).includes(walker));
  });
});

// ── Cohort arithmetic (lib/intelProjectionAggregator's rules, verbatim) ───────

describe("cohort counting follows lib/intelProjectionAggregator", () => {
  it("an actor is counted ONCE however many signals they send", () => {
    const spam: MovementSignal[] = Array.from({ length: 50 }, (_, i) => ({
      actorId: ACTOR(0), groupKey: GROUP(0),
      family: i % 2 === 0 ? "next_stop_contribution" : "arrival",
      fromZoneId: "zone-A", toZoneId: "zone-B", observedAt: OBSERVED,
    }));
    const [t] = derive(spam).transitions;
    assert.equal(t.distinctActors, 1);
    assert.equal(t.distinctGroups, 1);
  });

  it("an ungrouped actor counts as a PERSON but earns zero group credit", () => {
    const signals: MovementSignal[] = Array.from({ length: 20 }, (_, i) => ({
      actorId: ACTOR(i), groupKey: null, family: "next_stop_contribution",
      fromZoneId: "zone-A", toZoneId: "zone-B", observedAt: OBSERVED,
    }));
    const [t] = derive(signals).transitions;
    assert.equal(t.distinctActors, 20);
    assert.equal(t.distinctGroups, 0);
    assert.equal(t.maxGroupShare, 0, "finite, so the gate can answer below_group_threshold");
    // ...and the gate refuses it for the right, specific reason.
    const result = deriveCrowdFlow([t], { now: NOW });
    assert.equal(result.flows.length, 0);
    assert.equal(result.rejected[0]?.reason, "below_group_threshold");
  });

  it("one large party is not a crowd — maxGroupShare denominator is the GROUPED union", () => {
    // 20 actors, 16 of them in one party, 4 spread over 4 other parties.
    const signals: MovementSignal[] = Array.from({ length: 20 }, (_, i) => ({
      actorId: ACTOR(i),
      groupKey: i < 16 ? GROUP(0) : GROUP(i - 15),
      family: i % 2 === 0 ? "next_stop_contribution" : "arrival",
      fromZoneId: "zone-A", toZoneId: "zone-B", observedAt: OBSERVED,
    }));
    const [t] = derive(signals).transitions;
    assert.equal(t.distinctActors, 20);
    assert.equal(t.distinctGroups, 5);
    assert.equal(t.maxGroupShare, 16 / 20);
    const result = deriveCrowdFlow([t], { now: NOW });
    assert.equal(result.rejected[0]?.reason, "single_group_dominates");
  });

  it("an actor in several parties does not dilute the dominant party's share", () => {
    // 5 actors, all in GROUP(0); one of them ALSO in GROUP(1..4).
    const signals: MovementSignal[] = [];
    for (let i = 0; i < 5; i++) {
      signals.push({
        actorId: ACTOR(i), groupKey: GROUP(0), family: "next_stop_contribution",
        fromZoneId: "zone-A", toZoneId: "zone-B", observedAt: OBSERVED,
      });
    }
    for (let g = 1; g < 5; g++) {
      signals.push({
        actorId: ACTOR(0), groupKey: GROUP(g), family: "arrival",
        fromZoneId: "zone-A", toZoneId: "zone-B", observedAt: OBSERVED,
      });
    }
    const [t] = derive(signals).transitions;
    // Union of grouped actors is still 5, not 9 — so the big group reads 1.0.
    assert.equal(t.maxGroupShare, 1);
  });

  it("a sensitive endpoint poisons the whole bucket (fail-closed OR)", () => {
    const signals = publishableCohort();
    signals[7] = { ...signals[7], sensitiveSubject: true };
    const [t] = derive(signals).transitions;
    assert.equal(t.sensitiveSubject, true);
    assert.equal(deriveCrowdFlow([t], { now: NOW }).rejected[0]?.reason, "sensitive_subject");
  });
});

// ── Observed vs inferred cause ────────────────────────────────────────────────

describe("§10 observed movement and inferred cause are kept apart", () => {
  it("an event_context signal is REFUSED at intake — a cause is not an observation", () => {
    const signals: MovementSignal[] = [
      ...publishableCohort(),
      {
        actorId: ACTOR(50), groupKey: GROUP(0), family: "event_context",
        fromZoneId: "zone-A", toZoneId: "zone-B", observedAt: OBSERVED,
      },
    ];
    const { transitions, rejected } = derive(signals);
    assert.ok(rejected.some((r) => r.reason === "cause_is_not_observation"));
    // It added neither a body nor a family.
    assert.equal(transitions[0].distinctActors, 20);
    assert.ok(!transitions[0].signalFamilies.includes("event_context"));
  });

  it("event_context alone can never satisfy MIN_SIGNAL_FAMILIES", () => {
    // A full, otherwise-publishable cohort on ONE observed family, with an
    // event_context signal from every one of them on top.
    const signals: MovementSignal[] = [];
    for (let i = 0; i < 20; i++) {
      const base = {
        actorId: ACTOR(i), groupKey: GROUP(i % 5),
        fromZoneId: "zone-A", toZoneId: "zone-B", observedAt: OBSERVED,
      };
      signals.push({ ...base, family: "next_stop_contribution" });
      signals.push({ ...base, family: "event_context" });
    }
    const [t] = derive(signals).transitions;
    assert.deepEqual(t.signalFamilies, ["next_stop_contribution"]);
    assert.equal(deriveCrowdFlow([t], { now: NOW }).rejected[0]?.reason, "insufficient_signal_families");
  });

  it("deriveZoneTransitions NEVER sets inferredCause", () => {
    for (const t of derive(publishableCohort()).transitions) {
      assert.equal(t.inferredCause, undefined);
    }
  });

  it("attaching a cause leaves the OBSERVED half byte-for-byte identical", () => {
    const before = derive(publishableCohort()).transitions;
    const snapshot = JSON.parse(JSON.stringify(before));
    const after = attachCauseHypotheses(before, [
      { zoneId: "zone-B", cause: "Riverside concert ends around now", basis: ["event:1234"], confidence: "strong" },
    ]);
    for (let i = 0; i < after.length; i++) {
      const { inferredCause, ...observed } = after[i];
      assert.deepEqual(JSON.parse(JSON.stringify(observed)), snapshot[i]);
      assert.ok(inferredCause, "the hypothesis should have attached");
    }
    // The inputs were not mutated either.
    assert.deepEqual(JSON.parse(JSON.stringify(before)), snapshot);
  });

  it("a cause's confidence can never exceed `provisional`, nor the observation's own band", () => {
    const [t] = derive(publishableCohort()).transitions;
    assert.equal(t.confidence, "provisional"); // two families ⇒ provisional
    const [withCause] = attachCauseHypotheses([t], [
      { zoneId: "zone-B", cause: "Concert ending", confidence: "strong" },
    ]);
    assert.equal(withCause.inferredCause?.confidence, MAX_INFERRED_CAUSE_CONFIDENCE);

    // Observation weaker than the ceiling ⇒ the observation wins.
    const weak = { ...t, confidence: "unverified" as const };
    const [w] = attachCauseHypotheses([weak], [
      { zoneId: "zone-B", cause: "Concert ending", confidence: "strong" },
    ]);
    assert.equal(w.inferredCause?.confidence, "unverified");
  });

  it("the published MapObject keeps observed and inferred in separate fields", () => {
    const transitions = attachCauseHypotheses(derive(publishableCohort()).transitions, [
      { zoneId: "zone-B", cause: "Riverside concert ends around now", basis: ["event:1234"] },
    ]);
    const [flow] = deriveCrowdFlow(transitions, { now: NOW }).flows;
    assert.equal(flow.payload.observed.cohortSize, 20);
    assert.deepEqual(flow.payload.observed.signalFamilies, ["arrival", "next_stop_contribution"]);
    assert.equal(flow.payload.inferred?.cause, "Riverside concert ends around now");
    assert.deepEqual(flow.payload.inferred?.basis, ["event:1234"]);
    // The cause text appears ONLY under `inferred`.
    assert.ok(!JSON.stringify(flow.payload.observed).includes("concert"));
  });

  it("a transition with no hypothesis has no inferred half at all", () => {
    const [flow] = deriveCrowdFlow(derive(publishableCohort()).transitions, { now: NOW }).flows;
    assert.equal(flow.payload.inferred, null);
  });

  it("dispersing / unusual are never INFERRED by the producer", () => {
    const [t] = derive(publishableCohort()).transitions;
    assert.equal(t.dispersing, undefined);
    assert.equal(t.unusual, undefined);
  });
});

// ── Freshness (§37) and geometry ──────────────────────────────────────────────

describe("freshness and geometry gates at intake", () => {
  it("a signal past the policy window contributes NOTHING to the cohort", () => {
    const stale = new Date(NOW - (SIGNAL_MAX_AGE_MINUTES + 5) * 60_000).toISOString();
    const signals = publishableCohort().map((s, i) =>
      i < 10 ? { ...s, observedAt: stale } : s,
    );
    const { transitions, rejected } = derive(signals);
    assert.equal(rejected.filter((r) => r.reason === "stale_signal").length, 10);
    assert.equal(transitions[0].distinctActors, 10);
    // ...and the thinned cohort no longer clears k.
    assert.equal(deriveCrowdFlow(transitions, { now: NOW }).flows.length, 0);
  });

  it("a future timestamp is refused — an untrusted clock buys nothing", () => {
    const { rejected } = derive([
      {
        actorId: ACTOR(0), groupKey: GROUP(0), family: "arrival",
        fromZoneId: "zone-A", toZoneId: "zone-B",
        observedAt: new Date(NOW + 60_000).toISOString(),
      },
    ]);
    assert.equal(rejected[0]?.reason, "future_signal");
  });

  it("expiresAt is set from the freshest signal, so §37 cannot leave it visually live", () => {
    const [t] = derive(publishableCohort()).transitions;
    assert.equal(
      t.expiresAt,
      new Date(Date.parse(OBSERVED) + SIGNAL_MAX_AGE_MINUTES * 60_000).toISOString(),
    );
    assert.equal(t.windowMinutes, FLOW_DENSITY_BUCKET_MINUTES);
    assert.equal(t.privacyClass, "aggregate_only");
  });

  it("a zone with no centroid yields no transition — never a sharper fallback", () => {
    const { transitions, rejected } = derive(
      publishableCohort("zone-A", "zone-UNMAPPED"),
    );
    assert.equal(transitions.length, 0);
    assert.equal(rejected.length, 20);
    assert.ok(rejected.every((r) => r.reason === "unknown_zone"));
  });

  it("a self-transition is not a transition", () => {
    const { transitions, rejected } = derive(publishableCohort("zone-A", "zone-A"));
    assert.equal(transitions.length, 0);
    assert.ok(rejected.every((r) => r.reason === "not_a_transition"));
  });

  it("signals land in separate time buckets rather than pooling across them", () => {
    const older = new Date(NOW - 75 * 60_000).toISOString(); // a different 30-min bucket
    const signals = [
      ...publishableCohort("zone-A", "zone-B", OBSERVED),
      ...publishableCohort("zone-A", "zone-B", older),
    ];
    const { transitions } = derive(signals, { maxSignalAgeMinutes: 180 });
    assert.equal(transitions.length, 2);
    assert.ok(transitions.every((t) => t.distinctActors === 20));
  });

  it("empty and malformed input are handled without throwing", () => {
    assert.deepEqual(derive([]), { transitions: [], rejected: [] });
    const { transitions, rejected } = derive([
      { actorId: "", groupKey: null, family: "arrival", fromZoneId: "zone-A", toZoneId: "zone-B", observedAt: OBSERVED },
      { actorId: ACTOR(1), groupKey: null, family: "not_a_family", fromZoneId: "zone-A", toZoneId: "zone-B", observedAt: OBSERVED },
      { actorId: ACTOR(2), groupKey: null, family: "arrival", fromZoneId: "zone-A", toZoneId: "zone-B", observedAt: "not-a-date" },
    ]);
    assert.equal(transitions.length, 0);
    assert.deepEqual(rejected.map((r) => r.reason), ["invalid_input", "unrecognized_family", "invalid_input"]);
  });
});

// ── The one I/O function ──────────────────────────────────────────────────────

/** A client that fails the test if it is touched at all. */
function forbiddenClient() {
  return {
    from() {
      assert.fail("readCrowdFlowSignals must not query when no flow could publish");
    },
  };
}

/** Minimal supabase-shaped fake: feature_flags + intel_observations + consent. */
function fakeClient(opts: {
  flagOn?: boolean;
  observations?: any[];
  consented?: string[];
  consentError?: boolean;
}) {
  const chain = (rows: any[]) => {
    const self: any = {
      select: () => self,
      eq: () => self,
      in: () => self,
      is: () => self,
      gte: () => self,
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (res: any) => res({ data: rows, error: null }),
    };
    return self;
  };
  return {
    from(table: string) {
      if (table === "feature_flags") return chain([{ enabled: opts.flagOn === true }]);
      if (table === "intel_observations") return chain(opts.observations ?? []);
      if (table === "intel_contribution_consent") {
        if (opts.consentError) {
          const self: any = {
            select: () => self, eq: () => self, in: () => self, is: () => self,
            then: (res: any) => res({ data: null, error: { message: "boom" } }),
          };
          return self;
        }
        return chain((opts.consented ?? []).map((id) => ({ user_id: id })));
      }
      assert.fail(`unexpected table read: ${table}`);
    },
  };
}

/**
 * A client serving BOTH families: intel_observations for next_stop_contribution
 * and route_plans/route_stops/route_legs for accepted_plan, each behind its OWN
 * consent table. The two consent tables being separate is the point — if one
 * record governed both, they would be one source wearing two hats.
 *
 * The stop coordinates are sentinels (16.0512345 / 108.2212345). They must be
 * resolved to zones and never appear downstream.
 */
function twoFamilyClient(observations: any[], planActors: string[]) {
  const plans = planActors.map((a, i) => ({
    id: `plan-${i}`, trip_id: `TRIPSENTINEL${i % 5}xyz`,
    accepted_by_user_id: a, accepted_at: OBSERVED, status: "active",
  }));
  const stops = plans.flatMap((p) => [
    { id: `${p.id}-a`, route_plan_id: p.id, structured_location: { label: "L", lat: 16.0512345, lng: 108.2212345 }, updated_at: null },
    { id: `${p.id}-b`, route_plan_id: p.id, structured_location: { label: "L", lat: 16.0712345, lng: 108.2412345 }, updated_at: null },
  ]);
  const legs = plans.map((p) => ({ route_plan_id: p.id, from_stop_id: `${p.id}-a`, to_stop_id: `${p.id}-b` }));

  const chain = (rows: any[]) => {
    const self: any = {
      select: () => self, eq: () => self, in: () => self, is: () => self,
      gte: () => self, not: () => self, limit: () => self,
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (res: any) => res({ data: rows, error: null }),
    };
    return self;
  };
  return {
    from(table: string) {
      if (table === "feature_flags") return chain([{ enabled: true }]);
      if (table === "intel_observations") return chain(observations);
      if (table === "intel_contribution_consent") {
        return chain(observations.map((o) => ({ user_id: o.actor_id })));
      }
      if (table === "route_plans") return chain(plans);
      if (table === "route_stops") return chain(stops);
      if (table === "route_legs") return chain(legs);
      if (table === "route_flow_contribution_consent") {
        return chain(planActors.map((a) => ({ user_id: a })));
      }
      assert.fail(`unexpected table read: ${table}`);
    },
  };
}

describe("readCrowdFlowSignals — the single I/O seam", () => {
  it("REFUSES BEFORE READING when too few families are wired", async () => {
    // Both families are wired by default now, so the refusal is exercised by
    // pinning `wired` to one. The property under test is unchanged: below
    // MIN_SIGNAL_FAMILIES no query is issued at all, because processing
    // consent-scoped data for a result that cannot publish is not free.
    const r = await readCrowdFlowSignals(forbiddenClient() as any, {
      now: NOW,
      wired: ["next_stop_contribution"],
    });
    assert.equal(r.refusal, "insufficient_wired_families");
    assert.deepEqual(r.signals, []);
    assert.deepEqual([...r.unfedFamilies], [...DECLARED_BUT_UNFED_FAMILIES]);
  });

  it("refuses when the flag is off, even once two families are wired", async () => {
    const r = await readCrowdFlowSignals(fakeClient({ flagOn: false }) as any, {
      now: NOW,
      wired: ["next_stop_contribution", "arrival"],
    });
    assert.equal(r.refusal, "flag_off");
    assert.equal(CROWD_FLOW_FLAG, "map_crowd_flow_enabled");
  });

  it("drops every actor without a valid D4 consent, and fails soft to EMPTY", async () => {
    const observations = [
      { actor_id: ACTOR(1), subject_id: "p1", zone_id: "zone-A", value: { destinationArea: "An Thuong" }, group_key: GROUP(0), observed_at: OBSERVED, expires_at: null },
      { actor_id: ACTOR(2), subject_id: "p1", zone_id: "zone-A", value: { destinationArea: "An Thuong" }, group_key: GROUP(1), observed_at: OBSERVED, expires_at: null },
    ];
    const opts = {
      now: NOW,
      wired: ["next_stop_contribution", "arrival"] as const,
      resolveZoneId: (k: string, key: string) => (k === "destination_area" ? "zone-B" : key),
    };
    const consented = await readCrowdFlowSignals(
      fakeClient({ flagOn: true, observations, consented: [ACTOR(1)] }) as any,
      opts as any,
    );
    assert.equal(consented.signals.length, 1);
    assert.equal(consented.signals[0].fromZoneId, "zone-A");
    assert.equal(consented.signals[0].toZoneId, "zone-B");

    // A consent-read failure shrinks the cohort to nothing; it can never inflate it.
    const failed = await readCrowdFlowSignals(
      fakeClient({ flagOn: true, observations, consentError: true }) as any,
      opts as any,
    );
    assert.deepEqual(failed.signals, []);
  });

  it("produceZoneTransitions surfaces the refusal instead of an unexplained empty layer", async () => {
    const r = await produceZoneTransitions(forbiddenClient() as any, {
      now: NOW,
      wired: ["next_stop_contribution"],
    });
    assert.equal(r.refusal, "insufficient_wired_families");
    assert.deepEqual(r.transitions, []);
  });

  it("the accepted_plan family refuses WITHOUT a zone resolver, and says so per family", async () => {
    // The whole-read refusal must stay null — one family declining is not the
    // same event as declining to look at all, and a caller needs to tell them
    // apart. The surviving signals then carry ONE family, so the flow gate
    // refuses the bucket: a family failure shrinks the result, never widens it.
    const r = await readCrowdFlowSignals(
      fakeClient({ flagOn: true, observations: [], consented: [] }) as any,
      { now: NOW },
    );
    assert.equal(r.refusal, null);
    assert.equal(r.familyRefusals.accepted_plan, "no_zone_resolver");
    assert.equal(r.familyRefusals.next_stop_contribution, null);
    assert.deepEqual(r.signals, []);
  });

  it("BOTH families are read, and together they publish a flow end to end", async () => {
    // The end-to-end claim, exercised rather than asserted: ten consented
    // next-move contributions and ten consented accepted plans over the same
    // edge make one 20-person, 5-party, two-family cohort that clears every §10
    // gate — and no actor id, group key or stop coordinate survives into it.
    const observations = Array.from({ length: 10 }, (_, i) => ({
      actor_id: ACTOR(i), subject_id: "p1", zone_id: "zone-A",
      value: { destinationArea: "An Thuong" }, group_key: GROUP(i % 5),
      observed_at: OBSERVED, expires_at: null,
    }));
    const planActors = Array.from({ length: 10 }, (_, i) => ACTOR(100 + i));
    const client = twoFamilyClient(observations, planActors);

    const r = await readCrowdFlowSignals(client as any, {
      now: NOW,
      resolveZoneId: (kind: string) => (kind === "destination_area" ? "zone-B" : "zone-A"),
      resolveZoneForPoint: (pt: { lat: number }) => (pt.lat < 16.06 ? "zone-A" : "zone-B"),
      groupKeyFor: (_edge: unknown, id: any) =>
        `GK:${id.kind === "crew" ? id.crewId : id.actorId}`,
    } as any);

    assert.equal(r.refusal, null);
    assert.deepEqual(r.familyRefusals, { accepted_plan: null, next_stop_contribution: null });
    assert.equal(r.signals.length, 20);
    assert.deepEqual(
      [...new Set(r.signals.map((s) => s.family))].sort(),
      ["accepted_plan", "next_stop_contribution"],
    );

    const { transitions } = derive(r.signals);
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].distinctActors, 20);
    assert.deepEqual(transitions[0].signalFamilies, ["accepted_plan", "next_stop_contribution"]);

    const result = deriveCrowdFlow(transitions, { now: NOW });
    assert.equal(result.flows.length, 1, JSON.stringify(result.rejected));
    assert.equal(result.flows[0].payload.observed.cohortSize, 20);
    assert.deepEqual(
      result.flows[0].payload.observed.signalFamilies,
      ["accepted_plan", "next_stop_contribution"],
    );
    // Two families cap the band at `provisional` — see the residual-correlation
    // finding: two SOURCES is not two independent populations.
    assert.equal(transitions[0].confidence, "provisional");

    // And the privacy proof holds across the joined path.
    const blob = JSON.stringify({ transitions, result });
    for (const s of allStrings(JSON.parse(blob))) {
      assert.ok(!s.includes("SENTINEL"), `identifier fragment survived: ${s}`);
    }
    assert.ok(!blob.includes("16.0512345"), "a stop coordinate reached the flow");
    assert.ok(!blob.includes("108.2212345"), "a stop coordinate reached the flow");
  });
});

// ── The k floor is not re-invented here ───────────────────────────────────────

describe("the producer publishes nothing the shared gate would not", () => {
  it("a cohort one person below PRIVACY_THRESHOLD_V1 does not publish", () => {
    const k = PRIVACY_THRESHOLD_V1.minUniqueActors;
    const signals = publishableCohort().slice(0, k - 1);
    const { transitions } = derive(signals);
    assert.equal(transitions[0].distinctActors, k - 1);
    const result = deriveCrowdFlow(transitions, { now: NOW });
    assert.equal(result.flows.length, 0);
    assert.equal(result.rejected[0]?.reason, "below_actor_threshold");
  });

  it("a cohort observed seconds ago is held by the publication delay", () => {
    const { transitions } = derive(publishableCohort("zone-A", "zone-B", new Date(NOW - 30_000).toISOString()));
    const result = deriveCrowdFlow(transitions, { now: NOW });
    assert.equal(result.rejected[0]?.reason, "publication_delay_not_elapsed");
  });
});
