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
/** The repo's "published, not yet begun" states — see the header for the derivation. */
export const EVENT_STARTABLE_STATES: readonly string[] = ["open", "full", "waitlist"];
export const EVENT_STARTED_STATE = "started";
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
  if (!EVENT_STARTABLE_STATES.includes(state)) return { start: false, reason: "not_startable_state" };
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
