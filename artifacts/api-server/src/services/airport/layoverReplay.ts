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
 * ONE PRODUCTION CALLER, AND IT IS GATED. `GET /api/admin/layover/metrics`
 * (routes/adminLayoverMetrics.ts) replays the window's STORED rows through
 * `replayStoredComputations` below — only while
 * `layover_decision_persistence_enabled` is ON, because that is the only time
 * `layover_certified_computations` (2700 + 2992) has rows. Production has applied
 * neither migration, so on production the metric is UNPRODUCIBLE (census L217).
 */
import {
  certifyFeasibility,
  feasibilityInputHash,
  LAYOVER_FEASIBILITY_VERSION,
  type FeasibilityInputs,
} from "./LayoverFeasibility.js";
import { LAYOVER_ENGINE_VERSION } from "./LayoverSafetyEngine.js";
import { decisionRecordFor, snapshotIdFor, type DecisionRecord, type DecisionResult } from "./layoverLedger.js";

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
  return summariseReplay(entries.length, entries.map(replayDecision));
}

/** One summary rule for every corpus shape: refusals out of the denominator, always. */
function summariseReplay(read: number, results: ReplayResult[]): ReplaySummary {
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
    read,
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

// ── §20 L217 over STORED ROWS — the replay the admin route runs ─────────────

/**
 * One `layover_certified_computations` row, as PostgREST returns it (2700's
 * columns plus 2992's `snapshot_id` and `rules_applied`). Timestamps arrive in
 * PostgreSQL's spelling (`…+00:00`), integers as numbers, TEXT[] as arrays and
 * JSONB as parsed values.
 */
export interface StoredComputationRow {
  session_id: string;
  snapshot_id?: string | null;
  engine_version: string;
  feasibility_version: string;
  input_hash: string;
  computed_at: string;
  verdict: string;
  confidence: string;
  buffer_percentile: string;
  cutoff_at: string;
  hard_return_time: string;
  total_buffer_min: number;
  usable_minutes: number;
  breakdown: unknown;
  reason_codes: string[] | null;
  rules_applied?: string[] | null;
  inputs: unknown;
}

/**
 * The stored columns a replay compares, each against what the stored INPUTS
 * produce now. These are the decision as it was WRITTEN — `toDecisionRecord`
 * in LayoverDecisionStore rebuilds a record by replaying the inputs and never
 * reads them, which is why that reader cannot be the replay: it would compare
 * a recomputation with a recomputation.
 */
export const REPLAY_COMPARED_COLUMNS = [
  "input_hash", "snapshot_id", "computed_at", "verdict", "confidence", "buffer_percentile",
  "cutoff_at", "hard_return_time", "total_buffer_min", "usable_minutes", "breakdown",
  "reason_codes", "rules_applied",
] as const;
export type ReplayComparedColumn = (typeof REPLAY_COMPARED_COLUMNS)[number];

/**
 * What a stored-row replay does NOT compare, and why. Stated, so a clean replay
 * is never read as covering more than it does.
 */
export const REPLAY_NOT_COMPARED: Readonly<Record<string, string>> = {
  "result.tier": "no column: DecisionResult has nine members and the table five",
  "result.returnState": "no column",
  "result.windowRating": "no column",
  "result.shortfallMinutes": "no column",
  estimates: "provenance detail, not the decision",
  input_facts: "provenance detail, derived from the inputs",
  source_refs: "provenance detail, derived from the inputs",
};

const sameInstant = (stored: unknown, ms: number): boolean =>
  typeof stored === "string" && Date.parse(stored) === ms;

/** Key-order-insensitive JSON equality, for a JSONB column against a fresh object. */
function sameJson(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(canon);
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => [k, canon(o[k])]));
  };
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/**
 * Replay one STORED row: recompute the record from its stored `inputs` and
 * compare every stored decision column with it.
 *
 * Same order and same refusals as `replayDecision`: the version check runs
 * FIRST, so a row written by other arithmetic is refused (excluded from the
 * denominator, routed to the decision diff) rather than recomputed and called a
 * mismatch. A column 2992 adds (`snapshot_id`, `rules_applied`) is compared when
 * the row carries it.
 */
export function replayStoredComputation(row: StoredComputationRow): ReplayResult {
  const base = {
    sessionId: row.session_id,
    snapshotId: row.snapshot_id ?? snapshotIdFor(row.session_id, row.input_hash),
    mismatchedFields: [] as string[],
    rulesAdded: [] as string[],
    rulesRemoved: [] as string[],
  };
  const inputs = row.inputs as FeasibilityInputs | null;
  const inputsObject = inputs !== null && typeof inputs === "object" && !Array.isArray(inputs);

  if (row.engine_version !== LAYOVER_ENGINE_VERSION || (inputsObject && inputs.engineVersion !== LAYOVER_ENGINE_VERSION)) {
    return { ...base, status: "refused", refusal: "ENGINE_VERSION_CHANGED" };
  }
  if (row.feasibility_version !== LAYOVER_FEASIBILITY_VERSION || (inputsObject && inputs.feasibilityVersion !== LAYOVER_FEASIBILITY_VERSION)) {
    return { ...base, status: "refused", refusal: "RECORD_SHAPE_CHANGED" };
  }
  if (!inputsObject) return { ...base, status: "refused", refusal: "INPUTS_UNUSABLE" };

  let replay: ReturnType<typeof certifyFeasibility>;
  let replayed: DecisionRecord;
  try {
    replay = certifyFeasibility(inputs);
    if (!Number.isFinite(replay.deadline.hardReturnTime.getTime())) {
      return { ...base, status: "refused", refusal: "INPUTS_UNUSABLE" };
    }
    replayed = decisionRecordFor(row.session_id, replay);
  } catch {
    return { ...base, status: "refused", refusal: "INPUTS_UNUSABLE" };
  }

  const fields: ReplayComparedColumn[] = [];
  const hash = feasibilityInputHash(inputs);
  if (row.input_hash !== hash) fields.push("input_hash");
  if (row.snapshot_id != null && row.snapshot_id !== snapshotIdFor(row.session_id, hash)) fields.push("snapshot_id");
  if (!sameInstant(row.computed_at, Date.parse(replay.computedAt))) fields.push("computed_at");
  if (row.verdict !== replay.verdict) fields.push("verdict");
  if (row.confidence !== replay.confidence) fields.push("confidence");
  if (row.buffer_percentile !== replay.inputs.bufferPercentile) fields.push("buffer_percentile");
  if (!sameInstant(row.cutoff_at, replay.deadline.cutoffMs)) fields.push("cutoff_at");
  if (!sameInstant(row.hard_return_time, replay.deadline.hardReturnTime.getTime())) fields.push("hard_return_time");
  if (row.total_buffer_min !== replay.deadline.breakdown.totalBuffer) fields.push("total_buffer_min");
  if (row.usable_minutes !== replay.envelope.usableMinutes) fields.push("usable_minutes");
  if (!sameJson(row.breakdown, replay.deadline.breakdown)) fields.push("breakdown");
  if (!Array.isArray(row.reason_codes) || row.reason_codes.join("|") !== replay.reasonCodes.join("|")) fields.push("reason_codes");

  let rulesAdded: string[] = [];
  let rulesRemoved: string[] = [];
  if (row.rules_applied != null) {
    const stored = new Set(Array.isArray(row.rules_applied) ? row.rules_applied : []);
    const now = new Set(replayed.rulesApplied);
    rulesAdded = [...now].filter((r) => !stored.has(r)).sort();
    rulesRemoved = [...stored].filter((r) => !now.has(r)).sort();
    if (!Array.isArray(row.rules_applied) || rulesAdded.length > 0 || rulesRemoved.length > 0) fields.push("rules_applied");
  }

  return {
    ...base,
    status: fields.length === 0 ? "match" : "mismatch",
    refusal: null,
    mismatchedFields: fields,
    rulesAdded,
    rulesRemoved,
  };
}

/** `replayLedger`'s summary, over stored rows. Refusals stay out of the denominator. */
export function replayStoredComputations(rows: readonly StoredComputationRow[]): ReplaySummary {
  return summariseReplay(rows.length, rows.map(replayStoredComputation));
}
