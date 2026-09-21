/**
 * layoverReplay — §21 L240 deterministic replay, L241 decision diff, and the
 * §20 L217 `decision_replay_mismatch` metric these two feed.
 *
 * ── THE DISTINCTION THIS MODULE EXISTS TO HOLD ───────────────────────────────
 * Replay and decision-diff look like the same operation and are opposites.
 *
 *   REPLAY asks: does the answer we WROTE DOWN still follow from the inputs we
 *   wrote down, under the arithmetic that wrote it? Expected answer: always
 *   yes. Its metric's target is 0, and a non-zero value means a stored record
 *   is not what it claims — a tampered row, a truncated JSONB input set, a
 *   record produced by a build whose arithmetic was changed without a version
 *   bump. It is a CORRUPTION detector.
 *
 *   DECISION DIFF asks: what would the NEW arithmetic have told these same
 *   travellers? Expected answer: something, or the change was pointless. Its
 *   output is a review artifact, not an alarm.
 *
 * Run them through one code path and L217's target-0 metric lights up on every
 * engine version bump, gets acknowledged as expected, and stops being read.
 * So `replayDecision` REFUSES a record whose engine version is not the running
 * one, and the refusal is neither a match nor a mismatch: it is excluded from
 * the metric's denominator and routed to `decisionDiffCorpus` instead.
 *
 * ── WHY REPLAY IS NOT VACUOUS EVEN THOUGH `replayFeasibility === certifyFeasibility` ──
 * Because it does not compare a recomputation to a recomputation. It compares a
 * recomputation to the STORED DECISION — the ten §20 fields as they were
 * written. The engine being pure is what makes the comparison meaningful: any
 * difference is therefore in the row, not in the arithmetic.
 *
 * NO PRODUCTION CALLER. Nothing reads `layover_certified_computations` yet
 * (migration 2700 landed the table with no writer, deliberately), so this runs
 * against in-memory corpora in tests. The route that would call it is
 * `routes/airport.ts`, which this work does not own.
 */
import {
  certifyFeasibility,
  feasibilityInputHash,
  LAYOVER_FEASIBILITY_VERSION,
  type FeasibilityInputs,
} from "./LayoverFeasibility.js";
import { LAYOVER_ENGINE_VERSION } from "./LayoverSafetyEngine.js";
import { decisionRecordFor, type DecisionRecord, type DecisionResult } from "./layoverLedger.js";

/**
 * One stored ledger entry as replay needs to see it: the named inputs as
 * persisted, and the decision as persisted. Two fields rather than one because
 * they are stored in different places — `layover_certified_computations.inputs`
 * is JSONB and the decision is the typed columns beside it — and a replay whose
 * whole job is to detect disagreement between them must receive them
 * separately.
 */
export interface StoredDecision {
  sessionId: string;
  inputs: FeasibilityInputs;
  decision: DecisionRecord;
}

/**
 * Why a record could not be replayed. Declared so a caller cannot invent a new
 * spelling and so the metric can report refusals by cause rather than as one
 * undifferentiated bucket.
 */
export const REPLAY_REFUSAL_REASONS = [
  /** The record was produced by different arithmetic. This is L241's job. */
  "ENGINE_VERSION_CHANGED",
  /** The record shape changed; its `inputs` may not deserialise faithfully. */
  "RECORD_SHAPE_CHANGED",
  /** The stored inputs could not produce a record at all. */
  "INPUTS_UNUSABLE",
] as const;
export type ReplayRefusalReason = (typeof REPLAY_REFUSAL_REASONS)[number];

export interface ReplayResult {
  sessionId: string;
  snapshotId: string;
  status: "match" | "mismatch" | "refused";
  refusal: ReplayRefusalReason | null;
  /** Dotted names of every field whose stored value differs from the replay. */
  mismatchedFields: string[];
  /** Rules the replay fired that the stored record does not carry. */
  rulesAdded: string[];
  /** Rules the stored record carries that the replay does not fire. */
  rulesRemoved: string[];
}

/** Fields of `DecisionResult`, compared one by one so a diff can name them. */
const RESULT_FIELDS: (keyof DecisionResult)[] = [
  "verdict", "confidence", "tier", "returnState", "windowRating",
  "hardReturnTime", "totalBufferMin", "usableMinutes", "shortfallMinutes",
];

/**
 * Replay one stored decision.
 *
 * ORDER MATTERS. The version check runs FIRST, before anything is recomputed:
 * a record from an older engine must be refused rather than recomputed and
 * found different, or every version bump floods L217's target-0 metric.
 */
export function replayDecision(entry: StoredDecision): ReplayResult {
  const base = {
    sessionId: entry.sessionId,
    snapshotId: entry.decision.snapshotId,
    mismatchedFields: [] as string[],
    rulesAdded: [] as string[],
    rulesRemoved: [] as string[],
  };

  if (
    entry.decision.engineVersion !== LAYOVER_ENGINE_VERSION ||
    entry.inputs.engineVersion !== LAYOVER_ENGINE_VERSION
  ) {
    return { ...base, status: "refused", refusal: "ENGINE_VERSION_CHANGED" };
  }
  if (entry.inputs.feasibilityVersion !== LAYOVER_FEASIBILITY_VERSION) {
    return { ...base, status: "refused", refusal: "RECORD_SHAPE_CHANGED" };
  }

  let replayed: DecisionRecord;
  try {
    const record = certifyFeasibility(entry.inputs);
    // A record whose deadline is not a real instant is not a record. The engine
    // does not throw on an unparseable date — it propagates NaN — so the check
    // is here, where a refusal can still be reported honestly.
    if (!Number.isFinite(record.deadline.hardReturnTime.getTime())) {
      return { ...base, status: "refused", refusal: "INPUTS_UNUSABLE" };
    }
    replayed = decisionRecordFor(entry.sessionId, record);
  } catch {
    return { ...base, status: "refused", refusal: "INPUTS_UNUSABLE" };
  }

  const diff = diffDecisions(entry.decision, replayed);

  // The stored hash is checked against the INPUTS, not against the replay's
  // own hash — those are the same computation, so comparing them would test
  // nothing. This catches a row whose hash and inputs were written apart.
  const recomputedHash = feasibilityInputHash(entry.inputs);
  const fields = [...diff.fields];
  if (entry.decision.inputHash !== recomputedHash && !fields.includes("inputHash")) {
    fields.push("inputHash");
  }

  return {
    ...base,
    status: fields.length === 0 ? "match" : "mismatch",
    refusal: null,
    mismatchedFields: fields,
    rulesAdded: diff.rulesAdded,
    rulesRemoved: diff.rulesRemoved,
  };
}

export interface DecisionDiff {
  fields: string[];
  rulesAdded: string[];
  rulesRemoved: string[];
}

/**
 * What moved between two decisions for the same session.
 *
 * `a` is the baseline, `b` the candidate: `rulesAdded` are in `b` and not `a`.
 * Field names are dotted so a reader can tell `result.verdict` from a change in
 * the input set.
 */
export function diffDecisions(a: DecisionRecord, b: DecisionRecord): DecisionDiff {
  const fields: string[] = [];
  for (const f of RESULT_FIELDS) {
    if (a.result[f] !== b.result[f]) fields.push(`result.${f}`);
  }
  if (a.inputHash !== b.inputHash) fields.push("inputHash");
  if (a.snapshotId !== b.snapshotId) fields.push("snapshotId");
  if (a.engineVersion !== b.engineVersion) fields.push("engineVersion");
  if (a.reasonCodes.join("|") !== b.reasonCodes.join("|")) fields.push("reasonCodes");

  const aRules = new Set(a.rulesApplied);
  const bRules = new Set(b.rulesApplied);
  const rulesAdded = [...bRules].filter((r) => !aRules.has(r)).sort();
  const rulesRemoved = [...aRules].filter((r) => !bRules.has(r)).sort();
  if (rulesAdded.length > 0 || rulesRemoved.length > 0) fields.push("rulesApplied");

  return { fields, rulesAdded, rulesRemoved };
}

export interface ReplaySummary {
  read: number;
  /** Denominator of `decision_replay_mismatch`. Refusals are NOT in it. */
  replayed: number;
  matched: number;
  mismatched: number;
  refused: number;
  refusalsByReason: Record<ReplayRefusalReason, number>;
  /** `mismatched / replayed`, or 0 when nothing was replayable. */
  mismatchRate: number;
  results: ReplayResult[];
}

/**
 * Replay a corpus and summarise it into the shape `decision_replay_mismatch`
 * needs.
 *
 * `mismatchRate` divides by what was REPLAYED, never by what was read. A
 * denominator that included refusals would make the rate fall every time an
 * engine version bump made more records unreplayable — a metric that improves
 * because it measured less is worse than no metric.
 *
 * WHEN NOTHING IS REPLAYABLE the rate is 0 and `replayed` is 0 beside it. A
 * consumer must read both: `computeLayoverMetrics` in layoverObservability
 * reports the metric as UNPRODUCIBLE rather than as a green 0 in that case,
 * which is the whole reason it takes the summary rather than the rate.
 */
export function replayLedger(entries: StoredDecision[]): ReplaySummary {
  const results = entries.map(replayDecision);
  const refusalsByReason = {
    ENGINE_VERSION_CHANGED: 0,
    RECORD_SHAPE_CHANGED: 0,
    INPUTS_UNUSABLE: 0,
  } as Record<ReplayRefusalReason, number>;
  for (const r of results) if (r.refusal) refusalsByReason[r.refusal] += 1;

  const matched = results.filter((r) => r.status === "match").length;
  const mismatched = results.filter((r) => r.status === "mismatch").length;
  const refused = results.filter((r) => r.status === "refused").length;
  const replayed = matched + mismatched;

  return {
    read: entries.length,
    replayed,
    matched,
    mismatched,
    refused,
    refusalsByReason,
    mismatchRate: replayed === 0 ? 0 : mismatched / replayed,
    results,
  };
}

// ── §21 L241 — decision diff over a corpus ───────────────────────────────────

export interface VerdictFlip {
  sessionId: string;
  from: DecisionResult["verdict"];
  to: DecisionResult["verdict"];
}

export interface DeadlineMove {
  sessionId: string;
  byMinutes: number;
}

export interface CorpusDiff {
  /** Sessions present in BOTH corpora — the only ones a diff can speak about. */
  compared: number;
  changed: number;
  unmatchedBaseline: number;
  unmatchedCandidate: number;
  /**
   * TRUE when the diff compared nothing. Reported rather than silently
   * returning `changed: 0`, because "no session lined up" and "nothing changed"
   * are opposite findings that a bare zero renders identical — a corpus whose
   * session ids were regenerated between runs would otherwise certify every
   * engine change as behaviour-preserving.
   */
  vacuous: boolean;
  verdictFlips: VerdictFlip[];
  /** The candidate's deadline is EARLIER: more conservative, less freedom. */
  deadlineMovedEarlier: DeadlineMove[];
  /**
   * The candidate's deadline is LATER: the traveller is given more time in the
   * city. Separated from `deadlineMovedEarlier` because they are not
   * symmetrical risks — a later deadline is the direction that strands people,
   * and a reviewer scanning one combined count would not see it.
   */
  deadlineMovedLater: DeadlineMove[];
  perSession: { sessionId: string; diff: DecisionDiff }[];
}

/**
 * Compare two behaviours over the same sessions.
 *
 * Matched on `sessionId` because that is what "the same traveller" means; the
 * snapshot id cannot be used, since it is derived from the input hash and a
 * behaviour change that altered any input would make every pair unmatchable.
 */
export function decisionDiffCorpus(
  baseline: DecisionRecord[],
  candidate: DecisionRecord[],
): CorpusDiff {
  const byId = new Map(candidate.map((d) => [d.sessionId, d]));
  const seen = new Set<string>();

  const perSession: CorpusDiff["perSession"] = [];
  const verdictFlips: VerdictFlip[] = [];
  const deadlineMovedEarlier: DeadlineMove[] = [];
  const deadlineMovedLater: DeadlineMove[] = [];
  let compared = 0;
  let changed = 0;
  let unmatchedBaseline = 0;

  for (const a of baseline) {
    const b = byId.get(a.sessionId);
    if (!b) {
      unmatchedBaseline += 1;
      continue;
    }
    seen.add(a.sessionId);
    compared += 1;
    const diff = diffDecisions(a, b);
    if (diff.fields.length > 0) {
      changed += 1;
      perSession.push({ sessionId: a.sessionId, diff });
    }
    if (a.result.verdict !== b.result.verdict) {
      verdictFlips.push({ sessionId: a.sessionId, from: a.result.verdict, to: b.result.verdict });
    }
    const deltaMin =
      (Date.parse(b.result.hardReturnTime) - Date.parse(a.result.hardReturnTime)) / 60_000;
    if (deltaMin < 0) deadlineMovedEarlier.push({ sessionId: a.sessionId, byMinutes: -deltaMin });
    if (deltaMin > 0) deadlineMovedLater.push({ sessionId: a.sessionId, byMinutes: deltaMin });
  }

  return {
    compared,
    changed,
    unmatchedBaseline,
    unmatchedCandidate: candidate.filter((d) => !seen.has(d.sessionId)).length,
    vacuous: compared === 0,
    verdictFlips,
    deadlineMovedEarlier,
    deadlineMovedLater,
    perSession,
  };
}
