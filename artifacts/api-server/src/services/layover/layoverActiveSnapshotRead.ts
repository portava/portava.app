/**
 * layoverActiveSnapshotRead — the READ half of the canonical snapshot (census-layover L6 / L264): the session's
 * active snapshot as stored, and "is this the same decision". No writes, and no import of the decision store, so
 * the store (which checks a write against the active snapshot) and the door (LayoverActiveSnapshot.ts, which writes
 * through the store) can both use it without an import cycle. See LayoverActiveSnapshot.ts's header for the design.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { replayFeasibility, type FeasibilityInputs, type LayoverFeasibilityRecord } from "../airport/LayoverFeasibility.js";
import { snapshotIdFor } from "../airport/layoverLedger.js";

const logger = rootLogger.child({ service: "layoverActiveSnapshotRead" });

/** The session's active snapshot, as stored. */
export interface ActiveSnapshot {
  snapshotId: string;
  /** 3623's per-session `snapshot_version` (>= 1). The compare-and-swap's expectation. */
  version: number;
  /** The stored decision, REPLAYED from its stored inputs and checked against its stored input hash. */
  record: LayoverFeasibilityRecord;
}

export type ActiveSnapshotRead =
  | { ok: true; active: ActiveSnapshot | null }
  | { ok: false; reason: "active_snapshot_unreadable" | "active_snapshot_unreplayable" };

/** The columns of the active computation this module reads. */
const ACTIVE_COLUMNS = "snapshot_id,snapshot_version,input_hash,inputs";

/**
 * The session's ACTIVE snapshot (3828's pointer) and the computation it names, in ONE request.
 *
 * `active: null` is a MEASURED absence (no snapshot has been stored for the session, or the one it pointed at was
 * compacted away). A failed read is `ok: false`, never `null`: "no snapshot is active" and "we could not look" lead to
 * different writes (expectation 0 versus no write at all).
 *
 * A stored row whose inputs do not replay to its own stored hash is REFUSED (`active_snapshot_unreplayable`): serving
 * it would publish a decision that disagrees with the row it claims to be.
 */
export async function readActiveSnapshot(db: SupabaseClient, sessionId: string): Promise<ActiveSnapshotRead> {
  try {
    const { data, error } = await db
      .from("layover_sessions")
      .select(`active_snapshot_id, active:layover_certified_computations!layover_sessions_active_snapshot_id_fkey(${ACTIVE_COLUMNS})`)
      .eq("id", sessionId)
      .maybeSingle();
    if (error) {
      logger.warn({ err: error.message, sessionId }, "active snapshot unreadable — refusing to name one");
      return { ok: false, reason: "active_snapshot_unreadable" };
    }
    const row = data as { active_snapshot_id?: unknown; active?: unknown } | null;
    if (!row || row.active_snapshot_id == null) return { ok: true, active: null };
    const c = (Array.isArray(row.active) ? row.active[0] : row.active) as Record<string, unknown> | null | undefined;
    if (!c) return { ok: true, active: null };
    const version = Number(c["snapshot_version"]);
    if (typeof c["snapshot_id"] !== "string" || !Number.isInteger(version) || version < 1) {
      logger.warn({ sessionId }, "active snapshot row has no usable identity or version — refusing it");
      return { ok: false, reason: "active_snapshot_unreplayable" };
    }
    let record: LayoverFeasibilityRecord;
    try {
      record = replayFeasibility(c["inputs"] as FeasibilityInputs);
    } catch (err) {
      logger.warn({ sessionId, err: err instanceof Error ? err.message : String(err) }, "active snapshot inputs do not replay — refusing it");
      return { ok: false, reason: "active_snapshot_unreplayable" };
    }
    if (record.inputHash !== c["input_hash"] || snapshotIdFor(sessionId, record.inputHash) !== c["snapshot_id"]) {
      logger.warn({ sessionId, snapshotId: c["snapshot_id"] }, "active snapshot does not replay to its own stored identity — refusing it");
      return { ok: false, reason: "active_snapshot_unreplayable" };
    }
    return { ok: true, active: { snapshotId: c["snapshot_id"], version, record } };
  } catch (err) {
    logger.warn({ sessionId, err: err instanceof Error ? err.message : String(err) }, "active snapshot read threw — refusing to name one");
    return { ok: false, reason: "active_snapshot_unreadable" };
  }
}

// ── "the same decision" ───────────────────────────────────────────────────────────────────────────────────────────

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ":" + stable(o[k])).join(",") + "}";
}

/** Every input of the certification EXCEPT the instant it was taken at. */
export function inputsApartFromClock(inputs: FeasibilityInputs): string {
  const { nowMs: _clock, ...rest } = inputs;
  return stable(rest);
}

/** The published decision: every figure a surface shows, and every gate a surface admits by. */
export function decisionOf(r: LayoverFeasibilityRecord): string {
  return stable({
    verdict: r.verdict,
    confidence: r.confidence,
    tier: r.envelope.tier,
    returnState: r.envelope.returnState,
    usableMinutes: r.envelope.usableMinutes,
    totalMinutes: r.envelope.totalMinutes,
    temporalConflict: r.envelope.temporalConflict ?? null,
    hardReturnMs: r.deadline.hardReturnTime.getTime(),
    cutoffMs: r.deadline.cutoffMs,
    reasonCodes: [...r.reasonCodes].sort(),
    unknowns: [...r.unknowns].sort(),
    landsideGate: r.landsideGate ?? null,
    windowOnly: { rating: r.windowOnly.rating, availableMinutes: r.windowOnly.availableMinutes },
  });
}

/**
 * Does the stored `active` record certify the same decision a fresh certification (`candidate`) would publish?
 *
 * PURE. Both halves must hold: the same inputs apart from the clock (so nothing the traveller or the world changed is
 * hidden behind an old answer), AND the same published decision (so no clock-driven figure — the usable minutes,
 * the return state, the window — is served stale). Two records that differ only in the instant they were taken at,
 * within the minute in which every figure is equal, are one decision.
 */
export function sameDecision(active: LayoverFeasibilityRecord, candidate: LayoverFeasibilityRecord): boolean {
  if (active.engineVersion !== candidate.engineVersion || active.feasibilityVersion !== candidate.feasibilityVersion) return false;
  if (inputsApartFromClock(active.inputs) !== inputsApartFromClock(candidate.inputs)) return false;
  return decisionOf(active) === decisionOf(candidate);
}
