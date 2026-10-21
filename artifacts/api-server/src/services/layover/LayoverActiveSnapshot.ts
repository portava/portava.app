/**
 * LayoverActiveSnapshot — ONE canonical, versioned decision snapshot per session, read by every surface.
 *
 * Spec §2.1 (census-layover L6): "All surfaces consume the same certified LayoverSnapshot / RecommendationContract;
 * no duplicate time-budget logic." Spec north star: "All Portava surfaces should agree because they are reading the
 * same certified operational truth." Spec §24 / App C6 (census-layover L264): "Version/compare-and-swap active
 * snapshot; reject stale writes" / "Never update the active snapshot with a stale engine result". Owner directive
 * 2026-10-18: "Use one canonical, versioned decision snapshot. All recommendation surfaces must evaluate through the
 * same authoritative process."
 *
 * ── WHAT WAS WRONG (lane B1-P measured it on the real chain) ───────────────────────────────────────────────────
 * Every surface certified its OWN instant: `nowMs` is part of the input hash, so the overview, /safety, the cards
 * and the explain each stored (when they stored at all) a DIFFERENT snapshot of the same session in the same second,
 * and the notifications, Safe Return, constraints, Compass and Discovery stored none. "The same snapshot" was true
 * only of the arithmetic, never of the published answer. 3828 gave the session an ACTIVE snapshot pointer; nothing
 * read it.
 *
 * ── WHAT THIS MODULE DOES ────────────────────────────────────────────────────────────────────────────────────────
 * `canonicalLayoverRecord(db, session, certify)` is the one door every certified layover surface goes through (it is
 * called from services/airport/LayoverSnapshot.ts's certification — the door the overview, /safety, the
 * recommendations, Safe Return, the notifications, the constraint surfaces, Compass and Discovery already share):
 *
 *   1. READ THE ACTIVE SNAPSHOT FIRST — `layover_sessions.active_snapshot_id` and the stored computation it names, in
 *      one request — BEFORE anything is certified, so its version is the expectation a later write is compared with.
 *   2. CERTIFY the candidate exactly as the surface always did (`certify`: the door's own certification, entry
 *      corridor and live conditions included). No arithmetic is added here.
 *   3. If the ACTIVE snapshot certifies THE SAME DECISION (`sameDecision`: the same inputs apart from the clock, and
 *      the same verdict, confidence, deadline, usable minutes, tier, return state, reason codes and landside gate),
 *      SERVE THE ACTIVE SNAPSHOT — the stored record, replayed from its stored inputs and checked against its stored
 *      hash. Every surface reading in the same decision window publishes the same snapshot id, and nothing is written.
 *   4. Otherwise STORE the candidate through the compare-and-swap (persistDecision with the active version read in
 *      step 1; 3873's trigger refuses it if another writer moved the active snapshot meanwhile — LY409 — or the
 *      session was edited after it was read — LY412) and serve it: it is now the active snapshot.
 *   5. On a stale write: re-read the active snapshot; if it is the same decision, serve it (another surface stored it
 *      first); otherwise refuse the old candidate. Reusing the new expectation would let a stale certification overwrite
 *      UNCITED, with the reason named (`canonicalOutcomeOf(record)`), and never overwrites.
 *
 * ── WHEN IT IS OFF ───────────────────────────────────────────────────────────────────────────────────────────────
 * `layover_canonical_snapshot_enabled` (3873, seeded FALSE) AND `layover_decision_persistence_enabled` (2992, seeded
 * FALSE) must both be ON. Otherwise `canonicalLayoverRecord` answers `null` after the flag reads and the caller
 * certifies exactly as before — byte for byte. Production today: both absent.
 *
 * ── WHAT "THE SAME DECISION" DELIBERATELY INCLUDES ────────────────────────────────────────────────────────────────
 * The usable minutes are part of it. They are measured from `max(now, earliest landside)`, so once a traveller can be
 * out they fall by one each minute; a snapshot is therefore reused only within the minute in which every published
 * figure is still exactly what a fresh certification would say. "Reuse while only the clock moved" would have served
 * a usable-minutes figure that overstates the window — the one number on the screen that must never be generous.
 * A new decision (a minute later, an edit, a declared constraint, a live reading, an entry change) is a new snapshot,
 * version n+1, and the previous one stays stored (3896: immutable) for replay and explain.
 *
 * Never throws for a database failure: every failure is a named outcome and the candidate (a correct certification
 * of now) is served. Reads no location; writes nothing but the computation persistDecision writes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import type { LayoverFeasibilityRecord } from "../airport/LayoverFeasibility.js";
import { persistDecision, type PersistRefusal, type PersistState } from "./LayoverDecisionStore.js";
import { readActiveSnapshot, sameDecision, type ActiveSnapshot } from "./layoverActiveSnapshotRead.js";

export { readActiveSnapshot, sameDecision, decisionOf, inputsApartFromClock, type ActiveSnapshot, type ActiveSnapshotRead } from "./layoverActiveSnapshotRead.js";

const logger = rootLogger.child({ service: "LayoverActiveSnapshot" });

/** Seeded FALSE by migration 3873. Spelled as a literal at its reader for check:flag-polarity. */
export const CANONICAL_SNAPSHOT_FLAG = "layover_canonical_snapshot_enabled";

// ── the outcome, held beside the record ───────────────────────────────────────────────────────────────────────────

export type CanonicalState =
  /** The session's active snapshot certified the same decision; it was served and nothing was written. */
  | "active_snapshot"
  /** The candidate was stored through the compare-and-swap and is now the active snapshot. */
  | "recorded"
  /** Another surface stored the same decision first; its snapshot was served. */
  | "adopted_concurrent";

export type CanonicalRefusal =
  | "active_snapshot_unreadable"
  | "active_snapshot_unreplayable"
  | "contended"
  | PersistRefusal;

export type CanonicalOutcome =
  | {
      canonical: true;
      snapshotId: string;
      version: number | null;
      state: CanonicalState;
      /** On `recorded` only: what persistDecision reported for the write (children included). */
      persisted?: { state: PersistState; unwritten: Array<"time_budget" | "return_plan"> };
    }
  | { canonical: false; reason: CanonicalRefusal };

const OUTCOMES = new WeakMap<LayoverFeasibilityRecord, CanonicalOutcome>();

/** What the canonical door did with this record, or `undefined` for a record it did not hand out. */
export function canonicalOutcomeOf(record: LayoverFeasibilityRecord): CanonicalOutcome | undefined {
  return OUTCOMES.get(record);
}

function hand(record: LayoverFeasibilityRecord, outcome: CanonicalOutcome, validatedNowMs = record.inputs.nowMs): LayoverFeasibilityRecord {
  OUTCOMES.set(record, outcome); if (outcome.canonical) markCanonicalValidation(record, validatedNowMs);
  return record;
}

/** Both switches, fail-closed (an unreadable flag is OFF: the caller certifies as before). */
export async function canonicalSnapshotSwitchedOn(db: SupabaseClient): Promise<boolean> {
  if (!(await isFlagEnabled(db, "layover_canonical_snapshot_enabled"))) return false;
  return isFlagEnabled(db, "layover_decision_persistence_enabled");
}

/** The session fields the door needs. */
export interface CanonicalSession {
  id: string;
  userId: string;
}

/**
 * THE DOOR (see the header). `null` when the canonical snapshot is switched off — the caller certifies exactly as
 * before. Otherwise ALWAYS a record: the active snapshot's, the candidate stored as the new active one, or (on a named
 * refusal) the candidate uncited.
 */
export async function canonicalLayoverRecord(
  db: SupabaseClient,
  session: CanonicalSession,
  certify: () => Promise<LayoverFeasibilityRecord> | LayoverFeasibilityRecord,
): Promise<LayoverFeasibilityRecord | null> {
  if (!(await canonicalSnapshotSwitchedOn(db))) return null;

  // 1. The expectation, read BEFORE the inputs are.
  const first = await readActiveSnapshot(db, session.id);
  // 2. The candidate, exactly as the surface certifies it.
  const candidate = await certify();
  if (!first.ok) return hand(candidate, { canonical: false, reason: first.reason });

  // 3. Same decision: serve what is stored.
  if (first.active && sameDecision(first.active.record, candidate)) {
    await syncBoundReturn(db, session.id, first.active.record); return hand(first.active.record, { canonical: true, snapshotId: first.active.snapshotId, version: first.active.version, state: "active_snapshot" }, candidate.inputs.nowMs);
  }

  // 4./5. Store through the compare-and-swap; on a stale write re-read once, adopting only the identical decision.
  let expected: ActiveSnapshot | null = first.active;
  for (let attempt = 0; attempt < 1; attempt += 1) {
    const persisted = await persistDecision(db, session.userId, session.id, candidate, { canonical: { expectedActive: expected } });
    if (persisted.ok) {
      await syncBoundReturn(db, session.id, candidate); return hand(candidate, { canonical: true, snapshotId: persisted.snapshotId, version: null, state: "recorded", persisted: { state: persisted.state, unwritten: [...persisted.unwritten] } });
    }
    if (persisted.reason !== "stale_snapshot_write") return hand(candidate, { canonical: false, reason: persisted.reason });
    const again = await readActiveSnapshot(db, session.id);
    if (!again.ok) return hand(candidate, { canonical: false, reason: again.reason });
    if (again.active && sameDecision(again.active.record, candidate)) {
      await syncBoundReturn(db, session.id, again.active.record); return hand(again.active.record, { canonical: true, snapshotId: again.active.snapshotId, version: again.active.version, state: "adopted_concurrent" }, candidate.inputs.nowMs);
    }
    expected = again.active;
  }
  logger.warn({ sessionId: session.id }, "canonical snapshot: another decision won the compare-and-swap — refusing the stale certification");
  return hand(candidate, { canonical: false, reason: "stale_snapshot_write" });
}

/** `canonicalLayoverRecord`, or the caller's own certification when the canonical snapshot is switched off. */
export async function canonicalLayoverRecordOr(
  db: SupabaseClient,
  session: CanonicalSession,
  certify: () => Promise<LayoverFeasibilityRecord> | LayoverFeasibilityRecord,
): Promise<LayoverFeasibilityRecord> {
  return (await canonicalLayoverRecord(db, session, certify)) ?? (await certify());
}

import { markCanonicalValidation } from "./layoverCanonicalValidity.js";

/** Linked timers may tighten after publication; failures remain visible and are retried on the next canonical read. */
async function syncBoundReturn(db: SupabaseClient, sessionId: string, record: LayoverFeasibilityRecord): Promise<void> {
  try {
    const { syncLayoverSafeReturnDeadline } = await import("../airport/LayoverSafeReturnService.js");
    const result = await syncLayoverSafeReturnDeadline(db, sessionId, record);
    if (!result.ok) logger.warn({ sessionId, reason: result.reason }, "canonical snapshot published but bound Safe Return deadline could not synchronize");
  } catch (err) {
    logger.warn({ err, sessionId }, "canonical snapshot published but bound Safe Return synchronization unavailable");
  }
}
