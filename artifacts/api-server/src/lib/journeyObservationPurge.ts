import os from "node:os";
import { logger } from "./logger.js";
import { getServiceClient, isServiceClientReady } from "./supabase.js";

export const JOURNEY_PURGE_INTERVAL_MS = 5 * 60 * 1_000;
export const JOURNEY_PURGE_STARTUP_DELAY_MS = 20 * 1_000;
export const JOURNEY_PURGE_STALE_AFTER_MS = JOURNEY_PURGE_INTERVAL_MS * 2;
export const JOURNEY_PURGE_ALERT_AGE_MS = 15 * 60 * 1_000;
export const JOURNEY_RETENTION_JOB_KEY = "journey_observation_retention";
/** @deprecated Kept for callers that still use the Phase-1 name. */
export const JOURNEY_PURGE_JOB_KEY = JOURNEY_RETENTION_JOB_KEY;
export const JOURNEY_REVOCATION_MAX_VISIBLE_MS = JOURNEY_PURGE_INTERVAL_MS;
export const JOURNEY_REVOCATION_LEASE_SECONDS = 120;
export const JOURNEY_REVOCATION_BATCH_SIZE = 50;
export const JOURNEY_RETENTION_CYCLE_LEASE_SECONDS = 300;

export type JourneyRetentionHealthState =
  | "HEALTHY"
  | "DEGRADED"
  | "FAILED"
  | "STALE";

export interface JourneyPurgeStatus {
  healthState: JourneyRetentionHealthState;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastDeletedCount: number | null;
  lastFailedCount: number;
  oldestExpiredAgeMs: number | null;
  deletionLagMs: number | null;
  pendingRetryCount: number;
  consecutiveFailures: number;
  totalFailures: number;
}

const status: JourneyPurgeStatus = {
  healthState: "STALE",
  lastRunAt: null,
  lastSuccessAt: null,
  lastDeletedCount: null,
  lastFailedCount: 0,
  oldestExpiredAgeMs: null,
  deletionLagMs: null,
  pendingRetryCount: 0,
  consecutiveFailures: 0,
  totalFailures: 0,
};

export function getJourneyObservationPurgeStatus(): Readonly<JourneyPurgeStatus> {
  return { ...status };
}

interface DurableHealthRow {
  last_status?: unknown;
  last_run_at?: unknown;
  last_success_at?: unknown;
  last_failed_at?: unknown;
  last_deleted_count?: unknown;
  last_failed_count?: unknown;
  oldest_expired_age_ms?: unknown;
  deletion_lag_ms?: unknown;
  pending_retry_count?: unknown;
  consecutive_failures?: unknown;
  last_error?: unknown;
}

export interface JourneyRetentionHealth {
  state: JourneyRetentionHealthState;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastFailedAt: string | null;
  lastDeletedCount: number;
  lastFailedCount: number;
  oldestExpiredAgeMs: number | null;
  deletionLagMs: number | null;
  pendingRetryCount: number;
  consecutiveFailures: number;
  lastError: string | null;
}

function finiteNonNegative(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function nullableFiniteNonNegative(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function toIsoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return Number.isFinite(new Date(value).getTime()) ? value : null;
}

function persistedState(value: unknown): JourneyRetentionHealthState {
  return value === "HEALTHY"
    || value === "DEGRADED"
    || value === "FAILED"
    || value === "STALE"
    ? value
    : "FAILED";
}

function effectiveHealth(
  row: DurableHealthRow | null,
  now: Date,
): JourneyRetentionHealth {
  if (!row) {
    return {
      state: "STALE",
      lastRunAt: null,
      lastSuccessAt: null,
      lastFailedAt: null,
      lastDeletedCount: 0,
      lastFailedCount: 0,
      oldestExpiredAgeMs: null,
      deletionLagMs: null,
      pendingRetryCount: 0,
      consecutiveFailures: 0,
      lastError: null,
    };
  }

  const lastRunAt = toIsoOrNull(row.last_run_at);
  const lastSuccessAt = toIsoOrNull(row.last_success_at);
  const elapsedSinceSuccess = lastSuccessAt
    ? now.getTime() - new Date(lastSuccessAt).getTime()
    : Number.POSITIVE_INFINITY;
  const durableState = persistedState(row.last_status);
  const state = !Number.isFinite(elapsedSinceSuccess)
    || elapsedSinceSuccess > JOURNEY_PURGE_STALE_AFTER_MS
    ? "STALE"
    : durableState;

  return {
    state,
    lastRunAt,
    lastSuccessAt,
    lastFailedAt: toIsoOrNull(row.last_failed_at),
    lastDeletedCount: finiteNonNegative(row.last_deleted_count),
    lastFailedCount: finiteNonNegative(row.last_failed_count),
    oldestExpiredAgeMs: nullableFiniteNonNegative(row.oldest_expired_age_ms),
    deletionLagMs: nullableFiniteNonNegative(row.deletion_lag_ms),
    pendingRetryCount: finiteNonNegative(row.pending_retry_count),
    consecutiveFailures: finiteNonNegative(row.consecutive_failures),
    lastError: typeof row.last_error === "string" ? row.last_error : null,
  };
}

/**
 * Durable health survives process restarts. Missing, unreadable, or older than
 * two purge intervals is never considered healthy enough for new writes.
 */
export async function queryJourneyRetentionHealth(opts?: {
  client?: any | null;
  now?: Date;
}): Promise<JourneyRetentionHealth> {
  const client =
    opts !== undefined && "client" in opts
      ? opts.client
      : isServiceClientReady
        ? getServiceClient()
        : null;
  const now = opts?.now ?? new Date();
  if (!client) return effectiveHealth(null, now);

  try {
    const { data, error } = await client
      .from("journey_retention_health")
      .select(
        "last_status, last_run_at, last_success_at, last_failed_at, last_deleted_count, last_failed_count, oldest_expired_age_ms, deletion_lag_ms, pending_retry_count, consecutive_failures, last_error",
      )
      .eq("job", JOURNEY_RETENTION_JOB_KEY)
      .maybeSingle();
    if (error) {
      return {
        ...effectiveHealth(null, now),
        state: "FAILED",
        lastError: String(error.message ?? error),
      };
    }
    return effectiveHealth((data as DurableHealthRow | null) ?? null, now);
  } catch (error) {
    return {
      ...effectiveHealth(null, now),
      state: "FAILED",
      lastError: error instanceof Error ? error.message : String(error),
    };
  }
}

export type JourneyPurgeHealthLevel = "ok" | "overdue" | "critical";

/** Compatibility projection for the Phase-1 health call site. */
export async function queryJourneyObservationPurgeHealth(opts?: {
  client?: any | null;
  now?: Date;
}): Promise<{ level: JourneyPurgeHealthLevel; lastSuccessAt: string | null }> {
  const health = await queryJourneyRetentionHealth(opts);
  return {
    level:
      health.state === "HEALTHY"
        ? "ok"
        : health.state === "DEGRADED"
          ? "overdue"
          : "critical",
    lastSuccessAt: health.lastSuccessAt,
  };
}

interface ClaimedRevocationJob {
  id: string;
  user_id: string;
  location_session_id: string | null;
  attempt_count: number;
  leased_by: string;
  lease_token: string;
}

export interface JourneyRetentionCycleResult {
  state: JourneyRetentionHealthState;
  expiredDeleted: number | null;
  expiredObservationDeleted: number | null;
  expiredSegmentDeleted: number | null;
  expiredGroundTruthDeleted: number | null;
  revokedDeleted: number;
  failedCount: number;
  pendingRetryCount: number;
  oldestExpiredAgeMs: number | null;
  deletionLagMs: number | null;
  error: unknown;
}

function errorMessage(error: unknown): string {
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message)
      : String(error);
  return message.slice(0, 500);
}

function retryDelayMs(attemptCount: number): number {
  return Math.min(
    JOURNEY_REVOCATION_MAX_VISIBLE_MS,
    30_000 * (2 ** Math.max(0, Math.min(attemptCount - 1, 4))),
  );
}

async function markRevocationCompleted(
  client: any,
  job: ClaimedRevocationJob,
  now: Date,
  deletedCount: number,
): Promise<void> {
  const { data, error } = await client.rpc(
    "complete_journey_revocation_job_v1",
    {
      p_job_id: job.id,
      p_lease_token: job.lease_token,
      p_now: now.toISOString(),
      p_deleted_count: deletedCount,
    },
  );
  if (error) throw error;
  if (data !== true) throw new Error("Journey revocation job lease was lost before completion");
}

async function markRevocationFailed(
  client: any,
  job: ClaimedRevocationJob,
  now: Date,
  error: unknown,
): Promise<void> {
  const { data, error: updateError } = await client.rpc(
    "fail_journey_revocation_job_v1",
    {
      p_job_id: job.id,
      p_lease_token: job.lease_token,
      p_now: now.toISOString(),
      p_available_at: new Date(
        now.getTime() + retryDelayMs(job.attempt_count),
      ).toISOString(),
      p_failed_count: job.attempt_count,
      p_error: errorMessage(error),
    },
  );
  if (updateError) throw updateError;
  if (data !== true) throw new Error("Journey revocation job lease was lost before failure recording");
}

async function deleteRevokedRows(
  client: any,
  job: ClaimedRevocationJob,
): Promise<number> {
  // service_role no longer has direct SELECT/DELETE on journey_observations, so
  // deletion of raw observations + derived segments goes through the SECURITY
  // DEFINER RPC, which erases both tables atomically under a per-user lock.
  const { data, error } = await client.rpc("delete_journey_shadow_rows_v1", {
    p_user_id: job.user_id,
    p_location_session_id: job.location_session_id ?? null,
  });
  if (error) throw error;
  return finiteNonNegative(data, 0);
}

/** Maps a retention table to the purge RPC's p_kind enum value. */
type JourneyRetentionTable =
  | "journey_observations"
  | "journey_segment_revisions"
  | "journey_shadow_ground_truth";

const PURGE_KIND_BY_TABLE: Record<JourneyRetentionTable, "observation" | "segment" | "ground_truth"> = {
  journey_observations: "observation",
  journey_segment_revisions: "segment",
  journey_shadow_ground_truth: "ground_truth",
};

interface JourneyTablePurgeResult {
  deletedCount: number;
  oldestBeforeAgeMs: number | null;
  oldestAfterAgeMs: number | null;
}

/**
 * Purges expired rows for a single retention table via the SECURITY DEFINER
 * RPC. service_role can no longer directly SELECT/DELETE journey_observations,
 * so the RPC is the only maintenance surface. Returns aggregate counts/ages —
 * never rows or IDs.
 */
async function purgeExpiredTable(
  client: any,
  table: JourneyRetentionTable,
  now: Date,
): Promise<JourneyTablePurgeResult> {
  const { data, error } = await client.rpc("purge_expired_journey_shadow_table_v1", {
    p_kind: PURGE_KIND_BY_TABLE[table],
    p_now: now.toISOString(),
  });
  if (error) throw error;
  const row = (data ?? {}) as {
    deletedCount?: unknown;
    oldestBeforeAgeMs?: unknown;
    oldestAfterAgeMs?: unknown;
  };
  return {
    deletedCount: finiteNonNegative(row.deletedCount, 0),
    oldestBeforeAgeMs: nullableFiniteNonNegative(row.oldestBeforeAgeMs),
    oldestAfterAgeMs: nullableFiniteNonNegative(row.oldestAfterAgeMs),
  };
}

async function queryPendingRevocations(
  client: any,
  now: Date,
): Promise<{ count: number; lagMs: number | null }> {
  const { data, count, error } = await client
    .from("journey_revocation_jobs")
    .select("requested_at", { count: "exact" })
    .neq("status", "completed")
    .order("requested_at", { ascending: true })
    .limit(1);
  if (error) throw error;
  const oldest = Array.isArray(data) ? data[0] : null;
  const requestedAt = oldest?.requested_at
    ? new Date(String(oldest.requested_at)).getTime()
    : Number.NaN;
  return {
    count: count ?? (oldest ? 1 : 0),
    lagMs: Number.isFinite(requestedAt)
      ? Math.max(0, now.getTime() - requestedAt)
      : null,
  };
}

async function beginRetentionCycle(
  client: any,
  now: Date,
  workerId: string,
): Promise<string | null> {
  const { data, error } = await client.rpc(
    "begin_journey_retention_cycle_v1",
    {
      p_worker_id: workerId,
      p_now: now.toISOString(),
      p_lease_seconds: JOURNEY_RETENTION_CYCLE_LEASE_SECONDS,
    },
  );
  if (error) throw error;
  return typeof data === "string" && data.length > 0 ? data : null;
}

async function finishRetentionCycle(
  client: any,
  cycleToken: string,
  now: Date,
  result: JourneyRetentionCycleResult,
  message: string | null,
): Promise<void> {
  const { data, error } = await client.rpc(
    "finish_journey_retention_cycle_v2",
    {
      p_cycle_token: cycleToken,
      p_now: now.toISOString(),
      p_status: result.state,
      p_deleted_count:
        (result.expiredDeleted ?? 0) + result.revokedDeleted,
      p_observation_deleted_count: result.expiredObservationDeleted ?? 0,
      p_segment_deleted_count: result.expiredSegmentDeleted ?? 0,
      p_ground_truth_deleted_count: result.expiredGroundTruthDeleted ?? 0,
      p_failed_count: result.failedCount,
      p_oldest_expired_age_ms: result.oldestExpiredAgeMs,
      p_deletion_lag_ms: result.deletionLagMs,
      p_pending_retry_count: result.pendingRetryCount,
      p_error: message,
    },
  );
  if (error) throw error;
  if (data !== true) throw new Error("Journey retention cycle lease was lost before finalization");
}

export let _journeyPurgeCallCount = 0;

/**
 * One always-on cycle handles Journey session expiry, restart-safe revocation
 * work, raw TTL deletion, and durable monitoring. It never reads Journey feature
 * flags: disabling collection must never disable deletion.
 */
export async function runJourneyRetentionCycle(opts?: {
  client?: any | null;
  now?: Date;
  workerId?: string;
}): Promise<JourneyRetentionCycleResult> {
  _journeyPurgeCallCount += 1;
  const now = opts?.now ?? new Date();
  const client =
    opts !== undefined && "client" in opts
      ? opts.client
      : isServiceClientReady
        ? getServiceClient()
        : null;
  status.lastRunAt = now.toISOString();

  if (!client) {
    const error = new Error("Journey retention service client is unavailable");
    status.healthState = "FAILED";
    status.lastDeletedCount = null;
    status.lastFailedCount = 1;
    status.oldestExpiredAgeMs = null;
    status.deletionLagMs = null;
    status.consecutiveFailures += 1;
    status.totalFailures += 1;
    logger.error(
      { consecutiveFailures: status.consecutiveFailures },
      "journey retention cycle failed: service client unavailable",
    );
    return {
      state: "FAILED",
      expiredDeleted: null,
      expiredObservationDeleted: null,
      expiredSegmentDeleted: null,
      expiredGroundTruthDeleted: null,
      revokedDeleted: 0,
      failedCount: 1,
      pendingRetryCount: status.pendingRetryCount,
      oldestExpiredAgeMs: null,
      deletionLagMs: null,
      error,
    };
  }

  const errors: unknown[] = [];
  let expiredDeleted: number | null = null;
  let expiredObservationDeleted: number | null = null;
  let expiredSegmentDeleted: number | null = null;
  let expiredGroundTruthDeleted: number | null = null;
  let revokedDeleted = 0;
  let failedCount = 0;
  let oldestBeforeMs: number | null = null;
  let oldestRemainingMs: number | null = null;
  let pendingRetryCount = 0;
  let deletionLagMs: number | null = null;
  const previous = await queryJourneyRetentionHealth({ client, now });
  const workerId =
    opts?.workerId ?? `${os.hostname()}:${process.pid}:journey-retention`;
  let cycleToken: string | null = null;

  // Atomically serialize the global cycle and publish a non-healthy state before
  // cleanup. If another instance owns the lease, this instance does no work and
  // cannot overwrite the owner's eventual result.
  try {
    cycleToken = await beginRetentionCycle(client, now, workerId);
  } catch (error) {
    status.healthState = "FAILED";
    status.lastDeletedCount = null;
    status.lastFailedCount = 1;
    status.oldestExpiredAgeMs = previous.oldestExpiredAgeMs;
    status.deletionLagMs = previous.deletionLagMs;
    status.pendingRetryCount = previous.pendingRetryCount;
    status.consecutiveFailures += 1;
    status.totalFailures += 1;
    logger.error(
      { error: errorMessage(error) },
      "journey retention cycle could not publish its start marker",
    );
    return {
      state: "FAILED",
      expiredDeleted: null,
      expiredObservationDeleted: null,
      expiredSegmentDeleted: null,
      expiredGroundTruthDeleted: null,
      revokedDeleted: 0,
      failedCount: 1,
      pendingRetryCount: previous.pendingRetryCount,
      oldestExpiredAgeMs: previous.oldestExpiredAgeMs,
      deletionLagMs: previous.deletionLagMs,
      error,
    };
  }
  if (!cycleToken) {
    const active = await queryJourneyRetentionHealth({ client, now });
    logger.info(
      { workerId, state: active.state },
      "journey retention cycle skipped: another worker owns the cycle lease",
    );
    return {
      state: active.state === "HEALTHY" ? "DEGRADED" : active.state,
      expiredDeleted: 0,
      expiredObservationDeleted: 0,
      expiredSegmentDeleted: 0,
      expiredGroundTruthDeleted: 0,
      revokedDeleted: 0,
      failedCount: 0,
      pendingRetryCount: active.pendingRetryCount,
      oldestExpiredAgeMs: active.oldestExpiredAgeMs,
      deletionLagMs: active.deletionLagMs,
      error: null,
    };
  }

  try {
    // Expiring a Journey-purpose session fires the durable session-revocation
    // trigger. Generic/legacy sessions are deliberately untouched.
    const { error } = await client
      .from("location_sessions")
      .update({ ended_at: now.toISOString() })
      .eq("journey_purpose", "journey_observation_v1")
      .is("ended_at", null)
      .lte("expires_at", now.toISOString());
    if (error) throw error;
  } catch (error) {
    errors.push(error);
  }

  let claimed: ClaimedRevocationJob[] = [];
  try {
    const { data, error } = await client.rpc(
      "claim_journey_revocation_jobs_v1",
      {
        p_worker_id: workerId,
        p_limit: JOURNEY_REVOCATION_BATCH_SIZE,
        p_now: now.toISOString(),
        p_lease_seconds: JOURNEY_REVOCATION_LEASE_SECONDS,
      },
    );
    if (error) throw error;
    claimed = (data ?? []) as ClaimedRevocationJob[];
  } catch (error) {
    errors.push(error);
  }

  for (const job of claimed) {
    try {
      const deleted = await deleteRevokedRows(client, job);
      const transitionNow = opts?.now ?? new Date();
      await markRevocationCompleted(client, job, transitionNow, deleted);
      revokedDeleted += deleted;
    } catch (error) {
      failedCount += 1;
      errors.push(error);
      try {
        const transitionNow = opts?.now ?? new Date();
        await markRevocationFailed(client, job, transitionNow, error);
      } catch (markError) {
        errors.push(markError);
      }
    }
  }

  const expiryTables = [
    ["journey_observations", "observation"],
    ["journey_segment_revisions", "segment"],
    ["journey_shadow_ground_truth", "ground_truth"],
  ] as const;
  const oldestRemainingByTable: Array<number | null> = [];
  for (const [table, kind] of expiryTables) {
    try {
      // Single SECURITY DEFINER RPC computes oldest-before, deletes expired
      // rows, and reports oldest-after — all inside one transaction. This
      // replaces the direct SELECT + DELETE that service_role can no longer do.
      const purged = await purgeExpiredTable(client, table, now);
      oldestBeforeMs = oldestBeforeMs == null
        ? purged.oldestBeforeAgeMs
        : purged.oldestBeforeAgeMs == null
          ? oldestBeforeMs
          : Math.max(oldestBeforeMs, purged.oldestBeforeAgeMs);
      if (kind === "observation") expiredObservationDeleted = purged.deletedCount;
      if (kind === "segment") expiredSegmentDeleted = purged.deletedCount;
      if (kind === "ground_truth") expiredGroundTruthDeleted = purged.deletedCount;
      oldestRemainingByTable.push(purged.oldestAfterAgeMs);
    } catch (error) {
      errors.push(error);
      oldestRemainingByTable.push(null);
    }
  }
  if (
    expiredObservationDeleted !== null
    && expiredSegmentDeleted !== null
    && expiredGroundTruthDeleted !== null
  ) {
    expiredDeleted =
      expiredObservationDeleted + expiredSegmentDeleted + expiredGroundTruthDeleted;
  }
  const remainingAges = oldestRemainingByTable.filter(
    (age): age is number => age !== null,
  );
  oldestRemainingMs = remainingAges.length > 0 ? Math.max(...remainingAges) : null;

  try {
    const pending = await queryPendingRevocations(client, now);
    pendingRetryCount = pending.count;
    deletionLagMs = pending.lagMs;
  } catch (error) {
    errors.push(error);
  }

  const cycleState: JourneyRetentionHealthState =
    errors.length > 0
      ? "FAILED"
      : pendingRetryCount > 0 || oldestRemainingMs !== null
        ? "DEGRADED"
        : "HEALTHY";
  const primaryError = errors[0] ?? null;
  const result: JourneyRetentionCycleResult = {
    state: cycleState,
    expiredDeleted,
    expiredObservationDeleted,
    expiredSegmentDeleted,
    expiredGroundTruthDeleted,
    revokedDeleted,
    failedCount: failedCount + (errors.length > failedCount ? 1 : 0),
    pendingRetryCount,
    oldestExpiredAgeMs: oldestRemainingMs,
    deletionLagMs,
    error: primaryError,
  };

  try {
    const finishedAt = opts?.now ?? new Date();
    await finishRetentionCycle(
      client,
      cycleToken,
      finishedAt,
      result,
      primaryError ? errorMessage(primaryError) : null,
    );
  } catch (healthError) {
    errors.push(healthError);
    result.state = "FAILED";
    result.error = result.error ?? healthError;
    result.failedCount = Math.max(1, result.failedCount);
  }

  status.healthState = result.state;
  status.lastDeletedCount =
    result.expiredDeleted === null
      ? null
      : result.expiredDeleted + result.revokedDeleted;
  status.lastFailedCount = result.failedCount;
  status.oldestExpiredAgeMs = result.oldestExpiredAgeMs;
  status.deletionLagMs = result.deletionLagMs;
  status.pendingRetryCount = result.pendingRetryCount;
  if (result.state === "FAILED") {
    status.consecutiveFailures += 1;
    status.totalFailures += 1;
    logger.error(
      {
        failedCount: result.failedCount,
        pendingRetryCount: result.pendingRetryCount,
      },
      "journey retention cycle failed",
    );
  } else {
    status.lastSuccessAt = now.toISOString();
    status.consecutiveFailures = 0;
    logger.info(
      {
        state: result.state,
        expiredDeleted: result.expiredDeleted,
        revokedDeleted: result.revokedDeleted,
        pendingRetryCount: result.pendingRetryCount,
        oldestExpiredBeforeMs: oldestBeforeMs,
        oldestExpiredAgeMs: result.oldestExpiredAgeMs,
        deletionLagMs: result.deletionLagMs,
      },
      "journey retention cycle completed",
    );
  }

  return result;
}

/**
 * Compatibility wrapper preserving the Phase-1 result shape. The underlying
 * cycle now performs both TTL and revocation cleanup.
 */
export async function purgeExpiredJourneyObservations(opts?: {
  client?: any | null;
  now?: Date;
}): Promise<{
  deleted: number | null;
  oldestExpiredAgeMs: number | null;
  error: unknown;
}> {
  // service_role can no longer directly SELECT journey_observations, so the
  // pre-cycle "oldest before" probe is gone; the retention cycle (via the purge
  // RPC) reports the post-deletion remaining age instead.
  const result = await runJourneyRetentionCycle(opts);
  return {
    deleted: result.expiredObservationDeleted,
    oldestExpiredAgeMs: result.oldestExpiredAgeMs,
    error: result.error,
  };
}

export function startJourneyObservationPurge(): ReturnType<typeof setInterval> {
  const initialTimer = setTimeout(() => {
    void runJourneyRetentionCycle();
  }, JOURNEY_PURGE_STARTUP_DELAY_MS);
  const interval = setInterval(() => {
    void runJourneyRetentionCycle();
  }, JOURNEY_PURGE_INTERVAL_MS);

  initialTimer.unref?.();
  interval.unref();
  logger.info(
    {
      intervalMs: JOURNEY_PURGE_INTERVAL_MS,
      staleAfterMs: JOURNEY_PURGE_STALE_AFTER_MS,
      revocationVisibleWithinMs: JOURNEY_REVOCATION_MAX_VISIBLE_MS,
    },
    "journey retention scheduler started",
  );
  return interval;
}