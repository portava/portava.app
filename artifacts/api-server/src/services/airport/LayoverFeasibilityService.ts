/**
 * LayoverFeasibilityService — spec §18 `LayoverFeasibilityService.evaluate(sessionId)`
 * (census-layover L175).
 *
 * ── WHAT THE CENSUS FOUND MISSING ───────────────────────────────────────────
 * "The computation exists and is invoked per session, but there is no service,
 * no session-scoped `evaluate`, and the result is a response body rather than a
 * certified, stored evaluation." Every route that certifies a session does the
 * same four steps inline — read the owned session, resolve its airport, certify,
 * and (on two of them) hand the record to `persistDecision`. This is those four
 * steps as one session-scoped entry point, so a caller asks "evaluate this
 * session" and gets the certified record AND what became of it in the ledger.
 *
 * ── NO ARITHMETIC AND NO JUDGEMENT ──────────────────────────────────────────
 * The record is the house's one derivation —
 * `consumerLayoverRecord ?? certifySessionFeasibility` with the owner's entry
 * corridor (`resolveLayoverEntry`), exactly as `/safety` and the notification
 * service build it — and the write is `persistDecision`, the one §20 writer.
 * Nothing here computes a number or decides a verdict.
 *
 * ── STORED ONLY BEHIND THE PRESS, AND IT SAYS WHICH ─────────────────────────
 * `layover_decision_persistence_enabled` is read with the FOUR-STATE reader:
 *   on                → `persistDecision`; its outcome is reported verbatim.
 *   off / absent      → `persistence_disabled`. Production today: the flag is
 *                       absent and 2700/2992/3792 are unapplied, so this path
 *                       reads the flag and writes NOTHING.
 *   unreadable        → `flag_unreadable`. Not "off": nothing was stored
 *                       because the state could not be established.
 * The certified record is returned on every one of those paths — it is real,
 * it is what the traveller is told elsewhere — but a snapshot id is returned
 * ONLY when the ledger confirmed the row exists. An id nothing can resolve is
 * the one thing a caller must never be handed (LayoverDecisionStore's header).
 *
 * ── THE BOUNDARIES ──────────────────────────────────────────────────────────
 *   - `userId` is the owner. A session of another user is `not_found`, never
 *     "forbidden" (`getSession` filters by both).
 *   - An unreadable session or airport is a REFUSAL, never a certification
 *     against defaults (`getSession`, `resolveSessionAirport`).
 *   - An ENDED session (`layoverSessionIsLiveAt` false) is refused before any
 *     write: a ledger row about a layover that is over is a row about nothing.
 *   - It never throws on a database failure; every failure is a named reason.
 *
 * NAMED FOR THE SPEC'S SERVICE, NOT FOR `LayoverFeasibility.ts`, which is the
 * pure engine module and stays pure. Nothing here stores or reads a location.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { readFlagState } from "../../lib/capability/schemaCapability.js";
import { getSession, layoverSessionIsLiveAt } from "./LayoverSessionService.js";
import { resolveSessionAirport, consumerLayoverRecord } from "./LayoverSnapshot.js";
import {
  certificationHeader,
  certifySessionFeasibility,
  type LayoverFeasibilityRecord,
} from "./LayoverFeasibility.js";
import { resolveLayoverEntry, layoverAirportCountry } from "./layoverEntryGate.js";
import {
  persistDecision,
  type PersistRefusal,
  type PersistState,
} from "../layover/LayoverDecisionStore.js";

/** Why there is no evaluation at all. Nothing was certified and nothing was written. */
export type FeasibilityEvaluationRefusal =
  /** `layover_sessions` could not be read. */
  | "session_unreadable"
  /** No such session for this user. */
  | "not_found"
  /** The session's departure has passed under a terminal status. */
  | "session_ended"
  /** `airport_profiles` could not be read; certifying against defaults is refused. */
  | "airport_unreadable";

/** What became of the evaluation in the §20 ledger. */
export type EvaluationStorage =
  | {
      stored: true;
      /** The ledger row's snapshot identity. Returned ONLY here. */
      snapshotId: string;
      state: PersistState;
      unwritten: Array<"time_budget" | "return_plan">;
    }
  | {
      stored: false;
      reason: "flag_unreadable" | PersistRefusal | CanonicalRefusal; // CanonicalRefusal (lane B2-RECS-A, L6): the canonical door served this record uncited and says why
    };

export type FeasibilityEvaluation =
  | {
      ok: true;
      sessionId: string;
      /** The certified record — the one derivation every surface uses. */
      record: LayoverFeasibilityRecord;
      /** §20 header fields (engine version, input hash, verdict, confidence). */
      certification: ReturnType<typeof certificationHeader>;
      storage: EvaluationStorage;
    }
  | { ok: false; reason: FeasibilityEvaluationRefusal };

/**
 * Spec §18 `LayoverFeasibilityService.evaluate(sessionId)`: certify ONE owned
 * session at ONE instant and store the certified evaluation when the ledger is
 * switched on.
 */
export async function evaluate(
  db: SupabaseClient,
  userId: string,
  sessionId: string,
  opts: { nowMs?: number; loaded?: LoadedLayoverSession } = {}, // `loaded` (lane B2-RECS-A, L175): a route that already read the owned session and its airport hands them in, so evaluate() costs no second read
): Promise<FeasibilityEvaluation> {
  const nowMs = opts.nowMs ?? Date.now();

  const read = opts.loaded ? { ok: true as const, session: opts.loaded.session } : await getSession(db, sessionId, userId);
  if (!read.ok) return { ok: false, reason: "session_unreadable" };
  const session = read.session;
  if (!session || session.id !== sessionId || session.userId !== userId) return { ok: false, reason: "not_found" };
  if (!layoverSessionIsLiveAt(session, nowMs)) return { ok: false, reason: "session_ended" };

  const airportRead = opts.loaded ? { ok: true as const, airport: opts.loaded.airport } : await resolveSessionAirport(db, session);
  if (!airportRead.ok) return { ok: false, reason: "airport_unreadable" };
  const airport = airportRead.airport;

  // The snapshot first, the legacy arm only on a null snapshot — on ONE line,
  // the shape layoverSnapshotConsumers.test.ts (C1) recognises as a legacy arm.
  const record = (await consumerLayoverRecord(db, airport, session, nowMs)) ?? certifySessionFeasibility(airport, session, {
    nowMs,
    entry: await resolveLayoverEntry(db, session.userId, layoverAirportCountry(airport)),
  });

  return {
    ok: true,
    sessionId: session.id,
    record,
    certification: certificationHeader(record),
    storage: await storeEvaluation(db, userId, session.id, record),
  };
}

/** The literal is spelled here so check:flag-polarity can resolve it. */
async function storeEvaluation(
  db: SupabaseClient,
  userId: string,
  sessionId: string,
  record: LayoverFeasibilityRecord,
): Promise<EvaluationStorage> {
  const canon = canonicalOutcomeOf(record); if (canon) return canonicalStorage(canon); const flag = await readFlagState(db, "layover_decision_persistence_enabled"); // L6: the canonical door already stored (or reused) this record — report THAT, never a second write
  if (flag === "unreadable") return { stored: false, reason: "flag_unreadable" };
  if (flag !== "on") return { stored: false, reason: "persistence_disabled" };

  const persisted = await persistDecision(db, userId, sessionId, record);
  if (!persisted.ok) return { stored: false, reason: persisted.reason };
  return { stored: true, snapshotId: persisted.snapshotId, state: persisted.state, unwritten: [...persisted.unwritten] };
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYOVER 165, lane B2-RECS-A — L6 / L175: evaluate() over the canonical snapshot.
//
// Appended at the TAIL so every line above keeps its number; ESM hoists the
// imports. With `layover_canonical_snapshot_enabled` ON the record evaluate()
// receives from the door (consumerLayoverRecord → certifiedLayoverSnapshot) is
// the session's canonical snapshot, and the door has ALREADY stored it through
// the compare-and-swap (or served the stored active one). `storeEvaluation`
// reports that outcome instead of writing again: a second persistDecision would
// be the double write the canonical snapshot exists to remove.
// ═══════════════════════════════════════════════════════════════════════════
import type { LoadedLayoverSession } from "./LayoverSnapshot.js";
import { canonicalOutcomeOf, type CanonicalOutcome, type CanonicalRefusal } from "../layover/LayoverActiveSnapshot.js";

/** The canonical door's outcome, in evaluate()'s storage vocabulary. */
function canonicalStorage(canon: CanonicalOutcome): EvaluationStorage {
  if (!canon.canonical) return { stored: false, reason: canon.reason };
  if (canon.state === "recorded" && canon.persisted) return { stored: true, snapshotId: canon.snapshotId, state: canon.persisted.state, unwritten: [...canon.persisted.unwritten] };
  return { stored: true, snapshotId: canon.snapshotId, state: "active_snapshot", unwritten: [] };
}

export { certifyRecommendation } from "../layover/LayoverRecommendationStatus.js";
