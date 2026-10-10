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
 *   - Children are deleted BEFORE their parent: a failure between the two
 *     leaves a parent without children (legible: the readers return null for
 *     a missing child), never children citing a computation that is gone.
 *     `layover_recommendations.snapshot_id` is ON DELETE SET NULL (3623), so a
 *     card loses a citation rather than citing a deleted row.
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
} from "./LayoverDecisionStore.js";

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

/** How many old rows one sweep reads to find sessions to compact. */
export const COMPACTION_SWEEP_ROW_LIMIT = 200;

/**
 * Where the next sweep resumes. A compacted session KEEPS its newest record
 * however old it is, so without a cursor the oldest page of due rows would
 * eventually be nothing but kept rows and every later session would starve.
 * The cursor walks forward through `computed_at` and wraps to the start when a
 * page comes back short. In-process only: a restart begins again from the
 * oldest row, which costs a re-read and deletes nothing extra.
 */
let _sweepCursor: string | null = null;

/** Test seam. */
export function _resetSnapshotCompactionCursor(): void {
  _sweepCursor = null;
}

/**
 * One scheduled pass: find sessions holding a record older than the retention
 * window and compact each. NEVER throws; a failure is counted, logged and
 * leaves every row in place for the next pass.
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
    let query = db
      .from("layover_certified_computations")
      .select("session_id,computed_at")
      .lt("computed_at", cutoff);
    if (_sweepCursor !== null) query = query.gt("computed_at", _sweepCursor);
    const { data, error } = await query
      .order("computed_at", { ascending: true })
      .limit(COMPACTION_SWEEP_ROW_LIMIT);
    if (error) {
      logger.warn({ err: error.message }, "snapshot compaction sweep could not read due rows — nothing deleted");
      return { outcome: "failed", sessions: 0, dropped: 0, failedSessions: 0 };
    }
    const rows = (data ?? []) as Array<{ session_id: unknown; computed_at: unknown }>;
    const last = rows.length > 0 ? rows[rows.length - 1].computed_at : null;
    _sweepCursor = rows.length < COMPACTION_SWEEP_ROW_LIMIT || typeof last !== "string" ? null : last;
    const sessions = [...new Set(rows
      .map((r) => r.session_id)
      .filter((s): s is string => typeof s === "string" && s.length > 0))];
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
