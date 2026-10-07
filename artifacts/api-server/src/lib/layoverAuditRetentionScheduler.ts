/**
 * layoverAuditRetentionScheduler — the "then delete it" half of OD-MAP-4 for
 * the layover decision ledger (census-layover L163; lead ruling 2026-10-07).
 *
 * OD-MAP-4 (docs/ops/owner-decisions-20261004.md): "Keep a pseudonymized,
 * access-restricted audit record for up to 12 months, then delete it, unless a
 * specific local legal obligation requires a different period."
 *
 * Account deletion (services/accountDeletion/AccountDeletionService.ts,
 * `pseudonymise_layover_events`) turns a departed traveller's layover_events
 * into pseudonymised rows with a `retain_until` 365 days out; migration 3621's
 * CHECK forbids a `retain_until` past 12 months. A retention promise nothing
 * keeps is not retention, so this sweep deletes every pseudonymised row whose
 * `retain_until` has passed. Named rows (pseudonymised_at IS NULL) are never
 * touched: the read filters on `pseudonymised_at IS NOT NULL`.
 *
 * Shaped as lib/layoverCrewExpiryScheduler.ts is, for the same reasons: the
 * clock is an argument (`opts.now`), the result is four-way rather than a
 * count, a read failure is never "nothing due", and the schema is the gate —
 * where 3621 is not applied the probe fails and nothing is attempted. No flag:
 * the rows it deletes are past the retention the owner set, and a flag would
 * only be a way to keep them longer.
 */
import { logger } from "./logger.js";
import { getServiceClient } from "./supabase.js";


/** Hourly. The ceiling is in months; an hour of lag cannot breach it materially. */
export const LAYOVER_AUDIT_RETENTION_INTERVAL_MS = 60 * 60_000;
export const LAYOVER_AUDIT_RETENTION_BATCH_SIZE = 500;
const STARTUP_DELAY_MS = 90_000;

export type LayoverAuditRetentionOutcome = "swept" | "idle" | "refused" | "failed";
export interface LayoverAuditRetentionResult {
  outcome: LayoverAuditRetentionOutcome;
  reason: "no_client" | "schema_absent" | "probe_failed" | "read_failed" | "delete_failed" | null;
  deleted: number;
  complete: boolean;
}

/**
 * 3621 applied here? Only the database saying the COLUMN is missing (42703 from
 * Postgres, PGRST204 from PostgREST's schema cache) is "absent". Any other
 * error, or a throw, is "error": a probe that could not reach the table has not
 * learned that the schema is old, and reading it as absent would report a
 * broken connection as a sweep with nothing to do.
 */
async function auditColumnsProbe(db: any): Promise<"present" | "absent" | "error"> {
  try {
    const { error } = await db.from("layover_events").select("retain_until", { head: true }).limit(1);
    if (!error) return "present";
    const code = String((error as { code?: unknown }).code ?? "");
    return code === "42703" || code === "PGRST204" ? "absent" : "error";
  } catch {
    return "error";
  }
}

/** One sweep, deterministic in its instant: `opts.now` IS the cutoff. */
export async function runLayoverAuditRetentionSweep(
  opts: { client?: any; now: Date; batchSize?: number },
): Promise<LayoverAuditRetentionResult> {
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return { outcome: "refused", reason: "no_client", deleted: 0, complete: false };
  const probe = await auditColumnsProbe(db);
  if (probe === "absent") return { outcome: "refused", reason: "schema_absent", deleted: 0, complete: false };
  if (probe === "error") return { outcome: "failed", reason: "probe_failed", deleted: 0, complete: false };

  const limit = opts.batchSize ?? LAYOVER_AUDIT_RETENTION_BATCH_SIZE;
  const read = await db
    .from("layover_events")
    .select("id")
    .not("pseudonymised_at", "is", null)
    .lt("retain_until", opts.now.toISOString())
    .order("retain_until", { ascending: true })
    .limit(limit);
  if (read?.error) {
    logger.warn({ err: read.error }, "layover audit retention sweep could not read due rows — 0 deleted is not a measurement here");
    return { outcome: "failed", reason: "read_failed", deleted: 0, complete: false };
  }
  const ids = ((read?.data ?? []) as Array<{ id: unknown }>)
    .map((r) => r.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return { outcome: "idle", reason: null, deleted: 0, complete: true };

  // Deleted by id AND still pseudonymised: a row cannot be re-identified, but
  // the second filter keeps this statement from ever reaching a named row.
  const del = await db.from("layover_events").delete().in("id", ids).not("pseudonymised_at", "is", null);
  if (del?.error) {
    logger.warn({ err: del.error, due: ids.length }, "layover audit retention sweep could not delete due rows — they outlive OD-MAP-4's 12 months");
    return { outcome: "failed", reason: "delete_failed", deleted: 0, complete: false };
  }
  const confirmed = Array.isArray(del?.data) ? del.data.length : ids.length;
  logger.info({ deleted: confirmed, complete: ids.length < limit }, "layover audit retention sweep deleted expired pseudonymised events");
  return { outcome: "swept", reason: null, deleted: confirmed, complete: ids.length < limit };
}

/**
 * What GET /healthz/schedulers reads (job "layoverAuditRetention"). A retention
 * job that silently stopped would keep pseudonymised rows past OD-MAP-4's 12
 * months with nothing to say so, so this sweep is one of the REPORTED jobs, not
 * one of the invisible ones (lib/schedulerCoverage.ts).
 *   lastAttemptAt        a tick began — never evidence that it worked;
 *   lastSuccessAt        a tick swept or found nothing due;
 *   consecutiveFailures  no client, a failed read or delete, or a throw;
 *   lastOutcome/Reason   the four-way result. `refused`/`schema_absent` (3621
 *                        not applied) is neither a success nor a failure:
 *                        without 3621 deletion erases the events outright, so
 *                        there is nothing for this sweep to keep honest.
 */
export interface LayoverAuditRetentionStatus {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastOutcome: LayoverAuditRetentionOutcome | null;
  lastReason: LayoverAuditRetentionResult["reason"];
  lastDeleted: number;
}

const _status: LayoverAuditRetentionStatus = {
  lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0, lastOutcome: null, lastReason: null, lastDeleted: 0,
};

/** Snapshot for /healthz/schedulers. */
export function getLayoverAuditRetentionStatus(): Readonly<LayoverAuditRetentionStatus> {
  return { ..._status };
}

/** Test seam: reset module state between cases. */
export function _resetLayoverAuditRetentionStatus(): void {
  Object.assign(_status, { lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0, lastOutcome: null, lastReason: null, lastDeleted: 0 });
}

/** One tick: reads the clock once, never rejects, keeps a failure count. */
export async function runLayoverAuditRetentionTick(
  opts: { client?: any; now?: Date; batchSize?: number } = {},
): Promise<LayoverAuditRetentionResult> {
  const now = opts.now ?? new Date();
  _status.lastAttemptAt = now.toISOString();
  let result: LayoverAuditRetentionResult;
  try {
    result = await runLayoverAuditRetentionSweep({ ...opts, now });
  } catch (err) {
    _status.consecutiveFailures += 1;
    _status.lastOutcome = "failed";
    _status.lastReason = null;
    _status.lastDeleted = 0;
    logger.warn({ err, consecutiveFailures: _status.consecutiveFailures }, "layover audit retention tick threw");
    return { outcome: "failed", reason: null, deleted: 0, complete: false };
  }
  _status.lastOutcome = result.outcome;
  _status.lastReason = result.reason;
  _status.lastDeleted = result.deleted;
  if (result.outcome === "failed" || result.reason === "no_client") {
    _status.consecutiveFailures += 1;
    const log = _status.consecutiveFailures >= 3 ? logger.error.bind(logger) : logger.warn.bind(logger);
    log({ consecutiveFailures: _status.consecutiveFailures, reason: result.reason }, "layover audit retention sweep failed");
  } else if (result.outcome === "swept" || result.outcome === "idle") {
    _status.consecutiveFailures = 0;
    _status.lastSuccessAt = now.toISOString();
  }
  return result;
}

let _timer: ReturnType<typeof setTimeout> | null = null;

export function startLayoverAuditRetentionScheduler(): void {
  if (_timer !== null) return;
  logger.info(
    { intervalMs: LAYOVER_AUDIT_RETENTION_INTERVAL_MS, gate: "layover_events.retain_until must exist (migration 3621)" },
    "LayoverAuditRetentionScheduler scheduled (no-op wherever migration 3621 is not applied)",
  );
  _timer = setTimeout(function tick() {
    void runLayoverAuditRetentionTick().finally(() => {
      if (_timer !== null) { _timer = setTimeout(tick, LAYOVER_AUDIT_RETENTION_INTERVAL_MS); _timer.unref?.(); }
    });
  }, STARTUP_DELAY_MS);
  _timer.unref?.();
}

export function stopLayoverAuditRetentionScheduler(): void {
  if (_timer !== null) {
    clearTimeout(_timer);
    _timer = null;
  }
}
