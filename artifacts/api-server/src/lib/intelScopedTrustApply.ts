/**
 * Intelligence Gathering — SCOPED TRUST application (unit I4a, spec §15).
 *
 * The DB-touching half of lib/intelScopedTrust.ts: folds finalized attribution
 * rows (intel_attributions, 2277) into the per-(actor, scope) calibration state
 * (intel_scoped_trust, 2278) with the §15 update rule, exactly, and bridges each
 * graded outcome into the EXISTING trust engine as a trust_events row under
 * `guide_accuracy` — so trust_profiles stays the one user-level trust (the 2130
 * ruling: "scope the existing Trust services").
 *
 * AT-MOST-ONCE PER ATTRIBUTION ROW, WITHOUT TOUCHING THE LEDGER
 * ============================================================
 * intel_attributions is append-only (no "applied" column can ever be set), so
 * the fold is driven by a CURSOR on the scoped row: (last_attribution_at,
 * last_attribution_id) in (computed_at, id) order. A pass reads every row past
 * the cursor for each touched cell, folds them in order, and advances the cursor
 * with an OPTIMISTIC update keyed on the cursor it read — a concurrent pass that
 * advanced it first wins and this one skips (no double fold). A pass that dies
 * between the ledger insert and this fold leaves the cursor behind; the next
 * pass that touches the cell folds what was missed. Nothing is lost, nothing is
 * counted twice.
 *
 * NOT WIRED INTO CONFIDENCE. getScopedTrust() is a read for tests and a future
 * owner decision; lib/intelProjection's confidence model does not consume it.
 */
import { logger } from "./logger.js";
import { recordTrustEvent } from "../services/trust/TrustEventService.js";
import type { IntelOutcome } from "./intelOutcomes.js";
import {
  updateScopedTrust, signalForAttribution, deriveScopedBadges, buildScopeKey,
  TRUST_SIGNAL_EFFECT, DEFAULT_SCOPED_TRUST, SCOPED_TRUST_ALGORITHM_VERSION,
  type ScopeInput, type ScopedBadge, type ScopedTrustRow,
} from "./intelScopedTrust.js";
import { setTrustApplier, type TrustApplier } from "./intelAttributionScheduler.js";

/** Bounded fold per cell per pass; the cursor carries the rest to the next pass. */
export const MAX_ROWS_PER_CELL = 500;

/** trust_events.source_type for the bridge (dedup key with source_id = attribution id). */
export const TRUST_BRIDGE_SOURCE_TYPE = "intel_attribution";

/** One intel_attributions row as the fold reads it. */
export interface AttributionLedgerRow {
  id: string;
  actor_id: string;
  scope_key: string;
  outcome: IntelOutcome;
  outcome_score: number | string | null;
  expected_accuracy: number | string | null;
  weight: number | string;
  contradiction: boolean;
  computed_at: string;
}

/** The persisted intel_scoped_trust row. */
export interface ScopedTrustState extends ScopedTrustRow {
  calibration_samples: number;
  last_attribution_id: string | null;
  last_attribution_at: string | null;
  algorithm_version: string;
}

const num = (x: unknown): number | null => {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x === "string" && x.trim() !== "") { const n = Number(x); return Number.isFinite(n) ? n : null; }
  return null;
};

/** A fresh cell (no row yet). */
export function emptyScopedTrust(actorId: string, scopeKey: string): ScopedTrustState {
  return {
    actor_id: actorId, scope_key: scopeKey, trust: DEFAULT_SCOPED_TRUST,
    outcomes: 0, successes: 0, contradictions: 0, calibration_error: null, calibration_samples: 0,
    last_attribution_id: null, last_attribution_at: null, algorithm_version: SCOPED_TRUST_ALGORITHM_VERSION,
  };
}

/** Is `row` strictly after the state's cursor in (computed_at, id) order? */
export function isPastCursor(state: Pick<ScopedTrustState, "last_attribution_at" | "last_attribution_id">, row: Pick<AttributionLedgerRow, "id" | "computed_at">): boolean {
  if (!state.last_attribution_at) return true;
  const rowT = Date.parse(row.computed_at);
  const curT = Date.parse(state.last_attribution_at);
  if (!Number.isFinite(rowT) || !Number.isFinite(curT)) return false; // fail-closed: never fold an undated row
  if (rowT !== curT) return rowT > curT;
  return state.last_attribution_id ? row.id > state.last_attribution_id : true;
}

/**
 * Fold ledger rows into a scoped state. PURE. Rows must already be sorted by
 * (computed_at, id); rows at or before the cursor are skipped. Ungraded rows
 * (did_not_go: outcome_score null) advance the cursor but move nothing — the
 * traveler never tested the claim.
 */
export function foldScopedTrust(state: ScopedTrustState, rows: readonly AttributionLedgerRow[]): { next: ScopedTrustState; applied: AttributionLedgerRow[] } {
  const next: ScopedTrustState = { ...state };
  const applied: AttributionLedgerRow[] = [];
  for (const r of rows) {
    if (!isPastCursor(next, r)) continue;
    const score = num(r.outcome_score);
    const expected = num(r.expected_accuracy);
    const weight = num(r.weight) ?? 0;
    if (score !== null) {
      next.outcomes += 1;
      if (r.contradiction) next.contradictions += 1; else next.successes += 1;
      if (expected !== null) {
        next.trust = updateScopedTrust(next.trust, { outcomeScore: score, expectedAccuracy: expected, evidenceWeight: weight });
        const err = Math.abs(score - expected);
        const n = next.calibration_samples;
        next.calibration_error = n === 0 || next.calibration_error === null
          ? err
          : (next.calibration_error * n + err) / (n + 1);
        next.calibration_samples = n + 1;
      }
    }
    next.last_attribution_id = r.id;
    next.last_attribution_at = r.computed_at;
    applied.push(r);
  }
  next.algorithm_version = SCOPED_TRUST_ALGORITHM_VERSION;
  return { next, applied };
}

/** The trust_events bridge input for one graded row, or null when nothing bridges. */
export function bridgeEventFor(row: AttributionLedgerRow): { eventType: string; delta: number; severity: "minor" | "moderate" | "serious" | "severe" } | null {
  const signal = signalForAttribution({ outcome: row.outcome, contradiction: row.contradiction, expectedAccuracy: num(row.expected_accuracy) });
  if (!signal) return null;
  const effect = TRUST_SIGNAL_EFFECT[signal];
  // A zero-delta signal (calibrated_uncertainty) has no expression in the
  // existing engine's category scores; it lives in calibration_error only.
  if (effect.bridgeDelta === 0) return null;
  return { eventType: `intel_${signal}`, delta: effect.bridgeDelta, severity: effect.bridgeSeverity };
}

async function readState(db: any, actorId: string, scopeKey: string): Promise<ScopedTrustState | null> {
  const { data, error } = await db
    .from("intel_scoped_trust")
    .select("actor_id, scope_key, trust, outcomes, successes, contradictions, calibration_error, calibration_samples, last_attribution_id, last_attribution_at, algorithm_version")
    .eq("actor_id", actorId)
    .eq("scope_key", scopeKey)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const d = data as Record<string, unknown>;
  return {
    actor_id: actorId, scope_key: scopeKey,
    trust: num(d.trust) ?? DEFAULT_SCOPED_TRUST,
    outcomes: num(d.outcomes) ?? 0, successes: num(d.successes) ?? 0, contradictions: num(d.contradictions) ?? 0,
    calibration_error: num(d.calibration_error), calibration_samples: num(d.calibration_samples) ?? 0,
    last_attribution_id: typeof d.last_attribution_id === "string" ? d.last_attribution_id : null,
    last_attribution_at: typeof d.last_attribution_at === "string" ? d.last_attribution_at : null,
    algorithm_version: typeof d.algorithm_version === "string" ? d.algorithm_version : SCOPED_TRUST_ALGORITHM_VERSION,
  };
}

async function readLedgerPastCursor(db: any, state: ScopedTrustState): Promise<AttributionLedgerRow[]> {
  let q = db
    .from("intel_attributions")
    .select("id, actor_id, scope_key, outcome, outcome_score, expected_accuracy, weight, contradiction, computed_at")
    .eq("actor_id", state.actor_id)
    .eq("scope_key", state.scope_key);
  // The cursor's own instant is re-read (gte) and filtered in TS by (computed_at, id),
  // so two rows sharing computed_at are never split across the cursor.
  if (state.last_attribution_at) q = q.gte("computed_at", state.last_attribution_at);
  const { data, error } = await q
    .order("computed_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(MAX_ROWS_PER_CELL);
  if (error) throw error;
  return ((data ?? []) as AttributionLedgerRow[]).filter((r) => r.id && r.computed_at);
}

/** Persist the folded state. Returns false when a concurrent pass won the cursor. */
async function writeState(db: any, prev: ScopedTrustState | null, next: ScopedTrustState, now: Date): Promise<boolean> {
  const row = {
    trust: next.trust, outcomes: next.outcomes, successes: next.successes, contradictions: next.contradictions,
    calibration_error: next.calibration_error, calibration_samples: next.calibration_samples,
    last_attribution_id: next.last_attribution_id, last_attribution_at: next.last_attribution_at,
    algorithm_version: next.algorithm_version, last_updated_at: now.toISOString(),
  };
  if (!prev) {
    const { error } = await db.from("intel_scoped_trust").insert({ actor_id: next.actor_id, scope_key: next.scope_key, ...row });
    if (error) {
      if (error.code === "23505") return false; // another pass created the cell first
      throw error;
    }
    return true;
  }
  let q = db.from("intel_scoped_trust").update(row).eq("actor_id", next.actor_id).eq("scope_key", next.scope_key);
  q = prev.last_attribution_at ? q.eq("last_attribution_at", prev.last_attribution_at) : q.is("last_attribution_at", null);
  const { data, error } = await q.select("actor_id");
  if (error) throw error;
  return Array.isArray(data) ? data.length > 0 : Boolean(data);
}

/**
 * Bridge graded rows into the existing engine. Best-effort per row: the scoped
 * fold is the primary record; recordTrustEvent dedups on (user, type,
 * source_type, source_id) so a re-bridge after a crash is a no-op, and it is
 * itself gated on trust_engine_enabled (off ⇒ skipped, not an error).
 */
async function bridgeRows(db: any, rows: readonly AttributionLedgerRow[]): Promise<number> {
  let bridged = 0;
  for (const r of rows) {
    const ev = bridgeEventFor(r);
    if (!ev) continue;
    try {
      const res = await recordTrustEvent(db, {
        userId: r.actor_id,
        eventType: ev.eventType,
        category: "guide_accuracy",
        delta: ev.delta,
        severity: ev.severity,
        sourceType: TRUST_BRIDGE_SOURCE_TYPE,
        sourceId: r.id,
        metadata: { scope_key: r.scope_key, outcome: r.outcome, algorithm_version: SCOPED_TRUST_ALGORITHM_VERSION },
      });
      if (res.ok) bridged++;
    } catch (err) {
      logger.warn({ err, attribution_id: r.id }, "scoped trust: trust_events bridge failed (fold is recorded; bridge replays next pass)");
    }
  }
  return bridged;
}

export interface ApplyResult {
  cells: number;
  /** Attribution rows folded this call (past the cursor). */
  applied: number;
  /** trust_events rows written by the bridge. */
  bridged: number;
  /** Cells skipped because a concurrent pass advanced the cursor first. */
  lostRace: number;
}

/**
 * Apply scoped trust for the cells the given attribution rows touch. The rows
 * only name the cells; what is folded is read back from the ledger past each
 * cell's cursor, so a replay is exact and a missed pass is recovered.
 */
export async function applyScopedTrust(db: any, touched: ReadonlyArray<Pick<AttributionLedgerRow, "actor_id" | "scope_key">>, now: Date = new Date()): Promise<ApplyResult> {
  const cells = new Map<string, { actorId: string; scopeKey: string }>();
  for (const r of touched) if (r.actor_id && r.scope_key) cells.set(`${r.actor_id}|${r.scope_key}`, { actorId: r.actor_id, scopeKey: r.scope_key });
  const tally: ApplyResult = { cells: cells.size, applied: 0, bridged: 0, lostRace: 0 };
  for (const cell of cells.values()) {
    try {
      const prev = await readState(db, cell.actorId, cell.scopeKey);
      const state = prev ?? emptyScopedTrust(cell.actorId, cell.scopeKey);
      const ledger = await readLedgerPastCursor(db, state);
      const { next, applied } = foldScopedTrust(state, ledger);
      if (applied.length === 0) continue;
      const won = await writeState(db, prev, next, now);
      if (!won) { tally.lostRace++; continue; }
      tally.applied += applied.length;
      tally.bridged += await bridgeRows(db, applied);
    } catch (err) {
      logger.warn({ err, actor: cell.actorId, scope: cell.scopeKey }, "scoped trust: cell application failed (cursor unchanged; replays next pass)");
    }
  }
  return tally;
}

/** The TrustApplier the attribution scheduler calls after writing rows. */
export const scopedTrustApplier: TrustApplier = async (db, rows, now) => (await applyScopedTrust(db, rows, now)).applied;

/** Wire the applier into the attribution pass (index.ts). Idempotent. */
export function registerScopedTrustApplier(): void {
  setTrustApplier(scopedTrustApplier);
}

export interface ScopedTrustRead {
  trust: number;
  outcomes: number;
  successes: number;
  contradictions: number;
  calibrationError: number | null;
  badges: ScopedBadge[];
  algorithmVersion: string;
}

/**
 * Read one actor's trust in one scope. Internal, purpose-limited: the number is
 * for calibration and (future) confidence weighting; only `badges` is ever
 * public. NOT consumed by the confidence model in this unit. Null when the actor
 * has no folded outcome in that scope (a fresh scope is not "50" — it is unknown).
 */
export async function getScopedTrust(db: any, actorId: string, scope: ScopeInput | string): Promise<ScopedTrustRead | null> {
  const scopeKey = typeof scope === "string" ? scope : buildScopeKey(scope);
  const state = await readState(db, actorId, scopeKey);
  if (!state) return null;
  return {
    trust: state.trust,
    outcomes: state.outcomes,
    successes: state.successes,
    contradictions: state.contradictions,
    calibrationError: state.calibration_error,
    badges: deriveScopedBadges(state),
    algorithmVersion: state.algorithm_version,
  };
}
