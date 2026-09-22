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
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
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
import { readFileSync } from "node:fs";
import {
  DECISION_PERSISTENCE_FLAG,
  RISK_BANDS,
  riskBandFor,
  timeBudgetRowFor,
  returnPlanRowFor,
  persistDecision,
  decisionBySnapshotId,
  decisionsForSession,
  diffDecisions,
} from "../services/layover/LayoverDecisionStore.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";

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

// ═════════════════════════════════════════════════════════════════════════════
// THE PERSISTENCE HALF — services/layover/LayoverDecisionStore.ts
// ═════════════════════════════════════════════════════════════════════════════
//
// Everything above this line tests a PROJECTION: pure functions over a record
// held in memory. Nothing above it stores anything, and until this branch
// nothing in the repository did — `ledgerRowFor` was imported by exactly one
// file and that file is this one.
//
// census-layover states the consequence in five places, each with the same
// one-word reason: L5 "Nothing can be replayed", L95 "Create a new immutable
// snapshot" → `(L25)`, L190 `diff(previousSnapshotId, nextSnapshotId)` → "No
// snapshots.", L206/L207, and L209 "Nothing is certified to count."
//
// ── WHAT THESE CASES DO NOT PROVE ───────────────────────────────────────────
// They run against `fakeLayoverDb`, which models no unique index, no RLS, no
// foreign keys and no trigger. FOUR of this module's guarantees are therefore
// taken on migration 3003's word here and are NOT observed by these cases:
//
//   * the unique index on (session_id, input_hash) that makes a double-tapped
//     dashboard one row — the `already_recorded` case below STAGES a 23505
//     rather than provoking one, because this double cannot discover a
//     collision (its own header says so);
//   * the BEFORE UPDATE trigger that refuses a rewrite of a snapshot-scoped row;
//   * the CHECK that `recommended_return_by <= hard_return_by`;
//   * zero policies and zero client grants.
//
// All four WERE rehearsed, against a real PostgreSQL carrying this
// repository's own migration chain (`scripts/local-db`), before this suite was
// written. That rehearsal is not a committed test — `check:migration-ledger`
// and the four live-schema checks exit 2 in this container — so it is recorded
// as what it is: evidence from a rehearsal, not a green assertion here.

describe("§20 persistence — the flag is a refusal, not a no-op", () => {
  it("writes NOTHING and says so when the flag is absent", async () => {
    const tables: Record<string, any[]> = { feature_flags: [] };
    const db = makeLayoverDb(tables) as any;

    const out = await persistDecision(db, "user-1", "session-1", record(6, INTL));

    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.reason, "persistence_disabled");
    // The point of the case: an absent flag is not a quiet success. A caller
    // that could not tell would publish a snapshot id nothing can resolve.
    assert.equal((tables["layover_certified_computations"] ?? []).length, 0);
    assert.equal((tables["layover_time_budgets"] ?? []).length, 0);
    assert.equal((tables["layover_return_plans"] ?? []).length, 0);
  });

  it("writes NOTHING when the flag row exists and is FALSE", async () => {
    const tables: Record<string, any[]> = {
      feature_flags: [{ flag: DECISION_PERSISTENCE_FLAG, enabled: false }],
    };
    const out = await persistDecision(makeLayoverDb(tables) as any, "u", "s", record(6, INTL));
    assert.equal(out.ok, false);
    assert.equal((tables["layover_certified_computations"] ?? []).length, 0);
  });
});

describe("§20 persistence — one decision is a parent and its children", () => {
  const on = () =>
    ({ feature_flags: [{ flag: DECISION_PERSISTENCE_FLAG, enabled: true }] }) as Record<string, any[]>;

  it("stores the computation, its time budget and its return plan under ONE snapshot id", async () => {
    const tables = on();
    const r = record(6, INTL);
    const out = await persistDecision(makeLayoverDb(tables) as any, "user-1", "session-1", r);

    assert.equal(out.ok, true);
    assert.equal(out.ok === true && out.state, "recorded");
    assert.deepEqual(out.ok === true ? out.unwritten : null, []);

    const expected = snapshotIdFor("session-1", r.inputHash);
    assert.equal(out.ok === true && out.snapshotId, expected);
    assert.equal(tables["layover_certified_computations"][0].snapshot_id, expected);
    assert.equal(tables["layover_time_budgets"][0].snapshot_id, expected);
    assert.equal(tables["layover_return_plans"][0].snapshot_id, expected);
  });

  it("the parent payload carries the five §20 columns `ledgerRowFor` cannot send", async () => {
    const tables = on();
    await persistDecision(makeLayoverDb(tables) as any, "user-1", "session-1", record(6, INTL));
    const row = tables["layover_certified_computations"][0];
    for (const col of LEDGER_MISSING_COLUMNS) {
      assert.ok(col.column in row, `${col.column} must be in the post-3003 payload`);
    }
    // …and `ledgerRowFor` itself is UNCHANGED, which is what keeps a pre-3003
    // database writable if anything ever writes to one.
    const narrow = ledgerRowFor("user-1", "session-1", record(6, INTL));
    for (const col of LEDGER_MISSING_COLUMNS) {
      assert.ok(!(col.column in narrow), `${col.column} must stay OUT of ledgerRowFor`);
    }
  });

  it("a 23505 on the parent is ALREADY RECORDED, which is success", async () => {
    const tables = on();
    const db = makeLayoverDb(tables, {
      failures: { "layover_certified_computations:insert": { code: "23505", message: "duplicate key" } },
    }) as any;

    const out = await persistDecision(db, "user-1", "session-1", record(6, INTL));

    assert.equal(out.ok, true);
    assert.equal(out.ok === true && out.state, "already_recorded");
    // The children are NOT re-written: the identical computation already has
    // them, and 3003's immutability trigger would refuse an update.
    assert.equal((tables["layover_time_budgets"] ?? []).length, 0);
  });

  it("a parent failure writes NO child and is NOT success", async () => {
    const tables = on();
    const db = makeLayoverDb(tables, {
      failures: { "layover_certified_computations:insert": { message: "connection reset" } },
    }) as any;

    const out = await persistDecision(db, "user-1", "session-1", record(6, INTL));

    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.reason, "write_failed");
    assert.equal((tables["layover_time_budgets"] ?? []).length, 0);
    assert.equal((tables["layover_return_plans"] ?? []).length, 0);
  });

  it("A PARTIAL WRITE IS `write_unconfirmed` AND NAMES THE MISSING HALF", async () => {
    const tables = on();
    const db = makeLayoverDb(tables, {
      failures: { "layover_time_budgets:insert": { message: "relation does not exist" } },
    }) as any;

    const out = await persistDecision(db, "user-1", "session-1", record(6, INTL));

    assert.equal(out.ok, true, "the parent DID land and saying otherwise would be a second lie");
    assert.equal(out.ok === true && out.state, "write_unconfirmed");
    assert.deepEqual(out.ok === true ? out.unwritten : null, ["time_budget"]);
    // The return plan still went, because it does not depend on the budget.
    assert.equal(tables["layover_return_plans"].length, 1);
  });
});

describe("§20 L23 — a NULL is a measurement and a ZERO is a claim", () => {
  it("the terms this engine does not model separately are NULL, never 0", () => {
    const row = timeBudgetRowFor("snap:x", "session-1", record(6, INTL)) as Record<string, unknown>;
    // L46: deplane + immigration + baggage + exit friction are ONE lumped
    // figure, and security/boarding/transfer/contingency live inside two other
    // lumps. A 0 in any of these would record that somebody measured the term
    // and found it instant. Nobody measured it.
    for (const col of [
      "deplane_min", "immigration_min", "baggage_min",
      "security_min", "transfer_min", "boarding_min", "contingency_min",
    ]) {
      assert.equal(row[col], null, `${col} must be NULL (not modelled), never 0 (measured zero)`);
    }
    // The lump itself IS written, in the column whose name it matches.
    assert.equal(row.exit_min, record(6, INTL).envelope.exitDelayMin);
    assert.equal(typeof row.total_buffer_min, "number");
    assert.equal(row.usable_minutes, record(6, INTL).envelope.usableMinutes);
  });

  it("no stored term is re-derived: every written number is the engine's own", () => {
    const r = record(6, INTL);
    const row = timeBudgetRowFor("snap:x", "session-1", r) as Record<string, unknown>;
    assert.equal(row.scheduled_minutes, r.envelope.totalMinutes);
    assert.equal(row.total_buffer_min, r.deadline.breakdown.totalBuffer);
    assert.equal(row.buffer_percentile, r.inputs.bufferPercentile);
    assert.equal(row.computed_at, r.computedAt);
  });
});

describe("§4.1 L36 — the risk band is a relabelling and never reads a preference", () => {
  it("`stay_airside` is a PREFERENCE and yields NO band at all", () => {
    // `wantsToLeave: false` is the ONLY producer of `stay_airside`, and it is
    // returned before any window is consulted. A traveller who ticked "I'll
    // stay at the airport" has not been assessed — for low risk OR for high.
    const r = record(9, { ...INTL, wantsToLeave: false });
    assert.equal(r.verdict, "stay_airside");
    assert.equal(
      riskBandFor(r),
      null,
      "a preference became a risk certification — this is exactly the L36 divergence",
    );
  });

  it("but a session with NO WINDOW is UNSAFE even when the traveller elected to stay", () => {
    // THIS CASE EXISTS BECAUSE A MUTATION SURVIVED WITHOUT IT. The version
    // above passed against an implementation that returned ONE CONSTANT for
    // every stay-airside session, because `≠ LOW` cannot tell a constant from
    // a decision. A pair that must differ can.
    //
    // The shortfall arithmetic never reads `wantsToLeave`, so it is a real
    // assessment and it applies to everyone.
    const noWindow = record(2, { ...INTL, wantsToLeave: false });
    assert.equal(noWindow.verdict, "stay_airside");
    assert.notEqual(noWindow.envelope.temporalConflict, null);
    assert.equal(riskBandFor(noWindow), "UNSAFE");

    const roomy = record(9, { ...INTL, wantsToLeave: false });
    assert.notEqual(
      riskBandFor(roomy),
      riskBandFor(noWindow),
      "two stay-airside sessions with materially different windows got the same answer — the band is a constant, not an assessment",
    );
  });

  it("POSITIVE CONTROL: `windowOnly.rating` could NOT have served as the band", () => {
    // Recorded as a test rather than only as a comment, because "read the
    // preference-free rating instead" is the obvious next idea and it does not
    // work: the engine applies the preference to that rating too.
    for (const hours of [2, 4, 6, 9, 14]) {
      assert.equal(
        record(hours, { ...INTL, wantsToLeave: false }).windowOnly.rating,
        "airport_only",
        "if this ever varies, `windowOnly.rating` becomes a candidate for the band and riskBandFor should be revisited",
      );
    }
  });

  it("a nine-hour international layover the engine says YES to is LOW", () => {
    const r = record(9, INTL);
    assert.equal(r.verdict, "yes");
    assert.equal(riskBandFor(r), "LOW");
  });

  it("a layover the engine refuses is UNSAFE, so L50's invariant is statable", () => {
    const r = record(2, INTL);
    assert.ok(r.verdict === "no" || r.envelope.temporalConflict !== null);
    assert.equal(riskBandFor(r), "UNSAFE");
  });

  it("POSITIVE CONTROL: the band is not constant across the corpus", () => {
    const bands = new Set([
      riskBandFor(record(9, INTL)),
      riskBandFor(record(2, INTL)),
      riskBandFor(record(9, { ...INTL, wantsToLeave: false })),
    ]);
    assert.ok(bands.size >= 2, `a constant band reports nothing; saw ${[...bands].join(",")}`);
  });

  it("the return plan never states a recommended return AFTER the hard return", () => {
    // 3003 enforces this as a CHECK. Asserted here too because the CHECK is not
    // observable against this double, and a payload that violated it would fail
    // the whole insert the day the migration lands.
    for (const hours of [2, 4, 6, 9, 14]) {
      const r = record(hours, INTL);
      const row = returnPlanRowFor("snap:x", "s", r) as Record<string, string>;
      assert.ok(
        Date.parse(row.recommended_return_by) <= Date.parse(row.hard_return_by),
        `recommended > hard at ${hours}h — 3003's CHECK would reject this row`,
      );
      assert.ok((RISK_BANDS as readonly string[]).includes(row.risk_band));
    }
  });
});

describe("§20 persistence — every read refuses rather than reporting absence", () => {
  const on = () =>
    ({ feature_flags: [{ flag: DECISION_PERSISTENCE_FLAG, enabled: true }] }) as Record<string, any[]>;

  it("a failed single read is `read_failed`, NEVER a null record", async () => {
    const db = makeLayoverDb(on(), {
      failures: { "layover_certified_computations:select": { message: "timeout" } },
    }) as any;
    const out = await decisionBySnapshotId(db, "snap:whatever");
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.reason, "read_failed");
  });

  it("a failed history read is `read_failed`, NEVER an empty history", async () => {
    const db = makeLayoverDb(on(), {
      failures: { "layover_certified_computations:select": { message: "timeout" } },
    }) as any;
    const out = await decisionsForSession(db, "session-1");
    assert.equal(out.ok, false);
    // "You were never told anything" and "we could not read what you were
    // told" must not produce the same screen.
    assert.ok(!("value" in out));
  });

  it("a MEASURED absence is `ok: true` with null, and is a different answer", async () => {
    const out = await decisionBySnapshotId(makeLayoverDb(on()) as any, "snap:missing");
    assert.equal(out.ok, true);
    assert.equal(out.ok === true ? out.value : "unread", null);
  });

  it("a stored row that will not replay is a FAILED read, not an absent one", async () => {
    const tables = on();
    tables["layover_certified_computations"] = [
      {
        session_id: "session-1",
        snapshot_id: "snap:corrupt",
        engine_version: "x",
        input_hash: "sha256:" + "0".repeat(64),
        computed_at: new Date(NOW).toISOString(),
        inputs: { not: "a valid input set" },
      },
    ];
    const out = await decisionBySnapshotId(makeLayoverDb(tables) as any, "snap:corrupt");
    assert.equal(out.ok, false, "an unreplayable row must not be served");
  });

  it("a row whose inputs REPLAY FINE but disagree with the stored hash is refused", async () => {
    // THIS CASE EXISTS BECAUSE A MUTATION SURVIVED WITHOUT IT. The case above
    // is caught by the try/catch — its `inputs` are garbage and
    // `replayFeasibility` throws — so deleting the hash-agreement check left
    // the suite green. This row's inputs are VALID and replay cleanly; only the
    // hash comparison can catch it.
    //
    // It is the shape that matters: a row whose stored identity does not match
    // the inputs beside it is a row where somebody edited one of the two, and
    // serving it would answer with a record that disagrees with its own id.
    const tables = on();
    const r = record(6, INTL);
    await persistDecision(makeLayoverDb(tables) as any, "user-1", "session-1", r);
    tables["layover_certified_computations"][0].input_hash = "sha256:" + "a".repeat(64);

    const out = await decisionBySnapshotId(
      makeLayoverDb(tables) as any,
      snapshotIdFor("session-1", r.inputHash),
    );
    assert.equal(out.ok, false, "a row that disagrees with its own input hash must not be served");
  });

  it("round trips a stored computation back to a full DecisionRecord by REPLAY", async () => {
    const tables = on();
    const r = record(6, INTL);
    await persistDecision(makeLayoverDb(tables) as any, "user-1", "session-1", r);

    const out = await decisionBySnapshotId(
      makeLayoverDb(tables) as any,
      snapshotIdFor("session-1", r.inputHash),
    );
    assert.equal(out.ok, true);
    const stored = out.ok === true ? out.value : null;
    assert.notEqual(stored, null);
    // All NINE DecisionResult members survive, including the four that have no
    // column — which is the whole reason the read replays instead of mapping.
    const expected = decisionRecordFor("session-1", r);
    assert.deepEqual(stored === null ? null : stored.result, expected.result);
    assert.deepEqual(stored === null ? null : stored.rulesApplied, expected.rulesApplied);
  });
});

describe("§11.1 L190 — diff(previousSnapshotId, nextSnapshotId)", () => {
  it("a clock tick alone is NOT a material change", () => {
    const a = decisionRecordFor("s", certifySessionFeasibility(airport(), session(9, INTL), { nowMs: NOW }));
    const b = decisionRecordFor(
      "s",
      certifySessionFeasibility(airport(), session(9, INTL), { nowMs: NOW + 1000 }),
    );
    const d = diffDecisions(a, b);
    assert.ok(d.changed.includes("computedAt"));
    // L98/L99: notifying because a second passed is the spam the spec forbids.
    assert.equal(d.materiallyChanged, false);
  });

  it("a changed verdict IS material and names the field", () => {
    const roomy = decisionRecordFor("s", record(9, INTL));
    const tight = decisionRecordFor("s", record(2, INTL));
    const d = diffDecisions(roomy, tight);
    assert.equal(d.materiallyChanged, true);
    assert.ok(d.changed.includes("result.verdict"));
    assert.ok(d.changed.includes("result.usableMinutes"));
    assert.equal(d.previousSnapshotId, roomy.snapshotId);
    assert.equal(d.nextSnapshotId, tight.snapshotId);
  });

  it("reports reason codes gained and lost, separately and sorted", () => {
    const roomy = decisionRecordFor("s", record(9, INTL));
    const tight = decisionRecordFor("s", record(2, INTL));
    const d = diffDecisions(roomy, tight);
    assert.ok(d.reasonCodesAdded.includes("INSUFFICIENT_USABLE_TIME"));
    assert.deepEqual(d.reasonCodesAdded, [...d.reasonCodesAdded].sort());
    assert.ok(!d.reasonCodesAdded.some((c) => d.reasonCodesRemoved.includes(c)));
  });

  it("POSITIVE CONTROL: an identical pair changes nothing at all", () => {
    const a = decisionRecordFor("s", record(6, INTL));
    const d = diffDecisions(a, decisionRecordFor("s", record(6, INTL)));
    assert.deepEqual(d.changed, []);
    assert.equal(d.materiallyChanged, false);
  });
});

describe("§20 — migration 3003 and LEDGER_MISSING_COLUMNS cannot drift", () => {
  const sql = () =>
    readFileSync(
      new URL("../migrations/3003_layover_decision_record_and_operational_tables.sql", import.meta.url),
      "utf8",
    );

  it("3003 contains every DDL string the module declares it needs", () => {
    const text = sql().replace(/\s+/g, " ");
    for (const col of LEDGER_MISSING_COLUMNS) {
      // The snapshotId entry's `ddl` is two statements joined by "; ";
      // compare each so whitespace between them is not load-bearing.
      for (const stmt of col.ddl.split(";").map((s) => s.trim()).filter(Boolean)) {
        assert.ok(
          text.includes(stmt.replace(/\s+/g, " ")),
          `migration 3003 is missing the DDL LEDGER_MISSING_COLUMNS declares for ${col.field}:\n  ${stmt}`,
        );
      }
    }
  });

  it("3003 creates the five §4 tables the census records as absent", () => {
    const text = sql();
    for (const t of [
      "layover_constraints", "layover_time_budgets", "layover_return_plans",
      "layover_checkpoints", "layover_outcomes",
    ]) {
      assert.match(text, new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`), `3003 must create ${t}`);
    }
    // It must NOT create a second snapshot table beside 2700's, which is the
    // L1/L2 "two surfaces own one answer" defect in schema form.
    assert.ok(
      !/CREATE TABLE IF NOT EXISTS layover_snapshots\b/.test(text),
      "3003 must not fork `layover_certified_computations` with a second snapshot table",
    );
  });

  it("3003 seeds the gate OFF and can never flip an operator's TRUE back", () => {
    // Comments are stripped first: this file's prose quotes an INSERT, an
    // UPDATE and the flag name, and a check that reads its own documentation is
    // a check that can be satisfied by deleting a sentence.
    const body = sql().replace(/^\s*--.*$/gm, "");

    // THIS CASE ASSERTED THE OPPOSITE WHEN IT WAS FIRST WRITTEN. The reasoning
    // was that `isFlagEnabled` reads an absent row as FALSE, so a row is
    // redundant. `check:flag-polarity` refused it — "PHANTOM FLAG … false,
    // forever, UN-FLIPPABLE … It cannot be turned on without shipping a
    // migration first" — and that argument is better: step 5 of this
    // migration's own deployment sequence says "flip the flag", and without a
    // row there is nothing to flip except a hand-written INSERT that the
    // audited toggle path never sees.
    assert.match(
      body,
      /INSERT INTO\s+public\.feature_flags[\s\S]*'layover_decision_persistence_enabled',\s*false/i,
      "3003 must seed the gate, and seed it FALSE",
    );
    assert.match(
      body,
      /ON CONFLICT \(flag\) DO NOTHING/i,
      "the seed must be ON CONFLICT DO NOTHING, or a re-run turns an enabled feature off under its operator",
    );
    assert.equal(
      body.match(/ON CONFLICT/gi)?.length,
      body.match(/INSERT INTO/gi)?.length,
      "every INSERT in this migration must carry an ON CONFLICT clause",
    );
  });

  it("3003 alters and deletes NO existing row", () => {
    const body = sql().replace(/^\s*--.*$/gm, "");
    // The data-preservation requirement, as the only thing a file-level check
    // can actually observe. It was also rehearsed behaviourally against a real
    // PostgreSQL: a row written before the migration hashed identically over
    // its original 19 columns afterwards.
    assert.ok(
      !/(^|\n)\s*UPDATE\s+/i.test(body),
      "3003 must not UPDATE any row",
    );
    assert.ok(
      !/(^|\n)\s*DELETE\s+FROM/i.test(body),
      "3003 must not DELETE any row",
    );
    // The only INSERT is the flag seed. Any other is a backfill, and a backfill
    // here would mint snapshot ids for computations that never happened.
    const inserts = body.match(/INSERT INTO\s+[^\s(]+/gi) ?? [];
    assert.deepEqual(
      inserts.map((s) => s.replace(/INSERT INTO\s+/i, "")),
      ["public.feature_flags"],
      "the flag seed must be the ONLY insert in this migration",
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// THE CONSUMER — GET /api/airport/sessions/:id/safety
// ═════════════════════════════════════════════════════════════════════════════
//
// A store with no caller is a store that census-layover would score exactly as
// it scored the thing it replaces: built and unreachable. `ledgerRowFor` sat
// with no production caller for two censuses.
//
// `GET /:id/safety` is the one handler that publishes the SESSION's overall
// certified answer, so it is where the answer is written down. The cases below
// pin three properties of that wiring, and the third is the one that matters
// most:
//
//   1. the snapshot id travels WITH the answer (Appendix C5 / L296);
//   2. the flag decides whether anything is stored, and the wire SAYS which;
//   3. A LEDGER FAILURE MUST NOT COST THE TRAVELLER THE ANSWER. The deadline is
//      the safety-critical output; the record of it is not. An endpoint that
//      503s because it could not write its own audit trail has inverted that.

describe("§20 — the safety endpoint records what it told the traveller", () => {
  let server: http.Server;
  let base: string;
  const TOKEN = "ledger-token";
  const USER_ID = "ledger-user";

  const get = (path: string): Promise<{ status: number; body: any }> =>
    new Promise((resolve, reject) => {
      const url = new URL(path, base);
      const r = http.request(
        {
          hostname: url.hostname, port: Number(url.port), path: url.pathname,
          method: "GET", headers: { authorization: `Bearer ${TOKEN}` },
        },
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

  function stage(
    flags: Array<{ flag: string; enabled: boolean }>,
    failures: Record<string, { message: string; code?: string }> = {},
  ) {
    const tables: Record<string, any[]> = {
      feature_flags: [
        { flag: "airport_mode_enabled", enabled: true },
        { flag: "layover_safety_engine_enabled", enabled: true },
        ...flags,
      ],
      airport_profiles: [airportRow()],
      layover_sessions: [sessionRow({ user_id: USER_ID, id: "session-1" })],
      layover_events: [],
      layover_plan_stops: [],
      trip_plan_items: [],
    };
    _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: USER_ID }, failures }), true);
    return tables;
  }

  before(() => {
    const app = express();
    app.use(express.json());
    app.use((r: any, _res: any, next: any) => {
      r.log = { error() {}, info() {}, warn() {}, debug() {} };
      next();
    });
    app.use("/api", airportRouter);
    return new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as any).port}`;
        resolve();
      });
    });
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("publishes a snapshot id derived from the SAME function the store writes", async () => {
    stage([{ flag: DECISION_PERSISTENCE_FLAG, enabled: true }]);
    const r = await get("/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 200);
    // Not a shape check: the id must be `snapshotIdFor(sessionId, inputHash)`
    // over the very hash this response published, so the wire and the ledger
    // cannot name two different computations.
    assert.equal(r.body.snapshotId, snapshotIdFor("session-1", r.body.certification.inputHash));
    assert.match(r.body.snapshotId, /^snap:[0-9a-f]{32}$/);
  });

  it("with the flag ON, the computation and both children are stored under that id", async () => {
    const tables = stage([{ flag: DECISION_PERSISTENCE_FLAG, enabled: true }]);
    const r = await get("/api/airport/sessions/session-1/safety");

    assert.equal(r.body.persisted.state, "recorded");
    assert.equal(tables["layover_certified_computations"].length, 1);
    assert.equal(tables["layover_certified_computations"][0].snapshot_id, r.body.snapshotId);
    assert.equal(tables["layover_time_budgets"][0].snapshot_id, r.body.snapshotId);
    assert.equal(tables["layover_return_plans"][0].snapshot_id, r.body.snapshotId);
    // The stored deadline is the PUBLISHED one. Two derivations of one deadline
    // is the defect `9c26efba` closed; storing a third would reopen it.
    assert.equal(
      tables["layover_return_plans"][0].hard_return_by,
      r.body.hardReturnTime,
    );
  });

  it("with the flag OFF the answer is unchanged and the wire says NOT STORED", async () => {
    const tables = stage([]);
    const r = await get("/api/airport/sessions/session-1/safety");

    assert.equal(r.status, 200);
    assert.ok(typeof r.body.hardReturnTime === "string", "the traveller still gets their deadline");
    assert.equal(r.body.persisted.state, "not_stored");
    assert.equal(r.body.persisted.reason, "persistence_disabled");
    assert.equal((tables["layover_certified_computations"] ?? []).length, 0);
  });

  it("A LEDGER OUTAGE DOES NOT COST THE TRAVELLER THEIR DEADLINE", async () => {
    stage(
      [{ flag: DECISION_PERSISTENCE_FLAG, enabled: true }],
      { "layover_certified_computations:insert": { message: "relation does not exist" } },
    );
    const r = await get("/api/airport/sessions/session-1/safety");

    // The specific failure staged here is the one a mis-sequenced deployment
    // produces: the flag is on and migration 3003 is not applied. 3003's header
    // gives the sequence that prevents it; this case says what happens if
    // somebody runs it out of order anyway.
    assert.equal(r.status, 200, "an unwritable ledger must not become a 5xx on the safety answer");
    assert.equal(r.body.persisted.state, "not_stored");
    assert.equal(r.body.persisted.reason, "write_failed");
    assert.ok(typeof r.body.hardReturnTime === "string");
    assert.equal(typeof r.body.usableMinutes, "number");
    // And the id is still published, because it is a function of the inputs and
    // is well-defined whether or not anything stored it.
    assert.equal(r.body.snapshotId, snapshotIdFor("session-1", r.body.certification.inputHash));
  });

  it("a read failure on the immutability probe is NOT reported as stored", async () => {
    stage(
      [{ flag: DECISION_PERSISTENCE_FLAG, enabled: true }],
      { "layover_certified_computations:select": { message: "timeout" } },
    );
    const r = await get("/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 200);
    assert.equal(r.body.persisted.state, "not_stored");
    assert.equal(r.body.persisted.reason, "read_failed");
  });

  it("two identical requests do not claim two snapshots", async () => {
    const tables = stage([{ flag: DECISION_PERSISTENCE_FLAG, enabled: true }]);
    const first = await get("/api/airport/sessions/session-1/safety");
    const second = await get("/api/airport/sessions/session-1/safety");

    // The clock moves between the two, and `nowMs` is a named input, so the two
    // requests legitimately differ — that is `layoverLedger`'s own note. What
    // must NOT happen is one session growing an unbounded ledger from a single
    // screen being open: `compactLedger` is the bound, and this case records
    // that the bound is NOT YET APPLIED by any caller.
    assert.equal(first.body.persisted.state, "recorded");
    assert.ok(["recorded", "already_recorded"].includes(second.body.persisted.state));
    assert.ok(
      tables["layover_certified_computations"].length <= 2,
      "one screen must not write more rows than it made requests",
    );
  });
});
