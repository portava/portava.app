/**
 * tripReminderScheduler
 *
 * Polls once per hour for trips whose start_date falls within the next 22–26 hours
 * and sends a "Your trip starts tomorrow!" push notification to the owner and all
 * accepted crew members.
 *
 * ## Deduplication / at-most-once delivery
 * Two-phase outbox pattern (migrations 0138 + 0139):
 *   1. CLAIM  – atomically set `reminder_sent_at` (WHERE reminder_sent_at IS NULL)
 *               before the push is attempted.
 *   2. DELIVER – set `reminder_delivered_at` after a successful send.
 *
 * This guarantees at-most-once delivery across restarts: a row with
 * `reminder_sent_at` set is never claimed again by the normal sweep.
 *
 * ## Crash recovery
 * If the process crashes between step 1 and step 2, `reminder_sent_at` is set
 * but `reminder_delivered_at` is NULL. On the next poll the recovery sweep
 * detects rows in this state that are older than STALE_CLAIM_MINUTES and
 * re-sends the push, then marks `reminder_delivered_at`. Because the recovery
 * sweep checks `reminder_delivered_at IS NULL` before acting, concurrent
 * instances and rapid restarts cannot produce double-sends.
 *
 * An in-memory set additionally short-circuits repeat normal-sweep polls
 * within one process restart cycle (not needed for correctness).
 */
import { logger as rootLogger } from "./logger.js";
import { getServiceClient } from "./supabase.js";
import { sendPushWithRetry } from "./pushWithRetry.js";

const logger = rootLogger.child({ job: "TripReminderScheduler" });

// ── test clock hook ───────────────────────────────────────────────────────────

/** Pinned epoch-ms value injected by tests; null = use wall clock. */
let _testNow: number | null = null;

/**
 * Override the scheduler's notion of "now" in tests.  Pass null to restore
 * the real wall clock.  This lets tests pin the clock to a specific time
 * (e.g. near midnight UTC) without monkey-patching Date.
 */
export function _setTestNow(ms: number | null): void {
  _testNow = ms;
}

/** Returns the current epoch-ms, honouring any test-injected clock override. */
function getNow(): number {
  return _testNow ?? Date.now();
}

const POLL_INTERVAL_MS    = 60 * 60 * 1000; // every 60 minutes
const WINDOW_LOWER_HRS    = 22;
const WINDOW_UPPER_HRS    = 26;
/** A claim older than this with no delivery confirmation is assumed to be a
 *  crash-between-claim-and-send and will be retried. */
const STALE_CLAIM_MINUTES = 10;
/** STALE_CLAIM_MINUTES expressed in milliseconds.  Exported so tests can pin
 *  the exact fence-post without duplicating the magic number. */
export const STALE_CLAIM_MS = STALE_CLAIM_MINUTES * 60_000;
/** Stop retrying a stale claim after this long — the reminder window has
 *  definitely passed so there is nothing useful left to deliver.
 *  Capped at WINDOW_UPPER_HRS so recovery never fires outside the valid window
 *  and naturally terminates after at most one window-width of hourly retries. */
const MAX_RECOVERY_AGE_MS  = WINDOW_UPPER_HRS * 3_600_000; // 26 h
/** Extra buffer (hours) added on each side of the 22-26 h window when checking
 *  whether a stale-claimed trip is still worth recovering.  Accounts for clock
 *  drift between server restarts and timezone offsets in date-only start_date
 *  values. */
const RECOVERY_DRIFT_HRS = 2;
/** Maximum number of recovery-sweep retry attempts before a stale claim is
 *  permanently abandoned.  Prevents indefinite retries when all push tokens
 *  are invalid or a persistent Supabase error makes success impossible. */
const MAX_RECOVERY_RETRIES = 3;

/** In-memory dedup so we don't double-fire within a single process restart cycle. */
const reminded = new Set<string>();

// ── shared helpers ────────────────────────────────────────────────────────────

/** Collect recipients (owner + accepted members) and push the reminder. */
async function sendReminderForTrip(
  sc: ReturnType<typeof getServiceClient>,
  trip: { id: string; title?: string | null; owner_id: string },
): Promise<boolean> {
  const tripId = trip.id;

  const { data: members } = await (sc as any)
    .from("trip_members")
    .select("user_id")
    .eq("trip_id", tripId)
    .eq("role", "member");

  const recipientIds = [trip.owner_id];
  (members ?? []).forEach((m: any) => {
    if (m.user_id !== trip.owner_id) recipientIds.push(m.user_id);
  });

  const { data: profiles } = await (sc as any)
    .from("profiles")
    .select("id, expo_push_token")
    .in("id", recipientIds);

  const recipients = (profiles ?? [])
    .filter((p: any) => Boolean(p.expo_push_token))
    .map((p: any) => ({ userId: p.id as string, tokens: [p.expo_push_token as string] }));

  if (recipients.length === 0) return true; // nothing to send; don't block delivery mark

  await sendPushWithRetry(sc as any, recipients, {
    title: "Your trip starts tomorrow! 🌍",
    body:  `${trip.title ?? "Your upcoming trip"} starts in about 24 hours. Have a great trip!`,
    data:  { type: "trip_24h_reminder", tripId },
  });

  logger.info({ tripId, recipients: recipients.length }, "TripReminderScheduler: 24h reminder sent");
  return true;
}

/** Mark a trip's reminder as fully delivered. */
async function markDelivered(
  sc: ReturnType<typeof getServiceClient>,
  tripId: string,
): Promise<void> {
  await (sc as any)
    .from("trips")
    .update({ reminder_delivered_at: new Date(getNow()).toISOString() })
    .eq("id", tripId)
    .is("reminder_delivered_at", null);
}

// ── recovery sweep ────────────────────────────────────────────────────────────

/**
 * Find trips that were claimed (reminder_sent_at IS NOT NULL) but where the
 * delivery confirmation was never written (reminder_delivered_at IS NULL) and
 * the claim is old enough to rule out a still-in-flight send.  Re-send and
 * mark delivered so the reminder is not permanently lost.
 */
async function recoverStaleClaims(sc: ReturnType<typeof getServiceClient>): Promise<void> {
  const now            = new Date(getNow());
  const staleThreshold = new Date(now.getTime() - STALE_CLAIM_MINUTES * 60_000).toISOString();
  // Don't recover claims older than MAX_RECOVERY_AGE_MS: the reminder window has
  // passed, so there is nothing useful to deliver and retries would be indefinite.
  const recoveryFloor  = new Date(now.getTime() - MAX_RECOVERY_AGE_MS).toISOString();

  // Only recover trips whose start_date is still within the 22-26 h notification
  // window (widened by RECOVERY_DRIFT_HRS on each side to tolerate clock drift
  // and the date-only resolution of start_date).
  const windowLowerDate = new Date(now.getTime() + (WINDOW_LOWER_HRS - RECOVERY_DRIFT_HRS) * 3_600_000)
    .toISOString().slice(0, 10);
  const windowUpperDate = new Date(now.getTime() + (WINDOW_UPPER_HRS + RECOVERY_DRIFT_HRS) * 3_600_000)
    .toISOString().slice(0, 10);

  const { data: stale, error } = await (sc as any)
    .from("trips")
    .select("id, title, owner_id, start_date, reminder_retry_count")
    .is("reminder_delivered_at", null)
    .lte("reminder_sent_at", staleThreshold)
    .gte("reminder_sent_at", recoveryFloor)
    .gte("start_date", windowLowerDate)
    .lte("start_date", windowUpperDate)
    .in("status", ["upcoming", "planning"])
    // Exclude rows that have already exhausted the retry budget — they are
    // permanently abandoned and must not be retried again.
    .lt("reminder_retry_count", MAX_RECOVERY_RETRIES);

  if (error) {
    logger.warn({ err: error }, "TripReminderScheduler: recovery query error");
    return;
  }
  if (!stale || stale.length === 0) return;

  for (const trip of stale as any[]) {
    const tripId = trip.id as string;

    // Belt-and-suspenders: re-verify the start_date window in process, guarding
    // against DB engines that don't fully push down gte/lte on date columns.
    if (trip.start_date &&
        (trip.start_date < windowLowerDate || trip.start_date > windowUpperDate)) {
      logger.info({ tripId, startDate: trip.start_date, windowLowerDate, windowUpperDate },
        "TripReminderScheduler: skipping stale recovery — start_date outside notification window");
      continue;
    }

    const rawCount = trip.reminder_retry_count;
    const retryCount: number = (rawCount as number) ?? 0;
    const newCount = retryCount + 1;

    // Compare-and-set claim on the retry counter BEFORE sending. Two concurrent
    // recovery runs both read the same stale trip; without this both would
    // increment and both would send the 24h reminder (double push). The CAS
    // (increment only if the count is still what we read) lets exactly one run
    // win; the loser matches 0 rows and skips. Handles a NULL prior count too.
    let claimQuery = (sc as any)
      .from("trips")
      .update({ reminder_retry_count: newCount })
      .eq("id", tripId);
    claimQuery = rawCount == null
      ? claimQuery.is("reminder_retry_count", null)
      : claimQuery.eq("reminder_retry_count", rawCount);
    const { data: claimed } = await claimQuery.select("id");
    if (!claimed || (claimed as any[]).length === 0) {
      logger.info({ tripId }, "TripReminderScheduler: reminder already claimed by a concurrent recovery run — skipping to avoid a double send");
      continue;
    }

    logger.info({ tripId, retryCount: newCount, maxRetries: MAX_RECOVERY_RETRIES },
      "TripReminderScheduler: recovering stale claimed reminder");
    try {
      await sendReminderForTrip(sc, trip);
      await markDelivered(sc, tripId);
      // Ensure in-memory set is consistent so the normal sweep skips it.
      reminded.add(tripId);
    } catch (err) {
      if (newCount >= MAX_RECOVERY_RETRIES) {
        logger.warn(
          { err, tripId, retryCount: newCount, maxRetries: MAX_RECOVERY_RETRIES },
          "TripReminderScheduler: reminder permanently abandoned — max recovery retries exceeded",
        );
      } else {
        logger.warn(
          { err, tripId, retryCount: newCount, maxRetries: MAX_RECOVERY_RETRIES },
          "TripReminderScheduler: recovery send failed, will retry next poll",
        );
      }
    }
  }
}

// ── normal sweep ──────────────────────────────────────────────────────────────

export async function runOnce() {
  const sc = getServiceClient();
  if (!sc) return;

  // Recovery pass first: re-send any crash-orphaned claims before claiming new ones.
  await recoverStaleClaims(sc);

  const now   = new Date(getNow());
  const lower = new Date(now.getTime() + WINDOW_LOWER_HRS * 3_600_000).toISOString();
  const upper = new Date(now.getTime() + WINDOW_UPPER_HRS * 3_600_000).toISOString();

  const { data: trips, error } = await (sc as any)
    .from("trips")
    .select("id, title, owner_id")
    .gte("start_date", lower.slice(0, 10))
    .lte("start_date", upper.slice(0, 10))
    .in("status", ["upcoming", "planning"])
    .is("reminder_sent_at", null)
    .order("start_date", { ascending: true });

  if (error) { logger.warn({ err: error }, "TripReminderScheduler: query error"); return; }
  if (!trips || trips.length === 0) return;

  for (const trip of trips as any[]) {
    const tripId = trip.id as string;
    if (reminded.has(tripId)) continue;

    // Atomically claim the trip before sending: only the process that flips
    // reminder_sent_at from NULL wins, so restarts (or concurrent instances)
    // can't double-send. Claiming before the push errs on the side of at-most-once.
    const { data: claimed, error: claimError } = await (sc as any)
      .from("trips")
      .update({ reminder_sent_at: new Date(getNow()).toISOString() })
      .eq("id", tripId)
      .is("reminder_sent_at", null)
      .select("id");

    if (claimError) {
      logger.warn({ err: claimError, tripId }, "TripReminderScheduler: failed to claim trip for reminder");
      continue;
    }
    if (!claimed || claimed.length === 0) {
      // Someone else (or a previous run) already claimed this reminder.
      reminded.add(tripId);
      continue;
    }
    reminded.add(tripId);

    try {
      await sendReminderForTrip(sc, trip);
      // Mark delivery AFTER the push succeeds so crash recovery can detect
      // any gap between claim and confirmed delivery.
      await markDelivered(sc, tripId);
    } catch (err) {
      logger.warn({ err, tripId }, "TripReminderScheduler: failed to send reminder for trip");
      // reminder_delivered_at stays NULL; recovery sweep will retry after STALE_CLAIM_MINUTES.
    }
  }
}

/**
 * Remove a trip from the in-memory deduplication set so the normal sweep will
 * re-consider it on the next poll.  Call this after an admin reset of the
 * reminder outbox columns so the re-trigger takes effect within the current
 * process lifetime — not only after a server restart.
 */
export function clearReminderDedup(tripId: string): void {
  reminded.delete(tripId);
}

export function startTripReminderScheduler(): void {
  logger.info({ intervalMs: POLL_INTERVAL_MS }, "TripReminderScheduler: starting");

  // Run immediately, then on every interval.
  runOnce().catch((err) => logger.warn({ err }, "TripReminderScheduler: initial run error"));
  setInterval(() => {
    runOnce().catch((err) => logger.warn({ err }, "TripReminderScheduler: poll error"));
  }, POLL_INTERVAL_MS);
}
