/**
 * tripReminderScheduler
 *
 * Polls once per hour for trips whose start_date falls within the next 22–26 hours
 * and sends a "Your trip starts tomorrow!" push notification to the owner and all
 * accepted crew members. A deduplication column (`reminder_sent_at`) on the trips
 * table (migration 0138) prevents double-sending across restarts: each trip is
 * atomically claimed (UPDATE ... WHERE reminder_sent_at IS NULL) before the push
 * is sent. An in-memory set additionally short-circuits repeat polls within one
 * process.
 */
import { logger as rootLogger } from "./logger.js";
import { getServiceClient } from "./supabase.js";
import { sendPushWithRetry } from "./pushWithRetry.js";

const logger = rootLogger.child({ job: "TripReminderScheduler" });

const POLL_INTERVAL_MS  = 60 * 60 * 1000; // every 60 minutes
const WINDOW_LOWER_HRS  = 22;
const WINDOW_UPPER_HRS  = 26;

/** In-memory dedup so we don't double-fire within a single process restart cycle. */
const reminded = new Set<string>();

export async function runOnce() {
  const sc = getServiceClient();
  if (!sc) return;

  const now      = new Date();
  const lower    = new Date(now.getTime() + WINDOW_LOWER_HRS * 3_600_000).toISOString();
  const upper    = new Date(now.getTime() + WINDOW_UPPER_HRS * 3_600_000).toISOString();

  const { data: trips, error } = await sc
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
    const { data: claimed, error: claimError } = await sc
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
      // Someone else (or a previous run) already sent this reminder.
      reminded.add(tripId);
      continue;
    }
    reminded.add(tripId);

    try {
      // Collect owner + all accepted members
      const { data: members } = await sc
        .from("trip_members")
        .select("user_id")
        .eq("trip_id", tripId)
        .eq("role", "member");

      const recipientIds = [trip.owner_id as string];
      (members ?? []).forEach((m: any) => {
        if (m.user_id !== trip.owner_id) recipientIds.push(m.user_id);
      });

      const { data: profiles } = await sc
        .from("profiles")
        .select("id, expo_push_token")
        .in("id", recipientIds);

      const recipients = (profiles ?? [])
        .filter((p: any) => Boolean(p.expo_push_token))
        .map((p: any) => ({ userId: p.id as string, tokens: [p.expo_push_token as string] }));

      if (recipients.length > 0) {
        await sendPushWithRetry(sc, recipients, {
          title: "Your trip starts tomorrow! 🌍",
          body:  `${trip.title ?? "Your upcoming trip"} starts in about 24 hours. Have a great trip!`,
          data:  { type: "trip_24h_reminder", tripId },
        });
        logger.info({ tripId, recipients: recipients.length }, "TripReminderScheduler: 24h reminder sent");
      }
    } catch (err) {
      logger.warn({ err, tripId }, "TripReminderScheduler: failed to send reminder for trip");
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
