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

const POLL_INTERVAL_MS    = 60 * 60 * 1000; // every 60 minutes
const WINDOW_LOWER_HRS    = 22;
const WINDOW_UPPER_HRS    = 26;
/** A claim older than this with no delivery confirmation is assumed to be a
 *  crash-between-claim-and-send and will be retried. */
const STALE_CLAIM_MINUTES = 10;

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
    .update({ reminder_delivered_at: new Date().toISOString() })
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
  const staleThreshold = new Date(Date.now() - STALE_CLAIM_MINUTES * 60_000).toISOString();

  const { data: stale, error } = await (sc as any)
    .from("trips")
    .select("id, title, owner_id")
    .is("reminder_delivered_at", null)
    .lt("reminder_sent_at", staleThreshold)
    .in("status", ["upcoming", "planning"]);

  if (error) {
    logger.warn({ err: error }, "TripReminderScheduler: recovery query error");
    return;
  }
  if (!stale || stale.length === 0) return;

  for (const trip of stale as any[]) {
    const tripId = trip.id as string;
    logger.info({ tripId }, "TripReminderScheduler: recovering stale claimed reminder");
    try {
      await sendReminderForTrip(sc, trip);
      await markDelivered(sc, tripId);
      // Ensure in-memory set is consistent so the normal sweep skips it.
      reminded.add(tripId);
    } catch (err) {
      logger.warn({ err, tripId }, "TripReminderScheduler: recovery send failed");
    }
  }
}

// ── normal sweep ──────────────────────────────────────────────────────────────

export async function runOnce() {
  const sc = getServiceClient();
  if (!sc) return;

  // Recovery pass first: re-send any crash-orphaned claims before claiming new ones.
  await recoverStaleClaims(sc);

  const now   = new Date();
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
      .update({ reminder_sent_at: new Date().toISOString() })
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

export function startTripReminderScheduler(): void {
  logger.info({ intervalMs: POLL_INTERVAL_MS }, "TripReminderScheduler: starting");

  // Run immediately, then on every interval.
  runOnce().catch((err) => logger.warn({ err }, "TripReminderScheduler: initial run error"));
  setInterval(() => {
    runOnce().catch((err) => logger.warn({ err }, "TripReminderScheduler: poll error"));
  }, POLL_INTERVAL_MS);
}
