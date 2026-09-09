/**
 * Event lifecycle — the transition INTO `started`, which nothing wrote before.
 *
 * THE DEFECT (measured on production 2026-09-07, ajrurzioarfkagpuxfnb)
 * =====================================================================
 * `events.state` is the enum draft | open | full | waitlist | started |
 * completed | cancelled | archived. Every route that means "during or after
 * the event" gates on `started`:
 *   routes/events.ts POST /events/:id/complete       state === 'started'
 *   routes/events.ts POST /events/:id/attendance/:u  state IN (started, completed)
 *   routes/events.ts POST /events/:id/noshow/:u      state IN (started, completed)
 * and no route, sweeper, migration function or trigger ever wrote it. The only
 * path that could was PATCH /events/:id with a raw `state` in the body (an
 * unguarded host-only free-transition, see the doc). Production: 97 open, 96
 * of them past starts_at, 0 started; the 7 completed rows were seeded directly
 * by src/scripts/seed-demo-profile.ts (isPast ? "completed" : "open") and have
 * no activity-log row — none passed through any route.
 *
 * WHAT THIS MODULE IS
 * ===================
 *   decideEventStart   — the PURE transition rule. One function, no I/O, no
 *                        clock of its own. Any caller (this scheduler now; a
 *                        host-initiated POST /events/:id/start later, if the
 *                        owner chooses it) applies the same rule, so adding a
 *                        route is a caller, not a rework.
 *   runEventStartPass  — one scheduler pass: flag → read due rows → apply the
 *                        rule row by row → conditional UPDATE. Every supabase
 *                        result's `.error` is checked; a failed read is
 *                        reported as reason=error, never as "no events".
 *   start/stop…Scheduler — the house shape (memoryProjectionScheduler,
 *                        mapTripProjectionWorker): startup delay, self-
 *                        rescheduling timer, errors logged and swallowed.
 *
 * THE RULE, AND WHY IT IS DERIVED RATHER THAN INVENTED
 * ====================================================
 *   from ∈ {open, full, waitlist}  ∧  starts_at IS NOT NULL  ∧  starts_at ≤ now
 *     ⇒ started
 * `open | full | waitlist` is the repo's own "published, before it begins"
 * set: recomputeEventState (routes/events.ts) cycles an event among exactly
 * those three by capacity; migration 2033's RLS policy and both passport
 * LIVE_EVENT_STATES sets group them with `started` as the live states; the
 * complete route's own message calls `started` "active", and the attendance
 * gates say "during or after the event". `starts_at` is the only column that
 * says when "during" begins. Nothing else moves: draft (unpublished; postpone
 * writes it), cancelled, archived, completed and started itself are refused by
 * the rule, and the UPDATE re-asserts `state IN (startable)` so a cancel that
 * lands between the read and the write wins.
 *
 * `starts_at` is nullable (production: 1 open event with NULL) — a NULL start
 * is never due. `ends_at` is not consulted: whether an event whose window has
 * fully elapsed should still pass through `started` (so its host can complete
 * it) or be auto-completed is part of the owner decision below; the rule takes
 * the smallest step and the doc records the question.
 *
 * OWNER DECISION — EVENT_START_TRANSITION (not taken here)
 * ========================================================
 * (a) derived: started once now ≥ starts_at (this scheduler);
 * (b) host-initiated: the host presses start; an event nobody starts never
 *     becomes started, and its host can never complete it.
 * They differ for users. This module ships (a) behind `event_start_transition_
 * enabled`, seeded FALSE by migration 2600, so nothing changes until the owner
 * decides; (b) would be a route calling decideEventStart. See
 * docs/architecture/event-lifecycle-started-transition.md.
 *
 * WHAT TURNING THE FLAG ON MAKES REACHABLE (behaviour change, stated)
 * ===================================================================
 * Once an event is `started`: the complete route can run (host +5
 * event_hosted, each checked-in attendee +5 event_attended, event_host /
 * event_participant stamps, review-prompt pushes); the no-show route can run
 * (attendee −5 `event_no_show`, previously unreachable); the attendance route
 * can run. trust_engine_enabled is TRUE on production. Cancelling a started
 * event already sat in EVENT_HOST_CANCEL_TRIGGER_STATES. First enabled pass on
 * production today: 96 events, 3 hosts, 16 going RSVPs.
 */
import { getServiceClient } from "./supabase.js";
import { logger } from "./logger.js";
import { isFlagEnabled } from "./featureFlags.js";

export const EVENT_START_TRANSITION_FLAG = "event_start_transition_enabled";

// ═══════════════════════════════════════════════════════════════════════════
// THE TRANSITION AUTHORITY — which state may follow which, in ONE place
// ═══════════════════════════════════════════════════════════════════════════
//
// THE DEFECT (measured by reading every writer of `events.state`)
// --------------------------------------------------------------
// Nine sites in routes/events.ts write `events.state`. Eight carry their own
// hand-rolled, non-overlapping opinion about what is legal, and the ninth —
// `PATCH /events/:id` — carried NONE:
//
//     state: z.enum(["draft","open","started","completed","cancelled","archived"]).optional()
//     ...
//     if (b.state !== undefined) patch.state = b.state;      // ← written raw
//
// The only check on that path was `role === "host"`, so a host could PATCH any
// of the six values over any current state. That made every other gate in the
// file advisory rather than enforced:
//
//   * `PATCH {state:"completed"}` from `draft` skipped POST /complete's
//     `state === "started"` requirement outright.
//   * `PATCH {state:"open"}` from `cancelled` silently un-cancelled an event
//     whose attendees had already been told it was cancelled.
//   * `PATCH {state:"started"}` wrote `started` DIRECTLY — the one value the
//     whole `event_start_transition_enabled` flag (seeded FALSE, migration
//     2600) exists to withhold until the owner decides. The flag gated the
//     scheduler and nothing else, so it was not a gate at all: any host could
//     reach the complete / attendance / no-show routes today and collect the
//     trust awards behind them.
//   * `POST /events/:id/archive` read no state at all, so `cancelled`,
//     `completed` and already-`archived` events were all re-archived, and its
//     UPDATE discarded `.error` (supabase-js RESOLVES on a database error) so a
//     refused archive answered `{ok:true}`.
//
// WHAT THIS IS
// ------------
// `EVENT_STATE_TRANSITIONS` is the single answer to "may this event go from A
// to B". It is DERIVED from what the dedicated routes already enforce, not
// invented: publish draft→open; syncEventState cycles open/full/waitlist;
// postpone →draft from anything not cancelled/archived/completed; complete
// started→completed; cancel → cancelled from anything not already cancelled;
// archive → archived. Every writer now calls `decideEventTransition` before it
// writes, and `src/test/eventStateTransitionAuthority.test.ts` fails if a new
// `events.state` write appears in the routes without one.
//
// WHAT IT DELIBERATELY DOES NOT DECIDE
// ------------------------------------
// The table says open|full|waitlist → started is a STRUCTURALLY legal pair,
// which is exactly what `decideEventStart` already asserted and what the
// complete route's `state === "started"` precondition presumes. It says
// nothing about WHO or WHAT performs it — that is the open owner decision
// EVENT_START_TRANSITION. `isEventStartTransition` names that pair so a caller
// which is not an authorised starter (today: PATCH) can refuse it explicitly
// rather than by accident.

export const EVENT_STATES = [
  "draft", "open", "full", "waitlist", "started", "completed", "cancelled", "archived",
] as const;
export type EventState = (typeof EVENT_STATES)[number];

function isEventState(v: unknown): v is EventState {
  return typeof v === "string" && (EVENT_STATES as readonly string[]).includes(v);
}

/**
 * from -> the states it may move to. Absence is refusal; a state may never
 * transition to itself (a no-op write is the caller's business, not a
 * transition). `archived` is terminal.
 *
 * Each entry cites the writer it is derived from:
 *   open        publish (routes/events.ts POST /events/:id/publish)
 *   full/waitlist  syncEventState capacity cycle
 *   draft       postpone (POST /events/:id/postpone)
 *   started     decideEventStart / runEventStartPass  [EVENT_START_TRANSITION]
 *   completed   POST /events/:id/complete (requires `started`)
 *   cancelled   POST /events/:id/cancel and DELETE /events/:id
 *   archived    POST /events/:id/archive
 */
export const EVENT_STATE_TRANSITIONS: Readonly<Record<EventState, readonly EventState[]>> = Object.freeze({
  // Unpublished. Publishing is the only forward move.
  draft:     Object.freeze(["open", "cancelled", "archived"]),
  // Published, before it begins: capacity cycles it, the scheduler starts it,
  // the host may postpone / cancel / archive it.
  open:      Object.freeze(["full", "waitlist", "started", "draft", "cancelled", "archived"]),
  full:      Object.freeze(["open", "waitlist", "started", "draft", "cancelled", "archived"]),
  waitlist:  Object.freeze(["open", "full", "started", "draft", "cancelled", "archived"]),
  // In progress. It may finish, be called off, or be filed away. It may NOT
  // go back to open/full/waitlist — that would re-run the start transition.
  started:   Object.freeze(["completed", "draft", "cancelled", "archived"]),
  // Terminal outcomes: only filing remains. Notably NOT -> cancelled: an event
  // that already happened cannot be un-happened, and cancelling one pushed
  // "Event cancelled" to people who attended it.
  completed: Object.freeze(["archived"]),
  cancelled: Object.freeze(["archived"]),
  archived:  Object.freeze([]),
}) as Readonly<Record<EventState, readonly EventState[]>>;

export type EventTransitionRefusal =
  | "unknown_from_state"
  | "unknown_to_state"
  | "same_state"
  | "illegal_transition";

export type EventTransitionDecision =
  | { allowed: true; from: EventState; to: EventState }
  | { allowed: false; reason: EventTransitionRefusal; from: string; to: string };

/**
 * The one authority. Pure: no I/O, no clock, no flag read — so a route, the
 * scheduler and a test all get the same answer for the same pair.
 */
export function decideEventTransition(from: unknown, to: unknown): EventTransitionDecision {
  const f = typeof from === "string" ? from : String(from ?? "");
  const t = typeof to === "string" ? to : String(to ?? "");
  if (!isEventState(f)) return { allowed: false, reason: "unknown_from_state", from: f, to: t };
  if (!isEventState(t)) return { allowed: false, reason: "unknown_to_state", from: f, to: t };
  if (f === t) return { allowed: false, reason: "same_state", from: f, to: t };
  if (!EVENT_STATE_TRANSITIONS[f].includes(t)) {
    return { allowed: false, reason: "illegal_transition", from: f, to: t };
  }
  return { allowed: true, from: f, to: t };
}

/** Every state that may legally precede `to` — the `.in("state", …)` guard for a conditional UPDATE. */
export function eventStatesAllowedBefore(to: EventState): readonly EventState[] {
  return EVENT_STATES.filter((f) => f !== to && EVENT_STATE_TRANSITIONS[f].includes(to));
}

/**
 * Is this the transition whose TRIGGER is the open EVENT_START_TRANSITION
 * decision? Structurally legal (the table allows it); who may perform it is
 * not settled, so a caller that is not a sanctioned starter refuses it by name
 * rather than letting it through as an ordinary edit.
 */
export function isEventStartTransition(_from: unknown, to: unknown): boolean {
  return to === EVENT_STARTED_STATE;
}

/** Human-readable refusal, used verbatim in the 409 body so clients can tell the cases apart. */
export function eventTransitionRefusalMessage(d: Extract<EventTransitionDecision, { allowed: false }>): string {
  switch (d.reason) {
    case "unknown_from_state": return `Event is in an unrecognised state '${d.from}'`;
    case "unknown_to_state":   return `'${d.to}' is not an event state`;
    case "same_state":         return `Event is already '${d.to}'`;
    case "illegal_transition": return `An event cannot go from '${d.from}' to '${d.to}'`;
  }
}

export const EVENT_STARTED_STATE = "started";
/**
 * The repo's "published, not yet begun" states. DERIVED from the transition
 * table rather than restated, so the two can never disagree: it is exactly the
 * set of states the table lets become `started`.
 */
export const EVENT_STARTABLE_STATES: readonly string[] = EVENT_STATES.filter(
  (f) => f !== EVENT_STARTED_STATE && EVENT_STATE_TRANSITIONS[f].includes(EVENT_STARTED_STATE),
);
/** Written to event_activity_log so a scheduler transition is auditable (the 7 seeded rows were not). */
export const EVENT_STARTED_ACTIVITY_ACTION = "started";
export const EVENT_START_BATCH_LIMIT = 500;

const STARTUP_DELAY_MS = 2 * 60 * 1000;   // after the server is up; a late start costs a minute, not correctness
const INTERVAL_MS = 60 * 1000;            // the gates open within a minute of starts_at when the flag is on

let _timer: ReturnType<typeof setTimeout> | null = null;

export type EventStartRefusal =
  | "not_startable_state"
  | "no_starts_at"
  | "unparseable_starts_at"
  | "not_yet_due";

export type EventStartDecision =
  | { start: true; from: string }
  | { start: false; reason: EventStartRefusal };

/**
 * The pure rule. `now` is supplied by the caller so the decision is
 * reproducible; the function never reads a clock.
 */
export function decideEventStart(
  ev: { state: unknown; starts_at: unknown },
  now: Date,
): EventStartDecision {
  const state = typeof ev.state === "string" ? ev.state : "";
  // One authority: "may this state become `started`?" is answered by the
  // transition table, not by a second list that could drift away from it.
  if (!decideEventTransition(state, EVENT_STARTED_STATE).allowed) {
    return { start: false, reason: "not_startable_state" };
  }
  if (ev.starts_at === null || ev.starts_at === undefined || ev.starts_at === "") {
    return { start: false, reason: "no_starts_at" };
  }
  const startsAt = ev.starts_at instanceof Date ? ev.starts_at : new Date(String(ev.starts_at));
  if (Number.isNaN(startsAt.getTime())) return { start: false, reason: "unparseable_starts_at" };
  if (startsAt.getTime() > now.getTime()) return { start: false, reason: "not_yet_due" };
  return { start: true, from: state };
}

export interface EventStartPassResult {
  skipped: boolean;
  reason: "disabled" | "no_client" | "error" | null;
  /** Rows the due-events read returned. */
  scanned: number;
  /** Rows whose conditional UPDATE reported a changed row. */
  started: number;
  /** Rows the pure rule refused despite the read predicate (reported, never hidden). */
  refused: number;
  /** Rows whose UPDATE changed nothing — the state moved between read and write. */
  contended: number;
  /** Rows whose UPDATE resolved with `.error`. */
  failed: number;
  lastError: string | null;
}

const EMPTY: EventStartPassResult = {
  skipped: true, reason: null,
  scanned: 0, started: 0, refused: 0, contended: 0, failed: 0, lastError: null,
};

export async function runEventStartPass(
  opts: { client?: any; now?: Date; limit?: number } = {},
): Promise<EventStartPassResult> {
  // Explicit null means "no client"; undefined means "use the service client"
  // (the house pattern — see memoryProjectionScheduler).
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return { ...EMPTY, reason: "no_client" };
  // Fail-closed: absent row, unreadable table, thrown client all read as false.
  if (!(await isFlagEnabled(db, EVENT_START_TRANSITION_FLAG))) return { ...EMPTY, reason: "disabled" };

  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? EVENT_START_BATCH_LIMIT), 1), 1000);

  try {
    // The read predicate mirrors the rule so the batch is the due set; the rule
    // is still applied per row below, because the rule — not the query — is
    // the authority any future caller shares.
    const { data, error } = await db
      .from("events")
      .select("id, state, starts_at")
      .in("state", EVENT_STARTABLE_STATES)
      .not("starts_at", "is", null)
      .lte("starts_at", nowIso)
      .order("starts_at", { ascending: true })
      .limit(limit);
    if (error) {
      // supabase-js RESOLVES on a database error; unchecked, this would read as
      // "no events to transition" and the pass would report a clean no-op.
      logger.warn({ err: error }, "event start pass: due-events read failed");
      return { ...EMPTY, reason: "error", lastError: String(error.message ?? error) };
    }

    const rows = Array.isArray(data) ? data : [];
    const out: EventStartPassResult = { ...EMPTY, skipped: false, scanned: rows.length };

    for (const row of rows as Array<{ id: string; state: unknown; starts_at: unknown }>) {
      const decision = decideEventStart(row, now);
      if (!decision.start) { out.refused += 1; continue; }

      // Conditional on the state still being startable: a cancel/postpone/
      // archive that landed since the read is not overwritten, and a second
      // pass over the same row changes nothing (idempotent).
      const { data: changed, error: updErr } = await db
        .from("events")
        .update({ state: EVENT_STARTED_STATE, updated_at: nowIso })
        .eq("id", row.id)
        .in("state", EVENT_STARTABLE_STATES)
        .select("id");
      if (updErr) {
        out.failed += 1;
        out.lastError = String(updErr.message ?? updErr);
        logger.warn({ err: updErr, eventId: row.id }, "event start pass: update failed");
        continue;
      }
      const n = Array.isArray(changed) ? changed.length : 0;
      if (n === 0) { out.contended += 1; continue; }
      out.started += 1;

      // Audit row. Non-fatal (the transition is already durable) but its
      // `.error` is still checked and logged — never read as success.
      const { error: logErr } = await db.from("event_activity_log").insert({
        event_id: row.id,
        actor_id: null,
        action: EVENT_STARTED_ACTIVITY_ACTION,
        metadata: { source: EVENT_START_TRANSITION_FLAG, from_state: decision.from, starts_at: row.starts_at, at: nowIso },
      });
      if (logErr) logger.warn({ err: logErr, eventId: row.id }, "event start pass: activity log insert failed");
    }

    if (out.failed > 0) {
      logger.warn({ ...out }, "event start pass: some updates failed");
    } else if (out.started > 0 || out.contended > 0 || out.refused > 0) {
      logger.info({ ...out }, "event start pass complete");
    }
    return out;
  } catch (err) {
    logger.warn({ err }, "event start pass threw");
    return { ...EMPTY, reason: "error", lastError: err instanceof Error ? err.message : String(err) };
  }
}

export function startEventLifecycleScheduler(): void {
  if (_timer !== null) return;
  logger.info(
    { startupDelayMs: STARTUP_DELAY_MS, intervalMs: INTERVAL_MS, flag: EVENT_START_TRANSITION_FLAG },
    "EventLifecycleScheduler scheduled (no-op until the flag is enabled)",
  );
  _timer = setTimeout(function tick() {
    void runEventStartPass()
      .catch((err) => logger.warn({ err }, "event start pass failed"))
      .finally(() => { _timer = setTimeout(tick, INTERVAL_MS); });
  }, STARTUP_DELAY_MS);
}

export function stopEventLifecycleScheduler(): void {
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}

/** Test hook: is a timer currently scheduled? */
export function _eventLifecycleSchedulerArmed(): boolean {
  return _timer !== null;
}
