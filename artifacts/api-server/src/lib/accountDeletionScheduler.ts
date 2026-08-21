/**
 * accountDeletionScheduler
 *
 * Executes due account-deletion requests: rows in user_deletion_requests with
 * status='pending' whose scheduled_at has passed. Before this worker existed,
 * a user could request deletion, watch the app count down to their scheduled
 * date, and nothing would ever happen unless an admin manually pressed a
 * button — the gap the production audit flagged (P1 item 7).
 *
 * Uses the service-role client only; never runs inside an HTTP request.
 *
 * ── SAFETY: off by default ───────────────────────────────────────────────────
 * Account deletion is irreversible and this worker acts without a human in the
 * loop, so it is gated behind the `account_deletion_worker_enabled` feature
 * flag and fails CLOSED — if the flag row is missing, unreadable, or false,
 * the worker does nothing. Flip the flag only once you are satisfied with the
 * cascade in AccountDeletionService. Until then the manual admin endpoint
 * remains the only execution path (and shares the same cascade code).
 *
 * BATCH_LIMIT bounds the blast radius of any single tick.
 */
import { logger as rootLogger } from "./logger.js";
import { getServiceClient } from "./supabase.js";
import { executeAccountDeletion } from "../services/accountDeletion/AccountDeletionService.js";

const logger = rootLogger.child({ job: "AccountDeletionScheduler" });

/** Deletion is date-scheduled, not time-critical: a slow poll is fine. */
const POLL_INTERVAL_MS = 15 * 60_000; // 15 minutes
const BATCH_LIMIT = 25;
const FEATURE_FLAG = "account_deletion_worker_enabled";

async function isFlagEnabled(db: any, flag: string): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("feature_flags")
      .select("enabled")
      .eq("flag", flag)
      .maybeSingle();
    if (error) return false;
    return (data as any)?.enabled === true;
  } catch {
    return false; // fail closed
  }
}

/** Find and execute every due request. Exported for tests. */
export async function processDueDeletions(): Promise<{
  considered: number;
  executed: number;
  failed: number;
  skipped: boolean;
}> {
  const db = getServiceClient();
  if (!db) {
    logger.warn("processDueDeletions: no service client, skipping");
    return { considered: 0, executed: 0, failed: 0, skipped: true };
  }

  if (!(await isFlagEnabled(db, FEATURE_FLAG))) {
    return { considered: 0, executed: 0, failed: 0, skipped: true };
  }

  const now = new Date().toISOString();

  const { data, error } = await db
    .from("user_deletion_requests")
    .select("user_id, scheduled_at, status")
    .or(`status.eq.pending,and(status.eq.executing,execution_lease_expires_at.lte.${now})`)
    .lte("scheduled_at", now)
    .order("scheduled_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    logger.warn({ err: error }, "processDueDeletions: query failed");
    return { considered: 0, executed: 0, failed: 0, skipped: false };
  }

  const due = (data ?? []) as any[];
  if (due.length === 0) return { considered: 0, executed: 0, failed: 0, skipped: false };

  logger.info({ count: due.length }, "processDueDeletions: executing due deletion requests");

  let executed = 0;
  let failed = 0;

  // Sequential: each deletion touches many tables and Storage. Running them in
  // parallel would multiply load for no benefit — the batch is already capped.
  for (const row of due) {
    const userId = row.user_id as string;
    try {
      const outcome = await executeAccountDeletion(db, userId, {
        actorId: null, // executed by the system, not an admin
        reason: "Scheduled account deletion executed",
      });
      if (outcome.ok) {
        executed += 1;
        if (outcome.warnings.length > 0) {
          logger.warn({ userId, warnings: outcome.warnings }, "processDueDeletions: completed with warnings");
        }
      } else {
        failed += 1;
        logger.error(
          { userId, failedSteps: outcome.steps.filter((s) => !s.ok) },
          "processDueDeletions: deletion did not complete; execution claim expired for retry",
        );
      }
    } catch (err) {
      failed += 1;
      logger.error({ err, userId }, "processDueDeletions: threw");
    }
  }

  return { considered: due.length, executed, failed, skipped: false };
}

let _interval: ReturnType<typeof setInterval> | null = null;

export function startAccountDeletionScheduler(): void {
  if (_interval) return;
  logger.info(
    { intervalMs: POLL_INTERVAL_MS, batchLimit: BATCH_LIMIT, flag: FEATURE_FLAG },
    "AccountDeletionScheduler: starting (gated behind feature flag, fails closed)",
  );
  _interval = setInterval(() => {
    processDueDeletions().catch((err: unknown) =>
      logger.warn({ err }, "AccountDeletionScheduler: tick threw"),
    );
  }, POLL_INTERVAL_MS);
  // Delay the first pass so startup work finishes first.
  setTimeout(() => {
    processDueDeletions().catch((err: unknown) =>
      logger.warn({ err }, "AccountDeletionScheduler: initial tick threw"),
    );
  }, 30_000);
}

export function stopAccountDeletionScheduler(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}
