/**
 * notificationMaintenanceScheduler — the missing driver for the notification
 * pipeline's two scheduled jobs.
 *
 * ── THE GAP THIS CLOSES ──────────────────────────────────────────────────────
 * `NotificationDigestService.runForAllUsers()` and
 * `NotificationService.expireOldNotifications()` are both written, tested and
 * documented as "called by the scheduled cleanup/job infrastructure". There was
 * no such infrastructure. Before this file, the ONLY things in the repository
 * that referenced either function were:
 *
 *   - their own definitions,
 *   - `POST /internal/notifications/digest` and `POST /internal/notifications/expire`
 *     in src/routes/notifications.ts,
 *   - src/test/notificationFailClosedReads.test.ts.
 *
 * Nothing called those routes. There is no pg_cron in src/migrations (no
 * migration in this tree contains `cron.schedule`), no workflow under .github,
 * no shell or .mjs script, and none of the 47 `start*()` calls in src/index.ts
 * reached either function. So on a running server: no daily digest was ever
 * built, and `notifications.expires_at` was a column every reader honoured and
 * nothing ever acted on — rows accumulated for ever, exactly the shape
 * lib/sensingRetentionScheduler and lib/intelRetentionScheduler exist to refuse.
 *
 * ── "COULD NOT LOOK" IS NOT "NOTHING TO DO" ──────────────────────────────────
 * Both halves of this pass are guarded so a database that cannot be read is
 * never filed as a quiet day:
 *
 *   DIGEST. `runForAllUsers()` already returns `recipientsUnreadable`. This
 *   scheduler treats that as a FAILED pass: it does not mark the day done, it
 *   increments `consecutiveFailures`, and it logs at error level. The next tick
 *   retries the same day, which is safe because the digest's own per-day claim
 *   (`sourceId = "<category>_<YYYY-MM-DD>"`) makes a retry a no-op once the day
 *   really has been digested.
 *
 *   EXPIRY. `expireOldNotifications()` returns `0` BOTH when nothing was expired
 *   AND when the delete failed — it logs the error and returns 0 either way, and
 *   it is not this lane's file to change. A caller that simply reported that 0
 *   would be reporting "could not look" as "nothing to do", which is the defect
 *   class this file is here to close. So the pass PROBES FIRST: one bounded read
 *   for a single row with `expires_at < now`, with its `.error` checked.
 *
 *     probe errors                 → `expiry_unreadable`; the delete is NOT
 *                                    attempted and the pass is a FAILURE.
 *     probe finds no expired row   → there was genuinely nothing to expire;
 *                                    `deleted: 0` is a real answer.
 *     probe finds a row, delete
 *       returns 0                  → the delete did not do what the backlog
 *                                    says it should have; counted as a failure
 *                                    (`expiryZeroDespiteBacklog`), never as a
 *                                    clean pass.
 *
 *   The probe is what makes the expiry half MEASURABLE from outside a service
 *   whose return value cannot distinguish the two cases on its own.
 *
 * ── consecutiveFailures RESETS ONLY ON A PASS THAT GENUINELY SUCCEEDED ───────
 * Not "a pass that did not throw". A pass in which the recipient list was
 * unreadable, or the expiry probe failed, or the delete under-delivered, leaves
 * the counter climbing. `lastRunAt` records when a pass was ATTEMPTED and
 * `lastSuccessAt` when one actually worked; a health reader that sees those
 * diverge is looking at a job that is running and failing, which is the state
 * that was previously indistinguishable from a healthy idle one.
 *
 * ── RUNNING ON EVERY INSTANCE: WHAT ACTUALLY STOPS A DOUBLE SEND ─────────────
 * This is an in-process `setTimeout` like every other scheduler here, and there
 * is NO distributed lock anywhere in this repository — no advisory-lock helper,
 * no claim table, no `job_runs`. Inventing one is not this lane's call. What is
 * true today, precisely:
 *
 *   EXPIRY is idempotent by construction. `DELETE FROM notifications WHERE
 *   expires_at < now()` run twice concurrently deletes each row once; the two
 *   instances simply split the set. Two instances are safe. No claim needed.
 *
 *   DIGEST is at-most-once per (user, category, day) through TWO independent
 *   downstream mechanisms, neither of which is in this file:
 *     1. `alreadyDigestedForDay` — a read-then-write claim on the per-day
 *        `source_id`. Covers any two runs separated by more than the write
 *        latency. In practice that is the multi-instance case, because
 *        instances boot at different times and the tick is anchored to boot,
 *        not to a wall-clock minute every instance would hit together.
 *     2. `NotificationDeduplicationService`'s 30-minute window on
 *        (user, category, eventType, sourceType, sourceId) — which is exactly
 *        the window the read-then-write claim cannot cover, the near-simultaneous
 *        one.
 *   Together they leave one residual race: two instances whose reads BOTH
 *   precede both writes, within the same instant. That window is real and is
 *   RECORDED, not papered over. Closing it properly needs a partial unique index
 *   on `notifications (user_id, source_id) WHERE source_type = 'digest'`, the
 *   same technique migration 2650 used for `trust_reviews.source_event_id`;
 *   that is a migration, and migrations are held elsewhere.
 *
 *   The operational lever available NOW without a migration is
 *   `NOTIFICATION_MAINTENANCE_DISABLED=1`, which makes this scheduler an inert
 *   heartbeat on the instances an operator does not want driving it. It is NOT
 *   the default, because a job nothing runs is the defect this file exists to
 *   fix, and the safe-by-default direction here is "runs everywhere, deduped
 *   downstream" rather than "runs nowhere unless someone remembers".
 *
 * ── CADENCE ──────────────────────────────────────────────────────────────────
 * The tick is hourly. Expiry runs on every tick (cheap, idempotent). The digest
 * runs on the FIRST tick of each new local day, and only then — and if that
 * attempt fails, the day is NOT marked done, so the next hourly tick retries it.
 * "Local day" is the same convention the digest itself uses for its `sourceId`
 * (`getStartOfYesterday()` → `setHours(0,0,0,0)`), so the scheduler's idea of a
 * new day and the claim's idea of a day cannot drift apart.
 */
import { logger as rootLogger } from "./logger.js";
import { getServiceClient } from "./supabase.js";
import { NotificationDigestService } from "../services/notifications/NotificationDigestService.js";
import { NotificationService } from "../services/notifications/NotificationService.js";

const logger = rootLogger.child({ scheduler: "notificationMaintenance" });

/** A positive finite env float, else the default (house pattern: eventWaitlistSweeper). */
function parseEnvFloat(raw: string | undefined, def: number): number {
  const v = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(v) && v > 0 ? v : def;
}

const INTERVAL_HOURS = parseEnvFloat(process.env["NOTIFICATION_MAINTENANCE_INTERVAL_HOURS"], 1);

export const NOTIFICATION_MAINTENANCE_INTERVAL_MS = INTERVAL_HOURS * 60 * 60 * 1_000;

/**
 * Later than the intel band (latest is 8 minutes) and the sensing sweep (9), so
 * the boot burst is not made worse by a job whose first useful moment is the
 * next local midnight anyway.
 */
export const NOTIFICATION_MAINTENANCE_STARTUP_DELAY_MS = parseEnvFloat(
  process.env["NOTIFICATION_MAINTENANCE_STARTUP_DELAY_MS"],
  10 * 60 * 1_000,
);

/** Opt-out for operators who want exactly one instance driving the digest. */
export function maintenanceDisabled(): boolean {
  const raw = process.env["NOTIFICATION_MAINTENANCE_DISABLED"];
  return raw === "1" || raw === "true";
}

// ── Result ────────────────────────────────────────────────────────────────────

export type MaintenanceSkipReason = "no_service_client" | "disabled";

export interface NotificationMaintenanceResult {
  /** True only when every half of the pass that ran did what it claims. */
  ok: boolean;
  /** True when the pass did not attempt any work at all. */
  skipped: boolean;
  skipReason: MaintenanceSkipReason | null;

  /** Did this tick attempt the daily digest (first tick of a new local day)? */
  digestAttempted: boolean;
  /** Recipients the digest pass processed. Meaningless unless digestAttempted. */
  digestUsersProcessed: number;
  /** True when the recipient list could not be READ — not "no one opted in". */
  digestRecipientsUnreadable: boolean;

  /** Did the expiry probe succeed, so the delete could be attempted? */
  expiryProbed: boolean;
  /** True when the probe itself failed: we could not look. */
  expiryUnreadable: boolean;
  /** Did the probe find at least one already-expired row? */
  expiryBacklogSeen: boolean;
  /** Rows the delete reported. Only meaningful when expiryProbed && !expiryUnreadable. */
  expiredDeleted: number;
  /**
   * Probe saw a backlog, delete reported nothing. `expireOldNotifications`
   * collapses its error into 0, so this is how that error becomes visible.
   */
  expiryZeroDespiteBacklog: boolean;

  /** Every reason this pass is not a success, for the log and the health surface. */
  failures: string[];
}

const EMPTY: NotificationMaintenanceResult = {
  ok: true,
  skipped: false,
  skipReason: null,
  digestAttempted: false,
  digestUsersProcessed: 0,
  digestRecipientsUnreadable: false,
  expiryProbed: false,
  expiryUnreadable: false,
  expiryBacklogSeen: false,
  expiredDeleted: 0,
  expiryZeroDespiteBacklog: false,
  failures: [],
};

// ── Status (health surface) ───────────────────────────────────────────────────

export interface NotificationMaintenanceStatus {
  /** When a pass was last ATTEMPTED. */
  lastRunAt: string | null;
  /** When a pass last genuinely SUCCEEDED. Diverges from lastRunAt when broken. */
  lastSuccessAt: string | null;
  lastDigestDay: string | null;
  lastDigestUsersProcessed: number | null;
  lastExpiredDeleted: number | null;
  lastFailures: string[];
  lastSkippedReason: string | null;
  consecutiveFailures: number;
}

const _status: NotificationMaintenanceStatus = {
  lastRunAt: null,
  lastSuccessAt: null,
  lastDigestDay: null,
  lastDigestUsersProcessed: null,
  lastExpiredDeleted: null,
  lastFailures: [],
  lastSkippedReason: null,
  consecutiveFailures: 0,
};

export function getNotificationMaintenanceStatus(): Readonly<NotificationMaintenanceStatus> {
  return { ..._status, lastFailures: [..._status.lastFailures] };
}

/** Reset status between test runs — not for production use. */
export function _resetStatus(): void {
  _status.lastRunAt = null;
  _status.lastSuccessAt = null;
  _status.lastDigestDay = null;
  _status.lastDigestUsersProcessed = null;
  _status.lastExpiredDeleted = null;
  _status.lastFailures = [];
  _status.lastSkippedReason = null;
  _status.consecutiveFailures = 0;
}

// ── Day key ───────────────────────────────────────────────────────────────────

/**
 * The local calendar day, in the SAME convention NotificationDigestService uses
 * to name a digest (`setHours(0,0,0,0)` then `toISOString().slice(0,10)`).
 *
 * It must be derived the same way or the scheduler would decide "it is a new
 * day" on a boundary the claim disagrees with, and the digest would either be
 * attempted twice for one claimed day or skipped for a day nobody claimed.
 */
export function localDayKey(now: Date = new Date()): string {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

// ── Expiry probe ──────────────────────────────────────────────────────────────

/**
 * Can we read the notifications table, and is there anything already expired?
 *
 * `.error` is checked because supabase-js RESOLVES on a database error with
 * `data: null` — an unchecked read here would answer "no backlog" for an
 * unreadable table and hand a clean bill of health to a broken database.
 */
async function probeExpiryBacklog(
  db: any,
  nowIso: string,
): Promise<{ readable: boolean; backlog: boolean }> {
  try {
    const { data, error } = await db
      .from("notifications")
      .select("id")
      .lt("expires_at", nowIso)
      .limit(1);
    if (error) {
      logger.error(
        { err: error },
        "notification maintenance: expiry probe failed — the notifications table could not be read; NOT reporting 'nothing to expire'",
      );
      return { readable: false, backlog: false };
    }
    return { readable: true, backlog: Array.isArray(data) && data.length > 0 };
  } catch (err) {
    logger.error({ err }, "notification maintenance: expiry probe threw — could not look");
    return { readable: false, backlog: false };
  }
}

// ── One pass ──────────────────────────────────────────────────────────────────

export interface RunOptions {
  /**
   * Explicit client override for tests. `"client" in opts && opts.client !== undefined`
   * rather than `opts.client ?? getServiceClient()`: `??` does not short-circuit
   * on an explicit null, so a test passing `client: null` would get a REAL client
   * and open a socket. lib/intelRetentionScheduler records that exact defect.
   */
  client?: any;
  now?: Date;
  /**
   * Force the digest half on or off. Undefined (the default) means "decide from
   * the day key", which is what the scheduler does.
   */
  runDigest?: boolean;
}

export async function runNotificationMaintenance(
  opts: RunOptions = {},
): Promise<NotificationMaintenanceResult> {
  if (maintenanceDisabled()) {
    return { ...EMPTY, skipped: true, skipReason: "disabled" };
  }

  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) {
    return { ...EMPTY, ok: false, skipped: true, skipReason: "no_service_client" };
  }

  const now = opts.now ?? new Date();
  const dayKey = localDayKey(now);
  const failures: string[] = [];

  // ── Digest ──────────────────────────────────────────────────────────────────
  const shouldDigest = opts.runDigest !== undefined
    ? opts.runDigest
    : _status.lastDigestDay !== dayKey;

  let digestAttempted = false;
  let digestUsersProcessed = 0;
  let digestRecipientsUnreadable = false;

  if (shouldDigest) {
    digestAttempted = true;
    try {
      const r = await new NotificationDigestService(db).runForAllUsers();
      digestUsersProcessed = r.usersProcessed;
      digestRecipientsUnreadable = r.recipientsUnreadable;
      if (r.recipientsUnreadable) {
        failures.push("digest_recipients_unreadable");
        logger.error(
          { dayKey },
          "notification maintenance: digest recipient list unreadable — this is NOT 'no user has digests enabled'; the day is NOT marked done and the next tick retries it",
        );
      } else {
        // Only a run that actually read the list closes the day.
        _status.lastDigestDay = dayKey;
        _status.lastDigestUsersProcessed = r.usersProcessed;
        logger.info(
          { dayKey, usersProcessed: r.usersProcessed },
          "notification maintenance: daily digest pass complete",
        );
        if (r.usersProcessed === 0) {
          // Readable and empty is a real answer, but it is worth saying out
          // loud: this is the state in which the whole digest feature is on and
          // reaching nobody.
          logger.warn(
            { dayKey },
            "notification maintenance: digest recipient list READ successfully and is EMPTY — no user has digests_enabled",
          );
        }
      }
    } catch (err) {
      digestRecipientsUnreadable = true;
      failures.push("digest_threw");
      logger.error({ err, dayKey }, "notification maintenance: digest pass threw");
    }
  }

  // ── Expiry ──────────────────────────────────────────────────────────────────
  const nowIso = now.toISOString();
  const probe = await probeExpiryBacklog(db, nowIso);

  let expiredDeleted = 0;
  let expiryZeroDespiteBacklog = false;

  if (!probe.readable) {
    failures.push("expiry_unreadable");
  } else {
    try {
      expiredDeleted = await new NotificationService(db).expireOldNotifications();
    } catch (err) {
      failures.push("expiry_threw");
      logger.error({ err }, "notification maintenance: expiry pass threw");
    }
    if (probe.backlog && expiredDeleted === 0 && !failures.includes("expiry_threw")) {
      // The probe saw at least one row the delete should have taken. The service
      // returns 0 for a failed delete as well as for an empty one, so this is
      // the only place that difference is observable.
      expiryZeroDespiteBacklog = true;
      failures.push("expiry_zero_despite_backlog");
      logger.error(
        {},
        "notification maintenance: expiry probe saw an expired row but the delete reported 0 — treating as a FAILED expiry, not an empty one",
      );
    }
    if (expiredDeleted > 0) {
      _status.lastExpiredDeleted = expiredDeleted;
    } else if (!expiryZeroDespiteBacklog) {
      _status.lastExpiredDeleted = 0;
    }
  }

  return {
    ok: failures.length === 0,
    skipped: false,
    skipReason: null,
    digestAttempted,
    digestUsersProcessed,
    digestRecipientsUnreadable,
    expiryProbed: true,
    expiryUnreadable: !probe.readable,
    expiryBacklogSeen: probe.backlog,
    expiredDeleted,
    expiryZeroDespiteBacklog,
    failures,
  };
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let _timer: ReturnType<typeof setTimeout> | null = null;

/**
 * One scheduled tick: run a pass and fold its outcome into the health counters.
 *
 * `opts` exists so a test can drive the no-service-client path deterministically
 * — `getServiceClient()` builds a real client whenever SUPABASE_URL and the
 * service key are present in the environment, which they are under the suite's
 * own run command, so "no client" cannot be produced by injection alone.
 */
export async function tickOnce(opts: RunOptions = {}): Promise<NotificationMaintenanceResult> {
  let r: NotificationMaintenanceResult;
  try {
    r = await runNotificationMaintenance(opts);
  } catch (err) {
    _status.lastRunAt = new Date().toISOString();
    _status.consecutiveFailures += 1;
    _status.lastFailures = ["threw"];
    logger.error(
      { err, consecutiveFailures: _status.consecutiveFailures },
      "notification maintenance pass failed",
    );
    return { ...EMPTY, ok: false, failures: ["threw"] };
  }

  _status.lastRunAt = new Date().toISOString();
  _status.lastSkippedReason = r.skipped ? (r.skipReason ?? "skipped") : null;
  _status.lastFailures = [...r.failures];

  if (r.skipped) {
    // A skip is neither a success nor a failure of the WORK — except
    // no_service_client, which means this process cannot do the job at all and
    // must not read as healthy.
    if (r.skipReason === "no_service_client") {
      _status.consecutiveFailures += 1;
      logger.error(
        { consecutiveFailures: _status.consecutiveFailures },
        "notification maintenance: no service client — the job cannot run in this process",
      );
    }
    return r;
  }

  if (r.ok) {
    _status.consecutiveFailures = 0;
    _status.lastSuccessAt = _status.lastRunAt;
  } else {
    _status.consecutiveFailures += 1;
    logger.error(
      { failures: r.failures, consecutiveFailures: _status.consecutiveFailures },
      "notification maintenance pass did NOT fully succeed",
    );
  }
  return r;
}

export function startNotificationMaintenanceScheduler(): void {
  if (_timer !== null) return; // already started

  if (maintenanceDisabled()) {
    logger.warn(
      {},
      "NotificationMaintenanceScheduler NOT scheduled — NOTIFICATION_MAINTENANCE_DISABLED is set; no digest and no expiry will run in this process",
    );
    return;
  }

  logger.info(
    {
      startupDelayMs: NOTIFICATION_MAINTENANCE_STARTUP_DELAY_MS,
      intervalMs: NOTIFICATION_MAINTENANCE_INTERVAL_MS,
      digest: "first tick of each local day; retried hourly until a pass reads the recipient list",
      expiry: "every tick; probed first so an unreadable table is not reported as an empty one",
    },
    "NotificationMaintenanceScheduler scheduled",
  );

  _timer = setTimeout(function tick() {
    void tickOnce().finally(() => {
      _timer = setTimeout(tick, NOTIFICATION_MAINTENANCE_INTERVAL_MS);
    });
  }, NOTIFICATION_MAINTENANCE_STARTUP_DELAY_MS);
}

export function stopNotificationMaintenanceScheduler(): void {
  if (_timer !== null) {
    clearTimeout(_timer);
    _timer = null;
  }
}
