/**
 * Creator Attribution Scheduler — drives the creator attribution producers.
 * census-discovery DV-56 (`07` §10 "value can be attributed"); §17.2's bar for
 * DV-56…DV-59 is "a call site on a route or scheduler", and this is the
 * scheduler.
 *
 * Every hour it runs one pass of
 * `services/creators/CreatorAttributionProducers.ts#attributeCompletedTravelPartnerBookings`.
 * The pass is gated fail-closed on `creator_attribution_enabled` (2922, seeded
 * FALSE): with the flag off a tick reads that one flag row and writes nothing,
 * which is the state of every deployment until an owner turns it on.
 *
 * Follows lib/creatorActivityScoreScheduler.ts's shape: a startup delay, an
 * unref'd interval, and an in-process guard against overlapping ticks. The
 * pass itself is idempotent (bookings already attributed are skipped, and a
 * race replays onto 2920's unique key), so a second instance running the same
 * tick writes no second row.
 */
import { getServiceClient, isServiceClientReady } from "./supabase.js";
import { logger as rootLogger } from "./logger.js";
import { attributeCompletedTravelPartnerBookings } from "../services/creators/CreatorAttributionProducers.js";

const logger = rootLogger.child({ job: "CreatorAttributionScheduler" });

const STARTUP_DELAY_MS = 3 * 60_000;
const JOB_INTERVAL_MS = 60 * 60_000;

let _running = false;
let _testClient: any | null = null;
/** Inject a fake client in tests; pass null to restore. */
export function _setTestClient(sc: any | null): void {
  _testClient = sc;
}

export type CreatorAttributionTick =
  | { status: "skipped"; reason: "already_running" | "no_client" }
  | { status: "ran"; outcome: Awaited<ReturnType<typeof attributeCompletedTravelPartnerBookings>> };

/** One tick. Exported so a test can drive it without timers. */
export async function runCreatorAttributionTick(): Promise<CreatorAttributionTick> {
  if (_running) return { status: "skipped", reason: "already_running" };
  const sc = _testClient ?? (isServiceClientReady ? getServiceClient() : null);
  if (!sc) return { status: "skipped", reason: "no_client" };
  _running = true;
  try {
    const outcome = await attributeCompletedTravelPartnerBookings(sc);
    if (outcome.ok) {
      logger.info(outcome.value, "CreatorAttributionScheduler: travel_partner pass complete");
    } else if (outcome.reason !== "disabled") {
      // `disabled` is the seeded state and is not news; anything else is.
      logger.warn({ reason: outcome.reason, detail: outcome.detail }, "CreatorAttributionScheduler: pass refused");
    }
    return { status: "ran", outcome };
  } finally {
    _running = false;
  }
}

/** Start the periodic producer. Returns the interval handle so tests can cancel it. */
export function startCreatorAttributionScheduler(): ReturnType<typeof setInterval> {
  const tick = () => {
    runCreatorAttributionTick().catch((err) => logger.warn({ err }, "CreatorAttributionScheduler: tick error"));
  };
  const startupTimer = setTimeout(tick, STARTUP_DELAY_MS);
  const interval = setInterval(tick, JOB_INTERVAL_MS);
  interval.unref();
  if (typeof startupTimer.unref === "function") startupTimer.unref();
  logger.info({ intervalMinutes: JOB_INTERVAL_MS / 60_000 }, "CreatorAttributionScheduler: started");
  return interval;
}
