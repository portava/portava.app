/**
 * LayoverOutcomeStore — §4's `layover_outcomes`, written when a traveller closes
 * a layover. census-layover L32, and through it L10, L174, L195 and L214.
 *
 * ── WHAT WAS MISSING ────────────────────────────────────────────────────────
 * Migration 2992 created `layover_outcomes` and `LayoverDecisionStore.ts`'s
 * header says plainly that nothing writes it, for a reason that WAS true when
 * it was written: *"L32 needs a session to COMPLETE, and `status = 'completed'`
 * still has no writer."* It has one now. The end-of-layover sheet asks "I made
 * my flight" / "I'm ending it early" and `DELETE /airport/sessions/:id` records
 * the answer as `completed` / `cancelled`. So the outcome exists as an EVENT
 * and was never stored as an OUTCOME — the system could close a layover but
 * could not answer L10's question, "did this end in a safe return?", for any
 * layover after the fact.
 *
 * ── WHAT IS WRITTEN, AND WHAT IS DELIBERATELY LEFT NULL ─────────────────────
 * One row per session (`session_id` is the primary key; the write is an upsert,
 * so a replayed close is the same row):
 *
 *   boarding_outcome   'BOARDED' when the traveller said "I made my flight";
 *                      'UNKNOWN' when they ended early. Ending early is not
 *                      evidence of a missed flight, and the schema's 'MISSED'
 *                      is not inferred from it.
 *   completed_at       the close instant for a completed layover; NULL for one
 *                      ended early — nothing was completed.
 *
 *   left_airport, actual_airport_return_at
 *                      From the traveller's OWN checkpoints
 *                      (`LayoverCheckpointStore.observedReturnFrom`): TRUE and
 *                      the first re-entry after the last exit when they reported
 *                      leaving; NULL when they reported nothing, or when the
 *                      checkpoints could not be read. Never FALSE: "did not leave
 *                      the airport" would be a claim made from the absence of a
 *                      report, which is exactly the failed-read-as-a-value this
 *                      repository's master invariant forbids.
 *
 *   completed_experience, met_people_count, comfort_rating, plan_change_reason
 *                      ALL NULL. Nothing on this tree observes them: the plan has
 *                      no "done" state and the sheet asks no rating. NULL is "not
 *                      observed", which is what the schema's nullable columns
 *                      are for.
 *
 * No coordinate is written; the table has no coordinate column and 2992's
 * postcondition asserts it never will.
 *
 * ── THE GATE IS 2992'S OWN, AND IT IS LOAD-BEARING ──────────────────────────
 * supabase-js sends every key of an upsert, so on a database that has not run
 * 2992 this write fails outright. The write is therefore gated on
 * `layover_decision_persistence_enabled` — the flag 2992 seeds FALSE and whose
 * deployment sequence (2992's header, step 5) says is flipped ONLY after 2700
 * and 2992 are applied and re-probed. One gate for "2992's tables may be
 * written" rather than a second flag that could be switched on against a
 * database that has none of them. `isFlagEnabled` reads an absent or
 * unreadable flag as FALSE, so the default is no write.
 *
 * ── A FAILED OR DISABLED WRITE NEVER FAILS THE CLOSE ────────────────────────
 * The traveller is at a gate. The session close has already succeeded when
 * this runs, and an outcome that could not be stored must not turn "Your
 * layover is closed" into an error. It is REPORTED instead —
 * `{ recorded: false, reason }` on the response and a warning in the log — so
 * nothing downstream mistakes "not stored" for "stored".
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { DECISION_PERSISTENCE_FLAG } from "./LayoverDecisionStore.js";
import { observedReturnFrom, readTravellerCheckpoints } from "./LayoverCheckpointStore.js";

const logger = rootLogger.child({ service: "LayoverOutcomeStore" });

/** 2992's write gate — see the header for why it is shared rather than a new flag. */
export const OUTCOME_WRITE_FLAG = DECISION_PERSISTENCE_FLAG;

/** 2992's CHECK vocabulary for `boarding_outcome`, verbatim. */
export const BOARDING_OUTCOMES = ["BOARDED", "MISSED", "REBOOKED", "CANCELLED", "UNKNOWN"] as const;
export type BoardingOutcome = (typeof BOARDING_OUTCOMES)[number];

export type LayoverCloseOutcome = "completed" | "cancelled";

export type OutcomeWrite =
  | { recorded: true; boardingOutcome: BoardingOutcome }
  | { recorded: false; reason: "persistence_disabled" | "write_failed" };

/**
 * The row. Pure, so the suite can assert every column — including the ones
 * that must stay NULL.
 */
export function layoverOutcomeRow(
  sessionId: string,
  outcome: LayoverCloseOutcome,
  nowMs: number,
  observed: { leftAirport: boolean | null; actualAirportReturnAt: string | null } = { leftAirport: null, actualAirportReturnAt: null },
): Record<string, unknown> {
  const now = new Date(nowMs).toISOString();
  return {
    session_id: sessionId,
    completed_at: outcome === "completed" ? now : null,
    left_airport: observed.leftAirport,
    completed_experience: null,
    met_people_count: null,
    actual_airport_return_at: observed.actualAirportReturnAt,
    boarding_outcome: outcome === "completed" ? "BOARDED" : "UNKNOWN",
    comfort_rating: null,
    plan_change_reason: null,
    updated_at: now,
  };
}

/**
 * Store the outcome of a layover that has just been closed. Never throws and
 * never fails the close; see the header.
 */
export async function recordLayoverOutcome(
  db: SupabaseClient,
  args: { sessionId: string; outcome: LayoverCloseOutcome; nowMs: number },
): Promise<OutcomeWrite> {
  try {
    if (!(await isFlagEnabled(db, OUTCOME_WRITE_FLAG))) {
      return { recorded: false, reason: "persistence_disabled" };
    }
    // A failed or disabled checkpoint read is NOT OBSERVED, never "stayed airside".
    const observed = observedReturnFrom(await readTravellerCheckpoints(db, args.sessionId, args.nowMs));
    const row = layoverOutcomeRow(args.sessionId, args.outcome, args.nowMs, observed);
    // `.from("<literal>")`, not a constant: check:write-path-columns resolves a
    // write site only when it can see the table name (LayoverDecisionStore's
    // note on the same hazard).
    const { error } = await db
      .from("layover_outcomes")
      .upsert(row, { onConflict: "session_id" });
    if (error) {
      logger.warn({ err: error, sessionId: args.sessionId }, "layover outcome write failed — the close stands, the outcome is NOT stored");
      return { recorded: false, reason: "write_failed" };
    }
    return { recorded: true, boardingOutcome: row.boarding_outcome as BoardingOutcome };
  } catch (err) {
    logger.warn({ err, sessionId: args.sessionId }, "layover outcome write threw — the close stands, the outcome is NOT stored");
    return { recorded: false, reason: "write_failed" };
  }
}
