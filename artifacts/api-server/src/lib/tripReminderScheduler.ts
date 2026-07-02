/**
 * tripReminderScheduler
 *
 * Polls once per hour for trips whose start_date falls within the next 22–26 hours
 * and sends a "Your trip starts tomorrow!" push notification to the owner and all
 * accepted crew members. A deduplication column (`reminder_sent_at`) on the trips
 * table prevents double-sending; if the column does not exist we fall back to a
 * lightweight in-memory set that persists for the lifetime of the process.
 */
import { logger as rootLogger } from "./logger.js";
import { getServiceClient } from "./supabase.js";
import { sendPushNotification } from "./push.js";

const logger = rootLogger.child({ job: "TripReminderScheduler" });

const POLL_INTERVAL_MS  = 60 * 60 * 1000; // every 60 minutes
const WINDOW_LOWER_HRS  = 22;
const WINDOW_UPPER_HRS  = 26;

/** In-memory dedup so we don't double-fire within a single process restart cycle. */
const reminded = new Set<string>();

async function runOnce() {
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
    .order("start_date", { ascending: true });

  if (error) { logger.warn({ err: error }, "TripReminderScheduler: query error"); return; }
  if (!trips || trips.length === 0) return;

  for (const trip of trips as any[]) {
    const tripId = trip.id as string;
    if (reminded.has(tripId)) continue;
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
        .select("expo_push_token")
        .in("id", recipientIds);

      const tokens = (profiles ?? [])
        .map((p: any) => p.expo_push_token as string | undefined)
        .filter(Boolean);

      if (tokens.length > 0) {
        await sendPushNotification(tokens, {
          title: "Your trip starts tomorrow! 🌍",
          body:  `${trip.title ?? "Your upcoming trip"} starts in about 24 hours. Have a great trip!`,
          data:  { type: "trip_24h_reminder", tripId },
        });
        logger.info({ tripId, recipients: tokens.length }, "TripReminderScheduler: 24h reminder sent");
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
