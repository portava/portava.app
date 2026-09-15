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
  alertFellShort,
  type AlertOutcome,
} from "../services/safeReturn/SafeReturnNotificationService";
import { expireShareSettled } from "../services/safeReturn/SafeReturnLiveShareService";

const logger = rootLogger.child({ job: "SafeReturnScheduler" });

const POLL_INTERVAL_MS = 60_000; // every 60 seconds

// ── Inline feature-flag helper (service-role only) ────────────────────────────

/**
 * Flag state for the escalation job.
 *
 * `unknown` is separate from `off` because this job's `if (!flagEnabled)
 * return;` is the difference between "Safe Return is switched off" and "every
 * missed check-in in the system goes unescalated, silently, for as long as
 * feature_flags cannot be read". supabase-js RESOLVES on a DB error, so the old
 * `(data as any)?.enabled === true` produced `false` for both.
 */
type FlagState = "on" | "off" | "unknown";

// NAME KEPT: check-flag-polarity.mjs identifies the flags this job reads from
// the literals passed to `isFlagEnabled`, and this file carries a declared
// SHADOW_READERS entry under that name. The return TYPE is what changed.
async function isFlagEnabled(
  db: Exclude<ReturnType<typeof getServiceClient>, null>,
  flag: string,
): Promise<FlagState> {
  try {
    const { data, error } = await db
      .from("feature_flags")
      .select("enabled")
      .eq("flag", flag)
      .maybeSingle();
    if (error) {
      logger.error({ err: error, flag }, "SafeReturnScheduler: feature flag unreadable");
      return "unknown";
    }
    return (data as any)?.enabled === true ? "on" : "off";
  } catch (err) {
    logger.error({ err, flag }, "SafeReturnScheduler: feature flag read threw");
    return "unknown";
  }
}

// ── Expired session escalation ────────────────────────────────────────────────

async function processExpiredSessions(): Promise<void> {
  const db = getServiceClient();
  if (!db) {
    logger.warn("processExpiredSessions: no service client, skipping");
    return;
  }

  const flagEnabled = await isFlagEnabled(db, "safe_return_enabled");
  if (flagEnabled === "off") return;
  if (flagEnabled === "unknown") {
    // Do NOT return. A flag we cannot read is not permission to stop escalating
    // missed check-ins; the escalation itself is gated per session by the
    // user's own `escalation_level` and `trusted_circle_enabled`, so proceeding
    // cannot notify anyone the user did not nominate. It is logged as an
    // ERROR because running the safety job on an unverified flag is a state an
    // operator must know about.
    logger.error("processExpiredSessions: safe_return_enabled unreadable — escalating anyway rather than silently standing down");
  }

  const expiredRead = await findExpiredActiveSessions(db);
  if (!expiredRead.ok) {
    // The old `expired.length === 0 → return` swallowed exactly this: a failed
    // read looked identical to a healthy minute with nothing to do, and the
    // whole escalation system was off with no log line to show for it.
    logger.error(
      { reason: expiredRead.reason },
      "processExpiredSessions: expired-session read FAILED — missed check-ins are NOT being escalated this tick",
    );
    return;
  }
  const expired = expiredRead.value;
  if (expired.length === 0) return;

  logger.info({ count: expired.length }, "processExpiredSessions: processing sessions");

  const flagTcAlerts = await isFlagEnabled(db, "safe_return_trusted_circle_alerts_enabled");

  for (const session of expired) {
    try {
      const missedResult = await markMissed(db, session.id, session.userId);
      if (missedResult.outcome === "unavailable") {
        logger.error(
          { reason: missedResult.reason, sessionId: session.id },
          "processExpiredSessions: markMissed FAILED — this session was not escalated",
        );
        continue;
      }
      if (missedResult.outcome === "no_match") continue;
      const missed = missedResult.session;

      const outcomes: Record<string, unknown> = {};
      let incomplete = false;
      const record = (name: string, o: AlertOutcome) => {
        outcomes[name] = o;
        if (alertFellShort(o)) incomplete = true;
      };

      record("traveller", await sendMissedCheckIn(db, missed));

      // `unknown` does not cancel the alert, for the same reason as above.
      if (missed.escalationLevel >= 1 && flagTcAlerts !== "off") {
        const contactsRead = await listContacts(db, missed.id, missed.userId);
        const contacts = contactsRead.ok ? contactsRead.value : [];
        if (!contactsRead.ok) {
          logger.error(
            { reason: contactsRead.reason, sessionId: missed.id },
            "processExpiredSessions: contacts unreadable — cannot say who should have been alerted",
          );
        }
        record("trustedCircle", await notifyTrustedCircle(db, missed, contacts, !contactsRead.ok));
        const stamps = await Promise.all(contacts.map((c) => markContactNotified(db, c.id)));
        if (stamps.some((r) => !r.ok)) {
          logger.error({ sessionId: missed.id }, "processExpiredSessions: notified_at not stamped for every contact");
        }
      }

      if (missed.escalationLevel >= 3) {
        record("host", await notifyHost(db, missed));
        record("crew", await notifyTripCrew(db, missed));
      }

      if (incomplete) {
        logger.error(
          { sessionId: session.id, level: missed.escalationLevel, outcomes },
          "processExpiredSessions: escalated but NOT everyone who should have been alerted was",
        );
      } else {
        logger.info(
          { sessionId: session.id, level: missed.escalationLevel, outcomes },
          "processExpiredSessions: escalated",
        );
      }
    } catch (err) {
      logger.error({ err, sessionId: session.id }, "processExpiredSessions: error processing session — escalation incomplete");
    }
  }
}

// ── Stale live-share expiry ───────────────────────────────────────────────────

/**
 * What the sweep actually did. RETURNED rather than only logged, because a test
 * that asserts on log output asserts on a format; this is the contract. The
 * production caller ignores it — the value is that it can no longer be absent.
 */
export type ExpirySweepSummary = {
  swept: boolean;
  reason?: "no_client" | "read_failed" | "threw";
  ok: number;
  noMatch: number;
  unavailable: number;
};

/**
 * EXPORTED, AND THE SEAM IS ONE DEFAULTED PARAMETER RATHER THAN A REWRITE.
 * The production call below still invokes it with no arguments and still gets
 * `getServiceClient()`; a test passes a fake instead. Nothing about the shape of
 * what is being tested changes — which is the objection to seams, and the reason
 * this one is a default rather than a required argument or an injected module.
 */
export async function processExpiredLiveShares(
  client?: ReturnType<typeof getServiceClient>,
): Promise<ExpirySweepSummary> {
  const db = client ?? getServiceClient();
  if (!db) return { swept: false, reason: "no_client", ok: 0, noMatch: 0, unavailable: 0 };

  try {
    const now = new Date().toISOString();
    const { data: stale, error } = await db
      .from("safe_return_live_shares")
      .select("id")
      .eq("status", "active")
      .not("expires_at", "is", null)
      .lt("expires_at", now)
      .limit(50);

    // An unreadable table is not "nothing to expire". These rows are live
    // location shares past their cutoff; leaving them at status='active'
    // without a log makes a stalled expiry sweep look like a quiet one. (The
    // hard expiry check in SafeReturnLiveShareService still refuses to serve
    // them, so this is a hygiene failure, not an exposure — but it is a
    // failure, and it now says so.)
    if (error) {
      logger.error({ err: error }, "processExpiredLiveShares: stale-share read FAILED — expired shares were not swept this tick");
      return { swept: false, reason: "read_failed", ok: 0, noMatch: 0, unavailable: 0 };
    }
    if (!stale || stale.length === 0) return { swept: true, ok: 0, noMatch: 0, unavailable: 0 };

    logger.info({ count: stale.length }, "processExpiredLiveShares: expiring stale shares");

    // ── WHY THIS COUNTS RATHER THAN FIRE-AND-FORGETS ─────────────────────────
    //
    // `expireShare` is a LOSSY PROJECTION of `expireShareSettled` and its own
    // header says so. It collapses "the filter matched no row" (normal: already
    // closed, or someone else swept it) and "the statement did not complete"
    // (the share's state is UNKNOWN, and it is a live location share that the
    // person has already stopped agreeing to) into the same `null`.
    //
    // Discarding that `null` made the two indistinguishable HERE too, which is
    // the shape the Layover lane found one directory over: a sweep that fails
    // for every share looks exactly like a sweep with nothing to do. Both log
    // nothing and both return. The tick then reports success.
    //
    // So the outcomes are counted and an `unavailable` is reported at ERROR with
    // the count, separately from `no_match`. It does not retry and it does not
    // throw: the next tick sweeps again, and a share left open is found again
    // because its `expires_at` has not moved. What changes is that the failure
    // is VISIBLE on the tick it happened, instead of being inferred later from
    // a share that outlived its window.
    const settled = await Promise.allSettled(
      (stale as any[]).map((row: any) => expireShareSettled(db, row.id)),
    );

    let ok = 0;
    let noMatch = 0;
    const unavailable: Array<{ shareId: string; reason: string }> = [];
    settled.forEach((r, i) => {
      const shareId = String((stale as any[])[i]?.id ?? "unknown");
      if (r.status === "rejected") {
        unavailable.push({ shareId, reason: String((r.reason as any)?.message ?? r.reason ?? "threw") });
        return;
      }
      if (r.value.outcome === "ok") ok += 1;
      else if (r.value.outcome === "no_match") noMatch += 1;
      else unavailable.push({ shareId, reason: r.value.reason });
    });

    if (unavailable.length > 0) {
      logger.error(
        { ok, noMatch, unavailable: unavailable.length, shares: unavailable.slice(0, 10) },
        "processExpiredLiveShares: some shares could NOT be expired — their state is unknown and a " +
          "location may still be shared past the window the person agreed to",
      );
    } else {
      logger.info({ ok, noMatch }, "processExpiredLiveShares: swept");
    }

    return { swept: true, ok, noMatch, unavailable: unavailable.length };
  } catch (err) {
    logger.warn({ err }, "processExpiredLiveShares: threw");
    return { swept: false, reason: "threw", ok: 0, noMatch: 0, unavailable: 0 };
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
