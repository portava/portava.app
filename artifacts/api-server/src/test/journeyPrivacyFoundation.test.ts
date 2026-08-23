/**
 * journeyPrivacyFoundation.test.ts
 *
 * Focused automated tests for Task #3705 — Journey Privacy Foundation (2124)
 * and Task #3723 — Journey Shadow Controlled Rollout (2127).
 *
 * Covers:
 *   (1) readJourneyIngestionControls — requires all four known flag rows
 *       (master, ingest, shadow, global-stop), denies on error, denies on
 *       any missing row.
 *   (2) ingestJourneyObservationBatch — delegates to ingest_journey_observation_v2
 *       RPC (not v1) with mandatory quality args; maps accepted / not_authorized /
 *       temporarily_unavailable correctly.
 *   (3) queryJourneyRetentionHealth — reports HEALTHY / DEGRADED / FAILED /
 *       STALE; two missed 5-minute intervals become STALE.
 *   (4) runJourneyRetentionCycle — empty success vs failure; physically deletes
 *       expired rows from journey_observations, journey_segment_revisions and
 *       journey_shadow_ground_truth; processes a claimed revocation job to
 *       completion; records durable retry/failure when deletion fails; persists
 *       monitoring fields via finish_journey_retention_cycle_v2 with
 *       observation/segment/ground-truth counts.
 *   (5) 2124 migration source — versioned consent, legacy default + explicit
 *       Journey session purpose, finite expiry, durable queue/claim lease,
 *       trigger-based revocation/session termination, service-only RLS/grants,
 *       HEALTHY/DEGRADED/FAILED/STALE, 24h TTL, 10m stale authorization,
 *       default-off flags preserved, no product consumers.
 *   (6) Rollback source is fail-closed containment and does not drop durable
 *       evidence.
 *   (7) 2127 migration source — central authority called by v2 ingest+append,
 *       old execute revoked, admin role SQL check, time-limited stage/cohort/
 *       issuance, flags default off, unified health v2, atomic revocation
 *       erasure, FORCE RLS, no user access.
 *
 * No live DB required. All Supabase clients are in-memory fakes.
 *
 * Run: node --import tsx/esm --test src/test/journeyPrivacyFoundation.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  readJourneyIngestionControls,
  ingestJourneyObservationBatch,
  JOURNEY_MASTER_FLAG,
  JOURNEY_INGEST_FLAG,
  JOURNEY_SHADOW_FLAG,
  GLOBAL_LOCATION_STOP_FLAG,
  JOURNEY_RAW_TTL_MS,
} from "../services/journey/JourneyObservationService.js";

import {
  queryJourneyRetentionHealth,
  runJourneyRetentionCycle,
  JOURNEY_PURGE_INTERVAL_MS,
  JOURNEY_PURGE_STALE_AFTER_MS,
  JOURNEY_RETENTION_JOB_KEY,
  JOURNEY_RETENTION_CYCLE_LEASE_SECONDS,
  JOURNEY_REVOCATION_LEASE_SECONDS,
  JOURNEY_REVOCATION_BATCH_SIZE,
} from "../lib/journeyObservationPurge.js";

// ─── Migration source files ───────────────────────────────────────────────────

const migrationSql = readFileSync(
  fileURLToPath(
    new URL("../migrations/2124_journey_privacy_foundation.sql", import.meta.url),
  ),
  "utf8",
);

const migration2127Sql = readFileSync(
  fileURLToPath(
    new URL("../migrations/2127_journey_shadow_controlled_rollout.sql", import.meta.url),
  ),
  "utf8",
);

// The task description says the rollback reference is in
// docs/sql/rollback_2120_journey_privacy_foundation.sql.  The file may not
// exist on disk (it's referenced in a SQL comment and might live in the docs
// tree), so we load it defensively.
let rollbackSql = "";
try {
  rollbackSql = readFileSync(
    fileURLToPath(
      new URL(
        "../../../../docs/sql/rollback_2120_journey_privacy_foundation.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );
} catch {
  // Not present — the migration comment still contains the path; the migration
  // source tests that reference to the rollback is present but we cannot parse
  // the rollback body itself without the file.
}

// ─── Fake worker matching the current journeyObservationPurge worker ──────────
//
// The fake is a purpose-built in-memory store that mirrors only the tables and
// RPC functions that runJourneyRetentionCycle / queryJourneyRetentionHealth
// actually call.  It is NOT a generic Supabase mock.
//
// Tables simulated:
//   journey_retention_health        (upsert, select+eq+maybeSingle)
//   journey_revocation_jobs         (select+neq+order+limit)
//   journey_observations            (delete+lt, delete+eq, select+lt+order+limit+maybeSingle)
//   journey_segment_revisions       (delete+lt, delete+eq, select+lt+order+limit+maybeSingle)
//   journey_shadow_ground_truth     (delete+lt, select+lt+order+limit+maybeSingle)
//   location_sessions               (update+eq+is+lte)
//
// RPC simulated:
//   claim_journey_revocation_jobs_v1
//   complete_journey_revocation_job_v1
//   fail_journey_revocation_job_v1
//   begin_journey_retention_cycle_v1
//   finish_journey_retention_cycle_v2   (with observation/segment/ground-truth counts)

interface FakeObservation {
  id: string;
  user_id: string;
  location_session_id: string;
  expires_at: string; // ISO string
  requested_at?: string;
}

interface FakeRevocationJob {
  id: string;
  user_id: string;
  location_session_id: string | null;
  attempt_count: number;
  status: "pending" | "processing" | "completed" | "failed";
  available_at: string;
  requested_at: string;
  completed_at: string | null;
  deleted_count: number;
  failed_count: number;
  last_error: string | null;
  leased_by: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  updated_at: string;
}

interface FakeHealthRow {
  job: string;
  last_status: string;
  last_run_at: string | null;
  last_success_at: string | null;
  last_failed_at: string | null;
  last_deleted_count: number;
  last_failed_count: number;
  oldest_expired_age_ms: number | null;
  deletion_lag_ms: number | null;
  pending_retry_count: number;
  consecutive_failures: number;
  last_error: string | null;
  updated_at: string;
  // v2 finish fields
  last_observation_deleted_count?: number | null;
  last_segment_deleted_count?: number | null;
  last_ground_truth_deleted_count?: number | null;
}

interface FakeSession {
  id: string;
  user_id: string;
  journey_purpose: string;
  ended_at: string | null;
  expires_at: string | null;
}

interface FakeWorkerState {
  observations: FakeObservation[];
  segments?: FakeObservation[];
  groundTruth?: FakeObservation[];
  revocationJobs: FakeRevocationJob[];
  healthRow: FakeHealthRow | null;
  sessions: FakeSession[];
  // Failure injection
  deleteObservationsError?: Error;
  claimJobsError?: Error;
  updateJobError?: Error;
  updateSessionsError?: Error;
  upsertHealthError?: Error;
  failHealthUpsertAt?: number;
  queryPendingError?: Error;
  oldestExpiredError?: Error;
  loseLeaseOnComplete?: boolean;
  loseCycleLeaseOnFinish?: boolean;
}

function makeFakeClient(state: FakeWorkerState): any {
  let healthUpsertCount = 0;
  /**
   * Build a chainable query builder. Each method call returns `this` so
   * filter chains work. The final `await` resolves via a custom `then` that
   * calls the appropriate handler based on which operation was last set.
   *
   * The Supabase JS client uses the following patterns:
   *
   *   // DELETE with count
   *   const { count, error } = await client.from(t).delete({ count: "exact" }).lt(col, val);
   *   // UPDATE
   *   const { error } = await client.from(t).update(values).eq(col, val);
   *   // SELECT + maybeSingle
   *   const { data, error } = await client.from(t).select(cols).eq(col, val).maybeSingle();
   *   // SELECT + count (pending revocations)
   *   const { data, count, error } = await client.from(t).select(cols, { count: "exact" }).neq(...).order(...).limit(1);
   *   // UPSERT
   *   const { error } = await client.from(t).upsert(row, { onConflict: "job" });
   */
  function buildQueryBuilder(handlers: {
    onDelete?: (filters: Record<string, unknown>) => Promise<{ count: number | null; error: any }>;
    onSelect?: (filters: Record<string, unknown>, opts?: { count?: string }) => Promise<{ data: any; count: number | null; error: any }>;
    onUpdate?: (values: Record<string, unknown>, filters: Record<string, unknown>) => Promise<{ error: any }>;
    onUpsert?: (row: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<{ error: any }>;
  }) {
    const filters: Record<string, unknown> = {};
    let selectOpts: { count?: string } | undefined;
    let pendingOp: "delete" | "select" | "update" | "upsert" | null = null;
    let updateValues: Record<string, unknown> | null = null;
    let upsertValues: Record<string, unknown> | null = null;
    let upsertOpts: Record<string, unknown> | null = null;

    function execute(): Promise<any> {
      if (pendingOp === "delete" && handlers.onDelete) {
        return handlers.onDelete(filters);
      }
      if (pendingOp === "update" && handlers.onUpdate && updateValues) {
        return handlers.onUpdate(updateValues, filters);
      }
      if (pendingOp === "upsert" && handlers.onUpsert && upsertValues) {
        return handlers.onUpsert(upsertValues, upsertOpts ?? undefined);
      }
      if (handlers.onSelect) {
        return handlers.onSelect(filters, selectOpts);
      }
      return Promise.resolve({ data: null, count: null, error: null });
    }

    const b: any = {
      select(cols?: string, opts?: { count?: string }) {
        pendingOp = "select";
        selectOpts = opts;
        return b;
      },
      delete(_opts?: unknown) {
        pendingOp = "delete";
        return b;
      },
      update(values: Record<string, unknown>) {
        pendingOp = "update";
        updateValues = values;
        return b;
      },
      upsert(row: Record<string, unknown>, opts?: Record<string, unknown>) {
        pendingOp = "upsert";
        upsertValues = row;
        upsertOpts = opts ?? null;
        // Upsert is typically awaited directly — return thenable
        return {
          then(resolve: (v: any) => void, reject: (e: any) => void) {
            execute().then(resolve, reject);
          },
        };
      },
      eq(col: string, val: unknown) { filters[`eq:${col}`] = val; return b; },
      neq(col: string, val: unknown) { filters[`neq:${col}`] = val; return b; },
      is(col: string, val: unknown) { filters[`is:${col}`] = val; return b; },
      lt(col: string, val: unknown) { filters[`lt:${col}`] = val; return b; },
      lte(col: string, val: unknown) { filters[`lte:${col}`] = val; return b; },
      order() { return b; },
      limit() { return b; },
      async maybeSingle() {
        const result = await execute();
        const data = Array.isArray(result.data) ? (result.data[0] ?? null) : result.data;
        return { data, error: result.error };
      },
      then(resolve: (v: any) => void, reject: (e: any) => void) {
        execute().then(resolve, reject);
      },
    };
    return b;
  }

  return {
    from(table: string): any {
      if (table === "journey_observations") {
        return buildQueryBuilder({
          async onDelete(filters) {
            if (state.deleteObservationsError) {
              return { count: null, error: state.deleteObservationsError };
            }
            const ltExpiry = filters["lt:expires_at"] as string | undefined;
            const eqUser = filters["eq:user_id"] as string | undefined;
            const eqSession = filters["eq:location_session_id"] as string | undefined;

            let removed = 0;
            state.observations = state.observations.filter((obs) => {
              let matches = true;
              if (ltExpiry !== undefined) matches = matches && obs.expires_at < ltExpiry;
              if (eqUser !== undefined) matches = matches && obs.user_id === eqUser;
              if (eqSession !== undefined) matches = matches && obs.location_session_id === eqSession;
              if (matches) { removed++; return false; }
              return true;
            });
            return { count: removed, error: null };
          },
          async onSelect(filters) {
            if (state.oldestExpiredError) {
              return { data: null, count: null, error: state.oldestExpiredError };
            }
            const ltExpiry = filters["lt:expires_at"] as string | undefined;
            const matching = state.observations.filter((obs) => {
              if (ltExpiry !== undefined && !(obs.expires_at < ltExpiry)) return false;
              return true;
            });
            matching.sort((a, b) => a.expires_at.localeCompare(b.expires_at));
            return { data: matching, count: matching.length, error: null };
          },
        });
      }

      if (table === "journey_segment_revisions") {
        return buildQueryBuilder({
          async onDelete(filters) {
            const eqUser = filters["eq:user_id"] as string | undefined;
            const eqSession = filters["eq:location_session_id"] as string | undefined;
            const ltExpiry = filters["lt:expires_at"] as string | undefined;
            let removed = 0;
            state.segments = (state.segments ?? []).filter((segment) => {
              let matches = true;
              if (eqUser !== undefined) matches = matches && segment.user_id === eqUser;
              if (eqSession !== undefined) {
                matches = matches && segment.location_session_id === eqSession;
              }
              if (ltExpiry !== undefined) matches = matches && segment.expires_at < ltExpiry;
              if (matches) {
                removed += 1;
                return false;
              }
              return true;
            });
            return { count: removed, error: null };
          },
          async onSelect(filters) {
            if (state.oldestExpiredError) {
              return { data: null, count: null, error: state.oldestExpiredError };
            }
            const ltExpiry = filters["lt:expires_at"] as string | undefined;
            const matching = (state.segments ?? []).filter((seg) => {
              if (ltExpiry !== undefined && !(seg.expires_at < ltExpiry)) return false;
              return true;
            });
            matching.sort((a, b) => a.expires_at.localeCompare(b.expires_at));
            return { data: matching, count: matching.length, error: null };
          },
        });
      }

      if (table === "journey_shadow_ground_truth") {
        return buildQueryBuilder({
          async onDelete(filters) {
            const ltExpiry = filters["lt:expires_at"] as string | undefined;
            let removed = 0;
            state.groundTruth = (state.groundTruth ?? []).filter((row) => {
              let matches = true;
              if (ltExpiry !== undefined) matches = matches && row.expires_at < ltExpiry;
              if (matches) {
                removed += 1;
                return false;
              }
              return true;
            });
            return { count: removed, error: null };
          },
          async onSelect(filters) {
            if (state.oldestExpiredError) {
              return { data: null, count: null, error: state.oldestExpiredError };
            }
            const ltExpiry = filters["lt:expires_at"] as string | undefined;
            const matching = (state.groundTruth ?? []).filter((row) => {
              if (ltExpiry !== undefined && !(row.expires_at < ltExpiry)) return false;
              return true;
            });
            matching.sort((a, b) => a.expires_at.localeCompare(b.expires_at));
            return { data: matching, count: matching.length, error: null };
          },
        });
      }

      if (table === "journey_revocation_jobs") {
        return buildQueryBuilder({
          async onSelect(filters, opts) {
            if (state.queryPendingError) {
              return { data: null, count: null, error: state.queryPendingError };
            }
            const neqStatus = filters["neq:status"] as string | undefined;
            const matching = state.revocationJobs.filter((j) => {
              if (neqStatus !== undefined && j.status === neqStatus) return false;
              return true;
            });
            matching.sort((a, b) => a.requested_at.localeCompare(b.requested_at));
            const count = opts?.count === "exact" ? matching.length : null;
            return { data: matching, count, error: null };
          },
          async onUpdate(values, filters) {
            if (state.updateJobError) {
              return { error: state.updateJobError };
            }
            const eqId = filters["eq:id"] as string | undefined;
            for (const job of state.revocationJobs) {
              if (eqId !== undefined && job.id !== eqId) continue;
              Object.assign(job, values);
            }
            return { error: null };
          },
        });
      }

      if (table === "journey_retention_health") {
        return {
          select(_cols?: string) { return this; },
          eq(_col: string, _val: unknown) { return this; },
          async maybeSingle() {
            return { data: state.healthRow ?? null, error: null };
          },
          upsert(row: Record<string, unknown>, _opts?: unknown) {
            healthUpsertCount += 1;
            if (
              state.upsertHealthError ||
              state.failHealthUpsertAt === healthUpsertCount
            ) {
              return Promise.resolve({
                error: state.upsertHealthError ?? new Error("health upsert failed"),
              });
            }
            if (!state.healthRow) {
              state.healthRow = {
                job: "journey_observation_retention",
                last_status: "STALE",
                last_run_at: null,
                last_success_at: null,
                last_failed_at: null,
                last_deleted_count: 0,
                last_failed_count: 0,
                oldest_expired_age_ms: null,
                deletion_lag_ms: null,
                pending_retry_count: 0,
                consecutive_failures: 0,
                last_error: null,
                updated_at: new Date().toISOString(),
              };
            }
            Object.assign(state.healthRow, row);
            return Promise.resolve({ error: null });
          },
        };
      }

      if (table === "location_sessions") {
        return buildQueryBuilder({
          async onUpdate(values, filters) {
            if (state.updateSessionsError) {
              return { error: state.updateSessionsError };
            }
            const eqPurpose = filters["eq:journey_purpose"] as string | undefined;
            const isEndedAt = "is:ended_at" in filters ? filters["is:ended_at"] : undefined;
            const lteExpiry = filters["lte:expires_at"] as string | undefined;
            for (const s of state.sessions) {
              let matches = true;
              if (eqPurpose !== undefined && s.journey_purpose !== eqPurpose) matches = false;
              if (isEndedAt === null && s.ended_at !== null) matches = false;
              if (lteExpiry !== undefined && s.expires_at !== null && !(s.expires_at <= lteExpiry)) matches = false;
              if (matches) Object.assign(s, values);
            }
            return { error: null };
          },
        });
      }

      // Fallback table — return a no-op builder
      return buildQueryBuilder({
        async onSelect() { return { data: [], count: 0, error: null }; },
        async onDelete() { return { count: 0, error: null }; },
        async onUpdate() { return { error: null }; },
      });
    },

    rpc(name: string, args: Record<string, unknown>) {
      // Maintenance purge RPC (service_role can no longer directly SELECT/DELETE
      // journey_observations after 2127). One transaction per kind: computes
      // oldest-before age, deletes expired rows, reports oldest-after age.
      if (name === "purge_expired_journey_shadow_table_v1") {
        const kind = args.p_kind as string;
        const nowMs = new Date(args.p_now as string).getTime();
        const nowIso = args.p_now as string;
        const ageMs = (arr: FakeObservation[]): number | null => {
          const expired = arr.filter((r) => r.expires_at < nowIso);
          if (expired.length === 0) return null;
          const oldest = expired.reduce((a, b) => (a.expires_at <= b.expires_at ? a : b));
          return Math.max(0, nowMs - new Date(oldest.expires_at).getTime());
        };
        if (kind === "observation") {
          if (state.deleteObservationsError) {
            return Promise.resolve({ data: null, error: state.deleteObservationsError });
          }
          if (state.oldestExpiredError) {
            return Promise.resolve({ data: null, error: state.oldestExpiredError });
          }
          const before = ageMs(state.observations);
          const kept: FakeObservation[] = [];
          let deleted = 0;
          for (const r of state.observations) {
            if (r.expires_at < nowIso) { deleted += 1; } else { kept.push(r); }
          }
          state.observations = kept;
          return Promise.resolve({
            data: { deletedCount: deleted, oldestBeforeAgeMs: before, oldestAfterAgeMs: ageMs(state.observations) },
            error: null,
          });
        }
        if (kind === "segment") {
          const arr = state.segments ?? [];
          const before = ageMs(arr);
          const kept: FakeObservation[] = [];
          let deleted = 0;
          for (const r of arr) {
            if (r.expires_at < nowIso) { deleted += 1; } else { kept.push(r); }
          }
          state.segments = kept;
          return Promise.resolve({
            data: { deletedCount: deleted, oldestBeforeAgeMs: before, oldestAfterAgeMs: ageMs(state.segments ?? []) },
            error: null,
          });
        }
        if (kind === "ground_truth") {
          const arr = state.groundTruth ?? [];
          const before = ageMs(arr);
          const kept: FakeObservation[] = [];
          let deleted = 0;
          for (const r of arr) {
            if (r.expires_at < nowIso) { deleted += 1; } else { kept.push(r); }
          }
          state.groundTruth = kept;
          return Promise.resolve({
            data: { deletedCount: deleted, oldestBeforeAgeMs: before, oldestAfterAgeMs: ageMs(state.groundTruth ?? []) },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: { message: `unknown purge kind: ${kind}` } });
      }

      // Revocation erase RPC — deletes raw observations + derived segments for a
      // user (optionally scoped to one session) under a per-user lock. Replaces
      // the direct DELETEs service_role can no longer perform.
      if (name === "delete_journey_shadow_rows_v1") {
        if (state.deleteObservationsError) {
          return Promise.resolve({ data: null, error: state.deleteObservationsError });
        }
        const eqUser = args.p_user_id as string | undefined;
        const eqSession = (args.p_location_session_id as string | null | undefined) ?? undefined;
        const matches = (r: FakeObservation): boolean => {
          let m = true;
          if (eqUser !== undefined) m = m && r.user_id === eqUser;
          if (eqSession !== undefined) m = m && r.location_session_id === eqSession;
          return m;
        };
        let deleted = 0;
        state.observations = state.observations.filter((r) => {
          if (matches(r)) { deleted += 1; return false; }
          return true;
        });
        state.segments = (state.segments ?? []).filter((r) => {
          if (matches(r)) { deleted += 1; return false; }
          return true;
        });
        return Promise.resolve({ data: deleted, error: null });
      }

      if (name === "begin_journey_retention_cycle_v1") {
        if (state.upsertHealthError) {
          return Promise.resolve({ data: null, error: state.upsertHealthError });
        }
        const now = args.p_now as string;
        const existing = state.healthRow as (FakeHealthRow & {
          cycle_token?: string | null;
          cycle_leased_by?: string | null;
          cycle_lease_expires_at?: string | null;
        }) | null;
        if (
          existing?.cycle_token &&
          existing.cycle_lease_expires_at &&
          existing.cycle_lease_expires_at > now
        ) {
          return Promise.resolve({ data: null, error: null });
        }
        const token = `${String(args.p_worker_id)}:cycle:${now}`;
        if (!state.healthRow) {
          state.healthRow = {
            job: JOURNEY_RETENTION_JOB_KEY,
            last_status: "STALE",
            last_run_at: null,
            last_success_at: null,
            last_failed_at: null,
            last_deleted_count: 0,
            last_failed_count: 0,
            oldest_expired_age_ms: null,
            deletion_lag_ms: null,
            pending_retry_count: 0,
            consecutive_failures: 0,
            last_error: null,
            updated_at: now,
          };
        }
        Object.assign(state.healthRow, {
          last_status: "DEGRADED",
          last_run_at: now,
          last_error: "retention cycle in progress",
          cycle_token: token,
          cycle_leased_by: args.p_worker_id,
          cycle_lease_expires_at: new Date(
            new Date(now).getTime() + (args.p_lease_seconds as number) * 1000,
          ).toISOString(),
          updated_at: now,
        });
        return Promise.resolve({ data: token, error: null });
      }

      // finish_journey_retention_cycle_v2: records observation/segment/ground-truth counts
      if (name === "finish_journey_retention_cycle_v2") {
        if (state.failHealthUpsertAt === 2) {
          return Promise.resolve({ data: null, error: new Error("health finalize failed") });
        }
        const row = state.healthRow as (FakeHealthRow & {
          cycle_token?: string | null;
          cycle_leased_by?: string | null;
          cycle_lease_expires_at?: string | null;
        }) | null;
        if (state.loseCycleLeaseOnFinish && row) {
          row.cycle_token = "new-owner-token";
          row.cycle_leased_by = "new-owner";
        }
        const ownsCycle =
          row?.cycle_token === args.p_cycle_token &&
          row.cycle_lease_expires_at !== null &&
          row.cycle_lease_expires_at !== undefined &&
          row.cycle_lease_expires_at > (args.p_now as string);
        if (!row || !ownsCycle) {
          return Promise.resolve({ data: false, error: null });
        }
        row.last_status = args.p_status as string;
        row.last_run_at = args.p_now as string;
        row.last_deleted_count = args.p_deleted_count as number;
        row.last_failed_count = args.p_failed_count as number;
        row.oldest_expired_age_ms = args.p_oldest_expired_age_ms as number | null;
        row.deletion_lag_ms = args.p_deletion_lag_ms as number | null;
        row.pending_retry_count = args.p_pending_retry_count as number;
        row.last_error = args.p_error as string | null;
        // v2-specific per-table counts
        row.last_observation_deleted_count = args.p_observation_deleted_count as number ?? null;
        row.last_segment_deleted_count = args.p_segment_deleted_count as number ?? null;
        row.last_ground_truth_deleted_count = args.p_ground_truth_deleted_count as number ?? null;
        if (args.p_status === "FAILED") {
          row.last_failed_at = args.p_now as string;
          row.consecutive_failures += 1;
        } else {
          row.last_success_at = args.p_now as string;
          row.consecutive_failures = 0;
        }
        row.updated_at = args.p_now as string;
        row.cycle_token = null;
        row.cycle_leased_by = null;
        row.cycle_lease_expires_at = null;
        return Promise.resolve({ data: true, error: null });
      }

      // Legacy v1 finalizer — if still called, treat as unknown
      if (name === "finish_journey_retention_cycle_v1") {
        return Promise.resolve({ data: null, error: { message: "v1 finalizer superseded by v2" } });
      }

      if (name === "claim_journey_revocation_jobs_v1") {
        if (state.claimJobsError) {
          return Promise.resolve({ data: null, error: state.claimJobsError });
        }
        const now = args.p_now as string;
        const limit = args.p_limit as number;
        const workerId = args.p_worker_id as string;
        const leaseSeconds = args.p_lease_seconds as number;

        const claimable = state.revocationJobs.filter(
          (j) =>
            j.completed_at === null &&
            (
              ((j.status === "pending" || j.status === "failed") && j.available_at <= now) ||
              (j.status === "processing" && j.lease_expires_at !== null && j.lease_expires_at <= now)
            ),
        );
        claimable.sort((a, b) => a.requested_at.localeCompare(b.requested_at));
        const batch = claimable.slice(0, limit);
        const leaseExpires = new Date(
          new Date(now).getTime() + leaseSeconds * 1000,
        ).toISOString();
        for (const job of batch) {
          job.status = "processing";
          job.leased_by = workerId;
          job.lease_token = `${job.id}:lease:${job.attempt_count + 1}`;
          job.lease_expires_at = leaseExpires;
          job.attempt_count += 1;
          (job as any).last_attempt_at = now;
          job.updated_at = now;
        }
        return Promise.resolve({ data: batch.map((job) => ({ ...job })), error: null });
      }
      if (name === "complete_journey_revocation_job_v1") {
        if (state.updateJobError) {
          return Promise.resolve({ data: null, error: state.updateJobError });
        }
        const job = state.revocationJobs.find((candidate) => candidate.id === args.p_job_id);
        if (state.loseLeaseOnComplete && job) {
          job.status = "completed";
          job.completed_at = args.p_now as string;
          job.leased_by = null;
          job.lease_token = null;
          job.lease_expires_at = null;
          return Promise.resolve({ data: false, error: null });
        }
        const ownsLease =
          job?.status === "processing" &&
          job.lease_token === args.p_lease_token &&
          job.lease_expires_at !== null &&
          job.lease_expires_at > (args.p_now as string);
        if (!job || !ownsLease) {
          return Promise.resolve({ data: false, error: null });
        }
        job.status = "completed";
        job.completed_at = args.p_now as string;
        job.deleted_count = args.p_deleted_count as number;
        job.last_error = null;
        job.leased_by = null;
        job.lease_token = null;
        job.lease_expires_at = null;
        job.updated_at = args.p_now as string;
        return Promise.resolve({ data: true, error: null });
      }
      if (name === "fail_journey_revocation_job_v1") {
        if (state.updateJobError) {
          return Promise.resolve({ data: null, error: state.updateJobError });
        }
        const job = state.revocationJobs.find((candidate) => candidate.id === args.p_job_id);
        const ownsLease =
          job?.status === "processing" &&
          job.lease_token === args.p_lease_token &&
          job.lease_expires_at !== null &&
          job.lease_expires_at > (args.p_now as string);
        if (!job || !ownsLease) {
          return Promise.resolve({ data: false, error: null });
        }
        job.status = "failed";
        job.available_at = args.p_available_at as string;
        job.failed_count = args.p_failed_count as number;
        job.last_error = args.p_error as string;
        job.leased_by = null;
        job.lease_token = null;
        job.lease_expires_at = null;
        job.updated_at = args.p_now as string;
        return Promise.resolve({ data: true, error: null });
      }
      return Promise.resolve({ data: null, error: { message: `unknown rpc: ${name}` } });
    },
  };
}

// ─── (1) readJourneyIngestionControls ────────────────────────────────────────

describe("(1) readJourneyIngestionControls", () => {
  function makeFlagClient(rows: Array<{ flag: string; enabled: boolean }>) {
    return {
      from(_table: string) {
        const b: any = {
          select() { return b; },
          in() { return b; },
          then(resolve: any) {
            resolve({ data: rows, error: null });
          },
        };
        return b;
      },
    };
  }

  function makeErrorFlagClient() {
    return {
      from(_table: string) {
        const b: any = {
          select() { return b; },
          in() { return b; },
          then(resolve: any) {
            resolve({ data: null, error: { message: "db error" } });
          },
        };
        return b;
      },
    };
  }

  it("returns enabled=true when all four flags are present and correctly set", async () => {
    const client = makeFlagClient([
      { flag: JOURNEY_MASTER_FLAG, enabled: true },
      { flag: JOURNEY_INGEST_FLAG, enabled: true },
      { flag: JOURNEY_SHADOW_FLAG, enabled: true },
      { flag: GLOBAL_LOCATION_STOP_FLAG, enabled: false },
    ]);
    const result = await readJourneyIngestionControls(client as any);
    assert.equal(result.enabled, true, "should be enabled when all features on and stop off");
    assert.equal(result.available, true);
  });

  it("returns enabled=false when JOURNEY_MASTER_FLAG is false", async () => {
    const client = makeFlagClient([
      { flag: JOURNEY_MASTER_FLAG, enabled: false },
      { flag: JOURNEY_INGEST_FLAG, enabled: true },
      { flag: JOURNEY_SHADOW_FLAG, enabled: true },
      { flag: GLOBAL_LOCATION_STOP_FLAG, enabled: false },
    ]);
    const result = await readJourneyIngestionControls(client as any);
    assert.equal(result.enabled, false);
    assert.equal(result.available, true);
  });

  it("returns enabled=false when JOURNEY_INGEST_FLAG is false", async () => {
    const client = makeFlagClient([
      { flag: JOURNEY_MASTER_FLAG, enabled: true },
      { flag: JOURNEY_INGEST_FLAG, enabled: false },
      { flag: JOURNEY_SHADOW_FLAG, enabled: true },
      { flag: GLOBAL_LOCATION_STOP_FLAG, enabled: false },
    ]);
    const result = await readJourneyIngestionControls(client as any);
    assert.equal(result.enabled, false);
    assert.equal(result.available, true);
  });

  it("returns enabled=false when JOURNEY_SHADOW_FLAG is false", async () => {
    const client = makeFlagClient([
      { flag: JOURNEY_MASTER_FLAG, enabled: true },
      { flag: JOURNEY_INGEST_FLAG, enabled: true },
      { flag: JOURNEY_SHADOW_FLAG, enabled: false },
      { flag: GLOBAL_LOCATION_STOP_FLAG, enabled: false },
    ]);
    const result = await readJourneyIngestionControls(client as any);
    assert.equal(result.enabled, false);
    assert.equal(result.available, true);
  });

  it("returns enabled=false when GLOBAL_LOCATION_STOP_FLAG is true (emergency stop)", async () => {
    const client = makeFlagClient([
      { flag: JOURNEY_MASTER_FLAG, enabled: true },
      { flag: JOURNEY_INGEST_FLAG, enabled: true },
      { flag: JOURNEY_SHADOW_FLAG, enabled: true },
      { flag: GLOBAL_LOCATION_STOP_FLAG, enabled: true },
    ]);
    const result = await readJourneyIngestionControls(client as any);
    assert.equal(result.enabled, false);
    assert.equal(result.available, true);
  });

  it("returns enabled=false, available=false when DB returns an error", async () => {
    const client = makeErrorFlagClient();
    const result = await readJourneyIngestionControls(client as any);
    assert.equal(result.enabled, false);
    assert.equal(result.available, false);
  });

  it("returns enabled=false, available=false when GLOBAL_LOCATION_STOP_FLAG row is missing", async () => {
    // Only master + ingest + shadow rows — stop row absent means we cannot confirm safe
    const client = makeFlagClient([
      { flag: JOURNEY_MASTER_FLAG, enabled: true },
      { flag: JOURNEY_INGEST_FLAG, enabled: true },
      { flag: JOURNEY_SHADOW_FLAG, enabled: true },
      // GLOBAL_LOCATION_STOP_FLAG deliberately omitted
    ]);
    const result = await readJourneyIngestionControls(client as any);
    assert.equal(result.enabled, false, "missing stop row must disable ingestion");
    assert.equal(result.available, false);
  });

  it("returns enabled=false, available=false when JOURNEY_MASTER_FLAG row is missing", async () => {
    const client = makeFlagClient([
      { flag: JOURNEY_INGEST_FLAG, enabled: true },
      { flag: JOURNEY_SHADOW_FLAG, enabled: true },
      { flag: GLOBAL_LOCATION_STOP_FLAG, enabled: false },
    ]);
    const result = await readJourneyIngestionControls(client as any);
    assert.equal(result.enabled, false);
    assert.equal(result.available, false);
  });

  it("returns enabled=false, available=false when JOURNEY_INGEST_FLAG row is missing", async () => {
    const client = makeFlagClient([
      { flag: JOURNEY_MASTER_FLAG, enabled: true },
      { flag: JOURNEY_SHADOW_FLAG, enabled: true },
      { flag: GLOBAL_LOCATION_STOP_FLAG, enabled: false },
    ]);
    const result = await readJourneyIngestionControls(client as any);
    assert.equal(result.enabled, false);
    assert.equal(result.available, false);
  });

  it("returns enabled=false, available=false when JOURNEY_SHADOW_FLAG row is missing", async () => {
    const client = makeFlagClient([
      { flag: JOURNEY_MASTER_FLAG, enabled: true },
      { flag: JOURNEY_INGEST_FLAG, enabled: true },
      { flag: GLOBAL_LOCATION_STOP_FLAG, enabled: false },
      // JOURNEY_SHADOW_FLAG deliberately omitted
    ]);
    const result = await readJourneyIngestionControls(client as any);
    assert.equal(result.enabled, false);
    assert.equal(result.available, false);
  });
});

// ─── (2) ingestJourneyObservationBatch ───────────────────────────────────────

describe("(2) ingestJourneyObservationBatch", () => {
  const NOW = new Date("2026-10-01T12:00:00.000Z");
  const USER_ID = "aaaaaaaa-0000-4000-8000-000000000001";
  const SESSION_ID = "bbbbbbbb-0000-4000-8000-000000000001";

  function makeObservation(
    overrides?: Partial<{
      source: string;
      idempotencyKey: string;
    }>,
  ) {
    return {
      version: 1 as const,
      locationSessionId: SESSION_ID,
      observedAt: NOW.toISOString(),
      consentScope: "journey_observation_v1" as const,
      idempotencyKey: overrides?.idempotencyKey ?? "key-001",
      source: (overrides?.source ?? "plan_checkin") as "plan_checkin",
      world: { cityId: "city-1" },
    };
  }

  // All four flags enabled — readJourneyIngestionControls returns enabled=true
  function makeIngestClient(rpcResponse: string) {
    return {
      from(_table: string) {
        const b: any = {
          select() { return b; },
          in() { return b; },
          then(resolve: any) {
            resolve({
              data: [
                { flag: JOURNEY_MASTER_FLAG, enabled: true },
                { flag: JOURNEY_INGEST_FLAG, enabled: true },
                { flag: JOURNEY_SHADOW_FLAG, enabled: true },
                { flag: GLOBAL_LOCATION_STOP_FLAG, enabled: false },
              ],
              error: null,
            });
          },
        };
        return b;
      },
      rpc(_name: string, _args: unknown) {
        return Promise.resolve({ data: rpcResponse, error: null });
      },
    };
  }

  function makeIngestErrorClient() {
    return {
      from(_table: string) {
        const b: any = {
          select() { return b; },
          in() { return b; },
          then(resolve: any) {
            resolve({
              data: [
                { flag: JOURNEY_MASTER_FLAG, enabled: true },
                { flag: JOURNEY_INGEST_FLAG, enabled: true },
                { flag: JOURNEY_SHADOW_FLAG, enabled: true },
                { flag: GLOBAL_LOCATION_STOP_FLAG, enabled: false },
              ],
              error: null,
            });
          },
        };
        return b;
      },
      rpc(_name: string) {
        return Promise.resolve({ data: null, error: { message: "rpc error" } });
      },
    };
  }

  function makeFeatureDisabledClient(available: boolean) {
    return {
      from(_table: string) {
        const b: any = {
          select() { return b; },
          in() { return b; },
          then(resolve: any) {
            if (!available) {
              resolve({ data: null, error: { message: "db error" } });
            } else {
              // All flags present but master is off
              resolve({
                data: [
                  { flag: JOURNEY_MASTER_FLAG, enabled: false },
                  { flag: JOURNEY_INGEST_FLAG, enabled: true },
                  { flag: JOURNEY_SHADOW_FLAG, enabled: true },
                  { flag: GLOBAL_LOCATION_STOP_FLAG, enabled: false },
                ],
                error: null,
              });
            }
          },
        };
        return b;
      },
      rpc() { return Promise.resolve({ data: null, error: null }); },
    };
  }

  it("maps RPC response 'accepted' to status:accepted", async () => {
    const client = makeIngestClient("accepted");
    const items = [{ index: 0, observation: makeObservation() }];
    const results = await ingestJourneyObservationBatch(client as any, USER_ID, items, NOW);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "accepted");
  });

  it("maps RPC response 'not_authorized' to status:rejected / code:not_authorized", async () => {
    const client = makeIngestClient("not_authorized");
    const items = [{ index: 0, observation: makeObservation() }];
    const results = await ingestJourneyObservationBatch(client as any, USER_ID, items, NOW);
    assert.equal(results[0].status, "rejected");
    assert.equal((results[0] as any).code, "not_authorized");
  });

  it("maps RPC response 'temporarily_unavailable' to status:rejected / code:temporarily_unavailable", async () => {
    const client = makeIngestClient("temporarily_unavailable");
    const items = [{ index: 0, observation: makeObservation() }];
    const results = await ingestJourneyObservationBatch(client as any, USER_ID, items, NOW);
    assert.equal(results[0].status, "rejected");
    assert.equal((results[0] as any).code, "temporarily_unavailable");
  });

  it("maps RPC error to status:rejected / code:temporarily_unavailable", async () => {
    const client = makeIngestErrorClient();
    const items = [{ index: 0, observation: makeObservation() }];
    const results = await ingestJourneyObservationBatch(client as any, USER_ID, items, NOW);
    assert.equal(results[0].status, "rejected");
    assert.equal((results[0] as any).code, "temporarily_unavailable");
  });

  it("rejects all with code:feature_disabled when feature is off but DB is available", async () => {
    const client = makeFeatureDisabledClient(true);
    const items = [
      { index: 0, observation: makeObservation({ idempotencyKey: "k1" }) },
      { index: 1, observation: makeObservation({ idempotencyKey: "k2" }) },
    ];
    const results = await ingestJourneyObservationBatch(client as any, USER_ID, items, NOW);
    for (const r of results) {
      assert.equal(r.status, "rejected");
      assert.equal((r as any).code, "feature_disabled");
    }
  });

  it("rejects all with code:temporarily_unavailable when DB is unavailable", async () => {
    const client = makeFeatureDisabledClient(false);
    const items = [{ index: 0, observation: makeObservation() }];
    const results = await ingestJourneyObservationBatch(client as any, USER_ID, items, NOW);
    assert.equal(results[0].status, "rejected");
    assert.equal((results[0] as any).code, "temporarily_unavailable");
  });

  it("returns empty array when items list is empty", async () => {
    const client = makeIngestClient("accepted");
    const results = await ingestJourneyObservationBatch(client as any, USER_ID, [], NOW);
    assert.deepEqual(results, []);
  });

  it("delegates to ingest_journey_observation_v2 RPC (not v1)", async () => {
    const rpcCalls: string[] = [];
    const rpcArgs: Record<string, unknown>[] = [];
    const client = {
      from(_table: string) {
        const b: any = {
          select() { return b; },
          in() { return b; },
          then(resolve: any) {
            resolve({
              data: [
                { flag: JOURNEY_MASTER_FLAG, enabled: true },
                { flag: JOURNEY_INGEST_FLAG, enabled: true },
                { flag: JOURNEY_SHADOW_FLAG, enabled: true },
                { flag: GLOBAL_LOCATION_STOP_FLAG, enabled: false },
              ],
              error: null,
            });
          },
        };
        return b;
      },
      rpc(name: string, args: unknown) {
        rpcCalls.push(name);
        rpcArgs.push(args as Record<string, unknown>);
        return Promise.resolve({ data: "accepted", error: null });
      },
    };
    const items = [{ index: 0, observation: makeObservation() }];
    await ingestJourneyObservationBatch(client as any, USER_ID, items, NOW);
    assert.ok(
      rpcCalls.includes("ingest_journey_observation_v2"),
      "must call ingest_journey_observation_v2 RPC",
    );
    assert.ok(
      !rpcCalls.includes("ingest_journey_observation_v1"),
      "must NOT call ingest_journey_observation_v1 RPC",
    );
  });

  it("passes mandatory quality args to ingest_journey_observation_v2", async () => {
    const capturedArgs: Record<string, unknown>[] = [];
    const client = {
      from(_table: string) {
        const b: any = {
          select() { return b; },
          in() { return b; },
          then(resolve: any) {
            resolve({
              data: [
                { flag: JOURNEY_MASTER_FLAG, enabled: true },
                { flag: JOURNEY_INGEST_FLAG, enabled: true },
                { flag: JOURNEY_SHADOW_FLAG, enabled: true },
                { flag: GLOBAL_LOCATION_STOP_FLAG, enabled: false },
              ],
              error: null,
            });
          },
        };
        return b;
      },
      rpc(name: string, args: unknown) {
        if (name === "ingest_journey_observation_v2") {
          capturedArgs.push(args as Record<string, unknown>);
        }
        return Promise.resolve({ data: "accepted", error: null });
      },
    };
    const items = [{ index: 0, observation: makeObservation() }];
    await ingestJourneyObservationBatch(client as any, USER_ID, items, NOW);
    assert.equal(capturedArgs.length, 1, "v2 RPC must be called exactly once");
    const args = capturedArgs[0];
    // All four quality fields must be present and non-null
    assert.ok("p_quality_version" in args, "must pass p_quality_version");
    assert.ok("p_quality_score" in args, "must pass p_quality_score");
    assert.ok("p_quality_class" in args, "must pass p_quality_class");
    assert.ok("p_quality_reasons" in args, "must pass p_quality_reasons");
    assert.ok(args.p_quality_version !== null, "p_quality_version must not be null");
    assert.ok(args.p_quality_score !== null, "p_quality_score must not be null");
    assert.ok(args.p_quality_class !== null, "p_quality_class must not be null");
    assert.ok(args.p_quality_reasons !== null, "p_quality_reasons must not be null");
    // version must be the expected scorer algorithm string
    assert.equal(
      args.p_quality_version,
      "journey-observation-quality-v1",
      "quality_version must be journey-observation-quality-v1",
    );
    // score must be in [0, 1]
    const score = args.p_quality_score as number;
    assert.ok(score >= 0 && score <= 1, `quality_score ${score} must be in [0, 1]`);
    // class must be one of the allowed values (unusable also allowed, but fresh fixtures produce non-unusable)
    assert.ok(
      ["high", "usable", "degraded", "unusable"].includes(args.p_quality_class as string),
      `quality_class '${args.p_quality_class}' must be high|usable|degraded|unusable`,
    );
  });
});

// ─── (3) queryJourneyRetentionHealth ─────────────────────────────────────────

describe("(3) queryJourneyRetentionHealth", () => {
  const staleAfterMs = JOURNEY_PURGE_STALE_AFTER_MS; // 2 × 5min = 10min

  function makeHealthClient(row: Partial<FakeHealthRow> | null, error?: { message: string }) {
    return {
      from(_table: string) {
        return {
          select() { return this; },
          eq() { return this; },
          async maybeSingle() {
            if (error) return { data: null, error };
            if (!row) return { data: null, error: null };
            return {
              data: {
                last_status: "HEALTHY",
                last_run_at: null,
                last_success_at: null,
                last_failed_at: null,
                last_deleted_count: 0,
                last_failed_count: 0,
                oldest_expired_age_ms: null,
                deletion_lag_ms: null,
                pending_retry_count: 0,
                consecutive_failures: 0,
                last_error: null,
                ...row,
              },
              error: null,
            };
          },
        };
      },
    };
  }

  it("returns state=HEALTHY when last_success_at is within stale threshold and status is HEALTHY", async () => {
    const now = new Date("2026-10-01T12:10:00.000Z");
    const successAt = new Date(now.getTime() - 4 * 60 * 1000).toISOString(); // 4 min ago
    const client = makeHealthClient({ last_status: "HEALTHY", last_success_at: successAt });
    const health = await queryJourneyRetentionHealth({ client: client as any, now });
    assert.equal(health.state, "HEALTHY");
  });

  it("returns state=DEGRADED when persisted status is DEGRADED and within stale threshold", async () => {
    const now = new Date("2026-10-01T12:10:00.000Z");
    const successAt = new Date(now.getTime() - 3 * 60 * 1000).toISOString(); // 3 min ago
    const client = makeHealthClient({ last_status: "DEGRADED", last_success_at: successAt });
    const health = await queryJourneyRetentionHealth({ client: client as any, now });
    assert.equal(health.state, "DEGRADED");
  });

  it("returns state=FAILED when persisted status is FAILED and within stale threshold", async () => {
    const now = new Date("2026-10-01T12:10:00.000Z");
    const successAt = new Date(now.getTime() - 2 * 60 * 1000).toISOString(); // 2 min ago
    const client = makeHealthClient({ last_status: "FAILED", last_success_at: successAt });
    const health = await queryJourneyRetentionHealth({ client: client as any, now });
    assert.equal(health.state, "FAILED");
  });

  it("returns state=STALE when no row exists", async () => {
    const now = new Date("2026-10-01T12:00:00.000Z");
    const client = makeHealthClient(null);
    const health = await queryJourneyRetentionHealth({ client: client as any, now });
    assert.equal(health.state, "STALE");
  });

  it("returns state=STALE when two 5-minute intervals have been missed (elapsed > stale threshold)", async () => {
    const now = new Date("2026-10-01T12:00:00.000Z");
    // staleAfterMs = 10 min; success was 11 min ago → STALE
    const successAt = new Date(now.getTime() - (staleAfterMs + 60_000)).toISOString();
    const client = makeHealthClient({ last_status: "HEALTHY", last_success_at: successAt });
    const health = await queryJourneyRetentionHealth({ client: client as any, now });
    assert.equal(health.state, "STALE", "two missed 5-minute intervals must be STALE");
  });

  it("keeps the persisted state before two 5-minute intervals have been missed", async () => {
    // Elapsed 7 min — more than one interval (5 min) but less than stale threshold (10 min)
    // Should still be HEALTHY (the persisted state), not STALE yet
    const now = new Date("2026-10-01T12:00:00.000Z");
    const successAt = new Date(now.getTime() - 7 * 60_000).toISOString();
    const client = makeHealthClient({ last_status: "HEALTHY", last_success_at: successAt });
    const health = await queryJourneyRetentionHealth({ client: client as any, now });
    // 7 min < 10 min stale threshold → stays at persisted HEALTHY
    assert.equal(health.state, "HEALTHY");
  });

  it("returns state=FAILED and lastError set when DB returns an error", async () => {
    const now = new Date("2026-10-01T12:00:00.000Z");
    const client = makeHealthClient(null, { message: "connection error" });
    const health = await queryJourneyRetentionHealth({ client: client as any, now });
    assert.equal(health.state, "FAILED");
    assert.ok(health.lastError, "lastError should be populated on DB error");
  });

  it("returns state=STALE when client is null (no service client ready)", async () => {
    const now = new Date("2026-10-01T12:00:00.000Z");
    const health = await queryJourneyRetentionHealth({ client: null, now });
    assert.equal(health.state, "STALE");
  });

  it("STALE_AFTER_MS equals exactly two 5-minute purge intervals", () => {
    assert.equal(
      staleAfterMs,
      JOURNEY_PURGE_INTERVAL_MS * 2,
      "STALE threshold must be exactly two purge intervals",
    );
  });
});

// ─── (4) runJourneyRetentionCycle ─────────────────────────────────────────────

describe("(4) runJourneyRetentionCycle", () => {
  const NOW = new Date("2026-10-01T12:00:00.000Z");
  const USER_A = "aaaaaaaa-0000-4000-8000-000000000001";
  const SESSION_A = "sessaaaa-0000-4000-8000-000000000001";
  const JOB_A = "jobaaa00-0000-4000-8000-000000000001";

  function makeExpiredObservation(id: string, userId: string, sessionId: string): FakeObservation {
    return {
      id,
      user_id: userId,
      location_session_id: sessionId,
      expires_at: new Date(NOW.getTime() - 60_000).toISOString(), // expired 1 min ago
    };
  }

  function makeFreshObservation(id: string, userId: string, sessionId: string): FakeObservation {
    return {
      id,
      user_id: userId,
      location_session_id: sessionId,
      expires_at: new Date(NOW.getTime() + 60 * 60_000).toISOString(), // expires 1h from now
    };
  }

  function makeExpiredSegment(id: string, userId: string, sessionId: string): FakeObservation {
    return {
      id,
      user_id: userId,
      location_session_id: sessionId,
      expires_at: new Date(NOW.getTime() - 60_000).toISOString(),
    };
  }

  function makeExpiredGroundTruth(id: string, userId: string, sessionId: string): FakeObservation {
    return {
      id,
      user_id: userId,
      location_session_id: sessionId,
      expires_at: new Date(NOW.getTime() - 60_000).toISOString(),
    };
  }

  function makePendingJob(
    id: string,
    userId: string,
    sessionId: string | null = null,
    availableBeforeNow = true,
  ): FakeRevocationJob {
    return {
      id,
      user_id: userId,
      location_session_id: sessionId,
      attempt_count: 0,
      status: "pending",
      available_at: availableBeforeNow
        ? new Date(NOW.getTime() - 1000).toISOString()
        : new Date(NOW.getTime() + 60_000).toISOString(),
      requested_at: new Date(NOW.getTime() - 5000).toISOString(),
      completed_at: null,
      deleted_count: 0,
      failed_count: 0,
      last_error: null,
      leased_by: null,
      lease_token: null,
      lease_expires_at: null,
      updated_at: new Date(NOW.getTime() - 5000).toISOString(),
    };
  }

  function makeHealthyRow(): FakeHealthRow {
    return {
      job: JOURNEY_RETENTION_JOB_KEY,
      last_status: "HEALTHY",
      last_run_at: new Date(NOW.getTime() - 4 * 60_000).toISOString(),
      last_success_at: new Date(NOW.getTime() - 4 * 60_000).toISOString(),
      last_failed_at: null,
      last_deleted_count: 0,
      last_failed_count: 0,
      oldest_expired_age_ms: null,
      deletion_lag_ms: null,
      pending_retry_count: 0,
      consecutive_failures: 0,
      last_error: null,
      updated_at: new Date(NOW.getTime() - 4 * 60_000).toISOString(),
    };
  }

  it("returns state=HEALTHY and expiredDeleted=0 on empty DB (empty success)", async () => {
    const state: FakeWorkerState = {
      observations: [],
      revocationJobs: [],
      healthRow: makeHealthyRow(),
      sessions: [],
    };
    const client = makeFakeClient(state);
    const result = await runJourneyRetentionCycle({ client, now: NOW, workerId: "test-worker" });
    assert.equal(result.state, "HEALTHY");
    assert.equal(result.expiredDeleted, 0);
    assert.equal(result.revokedDeleted, 0);
    assert.equal(result.failedCount, 0);
    assert.equal(result.error, null);
  });

  it("returns state=FAILED when client is null", async () => {
    const result = await runJourneyRetentionCycle({ client: null, now: NOW });
    assert.equal(result.state, "FAILED");
    assert.ok(result.error instanceof Error, "error should be an Error instance");
  });

  it("physically deletes expired observations and reports expiredObservationDeleted count", async () => {
    const state: FakeWorkerState = {
      observations: [
        makeExpiredObservation("obs-expired-1", USER_A, SESSION_A),
        makeExpiredObservation("obs-expired-2", USER_A, SESSION_A),
        makeFreshObservation("obs-fresh-1", USER_A, SESSION_A),
      ],
      revocationJobs: [],
      healthRow: makeHealthyRow(),
      sessions: [],
    };
    const client = makeFakeClient(state);
    const result = await runJourneyRetentionCycle({ client, now: NOW, workerId: "test-worker" });
    assert.equal(result.expiredObservationDeleted, 2, "must delete exactly the two expired observation rows");
    assert.equal(result.expiredDeleted, 2, "expiredDeleted must sum to 2 when only observations expired");
    // The fresh observation must still be in state
    assert.equal(state.observations.length, 1, "fresh observation must survive");
    assert.equal(state.observations[0].id, "obs-fresh-1");
  });

  it("physically deletes expired journey_segment_revisions and reports expiredSegmentDeleted count", async () => {
    const state: FakeWorkerState = {
      observations: [],
      segments: [
        makeExpiredSegment("seg-expired-1", USER_A, SESSION_A),
        makeExpiredSegment("seg-expired-2", USER_A, SESSION_A),
      ],
      revocationJobs: [],
      healthRow: makeHealthyRow(),
      sessions: [],
    };
    const client = makeFakeClient(state);
    const result = await runJourneyRetentionCycle({ client, now: NOW, workerId: "test-worker" });
    assert.equal(result.expiredSegmentDeleted, 2, "must delete exactly the two expired segment rows");
    assert.equal(state.segments?.length, 0, "all expired segments must be deleted");
  });

  it("physically deletes expired journey_shadow_ground_truth and reports expiredGroundTruthDeleted count", async () => {
    const state: FakeWorkerState = {
      observations: [],
      groundTruth: [
        makeExpiredGroundTruth("gt-expired-1", USER_A, SESSION_A),
        makeExpiredGroundTruth("gt-expired-2", USER_A, SESSION_A),
      ],
      revocationJobs: [],
      healthRow: makeHealthyRow(),
      sessions: [],
    };
    const client = makeFakeClient(state);
    const result = await runJourneyRetentionCycle({ client, now: NOW, workerId: "test-worker" });
    assert.equal(result.expiredGroundTruthDeleted, 2, "must delete exactly the two expired ground-truth rows");
    assert.equal(state.groundTruth?.length, 0, "all expired ground-truth rows must be deleted");
  });

  it("sums all three expiry tables into expiredDeleted", async () => {
    const state: FakeWorkerState = {
      observations: [makeExpiredObservation("obs-exp-1", USER_A, SESSION_A)],
      segments: [makeExpiredSegment("seg-exp-1", USER_A, SESSION_A)],
      groundTruth: [makeExpiredGroundTruth("gt-exp-1", USER_A, SESSION_A)],
      revocationJobs: [],
      healthRow: makeHealthyRow(),
      sessions: [],
    };
    const client = makeFakeClient(state);
    const result = await runJourneyRetentionCycle({ client, now: NOW, workerId: "test-worker" });
    assert.equal(result.expiredObservationDeleted, 1, "expiredObservationDeleted must be 1");
    assert.equal(result.expiredSegmentDeleted, 1, "expiredSegmentDeleted must be 1");
    assert.equal(result.expiredGroundTruthDeleted, 1, "expiredGroundTruthDeleted must be 1");
    assert.equal(result.expiredDeleted, 3, "expiredDeleted must be sum of all three tables");
  });

  it("finish_journey_retention_cycle_v2 receives per-table observation/segment/ground-truth counts", async () => {
    const capturedRpcArgs: Record<string, unknown>[] = [];
    const state: FakeWorkerState = {
      observations: [makeExpiredObservation("obs-exp", USER_A, SESSION_A)],
      segments: [makeExpiredSegment("seg-exp", USER_A, SESSION_A)],
      groundTruth: [makeExpiredGroundTruth("gt-exp", USER_A, SESSION_A)],
      revocationJobs: [],
      healthRow: makeHealthyRow(),
      sessions: [],
    };
    const baseClient = makeFakeClient(state);
    // Wrap the rpc to capture calls to the v2 finalizer
    const wrappedClient = {
      ...baseClient,
      rpc(name: string, args: Record<string, unknown>) {
        if (name === "finish_journey_retention_cycle_v2") {
          capturedRpcArgs.push(args);
        }
        return baseClient.rpc(name, args);
      },
    };
    await runJourneyRetentionCycle({ client: wrappedClient, now: NOW, workerId: "test-worker" });
    assert.ok(capturedRpcArgs.length >= 1, "finish_journey_retention_cycle_v2 must be called");
    const finishArgs = capturedRpcArgs[0];
    assert.ok("p_observation_deleted_count" in finishArgs, "must pass p_observation_deleted_count");
    assert.ok("p_segment_deleted_count" in finishArgs, "must pass p_segment_deleted_count");
    assert.ok("p_ground_truth_deleted_count" in finishArgs, "must pass p_ground_truth_deleted_count");
    assert.equal(finishArgs.p_observation_deleted_count, 1, "observation count must be 1");
    assert.equal(finishArgs.p_segment_deleted_count, 1, "segment count must be 1");
    assert.equal(finishArgs.p_ground_truth_deleted_count, 1, "ground-truth count must be 1");
  });

  it("processes a claimed revocation job to completion and deletes linked observations and segments", async () => {
    const state: FakeWorkerState = {
      observations: [
        makeExpiredObservation("obs-revoked-1", USER_A, SESSION_A),
        {
          id: "obs-revoked-2",
          user_id: USER_A,
          location_session_id: SESSION_A,
          expires_at: new Date(NOW.getTime() + 3600_000).toISOString(), // not yet expired
        },
      ],
      segments: [{
        id: "segment-revoked-1",
        user_id: USER_A,
        location_session_id: SESSION_A,
        expires_at: new Date(NOW.getTime() + 3600_000).toISOString(),
      }],
      revocationJobs: [makePendingJob(JOB_A, USER_A, SESSION_A)],
      healthRow: makeHealthyRow(),
      sessions: [],
    };
    const client = makeFakeClient(state);
    const result = await runJourneyRetentionCycle({ client, now: NOW, workerId: "test-worker" });

    // The revocation job should now be completed
    const job = state.revocationJobs.find((j) => j.id === JOB_A);
    assert.ok(job, "revocation job must still be in state");
    assert.equal(job!.status, "completed", "job must be marked completed");
    assert.ok(job!.completed_at, "completed_at must be set");

    // Both session observations should have been deleted (session_id match)
    const remaining = state.observations.filter((o) => o.location_session_id === SESSION_A);
    assert.equal(remaining.length, 0, "all session observations must be deleted by revocation job");
    assert.equal(state.segments?.length, 0, "all session segments must be deleted by revocation job");

    assert.ok(
      result.revokedDeleted >= 3,
      "revokedDeleted must include observations and derived segments",
    );
  });

  it("records durable retry when observation deletion fails (job marked failed)", async () => {
    const state: FakeWorkerState = {
      observations: [],
      revocationJobs: [makePendingJob(JOB_A, USER_A, SESSION_A)],
      healthRow: makeHealthyRow(),
      sessions: [],
      deleteObservationsError: new Error("disk full"),
    };
    const client = makeFakeClient(state);
    const result = await runJourneyRetentionCycle({ client, now: NOW, workerId: "test-worker" });

    // Cycle itself reports FAILED due to errors
    assert.equal(result.state, "FAILED");
    assert.ok(result.failedCount >= 1, "failedCount must be >= 1");

    // The job should be marked failed (or still processing if mark-failed also errored,
    // but updateJobError is NOT set here, so it should be failed)
    const job = state.revocationJobs.find((j) => j.id === JOB_A);
    assert.ok(job, "job must still be in state");
    assert.equal(job!.status, "failed", "job must be marked failed after delete error");
    assert.ok(job!.last_error, "last_error must be recorded on the job");
  });

  it("does not let an expired claimant overwrite a reclaimed job", async () => {
    const state: FakeWorkerState = {
      observations: [makeFreshObservation("obs-reclaimed", USER_A, SESSION_A)],
      revocationJobs: [makePendingJob(JOB_A, USER_A, SESSION_A)],
      healthRow: makeHealthyRow(),
      sessions: [],
      loseLeaseOnComplete: true,
    };
    const client = makeFakeClient(state);
    const result = await runJourneyRetentionCycle({
      client,
      now: NOW,
      workerId: "stale-worker",
    });

    assert.equal(result.state, "FAILED", "lost lease must be visible as a failed cycle");
    assert.equal(state.revocationJobs[0].status, "completed");
    assert.equal(
      state.revocationJobs[0].last_error,
      null,
      "stale worker must not overwrite the new claimant's completion",
    );
  });

  it("persists monitoring fields in journey_retention_health after a successful cycle", async () => {
    const state: FakeWorkerState = {
      observations: [makeExpiredObservation("obs-exp", USER_A, SESSION_A)],
      revocationJobs: [],
      healthRow: makeHealthyRow(),
      sessions: [],
    };
    const client = makeFakeClient(state);
    await runJourneyRetentionCycle({ client, now: NOW, workerId: "test-worker" });

    const row = state.healthRow!;
    assert.ok(row, "health row must be written");
    assert.equal(row.last_status, "HEALTHY");
    assert.ok(row.last_run_at, "last_run_at must be set");
    assert.ok(row.last_success_at, "last_success_at must be set");
  });

  it("health row records per-table deleted counts via v2 finalizer", async () => {
    const state: FakeWorkerState = {
      observations: [makeExpiredObservation("obs-exp", USER_A, SESSION_A)],
      segments: [makeExpiredSegment("seg-exp", USER_A, SESSION_A)],
      groundTruth: [makeExpiredGroundTruth("gt-exp", USER_A, SESSION_A)],
      revocationJobs: [],
      healthRow: makeHealthyRow(),
      sessions: [],
    };
    const client = makeFakeClient(state);
    await runJourneyRetentionCycle({ client, now: NOW, workerId: "test-worker" });
    const row = state.healthRow! as FakeHealthRow;
    assert.equal(row.last_observation_deleted_count, 1, "health row must record observation count");
    assert.equal(row.last_segment_deleted_count, 1, "health row must record segment count");
    assert.equal(row.last_ground_truth_deleted_count, 1, "health row must record ground-truth count");
  });

  it("persists FAILED status in health when an error occurs", async () => {
    const state: FakeWorkerState = {
      observations: [],
      revocationJobs: [],
      healthRow: makeHealthyRow(),
      sessions: [],
      claimJobsError: new Error("claim rpc unavailable"),
    };
    const client = makeFakeClient(state);
    await runJourneyRetentionCycle({ client, now: NOW, workerId: "test-worker" });

    assert.equal(state.healthRow?.last_status, "FAILED", "health row must record FAILED state");
    assert.ok(state.healthRow?.last_error, "last_error must be set in health row on failure");
  });

  it("publishes DEGRADED before work so a final health-write failure never leaves HEALTHY", async () => {
    const state: FakeWorkerState = {
      observations: [makeExpiredObservation("obs-exp", USER_A, SESSION_A)],
      revocationJobs: [],
      healthRow: makeHealthyRow(),
      sessions: [],
      failHealthUpsertAt: 2,
    };
    const client = makeFakeClient(state);
    const result = await runJourneyRetentionCycle({
      client,
      now: NOW,
      workerId: "test-worker",
    });

    assert.equal(result.state, "FAILED");
    assert.equal(state.healthRow?.last_status, "DEGRADED");
    assert.equal(state.observations.length, 0, "cleanup completed before final health write failed");
  });

  it("does not start cleanup when the non-healthy start marker cannot be persisted", async () => {
    const state: FakeWorkerState = {
      observations: [makeExpiredObservation("obs-exp", USER_A, SESSION_A)],
      revocationJobs: [],
      healthRow: makeHealthyRow(),
      sessions: [],
      upsertHealthError: new Error("health table unavailable"),
    };
    const client = makeFakeClient(state);
    const result = await runJourneyRetentionCycle({
      client,
      now: NOW,
      workerId: "test-worker",
    });

    assert.equal(result.state, "FAILED");
    assert.equal(state.observations.length, 1, "cleanup must not begin without a start marker");
  });

  it("does no work while another instance owns the retention-cycle lease", async () => {
    const health = makeHealthyRow() as FakeHealthRow & {
      cycle_token: string;
      cycle_leased_by: string;
      cycle_lease_expires_at: string;
    };
    health.last_status = "DEGRADED";
    health.cycle_token = "other-cycle";
    health.cycle_leased_by = "other-worker";
    health.cycle_lease_expires_at = new Date(
      NOW.getTime() + JOURNEY_RETENTION_CYCLE_LEASE_SECONDS * 1000,
    ).toISOString();
    const state: FakeWorkerState = {
      observations: [makeExpiredObservation("obs-exp", USER_A, SESSION_A)],
      revocationJobs: [],
      healthRow: health,
      sessions: [],
    };

    const result = await runJourneyRetentionCycle({
      client: makeFakeClient(state),
      now: NOW,
      workerId: "second-worker",
    });

    assert.equal(result.state, "DEGRADED");
    assert.equal(state.observations.length, 1, "non-owner must not perform cleanup");
    assert.equal(health.cycle_token, "other-cycle", "non-owner must not replace the active cycle");
  });

  it("cannot publish a result after losing the retention-cycle lease", async () => {
    const state: FakeWorkerState = {
      observations: [],
      revocationJobs: [],
      healthRow: makeHealthyRow(),
      sessions: [],
      loseCycleLeaseOnFinish: true,
    };

    const result = await runJourneyRetentionCycle({
      client: makeFakeClient(state),
      now: NOW,
      workerId: "stale-cycle-worker",
    });

    assert.equal(result.state, "FAILED");
    assert.equal((state.healthRow as any).cycle_token, "new-owner-token");
    assert.equal(state.healthRow?.last_status, "DEGRADED");
  });

  it("increments consecutive_failures on each failed cycle", async () => {
    const state: FakeWorkerState = {
      observations: [],
      revocationJobs: [],
      healthRow: { ...makeHealthyRow(), consecutive_failures: 2 },
      sessions: [],
      claimJobsError: new Error("repeated failure"),
    };
    const client = makeFakeClient(state);
    await runJourneyRetentionCycle({ client, now: NOW, workerId: "test-worker" });

    assert.equal(
      state.healthRow?.consecutive_failures,
      3,
      "consecutive_failures must increment",
    );
  });

  it("resets consecutive_failures to 0 after a successful cycle", async () => {
    const state: FakeWorkerState = {
      observations: [],
      revocationJobs: [],
      healthRow: { ...makeHealthyRow(), consecutive_failures: 5 },
      sessions: [],
    };
    const client = makeFakeClient(state);
    await runJourneyRetentionCycle({ client, now: NOW, workerId: "test-worker" });

    assert.equal(
      state.healthRow?.consecutive_failures,
      0,
      "consecutive_failures must reset to 0 on success",
    );
  });

  it("JOURNEY_REVOCATION_LEASE_SECONDS is within the allowed claim bounds (30–900)", () => {
    assert.ok(
      JOURNEY_REVOCATION_LEASE_SECONDS >= 30 && JOURNEY_REVOCATION_LEASE_SECONDS <= 900,
      `lease ${JOURNEY_REVOCATION_LEASE_SECONDS} must be in [30, 900]`,
    );
  });

  it("JOURNEY_REVOCATION_BATCH_SIZE is within the allowed claim bounds (1–100)", () => {
    assert.ok(
      JOURNEY_REVOCATION_BATCH_SIZE >= 1 && JOURNEY_REVOCATION_BATCH_SIZE <= 100,
      `batch size ${JOURNEY_REVOCATION_BATCH_SIZE} must be in [1, 100]`,
    );
  });

  it("retention-cycle lease is bounded to the five-minute cadence", () => {
    assert.equal(
      JOURNEY_RETENTION_CYCLE_LEASE_SECONDS * 1000,
      JOURNEY_PURGE_INTERVAL_MS,
    );
  });
});

// ─── (5) 2124 migration source assertions ─────────────────────────────────────

describe("(5) 2124 migration source", () => {
  it("asserts versioned consent columns on user_location_preferences", () => {
    assert.match(migrationSql, /ADD COLUMN IF NOT EXISTS journey_consent_scope/);
    assert.match(migrationSql, /ADD COLUMN IF NOT EXISTS journey_consent_version/);
    assert.match(migrationSql, /ADD COLUMN IF NOT EXISTS journey_consent_granted_at/);
    assert.match(migrationSql, /ADD COLUMN IF NOT EXISTS journey_consent_revoked_at/);
  });

  it("prevents owner RLS writes from forging or restoring server-owned consent", () => {
    assert.match(
      migrationSql,
      /CREATE OR REPLACE FUNCTION public\.guard_journey_consent_server_authority/,
    );
    assert.match(
      migrationSql,
      /current_user::text IN \('anon', 'authenticated'\)/,
      "the guard must apply to direct owner/anonymous table writes",
    );
    assert.match(
      migrationSql,
      /NEW\.journey_observation_enabled IS DISTINCT FROM[\s\S]*?OLD\.journey_observation_enabled[\s\S]*?NEW\.journey_observation_enabled IS TRUE/,
      "a direct false-to-true consent update must be rejected",
    );
    assert.match(
      migrationSql,
      /NEW\.journey_consent_scope IS DISTINCT FROM OLD\.journey_consent_scope[\s\S]*?NEW\.journey_consent_revoked_at IS DISTINCT FROM OLD\.journey_consent_revoked_at/,
      "direct writes must not rewrite any versioned consent evidence",
    );
    assert.match(
      migrationSql,
      /CREATE TRIGGER a_journey_consent_server_authority[\s\S]*?BEFORE INSERT[\s\S]*?OR UPDATE OF journey_observation_enabled/,
      "the authority guard must run before the revocation trigger",
    );
  });

  it("existing sessions default to legacy_location_share — not journey_observation_v1", () => {
    assert.match(
      migrationSql,
      /ADD COLUMN IF NOT EXISTS journey_purpose.*DEFAULT\s+'legacy_location_share'/s,
    );
    // The constraint must enumerate both values
    assert.match(migrationSql, /'legacy_location_share'/);
    assert.match(migrationSql, /'journey_observation_v1'/);
  });

  it("requires finite expires_at for journey_observation_v1 sessions", () => {
    // The CHECK constraint mandates expires_at IS NOT NULL for journey sessions
    assert.match(migrationSql, /journey_purpose.*<>.*'journey_observation_v1'.*OR expires_at IS NOT NULL/s);
  });

  it("defines the durable queue table journey_revocation_jobs", () => {
    assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS public\.journey_revocation_jobs/);
  });

  it("durable queue has lease fields for atomic claim", () => {
    assert.match(migrationSql, /leased_by/);
    assert.match(migrationSql, /lease_token/);
    assert.match(migrationSql, /lease_expires_at/);
  });

  it("uses claim-token RPCs so an expired worker cannot overwrite a reclaimed job", () => {
    assert.match(
      migrationSql,
      /CREATE OR REPLACE FUNCTION public\.complete_journey_revocation_job_v1/,
    );
    assert.match(
      migrationSql,
      /CREATE OR REPLACE FUNCTION public\.fail_journey_revocation_job_v1/,
    );
    assert.match(migrationSql, /lease_token = gen_random_uuid\(\)/);
    assert.ok(
      (migrationSql.match(/AND lease_token = p_lease_token/g) ?? []).length >= 2,
      "both terminal transitions must verify the claim token",
    );
    assert.ok(
      (migrationSql.match(/AND lease_expires_at > p_now/g) ?? []).length >= 2,
      "both terminal transitions must reject expired leases",
    );
  });

  it("claim lease function exists and is service-only", () => {
    assert.match(migrationSql, /CREATE OR REPLACE FUNCTION public\.claim_journey_revocation_jobs_v1/);
    assert.match(migrationSql, /GRANT EXECUTE ON FUNCTION public\.claim_journey_revocation_jobs_v1/);
    assert.match(migrationSql, /TO service_role/);
    // Must revoke from anon and authenticated
    assert.match(migrationSql, /REVOKE ALL ON FUNCTION public\.claim_journey_revocation_jobs_v1[\s\S]*?FROM anon/);
    assert.match(migrationSql, /REVOKE ALL ON FUNCTION public\.claim_journey_revocation_jobs_v1[\s\S]*?FROM authenticated/);
  });

  it("defines trigger-based revocation on consent changes (preference trigger)", () => {
    assert.match(migrationSql, /CREATE TRIGGER user_location_preferences_purge_journey_on_revocation/);
    assert.match(migrationSql, /BEFORE UPDATE OF journey_observation_enabled.*OR DELETE ON public\.user_location_preferences/s);
  });

  it("defines trigger-based session termination on session revocation", () => {
    assert.match(migrationSql, /CREATE TRIGGER location_sessions_purge_journey_on_revocation/);
    assert.match(
      migrationSql,
      /AFTER UPDATE OF ended_at.*OR DELETE ON public\.location_sessions/s,
    );
  });

  it("trigger body ends active journey sessions when consent is revoked", () => {
    // The revocation trigger body updates location_sessions to set ended_at
    // and filters on journey_observation_v1 purpose
    assert.match(
      migrationSql,
      /UPDATE public\.location_sessions[\s\S]*?SET ended_at[\s\S]*?journey_observation_v1/,
    );
  });

  it("preference revocation synchronously erases raw and derived Journey rows", () => {
    assert.match(
      migrationSql,
      /DELETE FROM public\.journey_observations[\s\S]*?WHERE user_id = v_user_id/,
    );
    assert.match(
      migrationSql,
      /DELETE FROM public\.journey_segment_revisions[\s\S]*?WHERE user_id = v_user_id/,
    );
  });

  it("coarse-mode or paused updates clear versioned consent before durable cleanup", () => {
    assert.match(
      migrationSql,
      /NEW\.journey_observation_enabled := false[\s\S]*?NEW\.journey_consent_revoked_at/,
    );
    assert.match(
      migrationSql,
      /OLD\.location_mode IN[\s\S]*?NEW\.location_mode NOT IN[\s\S]*?location_mode_non_authorizing/,
    );
    assert.match(
      migrationSql,
      /IF NOT FOUND THEN\s+RETURN 'not_eligible'/,
      "consent must not be granted onto a newly defaulted coarse preference row",
    );
  });

  it("defines journey_retention_health table with service-only RLS/grants", () => {
    assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS public\.journey_retention_health/);
    assert.match(migrationSql, /ALTER TABLE public\.journey_retention_health ENABLE ROW LEVEL SECURITY/);
    assert.match(migrationSql, /GRANT SELECT ON TABLE public\.journey_retention_health TO service_role/);
    assert.match(migrationSql, /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.journey_retention_health FROM service_role/);
    assert.match(migrationSql, /REVOKE ALL ON TABLE public\.journey_retention_health FROM anon/);
    assert.match(migrationSql, /REVOKE ALL ON TABLE public\.journey_retention_health FROM authenticated/);
  });

  it("serializes health transitions with a cycle token and guarded finalizer", () => {
    assert.match(migrationSql, /CREATE OR REPLACE FUNCTION public\.begin_journey_retention_cycle_v1/);
    assert.match(migrationSql, /CREATE OR REPLACE FUNCTION public\.finish_journey_retention_cycle_v1/);
    assert.match(migrationSql, /cycle_token\s+uuid/);
    assert.match(migrationSql, /health\.cycle_token = p_cycle_token/);
    assert.match(migrationSql, /health\.cycle_lease_expires_at > p_now/);
  });

  it("health table status CHECK includes HEALTHY, DEGRADED, FAILED, STALE", () => {
    assert.match(migrationSql, /'HEALTHY'.*'DEGRADED'.*'FAILED'.*'STALE'/s);
  });

  it("health table is seeded with STALE as the initial value", () => {
    assert.match(
      migrationSql,
      /INSERT INTO public\.journey_retention_health.*'STALE'/s,
    );
  });

  it("ingest RPC enforces 24h TTL (expires_at = received_at + 24 hours)", () => {
    assert.match(migrationSql, /received_at \+ interval '24 hours'/);
  });

  it("ingest RPC denies writes when last_success_at is older than 10 minutes (stale authorization)", () => {
    assert.match(migrationSql, /v_received_at - interval '10 minutes'/);
  });

  it("feature flags inserted with DEFAULT false (default-off)", () => {
    // 2119 seeded the flags; 2124 reuses them — 2124 does not override to true
    // but the combined contract is: flags are default-off in 2119 and 2124 does not enable them.
    // Verify 2124 does not INSERT enabled=true for either Journey flag.
    const journeyFlagInserts = migrationSql.match(
      /INSERT INTO public\.feature_flags[\s\S]*?ON CONFLICT/g,
    ) ?? [];
    // If any insertion exists for JOURNEY flags it must not be enabled=true
    for (const block of journeyFlagInserts) {
      if (
        block.includes("COMPASS_JOURNEY_ENGINE_ENABLED") ||
        block.includes("COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED")
      ) {
        assert.doesNotMatch(block, /,\s*true\s*,/, "Journey flags must not be enabled by 2124");
      }
    }
  });

  it("journey_revocation_jobs has service-only RLS/grants", () => {
    assert.match(migrationSql, /ALTER TABLE public\.journey_revocation_jobs ENABLE ROW LEVEL SECURITY/);
    assert.match(migrationSql, /GRANT SELECT, DELETE ON TABLE public\.journey_revocation_jobs TO service_role/);
    assert.match(migrationSql, /REVOKE INSERT, UPDATE ON TABLE public\.journey_revocation_jobs FROM service_role/);
    assert.match(migrationSql, /REVOKE ALL ON TABLE public\.journey_revocation_jobs FROM anon/);
    assert.match(migrationSql, /REVOKE ALL ON TABLE public\.journey_revocation_jobs FROM authenticated/);
  });

  it("ingest RPC is service-only — no public/anon/authenticated grant", () => {
    assert.match(
      migrationSql,
      /GRANT EXECUTE ON FUNCTION public\.ingest_journey_observation_v1[\s\S]*?TO service_role/,
    );
    assert.match(
      migrationSql,
      /REVOKE ALL ON FUNCTION public\.ingest_journey_observation_v1[\s\S]*?FROM anon/,
    );
    assert.match(
      migrationSql,
      /REVOKE ALL ON FUNCTION public\.ingest_journey_observation_v1[\s\S]*?FROM authenticated/,
    );
  });

  it("revokes the Task 2119 direct INSERT grant so the ingest RPC is the only writer", () => {
    assert.match(
      migrationSql,
      /REVOKE INSERT ON TABLE public\.journey_observations FROM service_role/,
    );
  });

  it("no product consumer tables are created (no segment/graph/social/notification tables)", () => {
    // The migration must not CREATE any consumer-facing table
    const createTableBlocks = migrationSql.match(/CREATE TABLE[\s\S]*?;/g) ?? [];
    const consumerKeywords = ["segment", "graph", "social", "notification", "recommendation", "feed"];
    for (const block of createTableBlocks) {
      for (const kw of consumerKeywords) {
        assert.doesNotMatch(
          block,
          new RegExp(kw, "i"),
          `migration must not create a ${kw} consumer table`,
        );
      }
    }
  });

  it("references the rollback script path in a comment", () => {
    assert.match(
      migrationSql,
      /rollback_2120_journey_privacy_foundation/,
      "migration must reference its rollback path",
    );
  });

  it("is wrapped in BEGIN…COMMIT (transactional DDL)", () => {
    assert.match(migrationSql, /^\s*BEGIN\s*;/m);
    assert.match(migrationSql, /^\s*COMMIT\s*;/m);
  });
});

// ─── (6) Rollback source is fail-closed containment ──────────────────────────

describe("(6) rollback source — fail-closed containment", () => {
  it("rollback reference in migration comment identifies a separate file (not inline DDL)", () => {
    // The migration must NOT contain the rollback DDL inline — it should only
    // reference the separate file. Specifically, it must not DROP the durable
    // evidence tables (journey_revocation_jobs, journey_retention_health).
    assert.doesNotMatch(
      migrationSql,
      /DROP TABLE[\s\S]*?journey_revocation_jobs/i,
      "forward migration must not drop journey_revocation_jobs",
    );
    assert.doesNotMatch(
      migrationSql,
      /DROP TABLE[\s\S]*?journey_retention_health/i,
      "forward migration must not drop journey_retention_health",
    );
  });

  it("rollback file (if present) does not DROP journey_revocation_jobs durable evidence table", () => {
    if (!rollbackSql) return; // file not present — skip body checks
    // Fail-closed: the rollback must preserve durable evidence (revocation job log).
    // It may truncate or make inaccessible but must NOT silently drop the jobs table.
    assert.doesNotMatch(
      rollbackSql,
      /DROP TABLE[\s\S]*?journey_revocation_jobs\s*;/i,
      "rollback must not silently drop the durable revocation job queue",
    );
  });

  it("rollback file (if present) does not DROP journey_retention_health monitoring table", () => {
    if (!rollbackSql) return;
    assert.doesNotMatch(
      rollbackSql,
      /DROP TABLE[\s\S]*?journey_retention_health\s*;/i,
      "rollback must not silently drop the durable monitoring table",
    );
  });

  it("migration comment confirms rollback is intentionally separate", () => {
    // The comment pattern from 2119/2124 is: "Rollback is intentionally separate"
    assert.match(
      migrationSql,
      /[Rr]ollback is intentionally separate/,
      "migration must state rollback is intentionally separate",
    );
  });

  it("RAW_TTL_MS is exactly 24 hours (86400000 ms)", () => {
    assert.equal(JOURNEY_RAW_TTL_MS, 24 * 60 * 60 * 1000, "JOURNEY_RAW_TTL_MS must be 24h");
  });

  it("JOURNEY_PURGE_INTERVAL_MS is exactly 5 minutes (300000 ms)", () => {
    assert.equal(
      JOURNEY_PURGE_INTERVAL_MS,
      5 * 60 * 1000,
      "JOURNEY_PURGE_INTERVAL_MS must be 5 minutes",
    );
  });
});

// ─── (7) 2127 migration source assertions — controlled rollout ────────────────

describe("(7) 2127 migration source — controlled rollout", () => {
  // ── 7a. Central authorization authority ──

  it("defines journey_shadow_authorize_v1 as the central authorization authority", () => {
    assert.match(
      migration2127Sql,
      /CREATE OR REPLACE FUNCTION public\.journey_shadow_authorize_v1/,
    );
  });

  it("central authority locks and re-reads all three capability flags + global stop", () => {
    // All four flags are re-read FOR SHARE inside journey_shadow_authorize_v1
    assert.match(migration2127Sql, /COMPASS_JOURNEY_ENGINE_ENABLED[\s\S]*?FOR SHARE/);
    assert.match(migration2127Sql, /COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED[\s\S]*?FOR SHARE/);
    assert.match(migration2127Sql, /COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED[\s\S]*?FOR SHARE/);
    assert.match(migration2127Sql, /disable_location_sharing[\s\S]*?FOR SHARE/);
  });

  it("ingest_journey_observation_v2 calls central authority for ingest operation", () => {
    // v2 must delegate to journey_shadow_authorize_v1 for ingest
    assert.match(
      migration2127Sql,
      /CREATE OR REPLACE FUNCTION public\.ingest_journey_observation_v2/,
    );
    assert.match(
      migration2127Sql,
      /journey_shadow_authorize_v1[\s\S]*?'ingest'/,
    );
  });

  it("append_journey_segment_revisions_v2 calls central authority for derived_write operation", () => {
    assert.match(
      migration2127Sql,
      /CREATE OR REPLACE FUNCTION public\.append_journey_segment_revisions_v2/,
    );
    assert.match(
      migration2127Sql,
      /journey_shadow_authorize_v1[\s\S]*?'derived_write'/,
    );
  });

  // ── 7b. Old execute revoked ──

  it("revokes EXECUTE on ingest_journey_observation_v1 from service_role (v2 is the only writer)", () => {
    assert.match(
      migration2127Sql,
      /REVOKE EXECUTE ON FUNCTION public\.ingest_journey_observation_v1[\s\S]*?FROM service_role/,
    );
  });

  it("revokes EXECUTE on old append_journey_segment_revisions (v1) from service_role", () => {
    assert.match(
      migration2127Sql,
      /REVOKE EXECUTE ON FUNCTION public\.append_journey_segment_revisions\(jsonb\)[\s\S]*?FROM service_role/,
    );
  });

  it("re-asserts that direct INSERT on journey_observations is revoked from service_role", () => {
    assert.match(
      migration2127Sql,
      /REVOKE INSERT ON TABLE public\.journey_observations FROM service_role/,
    );
  });

  // ── 7c. Admin role SQL check ──

  it("_journey_shadow_require_admin_actor checks profiles.role = 'admin'", () => {
    assert.match(
      migration2127Sql,
      /CREATE OR REPLACE FUNCTION public\._journey_shadow_require_admin_actor/,
    );
    assert.match(
      migration2127Sql,
      /role = 'admin'/,
    );
  });

  it("_journey_shadow_require_admin_actor fails closed on missing row or wrong role", () => {
    // The check: NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_actor AND role = 'admin')
    assert.match(
      migration2127Sql,
      /NOT EXISTS[\s\S]*?FROM public\.profiles[\s\S]*?AND role = 'admin'/,
    );
  });

  it("_journey_shadow_require_admin_actor is revoked from all roles including service_role", () => {
    assert.match(
      migration2127Sql,
      /REVOKE ALL ON FUNCTION public\._journey_shadow_require_admin_actor\(uuid\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/,
    );
  });

  // ── 7d. Time-limited stage/cohort/issuance ──

  it("stage window is time-limited to at most 30 days", () => {
    assert.match(
      migration2127Sql,
      /ends_at <= starts_at \+ interval '30 days'/,
    );
  });

  it("configure_journey_shadow_stage_v1 rejects stages longer than 30 days", () => {
    assert.match(
      migration2127Sql,
      /stage duration must not exceed 30 days/,
    );
  });

  it("approved_at for stage configuration must be within 5 minutes of server clock", () => {
    assert.match(
      migration2127Sql,
      /approved_at must be within 5 minutes of server time/,
    );
  });

  it("cohort window must fit within stage window", () => {
    assert.match(
      migration2127Sql,
      /cohort window must be within stage window/,
    );
  });

  it("session issuance is limited to at most 24 hours", () => {
    assert.match(
      migration2127Sql,
      /session.*expires_at <= issued_at \+ interval '24 hours'/s,
    );
  });

  it("session expires_at must not exceed cohort or stage end", () => {
    assert.match(
      migration2127Sql,
      /session expires_at must not exceed cohort end/,
    );
    assert.match(
      migration2127Sql,
      /session expires_at must not exceed stage end/,
    );
  });

  // ── 7e. Flags default off ──

  it("COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED is inserted with enabled=false", () => {
    const insertBlocks = migration2127Sql.match(
      /INSERT INTO public\.feature_flags[\s\S]*?ON CONFLICT[\s\S]*?DO NOTHING/g,
    ) ?? [];
    const shadowInserts = insertBlocks.filter((b) =>
      b.includes("COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED"),
    );
    assert.ok(shadowInserts.length >= 1, "shadow flag must be seeded in 2127");
    for (const block of shadowInserts) {
      assert.doesNotMatch(
        block,
        /,\s*true\s*[,)]/,
        "COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED must default to false in 2127",
      );
    }
  });

  it("no Journey flag is enabled by 2127 (all remain default-off)", () => {
    const insertBlocks = migration2127Sql.match(
      /INSERT INTO public\.feature_flags[\s\S]*?ON CONFLICT[\s\S]*?DO NOTHING/g,
    ) ?? [];
    for (const block of insertBlocks) {
      if (
        block.includes("COMPASS_JOURNEY_ENGINE_ENABLED") ||
        block.includes("COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED") ||
        block.includes("COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED")
      ) {
        assert.doesNotMatch(
          block,
          /,\s*true\s*[,)]/,
          "No Journey flag must be enabled by 2127",
        );
      }
    }
  });

  // ── 7f. Unified health v2 (finish_journey_retention_cycle_v2) ──

  it("defines finish_journey_retention_cycle_v2 with per-table deleted counts", () => {
    assert.match(
      migration2127Sql,
      /CREATE OR REPLACE FUNCTION public\.finish_journey_retention_cycle_v2/,
    );
    // Must have observation, segment, and ground-truth count parameters
    assert.match(migration2127Sql, /p_observation_deleted_count/);
    assert.match(migration2127Sql, /p_segment_deleted_count/);
    assert.match(migration2127Sql, /p_ground_truth_deleted_count/);
  });

  // ── 7g. Atomic revocation erasure ──

  it("revoke_journey_shadow_cohort_v1 atomically revokes assignment, issuances, ends sessions, deletes observations and segments", () => {
    assert.match(
      migration2127Sql,
      /CREATE OR REPLACE FUNCTION public\.revoke_journey_shadow_cohort_v1/,
    );
    // Revokes assignment
    assert.match(
      migration2127Sql,
      /UPDATE public\.journey_shadow_cohort_assignments[\s\S]*?SET revoked_at[\s\S]*?revoke_journey_shadow_cohort_v1/s,
    );
    // Revokes issuances
    assert.match(
      migration2127Sql,
      /UPDATE public\.journey_shadow_session_issuances[\s\S]*?SET revoked_at[\s\S]*?revoke_journey_shadow_cohort_v1/s,
    );
    // Deletes observations
    assert.match(
      migration2127Sql,
      /DELETE FROM public\.journey_observations[\s\S]*?WHERE user_id = v_assignment\.user_id/,
    );
    // Deletes segments
    assert.match(
      migration2127Sql,
      /DELETE FROM public\.journey_segment_revisions[\s\S]*?WHERE user_id = v_assignment\.user_id/,
    );
  });

  it("consent revocation trigger atomically revokes shadow assignments and issuances", () => {
    // purge_journey_observations_on_consent_revocation must also revoke cohort assignments
    assert.match(
      migration2127Sql,
      /UPDATE public\.journey_shadow_cohort_assignments[\s\S]*?SET revoked_at[\s\S]*?WHERE user_id = v_user_id/,
    );
    assert.match(
      migration2127Sql,
      /UPDATE public\.journey_shadow_session_issuances[\s\S]*?SET revoked_at[\s\S]*?WHERE user_id = v_user_id/,
    );
  });

  it("revoked_by = v_user_id (owner UUID) for owner/trigger revocation — not admin actor", () => {
    // The trigger sets revoked_by = v_user_id, not a separate admin actor
    assert.match(
      migration2127Sql,
      /revoked_by = v_user_id/,
    );
  });

  it("account-deletion path sets revoked_by = NULL (no meaningful actor UUID)", () => {
    assert.match(
      migration2127Sql,
      /revoked_by = NULL/,
    );
  });

  it("advisory lock serialises revocation with append (journey-segments key)", () => {
    assert.match(
      migration2127Sql,
      /pg_advisory_xact_lock[\s\S]*?journey-segments:/,
    );
  });

  // ── 7h. FORCE RLS on all rollout tables ──

  it("journey_shadow_stages has FORCE ROW LEVEL SECURITY", () => {
    assert.match(
      migration2127Sql,
      /ALTER TABLE public\.journey_shadow_stages FORCE ROW LEVEL SECURITY/,
    );
  });

  it("journey_shadow_cohort_assignments has FORCE ROW LEVEL SECURITY", () => {
    assert.match(
      migration2127Sql,
      /ALTER TABLE public\.journey_shadow_cohort_assignments FORCE ROW LEVEL SECURITY/,
    );
  });

  it("journey_shadow_session_issuances has FORCE ROW LEVEL SECURITY", () => {
    assert.match(
      migration2127Sql,
      /ALTER TABLE public\.journey_shadow_session_issuances FORCE ROW LEVEL SECURITY/,
    );
  });

  it("journey_shadow_ground_truth has FORCE ROW LEVEL SECURITY", () => {
    assert.match(
      migration2127Sql,
      /ALTER TABLE public\.journey_shadow_ground_truth FORCE ROW LEVEL SECURITY/,
    );
  });

  it("journey_shadow_qa_reports has FORCE ROW LEVEL SECURITY", () => {
    assert.match(
      migration2127Sql,
      /ALTER TABLE public\.journey_shadow_qa_reports FORCE ROW LEVEL SECURITY/,
    );
  });

  // ── 7i. No user access — all rollout tables revoke from anon/authenticated ──

  it("journey_shadow_stages revokes all from anon and authenticated", () => {
    assert.match(
      migration2127Sql,
      /REVOKE ALL ON TABLE public\.journey_shadow_stages FROM PUBLIC, anon, authenticated/,
    );
  });

  it("journey_shadow_cohort_assignments revokes all from anon and authenticated", () => {
    assert.match(
      migration2127Sql,
      /REVOKE ALL ON TABLE public\.journey_shadow_cohort_assignments FROM PUBLIC, anon, authenticated/,
    );
  });

  it("journey_shadow_session_issuances revokes all from anon and authenticated", () => {
    assert.match(
      migration2127Sql,
      /REVOKE ALL ON TABLE public\.journey_shadow_session_issuances FROM PUBLIC, anon, authenticated/,
    );
  });

  it("journey_shadow_ground_truth revokes all from anon and authenticated", () => {
    assert.match(
      migration2127Sql,
      /REVOKE ALL ON TABLE public\.journey_shadow_ground_truth FROM PUBLIC, anon, authenticated/,
    );
  });

  it("journey_shadow_qa_reports revokes all from anon and authenticated", () => {
    assert.match(
      migration2127Sql,
      /REVOKE ALL ON TABLE public\.journey_shadow_qa_reports FROM PUBLIC, anon, authenticated/,
    );
  });

  it("service_role is granted only SELECT (not INSERT/UPDATE/DELETE) on rollout tables", () => {
    // For each shadow table, service_role must get SELECT but not write DML
    const shadowTables = [
      "journey_shadow_stages",
      "journey_shadow_cohort_assignments",
      "journey_shadow_session_issuances",
      "journey_shadow_ground_truth",
      "journey_shadow_qa_reports",
    ];
    for (const table of shadowTables) {
      assert.match(
        migration2127Sql,
        new RegExp(`GRANT SELECT ON TABLE public\\.${table} TO service_role`),
        `${table} must grant only SELECT to service_role`,
      );
      assert.match(
        migration2127Sql,
        new RegExp(`REVOKE INSERT, UPDATE, DELETE ON TABLE public\\.${table} FROM service_role`),
        `${table} must revoke INSERT/UPDATE/DELETE from service_role`,
      );
    }
  });

  // ── 7j. ingest_journey_observation_v2 quality constraints ──

  it("ingest_journey_observation_v2 rejects missing quality fields (all four mandatory)", () => {
    assert.match(
      migration2127Sql,
      /p_quality_version IS NULL OR p_quality_score IS NULL[\s\S]*?OR p_quality_class IS NULL OR p_quality_reasons IS NULL/,
    );
  });

  it("ingest_journey_observation_v2 requires quality_version = 'journey-observation-quality-v1'", () => {
    assert.match(
      migration2127Sql,
      /p_quality_version <> 'journey-observation-quality-v1'/,
    );
  });

  it("ingest_journey_observation_v2 rejects quality_score outside [0,1]", () => {
    assert.match(
      migration2127Sql,
      /p_quality_score < 0 OR p_quality_score > 1/,
    );
  });

  it("ingest_journey_observation_v2 accepts unusable class and rejects only unknown classes", () => {
    // high, usable, degraded, unusable are all accepted — unusable is persisted for
    // QA/report distribution measurement; only truly unknown classes are rejected.
    // Segmentation excludes unusable at read time via .neq("quality_class", "unusable").
    assert.match(
      migration2127Sql,
      /p_quality_class NOT IN \('high', 'usable', 'degraded', 'unusable'\)/,
    );
  });

  // ── 7k. ground_truth expires_at bounded to 30 days ──

  it("journey_shadow_ground_truth expires_at is bounded to 30 days from submitted_at", () => {
    assert.match(
      migration2127Sql,
      /expires_at <= submitted_at \+ interval '30 days'/,
    );
  });

  it("record_journey_shadow_ground_truth_v1 sets expires_at = submitted_at + 30 days", () => {
    assert.match(
      migration2127Sql,
      /v_now \+ interval '30 days'/,
    );
  });

  // ── 7l. Preconditions + transactional DDL ──

  it("is wrapped in BEGIN…COMMIT (transactional DDL)", () => {
    assert.match(migration2127Sql, /^\s*BEGIN\s*;/m);
    assert.match(migration2127Sql, /^\s*COMMIT\s*;/m);
  });

  it("checks for profiles.role column in preconditions (admin gate cannot be enforced without it)", () => {
    assert.match(
      migration2127Sql,
      /profiles\.role missing; admin gate cannot be enforced in SQL/,
    );
  });

  it("precondition verifies all three Journey capability flags exist before proceeding", () => {
    assert.match(
      migration2127Sql,
      /all three Journey capability flags must exist/,
    );
  });
});
