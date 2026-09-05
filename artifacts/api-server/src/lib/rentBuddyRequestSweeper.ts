/**
 * RentBuddyRequestSweeper
 *
 * Drives the three time-based transitions in the Rent-a-Buddy booking
 * lifecycle. The logic already existed, as the body of
 * POST /api/internal/buddy-requests/expire — but **nothing ever called it**.
 * The endpoint is secret-gated and referenced only from a test; src/index.ts
 * starts ~25 named schedulers and this was not one of them. Whether an external
 * cron hit it in production was not determinable from the code, and the route's
 * own comment ("Call on a schedule (cron / Supabase pg_cron / external
 * scheduler)") shows it was always meant to be driven by something.
 *
 * If nothing drove it, then on the day real bookings start:
 *   - no unanswered request ever expires (they sit in `requested`/`pending`
 *     past `expires_at` forever),
 *   - no dispute window ever closes, so a booking awaiting traveller
 *     confirmation never auto-completes and the buddy is never paid out,
 *   - no reported no-show ever escalates past its grace period, so the dispute
 *     that should follow is never opened.
 *
 * The logic is extracted here verbatim so the HTTP endpoint and the scheduler
 * share ONE implementation — the endpoint stays (it is useful for manual
 * replay and for an external cron), but it now delegates. Duplicating it would
 * guarantee the two drift.
 *
 * Fail-soft: each phase is independently guarded (its own try/catch), so one
 * failing phase never prevents the others — the header once promised this but
 * only phase 1 delivered it; phases 2 and 3 called `await …from(…)` bare, so a
 * thrown rejection in phase 2 skipped phase 3 and aborted the whole sweep. All
 * phases now wrap their own work. Counts are returned so the caller can log or
 * assert on them.
 *
 * A fourth phase expires stale open marketplace rows — pending
 * `rent_buddy_offers` and open `rent_buddy_requests` past their own `expires_at`
 * — which nothing else swept (offer expiry was only ever applied lazily, at
 * accept-time). It is idempotent (an expired row no longer matches the filter),
 * bounded (one capped batch per table per pass; the backlog drains over
 * successive passes), and gated behind the Rent-a-Buddy master flag
 * (`rent_buddy_enabled`, read fail-closed) so it is a no-op while the feature is
 * off — unlike phases 1–3, which govern already-created bookings and stay
 * ungated as before.
 *
 * Configuration (env vars)
 * ────────────────────────
 *   RAB_REQUEST_SWEEP_INTERVAL_MINUTES  — sweep interval        (default: 15)
 *   RAB_REQUEST_SWEEP_STARTUP_DELAY_MS  — delay before first run (default: 60 000)
 */

import { getServiceClient } from "./supabase.js";
import { logger as rootLogger } from "./logger.js";
import { notifyBookingParty } from "./bookingNotify.js";
import { isFlagEnabled } from "./featureFlags.js";
import { AWAITING_BUDDY_STATUSES } from "./rentBuddyBookingStatus.js";

/** Master feature flag that gates the whole Rent-a-Buddy surface. */
const RAB_MASTER_FLAG = "rent_buddy_enabled";

/**
 * Rows expired per table per pass. Keeps each sweep bounded; because the phase
 * is idempotent, any remaining backlog is drained on later passes.
 */
const OFFER_EXPIRY_BATCH_LIMIT = 500;

const logger = rootLogger.child({ service: "RentBuddyRequestSweeper" });

// ── Configuration ─────────────────────────────────────────────────────────────

function parseEnvFloat(raw: string | undefined, def: number): number {
  const v = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(v) && v > 0 ? v : def;
}

const INTERVAL_MINUTES = parseEnvFloat(process.env["RAB_REQUEST_SWEEP_INTERVAL_MINUTES"], 15);

export const SWEEP_INTERVAL_MS = INTERVAL_MINUTES * 60 * 1_000;
export const STARTUP_DELAY_MS  = parseEnvFloat(process.env["RAB_REQUEST_SWEEP_STARTUP_DELAY_MS"], 60_000);

// ── Status ────────────────────────────────────────────────────────────────────

export interface SweepStatus {
  lastRunAt: string | null;
  lastExpired: number;
  lastAutoCompleted: number;
  lastNoShowEscalated: number;
  lastOffersExpired: number;
  lastRequestsExpired: number;
  consecutiveFailures: number;
}

const _status: SweepStatus = {
  lastRunAt: null,
  lastExpired: 0,
  lastAutoCompleted: 0,
  lastNoShowEscalated: 0,
  lastOffersExpired: 0,
  lastRequestsExpired: 0,
  consecutiveFailures: 0,
};

export function getSweepStatus(): Readonly<SweepStatus> { return { ..._status }; }

/** Reset status between test runs — not for production use. */
export function _resetStatus(): void {
  _status.lastRunAt = null;
  _status.lastExpired = 0;
  _status.lastAutoCompleted = 0;
  _status.lastNoShowEscalated = 0;
  _status.lastOffersExpired = 0;
  _status.lastRequestsExpired = 0;
  _status.consecutiveFailures = 0;
}

// ── Core pass ─────────────────────────────────────────────────────────────────

export interface BuddyRequestSweepResult {
  ok: boolean;
  expired: number;
  autoCompleted: number;
  noShowEscalated: number;
  offersExpired: number;
  requestsExpired: number;
  unavailable?: boolean;
}

/**
 * Run one sweep pass.
 *
 * Accepts an optional client override so tests and the HTTP route can inject
 * their own client; production scheduling uses the service client.
 */
export async function runBuddyRequestSweep(client?: any): Promise<BuddyRequestSweepResult> {
  const serviceClient = client ?? getServiceClient();
  if (!serviceClient) {
    return {
      ok: false, expired: 0, autoCompleted: 0, noShowEscalated: 0,
      offersExpired: 0, requestsExpired: 0, unavailable: true,
    };
  }

  const now = new Date().toISOString();

  // ── 1. Expire unanswered requests in `requested` or `pending` ──────────────
  let staleRequests: { id: string; traveler_id: string; status: string }[] | null = null;
  try {
    const { data, error: staleErr } = await serviceClient
      .from("rent_buddy_bookings")
      .select("id, traveler_id, status")
      // AWAITING_BUDDY_STATUSES, not an inline pair. The canonical creation
      // route writes "requested" and the other four write "pending"; an inline
      // list here is exactly the drift lib/rentBuddyBookingStatus.ts exists to
      // stop, and phase 1 was the one place still carrying a hand-written copy.
      .in("status", [...AWAITING_BUDDY_STATUSES])
      .lt("expires_at", now);
    if (staleErr) {
      logger.error({ err: staleErr }, "stale-request fetch failed");
    } else {
      staleRequests = data as { id: string; traveler_id: string; status: string }[] | null;
    }
  } catch (err) {
    logger.error({ err }, "stale-request fetch threw");
  }

  let expiredCount = 0;
  if (staleRequests && staleRequests.length > 0) {
    const ids = staleRequests.map((r: any) => r.id as string);
    const { error: expireErr } = await serviceClient
      .from("rent_buddy_bookings")
      .update({ status: "expired", updated_at: now })
      .in("id", ids);

    if (!expireErr) {
      for (const bk of staleRequests) {
        void serviceClient.from("buddy_booking_events").insert({
          booking_id: bk.id, actor_user_id: bk.traveler_id, event: "request_expired",
          from_status: bk.status as string, to_status: "expired", metadata: {},
        });
        notifyBookingParty(serviceClient, bk.traveler_id as string, "rent_buddy.booking_expired", bk.id as string);
      }
      expiredCount = staleRequests.length;
    }
  }

  // ── 2. Auto-complete bookings whose dispute window closed without a dispute ─
  // Independently guarded (its own try/catch): a thrown/rejected fetch here is
  // logged and phases 3–4 still run, instead of aborting the whole sweep.
  let autoCompletedCount = 0;
  try {
  const { data: pendingConfirm } = await serviceClient
    .from("rent_buddy_bookings")
    .select("id, traveler_id, buddy_id")
    .eq("status", "completed_pending_traveler_confirmation")
    .lt("dispute_window_expires_at", now);

  if (pendingConfirm && pendingConfirm.length > 0) {
    const ids2 = pendingConfirm.map((r: any) => r.id as string);
    const { error: autoCompleteErr } = await serviceClient
      .from("rent_buddy_bookings")
      .update({ status: "completed", updated_at: now })
      .in("id", ids2);

    if (!autoCompleteErr) {
      // Resolve buddy user IDs in one batch for completion notifications.
      // Wrapped in try/catch (rather than just checking `error`) so that an
      // actual thrown/rejected lookup — not just a returned DB error — can
      // never abort the loop below and silence the TRAVELER's notification.
      const buddyProfileIds = [...new Set(pendingConfirm.map((r: any) => r.buddy_id as string))];
      const buddyUserIdMap: Record<string, string> = {};
      try {
        const { data: buddyProfiles, error: buddyLookupErr } = await serviceClient
          .from("rent_buddy_profiles")
          .select("id, user_id")
          .in("id", buddyProfileIds);
        if (buddyLookupErr) {
          logger.error({ err: buddyLookupErr }, "buddy-profile lookup failed during auto-completion — traveler notifications still proceed");
        } else {
          for (const bp of buddyProfiles ?? []) {
            buddyUserIdMap[(bp as any).id] = (bp as any).user_id;
          }
        }
      } catch (err) {
        logger.error({ err }, "buddy-profile lookup threw during auto-completion — traveler notifications still proceed");
      }

      for (const bk of pendingConfirm) {
        void serviceClient.from("buddy_booking_events").insert({
          booking_id: bk.id, actor_user_id: bk.traveler_id, event: "auto_completed",
          from_status: "completed_pending_traveler_confirmation", to_status: "completed",
          metadata: { reason: "dispute_window_expired" },
        });
        notifyBookingParty(serviceClient, bk.traveler_id as string, "rent_buddy.booking_completed", bk.id as string);
        const buddyUserId = buddyUserIdMap[bk.buddy_id as string];
        if (buddyUserId) {
          notifyBookingParty(serviceClient, buddyUserId, "rent_buddy.booking_completed", bk.id as string);
        }
      }
      autoCompletedCount = pendingConfirm.length;
    }
  }
  } catch (err) {
    logger.error({ err }, "auto-complete phase threw — later phases still run");
  }

  // ── 3. Escalate no_show_pending bookings past grace period → disputed ──────
  // Independently guarded (its own try/catch), same as phases 1, 2 and 4.
  let noShowEscalatedCount = 0;
  try {
  const { data: staleNoShows } = await serviceClient
    .from("rent_buddy_bookings")
    .select("id, traveler_id, buddy_id")
    .eq("status", "no_show_pending")
    .lt("no_show_grace_expires_at", now);

  if (staleNoShows && staleNoShows.length > 0) {
    for (const bk of staleNoShows) {
      // Derive the original reporter from the no_show_reported event —
      // do NOT assume traveler; either party can file a no-show report.
      const { data: noShowEvent } = await serviceClient
        .from("buddy_booking_events")
        .select("actor_user_id")
        .eq("booking_id", bk.id as string)
        .eq("event", "no_show_reported")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      // Fall back to traveler_id only if the event row is missing (data inconsistency)
      const reporterUserId: string = (noShowEvent as any)?.actor_user_id ?? (bk.traveler_id as string);

      // Resolve or create the dispute row FIRST. If the insert fails we skip the
      // booking update entirely, so the booking stays no_show_pending and
      // noShowEscalatedCount is never incremented.
      const { data: existingDispute } = await serviceClient
        .from("rent_buddy_disputes")
        .select("id")
        .eq("booking_id", bk.id as string)
        .eq("reason", "no_show")
        .maybeSingle();

      let disputeId: string | null = (existingDispute as any)?.id ?? null;

      if (!disputeId) {
        const { data: newDispute, error: disputeInsertError } = await serviceClient
          .from("rent_buddy_disputes")
          .insert({ booking_id: bk.id, raised_by: reporterUserId, reason: "no_show", status: "open" })
          .select("id")
          .maybeSingle();
        if (disputeInsertError) {
          console.error("[sweep] failed to insert no_show dispute row for booking", bk.id, disputeInsertError);
          continue;
        }
        disputeId = (newDispute as any)?.id ?? null;
      }

      // Dispute row is confirmed — now promote the booking to disputed.
      const { error: updateError } = await serviceClient
        .from("rent_buddy_bookings")
        .update({ status: "disputed", updated_at: now })
        .eq("id", bk.id as string);

      if (updateError) {
        console.error("[sweep] failed to promote booking to disputed after dispute insert", bk.id, updateError);
        continue;
      }

      noShowEscalatedCount++;

      try {
        const { error: eventInsertError } = await serviceClient.from("buddy_booking_events").insert({
          booking_id: bk.id, actor_user_id: reporterUserId, event: "no_show_escalated",
          from_status: "no_show_pending", to_status: "disputed",
          metadata: { reason: "grace_period_expired", dispute_id: disputeId },
        });
        if (eventInsertError) {
          console.error("[sweep] failed to write no_show_escalated event for booking", bk.id, eventInsertError);
        }
      } catch (eventErr) {
        console.error("[sweep] unexpected error writing no_show_escalated event for booking", bk.id, eventErr);
      }
    }
  }
  } catch (err) {
    logger.error({ err }, "no-show escalation phase threw — later phases still run");
  }

  // ── 4. Expire stale open marketplace rows (offers + requests) ──────────────
  // Nothing else sweeps these: pending offers and open requests were only ever
  // expired lazily at accept-time, so an offer/request nobody acted on lingered
  // past its `expires_at` forever. Gated behind the RAB master flag (read
  // fail-closed) so it is a no-op while the feature is off. Idempotent — an
  // already-`expired` row no longer matches the filter — and bounded to one
  // capped batch per table per pass. Independently guarded like phases 1–3.
  let offersExpired = 0;
  let requestsExpired = 0;
  try {
    if (await isFlagEnabled(serviceClient, RAB_MASTER_FLAG)) {
      offersExpired   = await expireStaleOpenRows(serviceClient, "rent_buddy_offers",   "pending", now);
      requestsExpired = await expireStaleOpenRows(serviceClient, "rent_buddy_requests", "open",    now);
    }
  } catch (err) {
    logger.error({ err }, "marketplace-expiry phase threw — booking phases already ran");
  }

  return {
    ok: true,
    expired: expiredCount,
    autoCompleted: autoCompletedCount,
    noShowEscalated: noShowEscalatedCount,
    offersExpired,
    requestsExpired,
  };
}

/**
 * Expire one capped batch of stale open rows for a marketplace table.
 *
 * Selects up to OFFER_EXPIRY_BATCH_LIMIT ids still in `openStatus` whose own
 * `expires_at` is in the past, then flips them to `expired`. Returns the count
 * flipped (0 on any DB error — non-fatal, logged). Idempotent: expired rows
 * drop out of the `openStatus` filter, so re-running never double-counts and a
 * remaining backlog is drained on the next pass.
 */
async function expireStaleOpenRows(
  serviceClient: any,
  table: "rent_buddy_offers" | "rent_buddy_requests",
  openStatus: string,
  now: string,
): Promise<number> {
  const { data, error: selErr } = await serviceClient
    .from(table)
    .select("id")
    .eq("status", openStatus)
    .lt("expires_at", now)
    .limit(OFFER_EXPIRY_BATCH_LIMIT);

  if (selErr) {
    logger.error({ err: selErr, table }, "stale open-row fetch failed");
    return 0;
  }

  const rows = (data ?? []) as { id: string }[];
  if (rows.length === 0) return 0;

  const ids = rows.map((r) => r.id);
  const { error: updErr } = await serviceClient
    .from(table)
    .update({ status: "expired", updated_at: now })
    .in("id", ids);

  if (updErr) {
    logger.error({ err: updErr, table }, "stale open-row expire update failed");
    return 0;
  }

  return ids.length;
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let _timer: ReturnType<typeof setTimeout> | null = null;

async function tickOnce(): Promise<void> {
  try {
    const r = await runBuddyRequestSweep();
    if (r.unavailable) return; // no service client yet — try again next tick
    _status.lastRunAt = new Date().toISOString();
    _status.lastExpired = r.expired;
    _status.lastAutoCompleted = r.autoCompleted;
    _status.lastNoShowEscalated = r.noShowEscalated;
    _status.lastOffersExpired = r.offersExpired;
    _status.lastRequestsExpired = r.requestsExpired;
    _status.consecutiveFailures = 0;
    if (r.expired || r.autoCompleted || r.noShowEscalated || r.offersExpired || r.requestsExpired) {
      logger.info(
        {
          expired: r.expired,
          autoCompleted: r.autoCompleted,
          noShowEscalated: r.noShowEscalated,
          offersExpired: r.offersExpired,
          requestsExpired: r.requestsExpired,
        },
        "buddy request sweep applied transitions",
      );
    }
  } catch (err) {
    _status.consecutiveFailures += 1;
    logger.error({ err, consecutiveFailures: _status.consecutiveFailures }, "buddy request sweep failed");
  }
}

export function startBuddyRequestSweeper(): void {
  if (_timer !== null) return; // already started

  logger.info(
    { startupDelayMs: STARTUP_DELAY_MS, intervalMs: SWEEP_INTERVAL_MS },
    "RentBuddyRequestSweeper scheduled",
  );

  _timer = setTimeout(function tick() {
    void tickOnce().finally(() => {
      _timer = setTimeout(tick, SWEEP_INTERVAL_MS);
    });
  }, STARTUP_DELAY_MS);
}

export function stopBuddyRequestSweeper(): void {
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}
