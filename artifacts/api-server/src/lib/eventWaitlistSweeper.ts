/**
 * EventWaitlistSweeper
 *
 * Background job that expires stale waitlist spot-offers and promotes the next
 * eligible user in queue. When an RSVP is cancelled the next waitlisted user
 * gets a 24 h window (`offer_expires_at`) to accept via
 * POST /api/events/:id/waitlist/accept. If they do not act in time this sweeper
 * clears the expired offer and promotes the next person, so the freed seat is
 * never stranded.
 *
 * ── WHAT WAS WRONG, AND HOW IT WAS MEASURED ──────────────────────────────────
 * Three of the four supabase results in the per-event loop had their `.error`
 * DISCARDED. supabase-js RESOLVES on a database error rather than throwing, so
 * each of those reads/writes returned the same shape on failure as on an empty
 * success, and the enclosing try/catch never fired — it was dead code for all
 * three. Counted at runtime against a fake that answers `{data:null,error}`:
 *
 *   1. `await sc.from("event_waitlist").delete()…`
 *      The result was dropped entirely, then `expired_count += userIds.length`
 *      credited the sweep with clearing rows the database had refused to delete.
 *      Because the rows survived with `offer_expires_at` still in the past, the
 *      NEXT sweep read the same rows, "cleared" them again, and promoted ANOTHER
 *      user — the previously promoted one now has a non-null offer so the
 *      `IS NULL` queue query skips them and picks someone new. One freed seat,
 *      one promotion per sweep, forever. That is the double-promotion.
 *
 *   2. `const { data: nextRows } = await sc…select…is("offer_expires_at", null)`
 *      `error` was not even destructured. "Nobody is waiting" and "the waitlist
 *      is unreadable" were the SAME value, and the sweep reported success with
 *      the seat silently stranded until a human noticed.
 *
 *   3. `await sc.from("event_waitlist").update({ offer_expires_at })…`
 *      Unchecked, so the sweep logged "promoted next waitlisted users" for a
 *      write the database refused. The seat is stranded and the log says the
 *      opposite.
 *
 * And the status the health surface reads set `consecutiveFailures = 0` at the
 * end of every pass that did not throw — including a pass in which every single
 * event failed, since per-event errors were caught inside the loop.
 *
 * ── WHAT IT DOES NOW ─────────────────────────────────────────────────────────
 * Every result's `.error` is checked. The DELETE and the promotion UPDATE both
 * `.select()`, so the number of rows they ACTUALLY changed is known:
 *
 *   • the sweep promotes exactly as many users as the DELETE really freed, so
 *     two concurrent passes over the same expired rows cannot both promote —
 *     the loser's DELETE matches nothing and it promotes nothing;
 *   • the promotion UPDATE re-asserts `offer_expires_at IS NULL`, so a user who
 *     was promoted by a concurrent pass between the queue read and the write is
 *     not given a second, later-expiring offer;
 *   • an unreadable queue is `unreadable`, never `stranded` — the seat is left
 *     alone and retried next pass rather than written off.
 *
 * `runSweep` RETURNS the counts. A sweeper that processed zero rows and one
 * that could not read the table are different values, and the tests assert the
 * counts rather than that the call resolved.
 *
 * Configuration (env vars)
 * ────────────────────────
 *   EVENT_WAITLIST_SWEEP_INTERVAL_HOURS — sweep interval (default: 1)
 *   EVENT_WAITLIST_SWEEP_STARTUP_DELAY_MS — delay before first run (default: 90 000)
 */

import { getServiceClient } from "./supabase.js";
import { logger as rootLogger } from "./logger.js";

const logger = rootLogger.child({ service: "EventWaitlistSweeper" });

// ── Configuration ─────────────────────────────────────────────────────────────

function parseEnvFloat(raw: string | undefined, def: number): number {
  const v = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(v) && v > 0 ? v : def;
}

const SWEEP_INTERVAL_HOURS = parseEnvFloat(process.env["EVENT_WAITLIST_SWEEP_INTERVAL_HOURS"], 1);

export const SWEEP_INTERVAL_MS    = SWEEP_INTERVAL_HOURS * 60 * 60 * 1_000;
export const STARTUP_DELAY_MS     = parseEnvFloat(process.env["EVENT_WAITLIST_SWEEP_STARTUP_DELAY_MS"], 90_000);
export const OFFER_WINDOW_MS      = 24 * 60 * 60 * 1_000;

// ── Status ────────────────────────────────────────────────────────────────────

interface SweepStatus {
  lastRunAt: string | null;
  lastExpiredCount: number;
  consecutiveFailures: number;
}

const _status: SweepStatus = { lastRunAt: null, lastExpiredCount: 0, consecutiveFailures: 0 };
export function getSweepStatus(): Readonly<SweepStatus> { return { ..._status }; }
/** Reset status between test runs — not for production use. */
export function _resetStatus(): void {
  _status.lastRunAt = null;
  _status.lastExpiredCount = 0;
  _status.consecutiveFailures = 0;
}

// ── Result ────────────────────────────────────────────────────────────────────

export interface SweepPassResult {
  /** True when the pass did not run at all (no client). */
  skipped: boolean;
  reason: "no_client" | "error" | null;
  /** Expired-offer rows the initial read returned. */
  scanned: number;
  /** Distinct events those rows belong to. */
  events: number;
  /** Rows the DELETE actually removed — the seats this pass really freed. */
  cleared: number;
  /** Rows the promotion UPDATE actually changed. Never exceeds `cleared`. */
  promoted: number;
  /** Seats freed for which the queue was readable and empty. */
  stranded: number;
  /** Events whose queue could NOT be read — left for the next pass, not written off. */
  unreadable: number;
  /** Events whose DELETE or promotion UPDATE reported `.error`. */
  failed: number;
  lastError: string | null;
}

const EMPTY: SweepPassResult = {
  skipped: true, reason: null,
  scanned: 0, events: 0, cleared: 0, promoted: 0, stranded: 0, unreadable: 0, failed: 0,
  lastError: null,
};

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Run one sweep pass.
 *
 * Accepts an optional `client` override so unit tests can inject a fake
 * Supabase client without a live connection. Production always uses the
 * module-level service client.
 */
export async function runSweep(opts?: { client?: any }): Promise<SweepPassResult> {
  // Use opts.client when explicitly provided (even null means "no client" in tests).
  // Fall back to the module-level service client for production.
  const sc: any = (opts !== undefined && "client" in opts) ? opts.client : getServiceClient();
  if (!sc) {
    logger.warn("service client not ready — skipping sweep");
    return { ...EMPTY, reason: "no_client" };
  }

  try {
    // Single clock read — the expiry cutoff and any new offer expiries derive
    // from the same instant so they can never disagree (split-clock risk).
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();

    // Fetch all expired offers: offer_expires_at < now AND offer_expires_at IS NOT NULL
    const { data: expired, error } = await sc
      .from("event_waitlist")
      .select("event_id, user_id")
      .not("offer_expires_at", "is", null)
      .lt("offer_expires_at", now);

    if (error) { throw error; }

    const rows = (expired as any[]) ?? [];
    if (rows.length === 0) {
      _status.lastRunAt = now;
      _status.lastExpiredCount = 0;
      _status.consecutiveFailures = 0;
      return { ...EMPTY, skipped: false };
    }

    // Group by event so we promote once per event after clearing all expired offers
    const byEvent = new Map<string, string[]>();
    for (const row of rows) {
      const eventId = row.event_id as string;
      if (!byEvent.has(eventId)) byEvent.set(eventId, []);
      byEvent.get(eventId)!.push(row.user_id as string);
    }

    const out: SweepPassResult = { ...EMPTY, skipped: false, scanned: rows.length, events: byEvent.size };

    for (const [eventId, userIds] of byEvent) {
      try {
        // Remove expired-offer holders from the queue entirely — setting them to
        // null would cause them to be re-queued first by the IS NULL promotion query.
        //
        // `.select()` is load-bearing: postgrest returns no rows without it, and
        // "the DELETE removed nothing" would be indistinguishable from "the
        // DELETE removed everything". The count of rows it really removed is
        // the number of seats this pass freed, and therefore the number of
        // promotions it is entitled to make. A concurrent pass that read the
        // same expired rows deletes zero and promotes zero.
        const { data: deleted, error: delErr } = await sc
          .from("event_waitlist")
          .delete()
          .eq("event_id", eventId)
          .in("user_id", userIds)
          .select("user_id");
        if (delErr) {
          // Previously discarded. The sweep credited itself with clearing these
          // rows, they survived with a past offer_expires_at, and every later
          // sweep promoted one more user for the same single seat.
          out.failed += 1;
          out.lastError = String(delErr.message ?? delErr);
          logger.error({ err: delErr, eventId, attempted: userIds.length },
            "expired-offer delete failed — seats NOT freed, no promotion attempted");
          continue;
        }
        const freed = Array.isArray(deleted) ? deleted.length : 0;
        out.cleared += freed;
        if (freed === 0) {
          // Another pass (or the accept route) got there first. Nothing was
          // freed here, so nothing may be promoted here.
          logger.info({ eventId, attempted: userIds.length },
            "expired offers already cleared by another writer — no promotion");
          continue;
        }
        logger.info({ eventId, expiredCount: freed }, "cleared expired waitlist offers");

        // Promote up to the number of reservations we just freed — one per
        // seat actually freed — in queue order.
        const { data: nextRows, error: nextErr } = await sc
          .from("event_waitlist")
          .select("user_id")
          .eq("event_id", eventId)
          .is("offer_expires_at", null)
          .order("position", { ascending: true })
          .limit(freed);
        if (nextErr) {
          // `error` was not even destructured here. An unreadable queue read as
          // "nobody is waiting" and the freed seat was written off in silence.
          out.unreadable += 1;
          out.lastError = String(nextErr.message ?? nextErr);
          logger.error({ err: nextErr, eventId, freed },
            "waitlist queue unreadable — seats left unfilled for the next pass, NOT written off");
          continue;
        }

        const promoteIds = ((nextRows as any[]) ?? []).map((r) => r.user_id as string);
        if (promoteIds.length === 0) {
          out.stranded += freed;
          logger.info({ eventId, freed }, "queue exhausted — no one to promote");
          continue;
        }

        const offerExpiresAt = new Date(nowMs + OFFER_WINDOW_MS).toISOString();
        const { data: promotedRows, error: updErr } = await sc
          .from("event_waitlist")
          .update({ offer_expires_at: offerExpiresAt })
          .eq("event_id", eventId)
          .in("user_id", promoteIds)
          // Re-asserted so a user promoted by a concurrent pass between the read
          // above and this write is not handed a second, later-expiring offer.
          .is("offer_expires_at", null)
          .select("user_id");
        if (updErr) {
          // Unchecked, this logged "promoted next waitlisted users" for a write
          // the database refused.
          out.failed += 1;
          out.lastError = String(updErr.message ?? updErr);
          logger.error({ err: updErr, eventId, attempted: promoteIds.length },
            "promotion write failed — seats NOT filled");
          continue;
        }
        const promoted = Array.isArray(promotedRows) ? promotedRows.length : 0;
        out.promoted += promoted;
        if (promoted < freed) out.stranded += freed - promoted;
        logger.info({ eventId, promotedCount: promoted, freed }, "promoted next waitlisted users");
      } catch (evErr) {
        out.failed += 1;
        out.lastError = evErr instanceof Error ? evErr.message : String(evErr);
        logger.error({ err: evErr, eventId }, "failed to process expired offers for event");
      }
    }

    _status.lastRunAt = now;
    // The seats this pass really freed, not the rows it hoped to free.
    _status.lastExpiredCount = out.cleared;
    // A pass in which every event failed used to reset this to 0 because the
    // per-event catch kept the top-level try from firing. A partial failure is
    // still a failure for the health surface.
    if (out.failed > 0 || out.unreadable > 0) {
      _status.consecutiveFailures += 1;
      logger.warn({ ...out }, "event waitlist sweep completed with failures");
    } else {
      _status.consecutiveFailures = 0;
    }
    return out;
  } catch (err) {
    _status.consecutiveFailures += 1;
    logger.error({ err, consecutiveFailures: _status.consecutiveFailures }, "event waitlist sweep failed");
    return { ...EMPTY, reason: "error", lastError: err instanceof Error ? err.message : String(err) };
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let _timer: ReturnType<typeof setTimeout> | null = null;

export function startEventWaitlistSweeper(): void {
  if (_timer !== null) return; // already started

  logger.info({ startupDelayMs: STARTUP_DELAY_MS, intervalMs: SWEEP_INTERVAL_MS }, "EventWaitlistSweeper scheduled");

  _timer = setTimeout(function tick() {
    void runSweep().finally(() => {
      _timer = setTimeout(tick, SWEEP_INTERVAL_MS);
    });
  }, STARTUP_DELAY_MS);
}

export function stopEventWaitlistSweeper(): void {
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}

/** Test hook: is a timer currently scheduled? */
export function _eventWaitlistSweeperArmed(): boolean {
  return _timer !== null;
}
