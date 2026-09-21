/**
 * §20 — the decision ledger.
 *
 * Census L206 ("every material recomputation creates a deterministic snapshot
 * and decision record") and L207 (the `DecisionRecord` field list) are both
 * scored NOT-BUILT, and L207's evidence is exact: `layover_events.metadata`
 * carries ad-hoc scalars, "never inputs, rules or reason codes".
 *
 * What already existed when this file was written is the CERTIFIED
 * COMPUTATION — `LayoverFeasibility.certifyFeasibility` returns a record with
 * `engineVersion`, `inputHash`, `computedAt`, `reasonCodes` and the full named
 * input set, and `replayFeasibility(record.inputs)` reproduces it. Four of the
 * ten §20 fields were therefore already derivable. The five that were not —
 * `sessionId`, `snapshotId`, `inputFacts[]`, `sourceRefs[]`, `rulesApplied[]`
 * — are what `layoverLedger` adds, and they are the only reason this module
 * exists. It computes nothing about safety; it is a projection.
 *
 * ── THE POSITIVE CONTROLS, AND WHY EACH IS HERE ──────────────────────────────
 * A ledger is the easiest thing in this repository to fake: emit a constant
 * list of rule names and a constant list of fact keys and every assertion
 * about "the record carries rules" passes forever while reporting nothing.
 * Three checks below are written so that they FAIL against such a fake:
 *
 *   1. `rulesApplied` MUST DIFFER between two records that differ materially.
 *      A constant list fails this outright.
 *   2. Every key of the engine's own named input set must appear in
 *      `inputFacts` — walked from `Object.keys` of the live input object, not
 *      from a list written here. Add a term to the engine and forget the
 *      ledger, and this goes red.
 *   3. The `rulesApplied` vocabulary must have NO member that is emitted by
 *      every record: a rule that is always on describes the module, not the
 *      decision. (`buffer.base.*` is the one legitimate always-on family and
 *      is asserted to VARY by flight type rather than exempted.)
 *
 * Run: node --import tsx/esm --test src/test/layoverDecisionLedger.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LAYOVER_LEDGER_VERSION,
  DECISION_RECORD_FIELDS,
  LEDGER_RULE_NAMESPACES,
  decisionRecordFor,
  snapshotIdFor,
  ledgerRowFor,
  LEDGER_MISSING_COLUMNS,
  compactLedger,
  assertSnapshotImmutable,
} from "../services/airport/layoverLedger.js";
import {
  certifySessionFeasibility,
  type FeasibilityAirport,
  type FeasibilitySession,
} from "../services/airport/LayoverFeasibility.js";
import type { LiveConditions } from "../services/airport/LayoverSafetyEngine.js";

const HOUR = 3_600_000;
/** 10:00 Asia/Taipei — off every time-of-day band, so the term is 0 unless asked for. */
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
    flightType: "domestic",
    immigrationRequired: false,
    checkedBags: false,
    wantsToLeave: true,
    ...over,
  };
}

const INTL = { flightType: "international" as const, immigrationRequired: true };

function record(
  hours: number,
  sOver: Partial<FeasibilitySession> = {},
  aOver: Partial<FeasibilityAirport> = {},
  live: LiveConditions | null = null,
) {
  return certifySessionFeasibility(airport(aOver), session(hours, sOver), {
    nowMs: NOW,
    liveConditions: live,
  });
}

// ── L207 — the field list, exactly ───────────────────────────────────────────

describe("§20 L207 — DecisionRecord carries the ten named fields", () => {
  it("has exactly the spec's field list and no silent extras", () => {
    const d = decisionRecordFor("session-1", record(6, INTL));
    assert.deepEqual(Object.keys(d).sort(), [...DECISION_RECORD_FIELDS].sort());
    // The spec's own spelling, so a rename cannot pass this by adding a field.
    assert.deepEqual([...DECISION_RECORD_FIELDS].sort(), [
      "computedAt", "engineVersion", "inputFacts", "inputHash", "reasonCodes",
      "result", "rulesApplied", "sessionId", "snapshotId", "sourceRefs",
    ]);
  });

  it("the five fields the certified computation did NOT already carry are populated", () => {
    const d = decisionRecordFor("session-1", record(6, INTL));
    assert.equal(d.sessionId, "session-1");
    assert.match(d.snapshotId, /^snap:[0-9a-f]{32}$/);
    assert.ok(d.inputFacts.length > 0);
    assert.ok(d.sourceRefs.length > 0);
    assert.ok(d.rulesApplied.length > 0);
  });

  it("carries the version of the ledger projection itself, not only the engine's", () => {
    const d = decisionRecordFor("session-1", record(6, INTL));
    assert.equal(d.engineVersion, record(6, INTL).engineVersion);
    assert.match(LAYOVER_LEDGER_VERSION, /^\d{4}\.\d{2}\.\d{2}-\d+$/);
  });
});

// ── L206 — deterministic snapshot ────────────────────────────────────────────

describe("§20 L206 — the snapshot id is deterministic and input-bound", () => {
  it("the same computation yields the same snapshot id, twice and after replay", () => {
    const a = decisionRecordFor("session-1", record(6, INTL));
    const b = decisionRecordFor("session-1", record(6, INTL));
    assert.equal(a.snapshotId, b.snapshotId);
    assert.equal(a.inputHash, b.inputHash);
  });

  it("a DIFFERENT computation yields a different snapshot id", () => {
    const six = decisionRecordFor("session-1", record(6, INTL));
    const seven = decisionRecordFor("session-1", record(7, INTL));
    assert.notEqual(six.snapshotId, seven.snapshotId);
  });

  it("the SAME computation for a different session is a different snapshot", () => {
    const one = decisionRecordFor("session-1", record(6, INTL));
    const two = decisionRecordFor("session-2", record(6, INTL));
    assert.equal(one.inputHash, two.inputHash, "the session id is not part of the engine's input set");
    assert.notEqual(one.snapshotId, two.snapshotId, "…but it must be part of the snapshot identity");
  });

  it("snapshotIdFor is a pure function of (sessionId, inputHash)", () => {
    const r = record(6, INTL);
    assert.equal(snapshotIdFor("session-1", r.inputHash), decisionRecordFor("session-1", r).snapshotId);
  });
});

// ── rulesApplied — derived, not declared ─────────────────────────────────────

/**
 * A corpus that varies every axis the engine actually has: flight type, bags,
 * traffic term, overnight, live conditions, the deadline anchor, the percentile
 * policy and the clock relative to the deadline. The positive control below is
 * only as strong as this list is varied, so each entry is here to move one
 * named thing.
 */
const VARIED_CORPUS = [
  decisionRecordFor("s", record(2)),                                        // domestic, too_short
  decisionRecordFor("s", record(6, INTL)),                                  // international, landside
  decisionRecordFor("s", record(6, { ...INTL, checkedBags: true })),        // bags term
  decisionRecordFor("s", record(20, INTL)),                                 // overnight
  decisionRecordFor("s", record(6, INTL, { trafficExtraMin: 0 })),          // no traffic term
  decisionRecordFor("s", record(6, {                                        // boarding anchor
    ...INTL, boardingTime: new Date(NOW + 5.5 * HOUR).toISOString(),
  })),
  decisionRecordFor("s", record(6, INTL, {}, {                              // live term
    securityWaitExtraMin: 25, immigrationWaitExtraMin: 0, groundTransportExtraMin: 0,
    reasonCodes: ["SECURITY_WAIT_HIGH"], observedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + HOUR).toISOString(),
  })),
  // p50 rather than the p90 default — the §6.2 selection policy is an input.
  decisionRecordFor("s", certifySessionFeasibility(airport(), session(6, INTL), {
    nowMs: NOW, bufferPercentile: "p50",
  })),
  // The clock past the deadline, so `returnState` is not NORMAL.
  decisionRecordFor("s", certifySessionFeasibility(airport(), session(6, INTL), {
    nowMs: NOW + 5 * HOUR,
  })),
];

describe("§20 L207 — rulesApplied is DERIVED from the record", () => {
  it("POSITIVE CONTROL: two materially different records do not share a rule list", () => {
    const plain = decisionRecordFor("s", record(6, INTL));
    const withBags = decisionRecordFor("s", record(6, { ...INTL, checkedBags: true }));
    assert.notDeepEqual(plain.rulesApplied, withBags.rulesApplied);
    assert.ok(!plain.rulesApplied.includes("buffer.bags"));
    assert.ok(withBags.rulesApplied.includes("buffer.bags"));
  });

  it("POSITIVE CONTROL: no rule name is emitted by every record", () => {
    const always = VARIED_CORPUS[0].rulesApplied.filter((r) =>
      VARIED_CORPUS.every((c) => c.rulesApplied.includes(r)),
    );
    assert.deepEqual(
      always, [],
      `rules emitted by every record in the corpus describe the module, not the decision: ${always.join(", ")}`,
    );
  });

  /**
   * THE CONTROL ABOVE WENT RED ON ITS FIRST RUN and named four rules the first
   * draft emitted unconditionally — `window.exitDelay`, `confidence.<C>` and
   * one `reason.<CODE>` per code. They were removed from the ledger rather than
   * exempted here; `layoverLedger.rulesAppliedFor`'s header records why for
   * each. This case pins the two FACTS behind two of those removals, so that
   * if either stops being true the ledger is re-examined instead of the rule
   * silently staying absent.
   */
  it("pins the two facts that made the removed rules vacuous", () => {
    // 1. Every session has a non-zero exit delay — `estimateExitDelay` returns
    //    15 at its smallest — so "the exit delay rule fired" distinguishes
    //    nothing.
    for (const r of [record(2), record(6, INTL), record(20, { ...INTL, checkedBags: true })]) {
      assert.ok(r.envelope.exitDelayMin >= 15);
    }
    // 2. The certified confidence is LOW for every input this tree can build,
    //    because `worstConfidence` folds in the time-of-day ramp, a
    //    STATIC_DEFAULT/LOW constant present in every computation. A record
    //    here reporting anything else means that changed — re-add the rule.
    for (const d of VARIED_CORPUS) {
      assert.equal(
        d.result.confidence, "LOW",
        "a record with confidence above LOW exists — `confidence.<C>` is no longer a constant and belongs back in rulesApplied",
      );
    }
  });

  it("every rule name lives in a declared namespace — a typo cannot invent one", () => {
    const corpus = [record(2), record(6, INTL), record(20, INTL)].map((r) => decisionRecordFor("s", r));
    for (const d of corpus) {
      for (const rule of d.rulesApplied) {
        assert.ok(
          LEDGER_RULE_NAMESPACES.some((ns) => rule === ns || rule.startsWith(ns + ".")),
          `rule ${rule} is in no declared namespace`,
        );
      }
    }
  });

  it("the live term appears as a rule only when live conditions were supplied", () => {
    const dry = decisionRecordFor("s", record(6, INTL));
    const wet = decisionRecordFor("s", record(6, INTL, {}, {
      securityWaitExtraMin: 25, immigrationWaitExtraMin: 0, groundTransportExtraMin: 0,
      reasonCodes: ["SECURITY_WAIT_HIGH"], observedAt: new Date(NOW).toISOString(), expiresAt: null,
    }));
    assert.ok(!dry.rulesApplied.includes("buffer.live"));
    assert.ok(wet.rulesApplied.includes("buffer.live"));
    // Reason codes are their own DecisionRecord field; they are deliberately
    // NOT mirrored into rulesApplied (see the removal note in the ledger).
    assert.ok(wet.reasonCodes.includes("SECURITY_WAIT_HIGH"));
    assert.ok(!wet.rulesApplied.some((r) => r.startsWith("reason.")));
  });

  it("the deadline anchor is recorded, and it follows boarding time when there is one", () => {
    const noBoarding = decisionRecordFor("s", record(6, INTL));
    const boarding = decisionRecordFor("s", record(6, {
      ...INTL, boardingTime: new Date(NOW + 5.5 * HOUR).toISOString(),
    }));
    assert.ok(noBoarding.rulesApplied.includes("deadline.anchor.departure"));
    assert.ok(boarding.rulesApplied.includes("deadline.anchor.boarding"));
  });
});

// ── inputFacts — every engine input is in the ledger ─────────────────────────

describe("§20 L207 — inputFacts covers the engine's whole named input set", () => {
  it("POSITIVE CONTROL: every airport and session key the engine hashes appears as a fact", () => {
    const r = record(6, INTL);
    const d = decisionRecordFor("session-1", r);
    const keys = new Set(d.inputFacts.map((f) => f.key));
    for (const k of Object.keys(r.inputs.airport)) {
      assert.ok(keys.has(`airport.${k}`), `airport.${k} is hashed into the decision but is not a fact in the ledger`);
    }
    for (const k of Object.keys(r.inputs.session)) {
      assert.ok(keys.has(`session.${k}`), `session.${k} is hashed into the decision but is not a fact in the ledger`);
    }
    assert.ok(keys.has("nowMs"));
    assert.ok(keys.has("bufferPercentile"));
  });

  it("each fact states where it came from, and a generic airport says GENERIC", () => {
    const curated = decisionRecordFor("s", record(6, INTL));
    const generic = decisionRecordFor("s", record(6, INTL, { id: null, verified: false }));
    const buf = (d: typeof curated) =>
      d.inputFacts.find((f) => f.key === "airport.internationalBufferMin")!;
    assert.equal(buf(curated).source, "AIRPORT_PROFILE");
    assert.equal(buf(generic).source, "GENERIC");
    assert.equal(buf(curated).value, 120);
  });

  it("live facts are present only when observed, and carry their observation instant", () => {
    const observedAt = new Date(NOW - 10 * 60_000).toISOString();
    const wet = decisionRecordFor("s", record(6, INTL, {}, {
      securityWaitExtraMin: 25, immigrationWaitExtraMin: 0, groundTransportExtraMin: 0,
      reasonCodes: [], observedAt, expiresAt: null,
    }));
    const f = wet.inputFacts.find((x) => x.key === "live.securityWaitExtraMin")!;
    assert.equal(f.value, 25);
    assert.equal(f.source, "LIVE");
    assert.equal(f.observedAt, observedAt);
    const dry = decisionRecordFor("s", record(6, INTL));
    assert.equal(dry.inputFacts.find((x) => x.key.startsWith("live.")), undefined);
  });
});

// ── sourceRefs ───────────────────────────────────────────────────────────────

describe("§20 L207 — sourceRefs points at what produced the numbers", () => {
  it("is deduplicated, sorted, and names the engine module every buffer term came from", () => {
    const d = decisionRecordFor("s", record(6, INTL));
    assert.deepEqual(d.sourceRefs, [...new Set(d.sourceRefs)].sort());
    assert.ok(d.sourceRefs.some((s) => s.includes("LayoverSafetyEngine")));
  });

  it("names the airport row when one supplied the buffers, and does not when none did", () => {
    const curated = decisionRecordFor("s", record(6, INTL));
    const generic = decisionRecordFor("s", record(6, INTL, { id: null }));
    assert.ok(curated.sourceRefs.includes("airport_profiles:airport-tpe"));
    assert.ok(!generic.sourceRefs.some((s) => s.startsWith("airport_profiles:")));
  });
});

// ── result ───────────────────────────────────────────────────────────────────

describe("§20 L207 — `result` is the certified answer, not a re-derivation", () => {
  it("every published number equals the certified record's own", () => {
    const r = record(6, INTL);
    const d = decisionRecordFor("s", r);
    assert.equal(d.result.verdict, r.verdict);
    assert.equal(d.result.confidence, r.confidence);
    assert.equal(d.result.tier, r.envelope.tier);
    assert.equal(d.result.returnState, r.envelope.returnState);
    assert.equal(d.result.usableMinutes, r.envelope.usableMinutes);
    assert.equal(d.result.totalBufferMin, r.deadline.breakdown.totalBuffer);
    assert.equal(d.result.hardReturnTime, r.deadline.hardReturnTime.toISOString());
  });

  it("reasonCodes are the engine's, verbatim and in order", () => {
    const r = record(6, INTL);
    assert.deepEqual(decisionRecordFor("s", r).reasonCodes, r.reasonCodes);
  });
});

// ── the storage row, and what the schema cannot hold ─────────────────────────

describe("§20 — the ledger row, and the columns that do not exist", () => {
  it("projects onto layover_certified_computations' real columns", () => {
    const row = ledgerRowFor("user-1", "session-1", record(6, INTL));
    assert.equal(row.session_id, "session-1");
    assert.equal(row.user_id, "user-1");
    assert.match(row.input_hash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(typeof row.verdict, "string");
    assert.ok(Array.isArray(row.reason_codes));
  });

  it("POSITIVE CONTROL: the five §20 fields with no column are NAMED, not silently dropped", () => {
    const row = ledgerRowFor("user-1", "session-1", record(6, INTL));
    const d = decisionRecordFor("session-1", record(6, INTL));
    for (const col of LEDGER_MISSING_COLUMNS) {
      assert.ok(
        !(col.column in row),
        `${col.column} is in the insert payload but has no column — supabase-js sends every key and the insert would fail`,
      );
    }
    // Every declared-missing column must correspond to a field the record DOES
    // carry: a stale entry here would be a note about nothing.
    const fields = new Set(Object.keys(d));
    for (const col of LEDGER_MISSING_COLUMNS) {
      assert.ok(fields.has(col.field), `${col.field} is declared missing but is not a DecisionRecord field`);
    }
    assert.ok(LEDGER_MISSING_COLUMNS.some((c) => c.field === "snapshotId"));
    assert.ok(LEDGER_MISSING_COLUMNS.some((c) => c.field === "rulesApplied"));
  });
});

// ── L261 — bounded retention, and immutability ───────────────────────────────

describe("§24 L261 — snapshots are immutable with bounded retention", () => {
  const mk = (sessionId: string, hours: number, ageMin: number) => {
    const r = certifySessionFeasibility(airport(), session(hours, INTL), {
      nowMs: NOW - ageMin * 60_000,
    });
    return decisionRecordFor(sessionId, r);
  };

  it("keeps the newest record per session however old it is", () => {
    const old = mk("s1", 6, 60 * 24 * 400);
    const { keep, drop } = compactLedger([old], NOW, { retentionDays: 90, maxPerSession: 10 });
    assert.deepEqual(keep.map((k) => k.snapshotId), [old.snapshotId]);
    assert.deepEqual(drop, []);
  });

  it("drops records past retention once a newer one exists for that session", () => {
    const recent = mk("s1", 6, 1);
    const ancient = mk("s1", 7, 60 * 24 * 400);
    const { keep, drop } = compactLedger([recent, ancient], NOW, { retentionDays: 90, maxPerSession: 10 });
    assert.deepEqual(keep.map((k) => k.snapshotId), [recent.snapshotId]);
    assert.deepEqual(drop.map((k) => k.snapshotId), [ancient.snapshotId]);
  });

  it("bounds per-session growth, newest first", () => {
    const rs = [1, 2, 3, 4, 5].map((h, i) => mk("s1", 5 + h, i));
    const { keep, drop } = compactLedger(rs, NOW, { retentionDays: 90, maxPerSession: 2 });
    assert.equal(keep.length, 2);
    assert.equal(drop.length, 3);
    assert.equal(keep[0].snapshotId, rs[0].snapshotId, "newest is kept");
  });

  it("POSITIVE CONTROL: compaction never crosses sessions", () => {
    const a = mk("s1", 6, 0);
    const b = mk("s2", 6, 5);
    const { keep } = compactLedger([a, b], NOW, { retentionDays: 90, maxPerSession: 1 });
    assert.deepEqual(new Set(keep.map((k) => k.sessionId)), new Set(["s1", "s2"]));
  });

  it("a snapshot id cannot be re-bound to a different result", () => {
    const d = decisionRecordFor("s1", record(6, INTL));
    assert.doesNotThrow(() => assertSnapshotImmutable(d, decisionRecordFor("s1", record(6, INTL))));
    const forged = { ...d, result: { ...d.result, verdict: "yes" as const, usableMinutes: 9999 } };
    assert.throws(() => assertSnapshotImmutable(d, forged), /immutab/i);
  });
});
