/**
 * EventWaitlistSweeper
 *
 * Background job that periodically expires stale waitlist spot-offers and
 * promotes the next eligible user in queue.
 *
 * When an RSVP is cancelled, the next waitlisted user gets a 24 h window
 * (offer_expires_at) to accept their spot via POST /api/events/:id/waitlist/accept.
 * If they don't act in time, this sweeper clears the expired offer and promotes
 * the next person — ensuring the slot is never stranded.
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

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Run one sweep pass.
 *
 * Accepts an optional `client` override so unit tests can inject a fake
 * Supabase client without a live connection. Production always uses the
 * module-level service client.
 */
export async function runSweep(opts?: { client?: any }): Promise<void> {
  // Use opts.client when explicitly provided (even null means "no client" in tests).
  // Fall back to the module-level service client for production.
  const sc: any = (opts !== undefined && "client" in opts) ? opts.client : getServiceClient();
  if (!sc) { logger.warn("service client not ready — skipping sweep"); return; }

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
      return;
    }

    // Group by event so we promote once per event after clearing all expired offers
    const byEvent = new Map<string, string[]>();
    for (const row of rows) {
      const eventId = row.event_id as string;
      if (!byEvent.has(eventId)) byEvent.set(eventId, []);
      byEvent.get(eventId)!.push(row.user_id as string);
    }

    let expired_count = 0;
    for (const [eventId, userIds] of byEvent) {
      try {
        // Remove expired-offer holders from the queue entirely — setting them to
        // null would cause them to be re-queued first by the IS NULL promotion query.
        await sc
          .from("event_waitlist")
          .delete()
          .eq("event_id", eventId)
          .in("user_id", userIds);

        expired_count += userIds.length;
        logger.info({ eventId, expiredCount: userIds.length }, "cleared expired waitlist offers");

        // Promote up to the number of reservations we just freed — one per
        // expired offer — in queue order. Previously only ONE user was promoted
        // per event even when several offers expired in the same sweep, so every
        // freed slot beyond the first was stranded until the next sweep.
        const { data: nextRows } = await sc
          .from("event_waitlist")
          .select("user_id")
          .eq("event_id", eventId)
          .is("offer_expires_at", null)
          .order("position", { ascending: true })
          .limit(userIds.length);

        const promoteIds = ((nextRows as any[]) ?? []).map((r) => r.user_id as string);
        if (promoteIds.length > 0) {
          const offerExpiresAt = new Date(nowMs + 24 * 60 * 60 * 1_000).toISOString();
          await sc
            .from("event_waitlist")
            .update({ offer_expires_at: offerExpiresAt })
            .eq("event_id", eventId)
            .in("user_id", promoteIds);

          logger.info({ eventId, promotedCount: promoteIds.length }, "promoted next waitlisted users");
        }
      } catch (evErr) {
        logger.error({ err: evErr, eventId }, "failed to process expired offers for event");
      }
    }

    _status.lastRunAt = now;
    _status.lastExpiredCount = expired_count;
    _status.consecutiveFailures = 0;
  } catch (err) {
    _status.consecutiveFailures += 1;
    logger.error({ err, consecutiveFailures: _status.consecutiveFailures }, "event waitlist sweep failed");
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
