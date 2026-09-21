/**
 * layoverLedger — the §20 decision ledger.
 *
 * Spec: docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt §20
 * (observability and decision ledger), §24 snapshot growth, §2.1 "versioned,
 * explainable and replayable".
 *
 * ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ────────────────────────────
 * THIS MODULE COMPUTES NOTHING ABOUT SAFETY. Every number it publishes is read
 * off a `LayoverFeasibilityRecord` that `LayoverFeasibility.certifyFeasibility`
 * already produced. That is the whole design constraint: a ledger that
 * re-derived a deadline would be a SECOND arithmetic for the number travellers
 * act on, which is the duplicate-buffer defect `9c26efba` closed on this
 * surface once already. A projection cannot drift from what it projects.
 *
 * ── WHY IT EXISTS WHEN THE CERTIFIED RECORD ALREADY DID ──────────────────────
 * §20's `DecisionRecord` names ten fields. The certified computation already
 * carried four of them (`engineVersion`, `inputHash`, `computedAt`,
 * `reasonCodes`) and the answer that fills a fifth (`result`). The five it did
 * not carry are the ones that make a record a LEDGER ENTRY rather than a
 * computation:
 *
 *   sessionId     which traveller's question this answered. The engine's input
 *                 set deliberately excludes it — two travellers with identical
 *                 flights are the same COMPUTATION — so it has to be supplied.
 *   snapshotId    a stable name a stored recommendation can cite, so "certified
 *                 against snapshot X" is checkable (Appendix C5 / census L296).
 *   inputFacts[]  the facts that went in, each with its provenance, so "why is
 *                 my deadline 18:40" can be answered from the row alone.
 *   sourceRefs[]  where those facts came from.
 *   rulesApplied[] which rules actually fired. DERIVED from the record — see
 *                 `rulesAppliedFor` below for why a constant list would be
 *                 worse than nothing.
 *
 * ── THERE IS NO PRODUCTION WRITER, AND THAT IS NOT AN OVERSIGHT ──────────────
 * Nothing on this tree calls `decisionRecordFor` outside tests. The two call
 * sites that would are `routes/airport.ts` and
 * `LayoverRecommendationService.ts`, neither of which this work owns, and
 * `LEDGER_MISSING_COLUMNS` records the other half of the reason: five of the
 * ten fields have no column on `layover_certified_computations` (migration
 * `src/migrations/2700_layover_certified_feasibility.sql`). supabase-js sends
 * every key of an insert payload, so a writer that named them would fail
 * outright against a database that has not been migrated — the ordering hazard
 * 2700's own header spells out. `ledgerRowFor` therefore emits ONLY columns
 * that exist, and the five that do not are declared rather than dropped.
 */
import { createHash } from "node:crypto";
import type {
  EstimateConfidence,
  LayoverFeasibilityRecord,
} from "./LayoverFeasibility.js";
import type {
  LayoverReasonCode,
  LayoverReturnState,
  LayoverTier,
  SafetyRating,
} from "./LayoverSafetyEngine.js";

/**
 * Version of THE PROJECTION, not of the arithmetic. Bump when a field's shape
 * or a rule name changes, so a stored entry can be read by the code that wrote
 * it. The engine's own version travels separately in `engineVersion`; they are
 * two different questions and collapsing them would make a rule rename look
 * like a safety change.
 *
 * History:
 *   2026.09.14-1  first ledger: the five fields the certified record lacked.
 */
export const LAYOVER_LEDGER_VERSION = "2026.09.14-1";

/**
 * §20's field list, verbatim. Exported so a test can assert the record has
 * exactly these keys — an extra field is as much a divergence as a missing one,
 * because a consumer written against the spec will not read it.
 */
export const DECISION_RECORD_FIELDS = [
  "sessionId",
  "snapshotId",
  "engineVersion",
  "inputHash",
  "inputFacts",
  "sourceRefs",
  "rulesApplied",
  "result",
  "reasonCodes",
  "computedAt",
] as const;
export type DecisionRecordField = (typeof DECISION_RECORD_FIELDS)[number];

/**
 * Where a fact came from, weakest first. Deliberately the vocabulary a
 * traveller-facing explanation needs rather than the engine's
 * `EstimateSourceClass`: the question "did anyone look at MY airport" has three
 * answers, and `AIRPORT_PROFILE` vs `GENERIC` is the one that decides whether
 * the minutes are about this airport at all.
 */
export const FACT_SOURCES = ["GENERIC", "SESSION", "AIRPORT_PROFILE", "LIVE", "POLICY"] as const;
export type FactSource = (typeof FACT_SOURCES)[number];

export interface InputFact {
  /** Dotted path into the engine's named input set, e.g. `airport.trafficExtraMin`. */
  key: string;
  value: string | number | boolean | null;
  source: FactSource;
  /** When the fact was observed. `null` for constants and for schedule fields. */
  observedAt: string | null;
}

/**
 * The certified answer, flattened. Every member is COPIED from the record; none
 * is recomputed. `hardReturnTime` is an ISO string rather than a `Date` because
 * a ledger entry is a value that gets stored and compared, and two `Date`
 * objects for the same instant are not `deepEqual`-stable across a JSON round
 * trip.
 */
export interface DecisionResult {
  verdict: LayoverFeasibilityRecord["verdict"];
  confidence: EstimateConfidence;
  tier: LayoverTier;
  returnState: LayoverReturnState;
  /** The window-only rating — the session's answer with no journey in it. */
  windowRating: SafetyRating;
  hardReturnTime: string;
  totalBufferMin: number;
  usableMinutes: number;
  /** Non-null exactly when there is no window at all (§7.2). */
  shortfallMinutes: number | null;
}

export interface DecisionRecord {
  sessionId: string;
  snapshotId: string;
  engineVersion: string;
  inputHash: string;
  inputFacts: InputFact[];
  sourceRefs: string[];
  rulesApplied: string[];
  result: DecisionResult;
  reasonCodes: LayoverReasonCode[];
  computedAt: string;
}

/**
 * The rule namespaces this ledger can emit. Exported so a test can assert that
 * every name a record carries belongs to one: it is what stops a typo becoming
 * a new rule nobody can count, which is precisely the defect Appendix A records
 * for the free-text warnings (`layover_recommendations.warning_reason` is a
 * bare TEXT, so the vocabulary is whatever anyone typed).
 */
export const LEDGER_RULE_NAMESPACES = [
  "buffer",
  "deadline",
  "window",
  "returnState",
  "verdict",
  "percentile",
  "probe",
] as const;

// ── snapshot identity ────────────────────────────────────────────────────────

/**
 * A stable name for one computation of one session.
 *
 * (sessionId, inputHash) and nothing else, so it is reproducible from a stored
 * row: replay the inputs, hash them, and the same snapshot id comes back. The
 * session id is in it because the engine's input set deliberately is not
 * session-scoped — two travellers on the same flights are one COMPUTATION and
 * must be two ledger entries. Truncated to 128 bits: this is an identity, not a
 * security boundary (the same note `feasibilityInputHash` carries).
 */
export function snapshotIdFor(sessionId: string, inputHash: string): string {
  const digest = createHash("sha256")
    .update(sessionId)
    .update("|")
    .update(inputHash)
    .digest("hex");
  return "snap:" + digest.slice(0, 32);
}

// ── inputFacts ───────────────────────────────────────────────────────────────

/**
 * Every named input, as a fact with provenance.
 *
 * WALKED FROM THE INPUT OBJECT, NOT FROM A LIST. `Object.keys` over
 * `inputs.airport` and `inputs.session` is what makes the ledger track the
 * engine: the day a new term enters `FeasibilityInputs` it enters the ledger on
 * the same commit, and the test that walks the same keys is what reports it if
 * this function is ever replaced by a hand-written list.
 *
 * Provenance rule for the airport terms: they are `AIRPORT_PROFILE` only when
 * an airport row actually supplied them. `airport.id === null` is the fallback
 * profile, whose columns are this repository's constants — calling those
 * `AIRPORT_PROFILE` would be the fabricated-specificity §2.1 forbids, and it is
 * the exact divergence census L243/L250 record (a generic-fallback airport
 * presenting identical confidence to a curated one).
 */
function inputFactsFor(record: LayoverFeasibilityRecord): InputFact[] {
  const { airport, session, liveConditions } = record.inputs;
  const facts: InputFact[] = [];
  const airportRowExists = airport.id !== null && airport.id !== undefined;
  const airportSource: FactSource = airportRowExists ? "AIRPORT_PROFILE" : "GENERIC";

  for (const key of Object.keys(airport)) {
    const value = (airport as Record<string, unknown>)[key];
    facts.push({
      key: `airport.${key}`,
      value: (value ?? null) as InputFact["value"],
      source: airportSource,
      observedAt: null,
    });
  }

  for (const key of Object.keys(session)) {
    const value = (session as Record<string, unknown>)[key];
    facts.push({
      key: `session.${key}`,
      value: (value ?? null) as InputFact["value"],
      source: "SESSION",
      observedAt: null,
    });
  }

  facts.push({ key: "nowMs", value: record.inputs.nowMs, source: "POLICY", observedAt: record.computedAt });
  facts.push({
    key: "bufferPercentile",
    value: record.inputs.bufferPercentile,
    source: "POLICY",
    observedAt: null,
  });

  // The probe is an input when there is one, and its ABSENCE is not recorded as
  // a zero — an absent probe means the landside question was not asked.
  const probe = record.inputs.landsideProbe;
  if (probe) {
    facts.push({ key: "probe.travelTimeMin", value: probe.travelTimeMin, source: "POLICY", observedAt: null });
    facts.push({ key: "probe.activityTimeMin", value: probe.activityTimeMin, source: "POLICY", observedAt: null });
    facts.push({ key: "probe.travelTimeSource", value: probe.travelTimeSource, source: "POLICY", observedAt: null });
  }

  // Live facts exist only when something was observed. A "no live intelligence"
  // zero is not a fact about the airport and must not be recorded as one.
  if (liveConditions) {
    for (const term of ["securityWaitExtraMin", "immigrationWaitExtraMin", "groundTransportExtraMin"] as const) {
      facts.push({
        key: `live.${term}`,
        value: liveConditions[term],
        source: "LIVE",
        observedAt: liveConditions.observedAt,
      });
    }
  }

  return facts;
}

// ── sourceRefs ───────────────────────────────────────────────────────────────

/**
 * Everything that produced a number in this record, deduplicated and sorted.
 *
 * The estimates already carry `sourceRefs` per term (§6.2), so this is mostly a
 * union of those. What it adds is the two ROWS: the airport profile when one
 * supplied the buffers, and the session. A source list that named only code
 * modules could not answer "which airport row was this" after that row changed.
 */
function sourceRefsFor(record: LayoverFeasibilityRecord): string[] {
  const refs = new Set<string>();
  const est = record.estimates;
  const all = [
    est.baseBuffer, est.immigrationExtra, est.bagsExtra, est.trafficExtra,
    est.timeOfDayExtra, est.liveExtra, est.exitDelay,
    ...(est.outboundTravel ? [est.outboundTravel] : []),
  ];
  for (const e of all) for (const r of e.sourceRefs) refs.add(r);

  const airportId = record.inputs.airport.id;
  if (airportId) refs.add(`airport_profiles:${airportId}`);
  if (record.inputs.session.id) refs.add(`layover_sessions:${record.inputs.session.id}`);
  if (record.inputs.liveConditions?.observedAt) {
    refs.add(`layover_airport_observations:observedAt=${record.inputs.liveConditions.observedAt}`);
  }
  return [...refs].sort();
}

// ── rulesApplied ─────────────────────────────────────────────────────────────

/**
 * Which rules actually fired for THIS record.
 *
 * ── WHY THIS IS DERIVED AND NOT DECLARED ─────────────────────────────────────
 * The tempting implementation is a constant array of every rule the engine
 * contains. It would make every assertion about "the ledger records rules" pass
 * forever and would report NOTHING: a decision-diff over a corpus (§21 L241)
 * compares rule sets, and a constant set diffs to empty for every pair of
 * records that ever existed. So every entry below is conditioned on something
 * the record itself says, and `src/test/layoverDecisionLedger.test.ts` holds a
 * positive control that fails if any rule name turns out to be emitted by every
 * record in a deliberately varied corpus.
 *
 * A term that contributed ZERO MINUTES did not fire. That is the rule: a
 * traveller with no checked bags did not have the bag rule applied to them, and
 * recording it as applied-with-value-0 is how a rule list stops distinguishing
 * anything.
 *
 * ── FOUR RULE NAMES WERE REMOVED BECAUSE THE POSITIVE CONTROL FOUND THEM ─────
 * The first draft emitted `window.exitDelay`, `confidence.<C>`, and one
 * `reason.<CODE>` per code. The control in the test file — no rule name may be
 * emitted by EVERY record in a varied corpus — went red and named them:
 *
 *   window.exitDelay   `estimateExitDelay` returns 15 at its smallest, for
 *                      every session that can exist, so "the exit delay rule
 *                      fired" is arithmetic that always runs, not a decision.
 *   confidence.<C>     `worstConfidence` folds in `timeOfDayExtra`, which is a
 *                      STATIC_DEFAULT/LOW constant on every computation, so the
 *                      certified confidence is LOW FOR EVERY POSSIBLE INPUT ON
 *                      THIS TREE. Pinned as such in the test rather than
 *                      dressed up as a varying rule. It is already published in
 *                      `result.confidence`, where a constant is honest.
 *   reason.<CODE>      duplicates the record's own `reasonCodes` field, and
 *                      `ENTRY_NOT_CONFIRMED` is emitted unconditionally because
 *                      nothing on this tree reads entry permission (census
 *                      L48). A duplicate that is always present is the worst of
 *                      both.
 *
 * Keeping them would have made every future decision-diff (§21 L241) report a
 * few guaranteed-equal names alongside the real difference. That is how a diff
 * becomes noise.
 */
function rulesAppliedFor(record: LayoverFeasibilityRecord): string[] {
  const rules: string[] = [];
  const b = record.deadline.breakdown;
  const env = record.envelope;
  const s = record.inputs.session;

  rules.push(s.flightType === "international" ? "buffer.base.international" : "buffer.base.domestic");
  if (b.immigrationExtra > 0) rules.push("buffer.immigration");
  if (b.bagsExtra > 0) rules.push("buffer.bags");
  if (b.trafficExtra > 0) rules.push("buffer.traffic");
  if (b.timeOfDayExtra > 0) rules.push("buffer.timeOfDay.ramped");
  if (b.liveExtra > 0) rules.push("buffer.live");

  rules.push(s.boardingTime ? "deadline.anchor.boarding" : "deadline.anchor.departure");

  rules.push(`window.tier.${env.tier}`);
  if (env.overnight) rules.push("window.overnight");
  if (env.freedomWindow === null) rules.push("window.temporalConflict");

  rules.push(`returnState.${env.returnState}`);
  rules.push(`verdict.${record.verdict}`);
  rules.push(`percentile.${record.inputs.bufferPercentile}`);

  const probe = record.inputs.landsideProbe;
  if (probe) {
    rules.push(`probe.${probe.travelTimeSource}`);
    if (record.landside?.requiredMinutesIsLowerBound) rules.push("probe.requiredIsLowerBound");
  }

  return rules;
}

// ── the record ───────────────────────────────────────────────────────────────

/**
 * Project a certified computation into a §20 ledger entry.
 *
 * `sessionId` is a parameter rather than read off `record.inputs.session.id`
 * because those are not the same thing: a caller certifying a hypothetical
 * ("what if my flight were two hours later") holds a session id the inputs do
 * not describe. Passing it makes the ledger entry's owner explicit.
 */
export function decisionRecordFor(
  sessionId: string,
  record: LayoverFeasibilityRecord,
): DecisionRecord {
  return {
    sessionId,
    snapshotId: snapshotIdFor(sessionId, record.inputHash),
    engineVersion: record.engineVersion,
    inputHash: record.inputHash,
    inputFacts: inputFactsFor(record),
    sourceRefs: sourceRefsFor(record),
    rulesApplied: rulesAppliedFor(record),
    result: {
      verdict: record.verdict,
      confidence: record.confidence,
      tier: record.envelope.tier,
      returnState: record.envelope.returnState,
      windowRating: record.windowOnly.rating,
      hardReturnTime: record.deadline.hardReturnTime.toISOString(),
      totalBufferMin: record.deadline.breakdown.totalBuffer,
      usableMinutes: record.envelope.usableMinutes,
      shortfallMinutes: record.envelope.shortfallMinutes,
    },
    reasonCodes: [...record.reasonCodes],
    computedAt: record.computedAt,
  };
}

// ── storage ──────────────────────────────────────────────────────────────────

/**
 * The §20 fields `layover_certified_computations` has nowhere to put.
 *
 * NAMED RATHER THAN MIGRATED, deliberately: this work does not write
 * migrations, and a partial ledger that silently dropped half of §20 would
 * score as built. Each entry is the exact DDL a follow-up migration needs.
 *
 * `inputFacts`, `sourceRefs` and `rulesApplied` are provenance detail, so JSONB
 * and TEXT[] are the right shapes under spec §4's implementation rule (JSON is
 * acceptable for provenance, not for fields used in safety predicates).
 * `snapshotId` is the exception and must be a real indexed column: a
 * recommendation citing a snapshot is a JOIN, which is precisely what §4 says
 * must not live in JSON.
 */
export const LEDGER_MISSING_COLUMNS = [
  {
    field: "snapshotId",
    column: "snapshot_id",
    ddl:
      "ALTER TABLE layover_certified_computations ADD COLUMN IF NOT EXISTS snapshot_id TEXT; " +
      "CREATE UNIQUE INDEX IF NOT EXISTS layover_certcomp_snapshot_uidx " +
      "ON layover_certified_computations(snapshot_id);",
    why: "a stored recommendation must be able to CITE the computation that certified it (Appendix C5 / census L296).",
  },
  {
    field: "inputFacts",
    column: "input_facts",
    ddl: "ALTER TABLE layover_certified_computations ADD COLUMN IF NOT EXISTS input_facts JSONB NOT NULL DEFAULT '[]'::jsonb;",
    why: "§20 DecisionRecord.inputFacts[] — `inputs` holds the values but not their provenance.",
  },
  {
    field: "sourceRefs",
    column: "source_refs",
    ddl: "ALTER TABLE layover_certified_computations ADD COLUMN IF NOT EXISTS source_refs TEXT[] NOT NULL DEFAULT '{}';",
    why: "§20 DecisionRecord.sourceRefs[].",
  },
  {
    field: "rulesApplied",
    column: "rules_applied",
    ddl: "ALTER TABLE layover_certified_computations ADD COLUMN IF NOT EXISTS rules_applied TEXT[] NOT NULL DEFAULT '{}';",
    why: "§20 DecisionRecord.rulesApplied[] — and the input to the §21 L241 decision diff.",
  },
  {
    field: "engineVersion",
    column: "ledger_version",
    ddl: "ALTER TABLE layover_certified_computations ADD COLUMN IF NOT EXISTS ledger_version TEXT;",
    why: "the PROJECTION's version (LAYOVER_LEDGER_VERSION), which is a different question from the engine's.",
  },
] as const;

/**
 * The insert payload for `layover_certified_computations`, containing ONLY
 * columns that exist today.
 *
 * supabase-js sends every key it is given, so naming a column the database does
 * not have fails the whole insert — the hazard migration 2700's header records
 * and 2410 gates behind a flag. Five §20 fields are therefore absent here and
 * declared in `LEDGER_MISSING_COLUMNS` instead; the test asserts they are not
 * in this payload, which is what stops someone "completing" the row by adding
 * them and breaking every write.
 */
export function ledgerRowFor(
  userId: string,
  sessionId: string,
  record: LayoverFeasibilityRecord,
) {
  return {
    session_id: sessionId,
    user_id: userId,
    engine_version: record.engineVersion,
    feasibility_version: record.feasibilityVersion,
    input_hash: record.inputHash,
    computed_at: record.computedAt,
    verdict: record.verdict,
    confidence: record.confidence,
    buffer_percentile: record.inputs.bufferPercentile,
    cutoff_at: new Date(record.deadline.cutoffMs).toISOString(),
    hard_return_time: record.deadline.hardReturnTime.toISOString(),
    total_buffer_min: record.deadline.breakdown.totalBuffer,
    usable_minutes: record.envelope.usableMinutes,
    inputs: record.inputs,
    breakdown: record.deadline.breakdown,
    estimates: record.estimates,
    reason_codes: [...record.reasonCodes],
  };
}

// ── §24 L261 — bounded retention ─────────────────────────────────────────────

export interface RetentionPolicy {
  retentionDays: number;
  maxPerSession: number;
}

/**
 * Split a ledger corpus into what a compaction keeps and what it drops.
 *
 * TWO RULES, AND ONE THAT OVERRIDES BOTH:
 *   - drop anything older than `retentionDays`;
 *   - keep at most `maxPerSession` entries per session, newest first;
 *   - ALWAYS keep the newest entry for a session, however old it is.
 *
 * The third is the one that matters. A session whose last computation is a year
 * old is a session whose traveller can still ask "what was I told" — dropping
 * it to satisfy a retention window deletes the only answer. §20's whole point
 * is that the answer survives; a retention policy that can empty a session is a
 * policy that can make the ledger unable to explain anything.
 *
 * Pure: it decides, it does not delete. The DELETE is a caller's business and
 * there is no caller yet.
 */
export function compactLedger(
  records: DecisionRecord[],
  nowMs: number,
  policy: RetentionPolicy,
): { keep: DecisionRecord[]; drop: DecisionRecord[] } {
  const cutoff = nowMs - policy.retentionDays * 24 * 60 * 60 * 1000;
  const bySession = new Map<string, DecisionRecord[]>();
  for (const r of records) {
    const list = bySession.get(r.sessionId) ?? [];
    list.push(r);
    bySession.set(r.sessionId, list);
  }

  const keepIds = new Set<string>();
  for (const list of bySession.values()) {
    const sorted = [...list].sort((a, b) => Date.parse(b.computedAt) - Date.parse(a.computedAt));
    sorted.forEach((r, i) => {
      const withinCount = i < policy.maxPerSession;
      const withinRetention = Date.parse(r.computedAt) >= cutoff;
      // i === 0 is the newest for this session and is unconditional.
      if (i === 0 || (withinCount && withinRetention)) keepIds.add(r.snapshotId);
    });
  }

  const keep = records.filter((r) => keepIds.has(r.snapshotId));
  const drop = records.filter((r) => !keepIds.has(r.snapshotId));
  return { keep, drop };
}

/**
 * A snapshot id names one result forever.
 *
 * Immutability on this tree is asserted by grant (migration 2700: no client
 * write verb exists), which covers the database. It does not cover the SERVICE
 * writing a second, different record under a snapshot id it already used — a
 * rewrite the unique index on (session_id, input_hash) would reject, but which
 * this check names before the write, with the field that differs. Throws rather
 * than returning false: a caller that could ignore it is a caller that will.
 */
export function assertSnapshotImmutable(stored: DecisionRecord, incoming: DecisionRecord): void {
  if (stored.snapshotId !== incoming.snapshotId) return;
  const differing: string[] = [];
  for (const [k, v] of Object.entries(stored.result)) {
    if (incoming.result[k as keyof DecisionResult] !== v) differing.push(`result.${k}`);
  }
  if (stored.inputHash !== incoming.inputHash) differing.push("inputHash");
  if (differing.length > 0) {
    throw new Error(
      `layoverLedger: snapshot ${stored.snapshotId} is immutable but would be rewritten — ` +
        `differing: ${differing.join(", ")}`,
    );
  }
}
