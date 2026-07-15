/**
 * safeReturnScheduler
 *
 * Background job that runs periodically to:
 *  1. Detect active Safe Return sessions whose timer has expired and escalate them.
 *  2. Expire stale live-shares (status='active', expires_at < now).
 *
 * Uses the service-role client — never fires user-auth requests — so it is safe
 * to run as a true internal cron path independent of any HTTP request lifecycle.
 */
import { logger as rootLogger } from "./logger";
import { getServiceClient } from "./supabase";
import {
  findExpiredActiveSessions,
  markMissed,
  listContacts,
  markContactNotified,
} from "../services/safeReturn/SafeReturnService";
import {
  sendMissedCheckIn,
  notifyTrustedCircle,
  notifyHost,
  notifyTripCrew,
} from "../services/safeReturn/SafeReturnNotificationService";
import { expireShare } from "../services/safeReturn/SafeReturnLiveShareService";

const logger = rootLogger.child({ job: "SafeReturnScheduler" });

const POLL_INTERVAL_MS = 60_000; // every 60 seconds

// ── Inline feature-flag helper (service-role only) ────────────────────────────

async function isFlagEnabled(
  db: Exclude<ReturnType<typeof getServiceClient>, null>,
  flag: string,
): Promise<boolean> {
  try {
    const { data } = await db
      .from("feature_flags")
      .select("enabled")
      .eq("key", flag)
      .maybeSingle();
    return (data as any)?.enabled === true;
  } catch {
    return false;
  }
}

// ── Expired session escalation ────────────────────────────────────────────────

async function processExpiredSessions(): Promise<void> {
  const db = getServiceClient();
  if (!db) {
    logger.warn("processExpiredSessions: no service client, skipping");
    return;
  }

  const flagEnabled = await isFlagEnabled(db, "safe_return_enabled").catch(() => false);
  if (!flagEnabled) return;

  const expired = await findExpiredActiveSessions(db);
  if (expired.length === 0) return;

  logger.info({ count: expired.length }, "processExpiredSessions: processing sessions");

  const flagTcAlerts = await isFlagEnabled(db, "safe_return_trusted_circle_alerts_enabled").catch(() => false);

  for (const session of expired) {
    try {
      const missed = await markMissed(db, session.id, session.userId);
      if (!missed) continue;

      await sendMissedCheckIn(db, missed);

      if (missed.escalationLevel >= 1 && flagTcAlerts) {
        const contacts = await listContacts(db, missed.id, missed.userId);
        await notifyTrustedCircle(db, missed, contacts);
        await Promise.all(contacts.map((c) => markContactNotified(db, c.id)));
      }

      if (missed.escalationLevel >= 3) {
        await notifyHost(db, missed);
        await notifyTripCrew(db, missed);
      }

      logger.info(
        { sessionId: session.id, level: session.escalationLevel },
        "processExpiredSessions: escalated",
      );
    } catch (err) {
      logger.warn({ err, sessionId: session.id }, "processExpiredSessions: error processing session");
    }
  }
}

// ── Stale live-share expiry ───────────────────────────────────────────────────

async function processExpiredLiveShares(): Promise<void> {
  const db = getServiceClient();
  if (!db) return;

  try {
    const now = new Date().toISOString();
    const { data: stale } = await db
      .from("safe_return_live_shares")
      .select("id")
      .eq("status", "active")
      .not("expires_at", "is", null)
      .lt("expires_at", now)
      .limit(50);

    if (!stale || stale.length === 0) return;

    logger.info({ count: stale.length }, "processExpiredLiveShares: expiring stale shares");

    await Promise.allSettled(
      (stale as any[]).map((row: any) =>
        expireShare(db, row.id).catch((err: unknown) =>
          logger.warn({ err, shareId: row.id }, "processExpiredLiveShares: expireShare threw"),
        ),
      ),
    );
  } catch (err) {
    logger.warn({ err }, "processExpiredLiveShares: threw");
  }
}

// ── Ticker ────────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  await Promise.allSettled([
    processExpiredSessions(),
    processExpiredLiveShares(),
  ]);
}

let _interval: ReturnType<typeof setInterval> | null = null;

export function startSafeReturnScheduler(): void {
  if (_interval) return;
  logger.info({ intervalMs: POLL_INTERVAL_MS }, "SafeReturnScheduler: starting");
  _interval = setInterval(() => {
    tick().catch((err: unknown) => logger.warn({ err }, "SafeReturnScheduler: tick threw"));
  }, POLL_INTERVAL_MS);
  // Run immediately on startup (brief delay to let the server finish init)
  setTimeout(() => {
    tick().catch((err: unknown) => logger.warn({ err }, "SafeReturnScheduler: initial tick threw"));
  }, 5_000);
}

export function stopSafeReturnScheduler(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}
