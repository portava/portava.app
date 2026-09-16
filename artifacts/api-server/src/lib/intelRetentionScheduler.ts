/**
 * Intel retention sweep — deletes intel_state_snapshots past expires_at.
 *
 * Ships with the tables it sweeps, deliberately. location_snapshots carried
 * expires_at for months with no cleanup job: the only purge function had a single
 * reference in the whole repository, its own definition. Readers filtered on
 * expiry so the feature looked correct while rows accumulated forever. 2130 gives
 * the intel tables the same shape, so the sweeper lands in the same band.
 *
 * Only DERIVED state is swept. Snapshots are recomputable from claims and an
 * expired one is already invisible (liveClaimRead filters it in the query), so
 * this is hygiene, not data loss. intel_observations is contributor content and
 * its retention window is an owner policy decision — see 2133's header.
 *
 * Flag-gated and fail-closed, following accountDeletionScheduler: DELETE is
 * irreversible, so starting this in index.ts is safe before the flag is on.
 */
import { getServiceClient } from "./supabase.js";
import { logger } from "./logger.js";
import { isFlagEnabled } from "./featureFlags.js";
import { INTEL_IDENTIFIABLE_RETENTION_SECONDS } from "./locationPurposes.js";

const STARTUP_DELAY_MS = 7 * 60 * 1000;
const INTERVAL_MS = 60 * 60 * 1000;

let _timer: ReturnType<typeof setTimeout> | null = null;

export interface SweepResult {
  purged: number;
  skipped: boolean;
  /**
   * WHY this run did nothing. An error and a disabled flag both used to return
   * `{purged:0, skipped:true}`, which made a persistently failing sweep
   * indistinguishable from one nobody had switched on — the same shape as the
   * original defect (a documented expiry that nothing enforced).
   */
  reason: "disabled" | "no_client" | "error" | null;
}

export async function runIntelRetentionSweep(opts: { client?: any } = {}): Promise<SweepResult> {
  // Explicit null means "no client"; undefined means "use the service client if
  // available" — the house pattern (dailyBriefCleanup, inviteSlotSweeper).
  //
  // This was `opts.client ?? getServiceClient()`, and `??` does NOT short-circuit
  // on an explicit null: `null ?? f()` calls f(). CI runs the suite with the
  // Supabase URL env var pointed at a closed port (127.0.0.1:9), so a test
  // passing `client: null` got a REAL client, spent ~7s failing to connect, and
  // reported reason
  // "error" instead of "no_client". It passed locally only because a dev machine
  // has that variable unset, so getServiceClient() returned null there. A unit test
  // must not depend on the absence of an env var — or open a socket at all.
  const db =
    "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return { purged: 0, skipped: true, reason: "no_client" };
  if (!(await isFlagEnabled(db, "intel_retention_sweep_enabled"))) {
    return { purged: 0, skipped: true, reason: "disabled" };
  }

  try {
    const { data, error } = await db.rpc("purge_expired_intel_snapshots");
    if (error) {
      logger.warn({ err: error }, "intel retention sweep failed");
      return { purged: 0, skipped: true, reason: "error" };
    }
    // The function returns bigint, which can arrive as a STRING over PostgREST
    // (int8 exceeds JS safe-integer range, so it is not always emitted as a JSON
    // number). A `typeof data === "number"` guard silently reported 0 for every
    // successful purge. Coerce instead.
    const purged = Number(data) || 0;
    if (purged > 0) logger.info({ purged }, "intel retention sweep removed expired snapshots");
    return { purged, skipped: false, reason: null };
  } catch (err) {
    logger.warn({ err }, "intel retention sweep threw");
    return { purged: 0, skipped: true, reason: "error" };
  }
}

export interface ContributionSweepResult {
  evidence: number;
  confirmations: number;
  observations: number;
  skipped: boolean;
  reason: "disabled" | "no_client" | "error" | null;
}

export interface PresenceCleanupResult {
  markedStale: number;
  deleted: number;
  skipped: boolean;
  reason: "disabled" | "no_client" | "error" | null;
}

export async function runSensingCredentialCleanup(opts: { client?: any; now?: Date } = {}) {
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return { deleted: 0, skipped: true, reason: "no_client" as const };
  const now = (opts.now ?? new Date()).toISOString();
  try {
    const found = await db.from("intel_sensing_credentials").select("id").lt("expires_at", now).limit(1000);
    if (found.error) return { deleted: 0, skipped: true, reason: "error" as const };
    const ids = (found.data ?? []).map((row: any) => row.id).filter(Boolean);
    if (!ids.length) return { deleted: 0, skipped: false, reason: null };
    const deleted = await db.from("intel_sensing_credentials").delete().in("id", ids);
    if (deleted.error) return { deleted: 0, skipped: true, reason: "error" as const };
    return { deleted: ids.length, skipped: false, reason: null };
  } catch {
    return { deleted: 0, skipped: true, reason: "error" as const };
  }
}

/** Operational owner for the presence_in_context retention bound. */
export async function runPresenceCleanup(opts: { client?: any; now?: Date } = {}): Promise<PresenceCleanupResult> {
  const empty = { markedStale: 0, deleted: 0 };
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return { ...empty, skipped: true, reason: "no_client" };
  if (!(await isFlagEnabled(db, "presence_cleanup_enabled"))) {
    return { ...empty, skipped: true, reason: "disabled" };
  }
  const now = opts.now ?? new Date();
  try {
    const rows: any[] = [];
    let cursor: string | null = null;
    for (;;) {
      let query = db.from("circle_presence")
        .select("id,last_seen_at,stale_after_secs,expires_at")
        .order("id", { ascending: true })
        .limit(1000);
      // Keyset continuation is applied by the database query builder where
      // supported; keeping the cursor explicit avoids a permanent first-page
      // starvation loop as rows are updated/deleted.
      if (cursor) query = query.gt("id", cursor);
      const result = await query;
      if (result.error) return { ...empty, skipped: true, reason: "error" };
      rows.push(...(result.data ?? []));
      if ((result.data ?? []).length < 1000) break;
      cursor = (result.data ?? []).at(-1)?.id ?? null;
      if (!cursor) break;
    }
    const stale: string[] = [];
    const expired: string[] = [];
    for (const row of (rows ?? []) as any[]) {
      const last = new Date(row.last_seen_at).getTime();
      if (Number.isFinite(last) && last + Number(row.stale_after_secs) * 1000 < now.getTime()) stale.push(row.id);
      const expiry = row.expires_at ? new Date(row.expires_at).getTime() : NaN;
      if (Number.isFinite(expiry) && expiry < now.getTime()) expired.push(row.id);
    }
    if (stale.length) {
      const { error } = await db.from("circle_presence").update({ is_stale: true }).in("id", stale);
      if (error) return { ...empty, skipped: true, reason: "error" };
    }
    if (expired.length) {
      const { error } = await db.from("circle_presence").delete().in("id", expired);
      if (error) return { ...empty, skipped: true, reason: "error" };
    }
    return { markedStale: stale.length, deleted: expired.length, skipped: false, reason: null };
  } catch {
    return { ...empty, skipped: true, reason: "error" };
  }
}

/**
 * Enforces the ruled 180-day identifiable retention for the intel_claim purpose by
 * DELETING actor-linked contributions older than the cutoff (now - 180 days) via
 * purge_intel_contributions_older_than(). Separate flag from the snapshot sweep
 * (intel_contribution_retention_enabled) because this is IRREVERSIBLE deletion of
 * contributor data, not recomputable hygiene. Fail-closed; idempotent (re-running
 * over the same cutoff deletes nothing new).
 */
export async function runIntelContributionRetentionSweep(
  opts: { client?: any; now?: Date } = {},
): Promise<ContributionSweepResult> {
  const empty = { evidence: 0, confirmations: 0, observations: 0 };
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return { ...empty, skipped: true, reason: "no_client" };
  if (!(await isFlagEnabled(db, "intel_contribution_retention_enabled"))) {
    return { ...empty, skipped: true, reason: "disabled" };
  }
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - INTEL_IDENTIFIABLE_RETENTION_SECONDS * 1000).toISOString();
  try {
    const { data, error } = await db.rpc("purge_intel_contributions_older_than", { p_cutoff: cutoff });
    if (error) {
      logger.warn({ err: error }, "intel contribution retention sweep failed");
      return { ...empty, skipped: true, reason: "error" };
    }
    const rows: any[] = Array.isArray(data) ? data : [];
    const byTable = (t: string) => Number(rows.find((r) => r?.table_name === t)?.deleted_count) || 0;
    const result = {
      evidence: byTable("intel_evidence"),
      confirmations: byTable("intel_confirmations"),
      observations: byTable("intel_observations"),
    };
    if (result.evidence + result.confirmations + result.observations > 0) {
      logger.info({ ...result }, "intel contribution retention removed aged contributions");
    }
    return { ...result, skipped: false, reason: null };
  } catch (err) {
    logger.warn({ err }, "intel contribution retention sweep threw");
    return { ...empty, skipped: true, reason: "error" };
  }
}

export function startIntelRetentionScheduler(): void {
  if (_timer !== null) return;
  logger.info(
    {
      startupDelayMs: STARTUP_DELAY_MS,
      intervalMs: INTERVAL_MS,
      flags: ["intel_retention_sweep_enabled", "intel_contribution_retention_enabled"],
    },
    "IntelRetentionScheduler scheduled (no-op until the flags are enabled)",
  );
  _timer = setTimeout(function tick() {
    // Snapshot hygiene and contribution retention run each pass, each behind its
    // own flag. allSettled so one failing never blocks the other or the reschedule.
    void Promise.allSettled([runIntelRetentionSweep(), runIntelContributionRetentionSweep(), runPresenceCleanup(), runSensingCredentialCleanup()])
      .finally(() => { _timer = setTimeout(tick, INTERVAL_MS); });
  }, STARTUP_DELAY_MS);
}

export function stopIntelRetentionScheduler(): void {
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}
