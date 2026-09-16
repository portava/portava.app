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

/** A positive finite env float, else the default (house pattern: eventWaitlistSweeper). */
function parseEnvFloat(raw: string | undefined, def: number): number {
  const v = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(v) && v > 0 ? v : def;
}

/**
 * Expiry-sweep cadence. Spec §21 ("Scheduled jobs"): the expiry sweep runs every
 * minute, so the default is 60 seconds — not the hour this used to hard-code.
 * Configurable via INTEL_RETENTION_SWEEP_INTERVAL_SECONDS (a positive number of
 * seconds; anything unset, non-numeric or ≤0 falls back to the 60 s default).
 * Both sweeps on this timer are flag-gated OFF and idempotent, so tightening the
 * cadence is inert until an owner enables a flag.
 */
export const INTEL_RETENTION_SWEEP_INTERVAL_SECONDS = parseEnvFloat(
  process.env["INTEL_RETENTION_SWEEP_INTERVAL_SECONDS"],
  60,
);
export const INTERVAL_MS = INTEL_RETENTION_SWEEP_INTERVAL_SECONDS * 1000;

/**
 * PostgREST encodes `.in()` into the query string, so a batch is bounded by URL
 * length rather than by row count. 200 ids is comfortably inside every proxy
 * default this deploys behind.
 */
const ID_BATCH = 200;
const PRESENCE_PAGE = 1000;
/** One pass reads at most 20 pages; the remainder waits for the next minute. */
const MAX_PRESENCE_PAGES = 20;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

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

/**
 * Enforces Map telemetry's declared expiry (migration 2202 gives
 * map_telemetry_events and map_telemetry_drops an `expires_at` and nothing has
 * ever deleted a row past it — the location_snapshots defect in this module's
 * own header, repeated).
 *
 * COLLECTION AND RETENTION HAVE SEPARATE FLAGS ON PURPOSE. Turning telemetry
 * collection off is the reaction to a privacy concern, and if that also switched
 * the purge off it would strand exactly the rows someone just decided they did
 * not want kept. `map_telemetry_retention_enabled` is therefore independent of
 * every collection flag.
 *
 * ── THIS PASS IS REGISTERED AND CANNOT YET DO ANYTHING. SAID PLAINLY. ────────
 * It is on RETENTION_PASSES and runs on every tick, but as of this port THREE
 * of its preconditions are missing and it therefore no-ops on both live
 * databases:
 *
 *   1. `map_telemetry_retention_enabled` is seeded by NO migration in
 *      src/migrations, so isFlagEnabled resolves it false and un-flippable.
 *      check:flag-polarity reports it as a PHANTOM FLAG, correctly.
 *   2. `purge_expired_map_telemetry()` does not exist in either database.
 *   3. map_telemetry_events and map_telemetry_drops do not exist in PRODUCTION
 *      at all — migration 2202 is unapplied there. Verified against the
 *      2026-09-16 full production capture (lib/capability/snapshots): 460
 *      tables, the only `map*` one is map_pins, and there is no
 *      map_telemetry_enabled flag row either.
 *
 * All three are fixed by ONE migration, which this port could not write because
 * migration numbering is owned elsewhere. Until it lands, the correct reading of
 * this function is "wired, inert" — not "enforcing a 90-day policy".
 */
export async function runMapTelemetryRetentionSweep(
  opts: { client?: any } = {},
): Promise<SweepResult> {
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return { purged: 0, skipped: true, reason: "no_client" };
  if (!(await isFlagEnabled(db, "map_telemetry_retention_enabled"))) {
    return { purged: 0, skipped: true, reason: "disabled" };
  }
  try {
    const { data, error } = await db.rpc("purge_expired_map_telemetry");
    if (error) {
      logger.warn({ err: error }, "map telemetry retention sweep failed");
      return { purged: 0, skipped: true, reason: "error" };
    }
    // int8 comes back from PostgREST as a STRING; `typeof data === "number"`
    // reported 0 for every successful purge in the shape this replaced.
    const purged = Number(data) || 0;
    if (purged > 0) logger.info({ purged }, "map telemetry retention removed expired rows");
    return { purged, skipped: false, reason: null };
  } catch (err) {
    logger.warn({ err }, "map telemetry retention sweep threw");
    return { purged: 0, skipped: true, reason: "error" };
  }
}

export interface SensingCredentialCleanupResult {
  deleted: number;
  skipped: boolean;
  reason: "no_client" | "error" | null;
}

/**
 * Erases intel_sensing_credentials rows past `expires_at` (migration 2956).
 *
 * NO FEATURE FLAG, for the reason lib/sensingRetentionScheduler sets out at
 * length: a flag protects rows a reader can still see, and these are not such
 * rows. `consume_intel_sensing_credential` requires `c.expires_at > p_now`, so an
 * expired credential cannot authorise anything — deleting it changes no answer
 * any caller could get, while keeping it leaves a device-linked digest in the
 * database forever. A flag here would only be a way to retain dead personal
 * data. Seeding a flag row is also an owner decision in this lane and 2956 seeds
 * none.
 */
export async function runSensingCredentialCleanup(
  opts: { client?: any; now?: Date } = {},
): Promise<SensingCredentialCleanupResult> {
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return { deleted: 0, skipped: true, reason: "no_client" };
  const now = (opts.now ?? new Date()).toISOString();
  try {
    // Bounded per pass. The cadence is a minute, so a backlog drains quickly and
    // an unbounded DELETE never holds a long lock.
    const found = await db.from("intel_sensing_credentials").select("id").lt("expires_at", now).limit(1000);
    // An absent relation (a database without 2956) is reported, not counted as a
    // successful erasure.
    if (found.error) {
      logger.warn({ err: found.error }, "sensing credential cleanup: read failed");
      return { deleted: 0, skipped: true, reason: "error" };
    }
    const ids = (found.data ?? []).map((row: any) => row?.id).filter(Boolean).map(String);
    if (!ids.length) return { deleted: 0, skipped: false, reason: null };
    let deleted = 0;
    for (const batch of chunk(ids, ID_BATCH)) {
      const { error } = await db.from("intel_sensing_credentials").delete().in("id", batch);
      if (error) {
        logger.warn({ err: error }, "sensing credential cleanup: delete failed");
        return { deleted: 0, skipped: true, reason: "error" };
      }
      deleted += batch.length;
    }
    if (deleted > 0) logger.info({ deleted }, "sensing credential cleanup removed expired credentials");
    return { deleted, skipped: false, reason: null };
  } catch (err) {
    logger.warn({ err }, "sensing credential cleanup threw");
    return { deleted: 0, skipped: true, reason: "error" };
  }
}

export interface PresenceCleanupResult {
  markedStale: number;
  deleted: number;
  skipped: boolean;
  reason: "disabled" | "no_client" | "error" | null;
}

/**
 * Operational owner for the circle_presence retention bound.
 *
 * circle_presence carries both `stale_after_secs`/`is_stale` and `expires_at`,
 * and nothing in this repository has ever enforced either: readers shape around
 * `is_stale` so the surface looks correct while rows outlive their session.
 *
 * GATED ON presence_cleanup_enabled, WHICH IS FALSE IN BOTH LIVE DATABASES.
 * Migration 2957 seeds it disabled "until scheduler rollout is verified" and that
 * default is deliberate — this pass DELETEs, so it stays inert until an owner
 * turns it on. Do not change the seeded default to make the sweep visible.
 */
export async function runPresenceCleanup(
  opts: { client?: any; now?: Date } = {},
): Promise<PresenceCleanupResult> {
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
    // Keyset pagination, capped. `stale_after_secs` is per-row so staleness
    // cannot be expressed as a server-side predicate; the cap keeps one pass
    // bounded in memory and time instead, and the next pass picks up the rest.
    for (let page = 0; page < MAX_PRESENCE_PAGES; page++) {
      let query = db.from("circle_presence")
        .select("id,last_seen_at,stale_after_secs,expires_at")
        .order("id", { ascending: true })
        .limit(PRESENCE_PAGE);
      if (cursor) query = query.gt("id", cursor);
      const result = await query;
      if (result.error) {
        logger.warn({ err: result.error }, "presence cleanup: read failed");
        return { ...empty, skipped: true, reason: "error" };
      }
      const page_rows = (result.data ?? []) as any[];
      rows.push(...page_rows);
      if (page_rows.length < PRESENCE_PAGE) break;
      // A full page whose last row has no usable id cannot be advanced past.
      // Stopping is the only safe move: continuing would re-request page one
      // forever, which is a hot loop rather than a sweep.
      cursor = page_rows.at(-1)?.id != null ? String(page_rows.at(-1).id) : null;
      if (!cursor) break;
    }
    const stale: string[] = [];
    const expired: string[] = [];
    for (const row of rows) {
      if (row?.id == null) continue;
      const id = String(row.id);
      const last = Date.parse(row.last_seen_at);
      const ttl = Number(row.stale_after_secs);
      if (Number.isFinite(last) && Number.isFinite(ttl) && last + ttl * 1000 < now.getTime()) stale.push(id);
      const expiry = row.expires_at ? Date.parse(row.expires_at) : NaN;
      if (Number.isFinite(expiry) && expiry < now.getTime()) expired.push(id);
    }
    // Chunked: PostgREST puts an .in() list in the QUERY STRING, so one request
    // carrying a full page of ids is an unsendable URL, not a slow one.
    let markedStale = 0;
    for (const batch of chunk(stale, ID_BATCH)) {
      const { error } = await db.from("circle_presence").update({ is_stale: true }).in("id", batch);
      if (error) {
        logger.warn({ err: error }, "presence cleanup: stale marking failed");
        return { ...empty, skipped: true, reason: "error" };
      }
      markedStale += batch.length;
    }
    let deleted = 0;
    for (const batch of chunk(expired, ID_BATCH)) {
      const { error } = await db.from("circle_presence").delete().in("id", batch);
      if (error) {
        logger.warn({ err: error }, "presence cleanup: delete failed");
        return { markedStale: 0, deleted: 0, skipped: true, reason: "error" };
      }
      deleted += batch.length;
    }
    if (markedStale + deleted > 0) {
      logger.info({ markedStale, deleted }, "presence cleanup enforced the session bound");
    }
    return { markedStale, deleted, skipped: false, reason: null };
  } catch (err) {
    logger.warn({ err }, "presence cleanup threw");
    return { ...empty, skipped: true, reason: "error" };
  }
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

/**
 * THE REGISTRATION TABLE, and why it is a value rather than a literal list
 * inside the timer body.
 *
 * The recurring failure in this band is not a sweep that computes the wrong
 * answer; it is a sweep that is written, exported, imported and never called —
 * "purge_expired_sensing_contributions had exactly one reference in the
 * repository, its own definition" (lib/sensingRetentionScheduler). There is no
 * pg_cron in src/migrations, so a pass reaches production ONLY by being on this
 * array and this array being on a timer that src/index.ts starts.
 *
 * Exporting it makes "is this registered?" a question a test can answer without
 * parsing a function body — see src/test/intelRetentionScheduler.test.ts.
 *
 * `flag` is documentation of the gate, not the gate itself: each pass re-reads
 * its own flag against the live client and fails closed. `null` means the pass
 * is deliberately ungated and the function's header says why.
 */
export interface RetentionPass {
  name: string;
  flag: string | null;
  run: (opts?: { client?: any; now?: Date }) => Promise<{ skipped: boolean; reason: string | null }>;
}

export const RETENTION_PASSES: readonly RetentionPass[] = [
  { name: "intel_retention_sweep", flag: "intel_retention_sweep_enabled", run: runIntelRetentionSweep },
  { name: "intel_contribution_retention", flag: "intel_contribution_retention_enabled", run: runIntelContributionRetentionSweep },
  { name: "map_telemetry_retention", flag: "map_telemetry_retention_enabled", run: runMapTelemetryRetentionSweep },
  { name: "presence_cleanup", flag: "presence_cleanup_enabled", run: runPresenceCleanup },
  { name: "sensing_credential_cleanup", flag: null, run: runSensingCredentialCleanup },
] as const;

export function startIntelRetentionScheduler(): void {
  if (_timer !== null) return;
  logger.info(
    {
      startupDelayMs: STARTUP_DELAY_MS,
      intervalMs: INTERVAL_MS,
      passes: RETENTION_PASSES.map((p) => p.name),
      flags: RETENTION_PASSES.map((p) => p.flag).filter(Boolean),
    },
    "IntelRetentionScheduler scheduled (each pass is a no-op until its flag is enabled)",
  );
  _timer = setTimeout(function tick() {
    // Every registered pass runs each tick, each behind its own flag. allSettled
    // so one failing never blocks another or the reschedule.
    void Promise.allSettled(RETENTION_PASSES.map((pass) => pass.run()))
      .finally(() => { _timer = setTimeout(tick, INTERVAL_MS); });
  }, STARTUP_DELAY_MS);
}

export function stopIntelRetentionScheduler(): void {
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}
