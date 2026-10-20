/**
 * LayoverDecisionService — the two operations on STORED snapshots that the
 * spec names and the store did not provide:
 *
 *   L190  `LayoverDecisionService.diff(previousSnapshotId, nextSnapshotId)` —
 *         resolve two stored computations by id and diff them. The comparison
 *         is `diffDecisions` (LayoverDecisionStore, pure); this adds the
 *         resolution, the ownership boundary and the honest refusals.
 *   L261  bounded retention/compaction — `compactLedger` (layoverLedger.ts)
 *         decides what leaves and said "the DELETE is a caller's business and
 *         there is no caller yet". `compactSessionDecisions` is that caller.
 *
 * NO ARITHMETIC AND NO JUDGEMENT. Every record is read through
 * `decisionBySnapshotId` / `decisionsForSession`, which REPLAY the stored inputs
 * and refuse a row whose replay disagrees with its stored hash.
 *
 * BOUNDARIES
 *   - A snapshot of another session is NOT FOUND, never "forbidden": the
 *     answer must not confirm that someone else's snapshot id exists.
 *   - With `layover_decision_persistence_enabled` OFF nothing is read: the
 *     ledger tables may not exist (2700/2992 unapplied in production), and
 *     "not stored" is the truthful answer there.
 *   - Compaction runs only with `layover_snapshot_compaction_enabled` ON
 *     (3624, seeded FALSE). Any read failure deletes NOTHING. The newest record
 *     of a session is never deleted (compactLedger's unconditional keep).
 *   - The two ledger children (`layover_time_budgets`, `layover_return_plans`)
 *     are deleted BEFORE their parent: a failure between the two leaves a
 *     parent without children (legible: the readers return null for a missing
 *     child), never a budget or plan citing a computation that is gone.
 *     `layover_recommendations.snapshot_id` is ON DELETE SET NULL (3623), so a
 *     card loses a citation rather than citing a deleted row.
 *   - ONE CITATION IS LEFT DANGLING, DELIBERATELY: `layover_constraints.snapshot_id`
 *     is a plain TEXT, NOT a foreign key (2992: a constraint set is declared
 *     before anything certifies it, so "the target may not exist yet"), and
 *     constraint versions are immutable history this compaction does not touch.
 *     After a compaction a constraint version may therefore name a snapshot id
 *     that no longer resolves. Its readers resolve nothing through that column,
 *     so nothing breaks; it is stated here and in the L261 owner question so
 *     nobody reads the id as proof the computation is still stored.
 *
 * Nothing here stores or reads a location.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { compactLedger, type RetentionPolicy } from "../../services/airport/layoverLedger.js";
import {
  decisionBySnapshotId,
  decisionsForSession,
  diffDecisions,
  type DecisionDiff,
} from "./LayoverDecisionStore.js"; import { readFlagState, isMissingSchemaError } from "../../lib/capability/schemaCapability.js"; import { decisionRecordFor, type DecisionRecord } from "../../services/airport/layoverLedger.js"; import { replayStoredComputation, replayStoredComputations, type ReplaySummary, type StoredComputationRow } from "../../services/airport/layoverReplay.js"; import { replayFeasibility, type FeasibilityInputs, type LayoverFeasibilityRecord } from "../../services/airport/LayoverFeasibility.js"; import { LAYOVER_ENGINE_VERSION } from "../../services/airport/LayoverSafetyEngine.js"; // census L189/L191 (lane 5): the foot of this file

const logger = rootLogger.child({ service: "LayoverDecisionService" });

// ── L190 — diff(previousSnapshotId, nextSnapshotId) ──────────────────────────

export type SnapshotDiffRefusal = "persistence_disabled" | "read_failed" | "not_found";

export type SnapshotDiffOutcome =
  | { ok: true; diff: DecisionDiff }
  | { ok: false; reason: SnapshotDiffRefusal };

/**
 * Diff two stored snapshots of ONE session.
 *
 * `sessionId` is the session the caller has already proven they own; a
 * snapshot that resolves to a different session is reported exactly as a
 * missing one.
 */
export async function diffSnapshots(
  db: SupabaseClient,
  sessionId: string,
  previousSnapshotId: string,
  nextSnapshotId: string,
): Promise<SnapshotDiffOutcome> {
  if (!(await isFlagEnabled(db, "layover_decision_persistence_enabled"))) { // = DECISION_PERSISTENCE_FLAG, literal for check:flag-polarity
    return { ok: false, reason: "persistence_disabled" };
  }
  const [prev, next] = await Promise.all([
    decisionBySnapshotId(db, previousSnapshotId),
    decisionBySnapshotId(db, nextSnapshotId),
  ]);
  if (!prev.ok || !next.ok) return { ok: false, reason: "read_failed" };
  if (prev.value === null || next.value === null) return { ok: false, reason: "not_found" };
  if (prev.value.sessionId !== sessionId || next.value.sessionId !== sessionId) {
    return { ok: false, reason: "not_found" };
  }
  return { ok: true, diff: diffDecisions(prev.value, next.value) };
}

// ── L261 — bounded retention / compaction ────────────────────────────────────

/** Seeded FALSE by migration 3624. Destructive when ON; see the header. */
export const SNAPSHOT_COMPACTION_FLAG = "layover_snapshot_compaction_enabled";

/**
 * PROPOSED RULING L-DATA-L261 (lane L-DATA, 2026-10-10), NOT an owner answer:
 * a stored decision record leaves 90 days after it was computed, a session
 * keeps at most 20, and the newest record of every session is kept until the
 * session itself is erased (account deletion cascades every row). Shipped
 * behind a flag seeded FALSE; turning it on is the owner's press.
 */
export const SNAPSHOT_RETENTION_POLICY: RetentionPolicy = Object.freeze({ retentionDays: 90, maxPerSession: 20 });

/** The most rows one session's compaction reads. Newest first, so the kept set is always among them. */
export const COMPACTION_READ_LIMIT = 500;

export type CompactionRefusal = "compaction_disabled" | "read_failed" | "delete_failed";

export type CompactionOutcome =
  | { ok: true; dropped: string[] }
  | { ok: false; reason: CompactionRefusal; dropped: string[] };

/**
 * Apply `compactLedger` to one session's stored records and DELETE what it
 * drops. `dropped` names the snapshot ids actually deleted (parent included).
 */
export async function compactSessionDecisions(
  db: SupabaseClient,
  sessionId: string,
  nowMs: number,
  policy: RetentionPolicy = SNAPSHOT_RETENTION_POLICY,
): Promise<CompactionOutcome> {
  if (!(await isFlagEnabled(db, "layover_snapshot_compaction_enabled"))) {
    return { ok: false, reason: "compaction_disabled", dropped: [] };
  }
  const history = await decisionsForSession(db, sessionId, COMPACTION_READ_LIMIT);
  if (!history.ok) return { ok: false, reason: "read_failed", dropped: [] };

  const { drop } = compactLedger(history.value, nowMs, policy);
  const ids = drop.map((d) => d.snapshotId);
  if (ids.length === 0) return { ok: true, dropped: [] };

  // Children first (see the header), each scoped to this session as well as the ids.
  const budgets = await db.from("layover_time_budgets").delete().eq("session_id", sessionId).in("snapshot_id", ids);
  if (budgets.error) {
    logger.warn({ err: budgets.error.message, sessionId }, "snapshot compaction: time budget delete failed — nothing else deleted");
    return { ok: false, reason: "delete_failed", dropped: [] };
  }
  const plans = await db.from("layover_return_plans").delete().eq("session_id", sessionId).in("snapshot_id", ids);
  if (plans.error) {
    logger.warn({ err: plans.error.message, sessionId }, "snapshot compaction: return plan delete failed — parents kept");
    return { ok: false, reason: "delete_failed", dropped: [] };
  }
  const parents = await db.from("layover_certified_computations").delete().eq("session_id", sessionId).in("snapshot_id", ids);
  if (parents.error) {
    logger.warn({ err: parents.error.message, sessionId }, "snapshot compaction: computation delete failed — children already gone, parents kept");
    return { ok: false, reason: "delete_failed", dropped: [] };
  }
  return { ok: true, dropped: ids };
}

export interface CompactionSweepResult {
  outcome: "disabled" | "idle" | "swept" | "failed";
  sessions: number;
  dropped: number;
  failedSessions: number;
}

/** How many rows each discovery query of one sweep reads to find sessions to compact. */
export const COMPACTION_SWEEP_ROW_LIMIT = 200;

/**
 * TWO DISCOVERY QUERIES, because the policy has two clauses and either can make
 * a session due:
 *   - AGE: the session holds a record computed before the retention cutoff;
 *   - CAP: the session has written more than `maxPerSession` records. 3623's
 *     per-session `snapshot_version` makes this a plain row predicate
 *     (`snapshot_version > maxPerSession` exists exactly when the session has
 *     ever written more than the cap), so a session holding 30 young records is
 *     found without waiting for one of them to age. A session found this way
 *     whose older records were already dropped compacts to a no-op.
 *
 * Each query has its own cursor. A compacted session KEEPS rows (its newest
 * always; up to the cap within the window), so without a cursor the first page
 * would eventually be nothing but kept rows and every later session would
 * starve. A cursor walks forward through `computed_at` and WRAPS to the start
 * when a page comes back short, so a session whose compaction failed on an
 * earlier page is retried on a later pass. In-process only: a restart begins
 * again from the oldest row, which costs a re-read and deletes nothing extra.
 */
let _ageCursor: string | null = null;
let _capCursor: string | null = null;

/** Test seam. */
export function _resetSnapshotCompactionCursor(): void {
  _ageCursor = null;
  _capCursor = null;
}

type DuePage = { ok: true; sessions: string[]; next: string | null } | { ok: false };

function duePageFrom(data: unknown, error: unknown): DuePage {
  if (error) return { ok: false };
  const rows = (data ?? []) as Array<{ session_id: unknown; computed_at: unknown }>;
  const last = rows.length > 0 ? rows[rows.length - 1].computed_at : null;
  return {
    ok: true,
    sessions: rows.map((r) => r.session_id).filter((x): x is string => typeof x === "string" && x.length > 0),
    // A short page means the walk reached the end: wrap.
    next: rows.length < COMPACTION_SWEEP_ROW_LIMIT || typeof last !== "string" ? null : last,
  };
}

/**
 * One scheduled pass: find sessions due under either clause and compact each.
 * NEVER throws; a failure is counted, logged and leaves every row in place for
 * the next pass.
 */
export async function runSnapshotCompactionSweep(
  db: SupabaseClient,
  now: Date,
  policy: RetentionPolicy = SNAPSHOT_RETENTION_POLICY,
): Promise<CompactionSweepResult> {
  try {
    if (!(await isFlagEnabled(db, "layover_snapshot_compaction_enabled"))) {
      return { outcome: "disabled", sessions: 0, dropped: 0, failedSessions: 0 };
    }
    const cutoff = new Date(now.getTime() - policy.retentionDays * 24 * 60 * 60 * 1000).toISOString();

    let ageQuery = db
      .from("layover_certified_computations")
      .select("session_id,computed_at")
      .lt("computed_at", cutoff);
    if (_ageCursor !== null) ageQuery = ageQuery.gt("computed_at", _ageCursor);
    const ageRead = await ageQuery.order("computed_at", { ascending: true }).limit(COMPACTION_SWEEP_ROW_LIMIT);
    const age = duePageFrom(ageRead.data, ageRead.error);

    let capQuery = db
      .from("layover_certified_computations")
      .select("session_id,computed_at")
      .gt("snapshot_version", policy.maxPerSession);
    if (_capCursor !== null) capQuery = capQuery.gt("computed_at", _capCursor);
    const capRead = await capQuery.order("computed_at", { ascending: true }).limit(COMPACTION_SWEEP_ROW_LIMIT);
    const cap = duePageFrom(capRead.data, capRead.error);

    if (!age.ok || !cap.ok) {
      logger.warn({ ageReadable: age.ok, capReadable: cap.ok }, "snapshot compaction sweep could not read due rows — nothing deleted");
      return { outcome: "failed", sessions: 0, dropped: 0, failedSessions: 0 };
    }
    _ageCursor = age.next;
    _capCursor = cap.next;
    const sessions = [...new Set([...age.sessions, ...cap.sessions])];
    if (sessions.length === 0) return { outcome: "idle", sessions: 0, dropped: 0, failedSessions: 0 };

    let dropped = 0;
    let failedSessions = 0;
    for (const sessionId of sessions) {
      const out = await compactSessionDecisions(db, sessionId, now.getTime(), policy);
      if (out.ok) dropped += out.dropped.length;
      else failedSessions += 1;
    }
    logger.info({ sessions: sessions.length, dropped, failedSessions }, "snapshot compaction sweep finished");
    return { outcome: failedSessions > 0 ? "failed" : "swept", sessions: sessions.length, dropped, failedSessions };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "snapshot compaction sweep threw — nothing further deleted");
    return { outcome: "failed", sessions: 0, dropped: 0, failedSessions: 0 };
  }
}

// ── L189 / L191 — explain(snapshotId) and replay(sessionId, engineVersion) ────
//
// Appended at the foot so no line above moves (this file is cited by line).
//
// BOTH READ THE ROW AS WRITTEN, NOT `decisionBySnapshotId`. That reader rebuilds
// a record BY REPLAYING the stored inputs and never reads the decision columns,
// so an explanation or a replay built on it would compare a recomputation with a
// recomputation (layoverReplay.ts's header). These two hand the stored row to
// `replayStoredComputation`, the §20 L217 replay, and act only on what it says.
//
// THE GATE IS THE FOUR-STATE FLAG READ. `layover_decision_persistence_enabled`
// on → read; off or absent → `persistence_disabled`, nothing read (2700/2992
// are unapplied in production, so "not stored" is the truthful answer there);
// unreadable → `flag_unreadable`, nothing read. Unreadable is not "off": an
// operator told "disabled" when the row could not be read looks in the wrong
// place. Neither function writes anything, on any path.

/** 2700's typed columns, 2992's two, and the inputs — the same list `storedComputationsInWindow` reads. */
const AS_WRITTEN_COLUMNS =
  "session_id,snapshot_id,engine_version,feasibility_version,input_hash,computed_at,verdict,confidence,buffer_percentile,cutoff_at,hard_return_time,total_buffer_min,usable_minutes,breakdown,reason_codes,rules_applied,inputs";

export type LedgerGateRefusal = "persistence_disabled" | "flag_unreadable";

/** `null` = open. The literal is spelled here so check:flag-polarity can resolve it. */
async function ledgerGate(db: SupabaseClient): Promise<LedgerGateRefusal | null> {
  const state = await readFlagState(db, "layover_decision_persistence_enabled");
  if (state === "on") return null;
  return state === "unreadable" ? "flag_unreadable" : "persistence_disabled";
}

/** A refused read names WHY: the ledger is not in this database, or the read failed. */
function readRefusal(error: unknown): "storage_unavailable" | "read_failed" {
  return isMissingSchemaError(error) ? "storage_unavailable" : "read_failed";
}

export type SnapshotExplainRefusal =
  | LedgerGateRefusal
  /** The ledger tables or columns are not in this database (2700/2992 unapplied). */
  | "storage_unavailable"
  | "read_failed"
  /** No such snapshot, OR it belongs to another session — the same answer, deliberately. */
  | "not_found"
  /** `replayStoredComputation` refused it: other arithmetic, another record shape, or unusable inputs. */
  | "not_replayable"
  /** The stored decision does not follow from its stored inputs. Explaining it would explain a fiction. */
  | "replay_mismatch";

export interface SnapshotExplanation {
  snapshotId: string;
  sessionId: string;
  /** §20's ten members for this snapshot. */
  decision: DecisionRecord;
  /** §9's explanation as this snapshot published it: the engine's reasons, unknowns and disclaimer. */
  reasons: string[];
  unknowns: string[];
  disclaimer: string;
  /** How the numbers were made: the deadline's per-term breakdown and the buffer percentile. */
  breakdown: LayoverFeasibilityRecord["deadline"]["breakdown"];
  bufferPercentile: string;
  /**
   * What licenses this explanation: the stored decision columns were reproduced
   * field for field by replaying the stored inputs under the running engine.
   * There is no other value; a row that does not replay is refused, not explained.
   */
  verifiedBy: "replay_match";
}

export type SnapshotExplainOutcome =
  | { ok: true; explanation: SnapshotExplanation }
  | { ok: false; reason: SnapshotExplainRefusal; detail: string[] };

/**
 * census L189 — `LayoverDecisionService.explain(snapshotId)`.
 *
 * Explains a STORED snapshot, not a live computation: the reasons, unknowns and
 * disclaimer the engine published for exactly the inputs that snapshot stored.
 * They are not stored as text, so they are reproduced by replay — and only after
 * the replay has reproduced every stored decision column, so the words cannot
 * describe a different answer from the one the traveller was given.
 *
 * `sessionId` is the session the caller has already proven they own (as in
 * `diffSnapshots`); another session's snapshot is `not_found`.
 */
export async function explainSnapshot(
  db: SupabaseClient,
  sessionId: string,
  snapshotId: string,
): Promise<SnapshotExplainOutcome> {
  const gate = await ledgerGate(db);
  if (gate) return { ok: false, reason: gate, detail: [] };

  const { data, error } = await db
    .from("layover_certified_computations")
    .select(AS_WRITTEN_COLUMNS)
    .eq("snapshot_id", snapshotId)
    .maybeSingle();
  if (error) {
    logger.warn({ err: (error as { message?: string }).message, snapshotId }, "snapshot explain: stored computation unreadable — refusing rather than explaining nothing");
    return { ok: false, reason: readRefusal(error), detail: [] };
  }
  if (!data) return { ok: false, reason: "not_found", detail: [] };
  const row = data as unknown as StoredComputationRow;
  if (row.session_id !== sessionId) return { ok: false, reason: "not_found", detail: [] };

  const replay = replayStoredComputation(row);
  if (replay.status === "refused") return { ok: false, reason: "not_replayable", detail: replay.refusal ? [replay.refusal] : [] };
  if (replay.status === "mismatch") {
    logger.warn({ snapshotId, fields: replay.mismatchedFields }, "snapshot explain: stored decision does not replay — refusing to explain it");
    return { ok: false, reason: "replay_mismatch", detail: [...replay.mismatchedFields] };
  }

  // `replayStoredComputation` matched, so these inputs reproduce the stored row.
  const record = replayFeasibility(row.inputs as FeasibilityInputs);
  return {
    ok: true,
    explanation: {
      snapshotId,
      sessionId: row.session_id,
      decision: decisionRecordFor(row.session_id, record),
      reasons: [...record.reasons],
      unknowns: [...record.unknowns],
      disclaimer: record.disclaimer,
      breakdown: record.deadline.breakdown,
      bufferPercentile: record.inputs.bufferPercentile,
      verifiedBy: "replay_match",
    },
  };
}

/** The most stored decisions one session replay reads. One over it is read, so `truncated` is measured. */
export const SESSION_REPLAY_LIMIT = 50;

export type SessionReplayRefusal =
  | LedgerGateRefusal
  /**
   * The requested engine is not the one running. This tree can only run its own
   * arithmetic; "what would THIS engine say about those records" is the L241
   * decision diff (`decisionDiffCorpus`), not a replay.
   */
  | "engine_version_not_running"
  | "storage_unavailable"
  | "read_failed";

export type SessionReplayOutcome =
  | { ok: true; sessionId: string; engineVersion: string; summary: ReplaySummary; truncated: boolean }
  | { ok: false; reason: SessionReplayRefusal; runningEngineVersion: string };

/**
 * census L191 — `LayoverDecisionService.replay(sessionId, engineVersion)`.
 *
 * Every decision this session stored under `engineVersion`, newest first and
 * bounded, each replayed from its stored inputs and compared with its stored
 * decision columns (`replayStoredComputations`). A match is a record that is
 * what it claims; a mismatch names the fields that are not. Refusals stay out of
 * the summary's denominator, exactly as L217's metric keeps them out.
 *
 * `sessionId` is the session the caller has already proven they own.
 */
export async function replaySessionDecisions(
  db: SupabaseClient,
  sessionId: string,
  engineVersion: string,
): Promise<SessionReplayOutcome> {
  const gate = await ledgerGate(db);
  if (gate) return { ok: false, reason: gate, runningEngineVersion: LAYOVER_ENGINE_VERSION };
  if (engineVersion !== LAYOVER_ENGINE_VERSION) {
    return { ok: false, reason: "engine_version_not_running", runningEngineVersion: LAYOVER_ENGINE_VERSION };
  }

  const { data, error } = await db
    .from("layover_certified_computations")
    .select(AS_WRITTEN_COLUMNS)
    .eq("session_id", sessionId)
    .eq("engine_version", engineVersion)
    .order("computed_at", { ascending: false })
    .limit(SESSION_REPLAY_LIMIT + 1);
  if (error || !Array.isArray(data)) {
    logger.warn({ err: (error as { message?: string } | null)?.message ?? "no row set", sessionId }, "session replay: stored decisions unreadable — refusing rather than replaying an empty history");
    return { ok: false, reason: error ? readRefusal(error) : "read_failed", runningEngineVersion: LAYOVER_ENGINE_VERSION };
  }
  const rows = data as unknown as StoredComputationRow[];
  return {
    ok: true,
    sessionId,
    engineVersion,
    summary: replayStoredComputations(rows.slice(0, SESSION_REPLAY_LIMIT)),
    truncated: rows.length > SESSION_REPLAY_LIMIT,
  };
}

// ── L190 — "what changed since the last answer", as a traveller is shown it ──
//
// The spec's north star asks Layover to answer "what changed since the last
// answer". `diffSnapshots` above names the fields that differ, and its
// `materiallyChanged` counts ANY usable-minute change. Usable time runs from the
// later of now and the earliest exit to the hard return (LayoverSafetyEngine
// computeWindow), so once the traveller is out it shrinks by exactly the minutes
// that passed between two answers: a diff of two answers ten minutes apart
// always "changed". A traveller told that on every refresh is told nothing.
//
// `travellerChangesOf` is what the app shows. Each field a traveller acts on,
// with its value in BOTH answers, and usable time only when neither the clock
// nor the moved deadline explains it (the window's START moved: a later arrival,
// a longer exit). Values are the stored records' own; nothing is recomputed.
// Appended at the tail so no cited line above moves; the route reads it through
// `diffSnapshotsForTraveller`, which resolves exactly as `diffSnapshots` does.

/** The fields a traveller acts on, in the order the app says them. */
export const TRAVELLER_CHANGE_FIELDS = ["verdict", "returnState", "hardReturnTime", "usableMinutes", "confidence"] as const;
export type TravellerChangeField = (typeof TRAVELLER_CHANGE_FIELDS)[number];

export interface TravellerChange {
  field: TravellerChangeField;
  previous: string | number;
  next: string | number;
  /** `hardReturnTime` only: whole minutes the deadline moved, negative = earlier. */
  minutesMoved?: number;
}

/** Both usable figures are whole minutes (Math.round), so their difference carries up to one minute of rounding. */
export const USABLE_ROUNDING_TOLERANCE_MIN = 1;

/**
 * PURE. The changes between two stored answers that a traveller should be told
 * about. `previous` is the older answer; an answer compared with itself, or one
 * whose only movement is the clock, yields `[]`.
 */
export function travellerChangesOf(previous: DecisionRecord, next: DecisionRecord): TravellerChange[] {
  const out: TravellerChange[] = [];
  const p = previous.result, n = next.result;
  if (p.verdict !== n.verdict) out.push({ field: "verdict", previous: p.verdict, next: n.verdict });
  if (p.returnState !== n.returnState) out.push({ field: "returnState", previous: p.returnState, next: n.returnState });
  const prevEnd = Date.parse(p.hardReturnTime), nextEnd = Date.parse(n.hardReturnTime);
  const endMovedMin = Number.isFinite(prevEnd) && Number.isFinite(nextEnd) ? (nextEnd - prevEnd) / 60_000 : null;
  if (p.hardReturnTime !== n.hardReturnTime) {
    out.push({ field: "hardReturnTime", previous: p.hardReturnTime, next: n.hardReturnTime, ...(endMovedMin !== null ? { minutesMoved: Math.round(endMovedMin) } : {}) });
  }
  if (p.usableMinutes !== n.usableMinutes) {
    // With the window's start and end unchanged, usable time can only lose the
    // minutes that passed (0 before the exit, all of them after). Anything
    // outside [moved deadline − elapsed, moved deadline] is the start moving.
    const elapsedMin = Math.max(0, (Date.parse(next.computedAt) - Date.parse(previous.computedAt)) / 60_000);
    const delta = n.usableMinutes - p.usableMinutes;
    const shift = endMovedMin ?? 0;
    const explained = endMovedMin !== null && Number.isFinite(elapsedMin)
      && delta >= shift - elapsedMin - USABLE_ROUNDING_TOLERANCE_MIN
      && delta <= shift + USABLE_ROUNDING_TOLERANCE_MIN;
    if (!explained) out.push({ field: "usableMinutes", previous: p.usableMinutes, next: n.usableMinutes });
  }
  if (p.confidence !== n.confidence) out.push({ field: "confidence", previous: p.confidence, next: n.confidence });
  return out;
}

export type TravellerDiffOutcome =
  | { ok: true; diff: DecisionDiff; changes: TravellerChange[] }
  | { ok: false; reason: SnapshotDiffRefusal };

/**
 * `diffSnapshots` plus `travellerChangesOf`, over the same resolution: the
 * persistence flag first (OFF reads nothing), both ids through the replaying
 * reader, another session's snapshot reported exactly as a missing one, and an
 * unreadable ledger refused rather than diffed as empty.
 */
export async function diffSnapshotsForTraveller(
  db: SupabaseClient,
  sessionId: string,
  previousSnapshotId: string,
  nextSnapshotId: string,
): Promise<TravellerDiffOutcome> {
  if (!(await isFlagEnabled(db, "layover_decision_persistence_enabled"))) { // = DECISION_PERSISTENCE_FLAG, literal for check:flag-polarity
    return { ok: false, reason: "persistence_disabled" };
  }
  const [prev, next] = await Promise.all([
    decisionBySnapshotId(db, previousSnapshotId),
    decisionBySnapshotId(db, nextSnapshotId),
  ]);
  if (!prev.ok || !next.ok) return { ok: false, reason: "read_failed" };
  if (prev.value === null || next.value === null) return { ok: false, reason: "not_found" };
  if (prev.value.sessionId !== sessionId || next.value.sessionId !== sessionId) return { ok: false, reason: "not_found" };
  return { ok: true, diff: diffDecisions(prev.value, next.value), changes: travellerChangesOf(prev.value, next.value) };
}
