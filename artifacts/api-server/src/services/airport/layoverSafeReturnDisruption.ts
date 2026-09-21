/**
 * §15.2 — the disruption state a layover is actually IN, remembered between
 * requests.
 *
 * ── THE DEFECT THIS FILE EXISTS FOR ──────────────────────────────────────────
 * `nextDisruptionState` (LayoverSafeReturnService.ts) is total, deterministic
 * and makes one guarantee the spec asks for by name: **the delay chain cannot
 * be re-entered from the cancellation chain.** Once a flight is CANCELLED, a
 * delay event leaves it CANCELLED.
 *
 * That guarantee was defeated at the only place the machine was ever called.
 * `handleEvent` reads the prior state from `ctx.disruptionStates?.[id] ?? "CONNECTION"`
 * (LayoverEventReplanner.ts:884) and NOTHING has ever populated that map —
 * `replanForWindowChange` does not pass it (LayoverReplanService.ts:967-973).
 * So every request starts from CONNECTION, and the next window edit after a
 * cancellation publishes `disruptionState: "DELAYED"`.
 *
 * A traveller whose flight is cancelled being told, by the API, that their
 * connection is merely delayed is the exact defect family §15/§16/§17 live in:
 * the server stating as fact about the traveller something it does not know.
 * The state machine was right; the memory was missing.
 *
 * ── WHY THE LEDGER, AND NOT A COLUMN ─────────────────────────────────────────
 * `layover_sessions` has no disruption column and this lane may not write a
 * migration. `layover_events` already exists, is already the §20 decision
 * ledger, is already owner-scoped, and is already cascade-deleted with the
 * session. The state is therefore an ATTRIBUTE OF A RECORDED DECISION rather
 * than a mutable field, which is the stronger shape anyway: the transition and
 * its cause are both retained.
 *
 * `layover_events.event_type` carries a closed CHECK constraint (0127:197-207,
 * widened once by 2741). `'disruption_recorded'` is NOT in it, so a row using
 * that value would be rejected by the database in production while passing
 * every in-memory double. This file therefore writes `'session_updated'` — a
 * value the constraint already accepts, and an honest description of what a
 * disruption is — and carries the disruption in `metadata.disruption`. The
 * dedicated event type is named in the report as the schema change it needs.
 *
 * ── FAIL CLOSED, TWICE ───────────────────────────────────────────────────────
 *  1. A ledger read that FAILS is not an absent history. `readDisruptionState`
 *     returns `ok:false`; callers must refuse rather than fall back to
 *     CONNECTION, because falling back is precisely the bug above with an
 *     outage as its cause instead of an omission.
 *  2. A stored value that is not one of the seven states is not CONNECTION
 *     either — it is a tree whose vocabulary has moved under the data. That is
 *     also `ok:false`, named.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../../lib/logger.js";
import {
  DISRUPTION_STATES,
  nextDisruptionState,
  type DisruptionEvent,
  type DisruptionState,
} from "./LayoverSafeReturnService.js";

/** Shape of `metadata.disruption`. Travels on every recorded transition. */
export const LAYOVER_DISRUPTION_LEDGER_VERSION = "2026.09.14-1";

/**
 * The `layover_events.event_type` this file writes.
 *
 * Constrained by the database, not chosen for taste — see the header. Exported
 * so the route test asserts the value the CHECK accepts rather than the value
 * this module would prefer.
 */
export const DISRUPTION_LEDGER_EVENT_TYPE = "session_updated";

/** How far back a state read will look. Bounded so one session cannot page. */
export const DISRUPTION_LEDGER_SCAN_LIMIT = 50;

export function isDisruptionState(v: unknown): v is DisruptionState {
  return typeof v === "string" && (DISRUPTION_STATES as readonly string[]).includes(v);
}

export interface DisruptionLedgerEntry {
  ledgerVersion: string;
  state: DisruptionState;
  previousState: DisruptionState;
  event: DisruptionEvent;
  /**
   * The departure time this session's delays are measured AGAINST — set once,
   * on the first recorded transition, and carried forward unchanged.
   *
   * §15.2's machine takes the TOTAL delay against the original schedule, not
   * the delta since the last edit, so two 90-minute slips must not add up to a
   * SEVERE_DELAY. Without a baseline there is nothing to total against;
   * `layover_sessions.departure_time` has already moved by the time the second
   * slip arrives.
   */
  baselineDepartureTime: string;
  /** The departure this transition moved the session to, when it moved one. */
  departureTime: string | null;
  recordedAt: string;
}

export type DisruptionStateRead =
  | {
      ok: true;
      state: DisruptionState;
      /** The baseline to measure total delay against; null when never recorded. */
      baselineDepartureTime: string | null;
      /** `"ledger"` when a transition was found, `"default"` when none ever was. */
      source: "ledger" | "default";
      recordedAt: string | null;
    }
  | { ok: false; message: string };

/**
 * The disruption state this session is in, as last recorded.
 *
 * A session with no recorded transition is genuinely `CONNECTION` and says so
 * with `source: "default"` — the caller can tell "never disrupted" from
 * "recovered back to CONNECTION", which the bare state cannot.
 */
export async function readDisruptionState(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<DisruptionStateRead> {
  const { data, error } = await db
    .from("layover_events")
    .select("metadata, created_at, event_type")
    .eq("session_id", sessionId)
    .eq("user_id", userId)
    .eq("event_type", DISRUPTION_LEDGER_EVENT_TYPE)
    .order("created_at", { ascending: false })
    .limit(DISRUPTION_LEDGER_SCAN_LIMIT);

  if (error) {
    logger.warn(
      { err: error, sessionId },
      "layover disruption ledger unreadable — refusing rather than assuming CONNECTION",
    );
    return { ok: false, message: String(error.message ?? "layover_events unreadable") };
  }

  const rows = Array.isArray(data) ? data : [];
  for (const row of rows) {
    const d = (row as any)?.metadata?.disruption;
    if (!d || typeof d !== "object") continue;
    if (!isDisruptionState(d.state)) {
      // A row that CLAIMS a disruption but names a state this build does not
      // know is not an absent history and must not be skipped past: the next
      // transition would be computed from a state that is not the real one.
      return {
        ok: false,
        message: `layover_events carries an unrecognised disruption state: ${String(d.state)}`,
      };
    }
    return {
      ok: true,
      state: d.state,
      baselineDepartureTime:
        typeof d.baselineDepartureTime === "string" ? d.baselineDepartureTime : null,
      source: "ledger",
      recordedAt: (row as any)?.created_at ?? null,
    };
  }

  return { ok: true, state: "CONNECTION", baselineDepartureTime: null, source: "default", recordedAt: null };
}

export type DisruptionWrite = { ok: true; entry: DisruptionLedgerEntry } | { ok: false; message: string };

/**
 * Record a transition.
 *
 * Unlike `emitLayoverEvent`, a failure here is NOT swallowed. The ledger is the
 * only memory this state has: a dropped write means the next request reads a
 * stale state and can tell a cancelled traveller they are merely delayed —
 * the defect this whole file is about, arriving by a different door.
 */
export async function recordDisruptionState(
  db: SupabaseClient,
  input: {
    sessionId: string;
    userId: string;
    previousState: DisruptionState;
    state: DisruptionState;
    event: DisruptionEvent;
    baselineDepartureTime: string;
    departureTime?: string | null;
    nowMs: number;
    certification?: Record<string, unknown> | null;
  },
): Promise<DisruptionWrite> {
  const entry: DisruptionLedgerEntry = {
    ledgerVersion: LAYOVER_DISRUPTION_LEDGER_VERSION,
    state: input.state,
    previousState: input.previousState,
    event: input.event,
    baselineDepartureTime: input.baselineDepartureTime,
    departureTime: input.departureTime ?? null,
    recordedAt: new Date(input.nowMs).toISOString(),
  };

  const { error } = await db.from("layover_events").insert({
    session_id: input.sessionId,
    user_id: input.userId,
    event_type: DISRUPTION_LEDGER_EVENT_TYPE,
    metadata: {
      disruption: entry,
      ...(input.certification ? { certification: input.certification } : {}),
    },
  });

  if (error) {
    logger.error(
      { err: error, sessionId: input.sessionId, state: input.state },
      "layover disruption transition NOT recorded — the next read will be stale",
    );
    return { ok: false, message: String(error.message ?? "layover_events unwritable") };
  }
  return { ok: true, entry };
}

/**
 * The disruption state after a traveller moved their own flight window.
 *
 * This is the correction to `replanForWindowChange`, which cannot see prior
 * state and so always publishes a transition out of CONNECTION. Two properties
 * it has and that one does not:
 *
 *  * **The cancellation chain survives an edit.** `nextDisruptionState` returns
 *    the current state for every delay arriving in CANCELLED/REBOOKING/RECOVERY,
 *    so carrying the prior state in is all that is required — this function
 *    adds no special case of its own, which is why it cannot disagree with the
 *    machine.
 *  * **Delay is measured against the BASELINE**, not the pre-edit departure, so
 *    two 90-minute slips are a 180-minute SEVERE_DELAY rather than two DELAYEDs.
 *
 * An edit that moves the departure EARLIER against the baseline is a delay of
 * `<= 0`, which the machine reads as on-time — correct: the flight is no longer
 * late.
 */
export function disruptionAfterWindowEdit(input: {
  prior: DisruptionState;
  baselineDepartureTime: string | null;
  beforeDepartureTime: string;
  afterDepartureTime: string;
}): { state: DisruptionState; delayMinutes: number; baselineDepartureTime: string } {
  const baseline = input.baselineDepartureTime ?? input.beforeDepartureTime;
  const baselineMs = new Date(baseline).getTime();
  const afterMs = new Date(input.afterDepartureTime).getTime();
  if (!Number.isFinite(baselineMs) || !Number.isFinite(afterMs)) {
    // Unparseable times cannot produce a delay; the state stands where it was
    // rather than being reset by arithmetic on NaN.
    return { state: input.prior, delayMinutes: 0, baselineDepartureTime: baseline };
  }
  const delayMinutes = Math.round((afterMs - baselineMs) / 60_000);
  return {
    state: nextDisruptionState(input.prior, { kind: "delay", delayMinutes }),
    delayMinutes,
    baselineDepartureTime: baseline,
  };
}

/**
 * §15 L145 — "rebooking / airline / airport help becomes available".
 *
 * `offerRecoveryHelp` is a boolean, and a boolean is not help. This publishes
 * WHAT IS AND IS NOT THERE beside it, in the same `available/reason` shape
 * `LayoverDegradedService` uses, so a client cannot render a rebooking button
 * over an integration that does not exist. None of the three is built; the row
 * stays `N` and this is the honest statement of why, on the wire.
 */
export interface RecoveryPosture {
  /** TRUE in the states where recovery help is what the traveller needs. */
  recoveryNeeded: boolean;
  rebooking: { available: false; reason: "no_airline_integration" };
  airlineContact: { available: false; reason: "no_airline_directory" };
  airportHelp: { available: false; reason: "no_airport_help_directory" };
}

export function recoveryPosture(state: DisruptionState): RecoveryPosture {
  return {
    recoveryNeeded:
      state === "CANCELLED" ||
      state === "REBOOKING" ||
      state === "SEVERE_DELAY" ||
      state === "OVERNIGHT",
    rebooking: { available: false, reason: "no_airline_integration" },
    airlineContact: { available: false, reason: "no_airline_directory" },
    airportHelp: { available: false, reason: "no_airport_help_directory" },
  };
}
