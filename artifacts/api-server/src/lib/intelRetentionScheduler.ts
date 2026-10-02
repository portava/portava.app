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
 * 2202's own header named this gap and left it open: "Rows carry `expires_at`
 * (default 90 days) so this cannot become indefinite behavioural history by
 * accident. The existing retention sweeps can adopt it; until one does, the
 * column is the record of intent, and the index makes the sweep cheap when it
 * lands." This is that adoption, and 2202 built map_telemetry_events_expiry_idx
 * and map_telemetry_drops_expiry_idx for exactly this DELETE.
 *
 * 2964 later widened the same function to a third table,
 * map_telemetry_disabled_discards — the hourly, viewer-less counter that
 * replaced the viewer-linked drop row the route used to write while collection
 * was off. Those rows name nobody, so they are not the behavioural history the
 * 90-day promise exists to bound; they age out anyway, because an operational
 * counter that grows forever stops being operational. Nothing changes here: the
 * caller still makes one RPC and still reports one combined count.
 *
 * COLLECTION AND RETENTION HAVE SEPARATE FLAGS ON PURPOSE. Turning telemetry
 * collection off is the reaction to a privacy concern, and if that also switched
 * the purge off it would strand exactly the rows someone just decided they did
 * not want kept. `map_telemetry_retention_enabled` is therefore independent of
 * every collection flag.
 *
 * ── WHAT THIS CALLS, AND WHO CREATES IT ─────────────────────────────────────
 * `purge_expired_map_telemetry()` and the `map_telemetry_retention_enabled` row
 * are created by 2960_map_telemetry_retention.sql, which is NOT this module's to
 * write — this function is the caller, that migration is the definition. Until
 * 2960 lands, isFlagEnabled resolves the unseeded flag false and every pass
 * returns `{skipped: true, reason: "disabled"}`; check:flag-polarity reports the
 * name as a PHANTOM FLAG for exactly that window, which is the check doing its
 * job rather than a defect to suppress.
 *
 * ── THE STORAGE THIS SWEEPS DOES NOW EXIST, AND DID NOT USED TO ──────────────
 * 2202 carried a schema_migration_ledger row with applied_by='backfill', which
 * asserts only that the FILENAME existed when 2254 ran — never that the file
 * ran. It had not. routes/mapTelemetry.ts:225 inserted into an absent table,
 * caught the failure, logged a warn and still returned 200 `accepted:0`, so
 * every production map telemetry event was silently discarded. 2202 and 2222
 * have since been applied to production and the object fingerprint matches CI.
 *
 * MEASURED against both live databases rather than inferred from the snapshot
 * files, which predate that apply:
 *
 *   production (ajrurzioarfkagpuxfnb) .. both tables present, `expires_at` on
 *                                        each, 0 rows, map_telemetry_enabled
 *                                        FALSE, purge function not yet created
 *   CI         (hwokxgbmezheskbzskfr) .. identical on every one of those
 *
 * ── WHY 2960 SHOULD SEED THIS FLAG **TRUE** ─────────────────────────────────
 * The usual house instinct — ship an irreversible DELETE switched off — is the
 * wrong polarity for a RETENTION control, and the numbers above are why. A
 * collection flag shipped off withholds a capability; a retention flag shipped
 * off declares a 90-day privacy promise and then does not keep it, which is
 * precisely the "off => data retained" hazard this flag's CLASSIFIED entry in
 * scripts/check-flag-polarity.mjs exists to name. There is also nothing to be
 * careful about yet: collection is FALSE and both tables hold 0 rows in both
 * environments, so an enabled purger deletes nothing today and is ALREADY
 * enforcing on the day collection is switched on — rather than becoming one
 * more thing someone has to remember to turn on afterwards.
 */
export async function runMapTelemetryRetentionSweep(
  opts: { client?: any } = {},
): Promise<SweepResult> {
  // Explicit null means "no client"; undefined means "use the service client".
  // NOT `opts.client ?? getServiceClient()` — see runIntelRetentionSweep's note
  // on why `??` opened a socket in CI.
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
    // bigint over PostgREST can arrive as a STRING — int8 exceeds JS safe-integer
    // range, so it is not always emitted as a JSON number. A
    // `typeof data === "number"` guard silently reported 0 for every successful
    // purge here once already; coerce instead.
    const purged = Number(data) || 0;
    // A count and nothing else. WHICH events expired is a fact about viewers.
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
 *
 * ── NOTHING WRITES THIS TABLE TODAY, AND THAT IS NOT A REASON TO DELETE THIS ──
 * Read this before concluding the sweep proves credential issuance is live. It
 * does not. The map/sensing lane raised exactly that objection during the port
 * and it was checked rather than argued: across the whole api-server tree the
 * ONLY non-test references to `intel_sensing_credentials` are this pass and
 * AccountDeletionService's erasure step — both DELETERS. There is no INSERT
 * anywhere, because the issuance route that would write one was rejected during
 * the port (it authorises against an actor id, which is precisely what
 * lib/sensingAuthPosture's "undecided" posture forbids). Production holds 0 rows.
 *
 * It is kept for the same reason 2960 seeds its retention flag TRUE: a retention
 * bound that is only wired on the day a writer lands is a bound somebody has to
 * remember, and that is the failure this whole module exists to stop. The cost
 * while there is no writer is one bounded SELECT per tick returning nothing.
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

/**
 * Sweep expired and revoked sensing contribution CREDENTIALS (2480's
 * `sensing_contribution_sessions`).
 *
 * Registered because `docs/architecture/sensing-auth-posture-decision.md` named
 * it as the one piece of Option B that had no code: *"the sweep needs
 * registering in index.ts beside sensingRetentionScheduler — code not yet
 * written, trivially the same shape."* It is that shape.
 *
 * NO FLAG, deliberately, and this is the one judgement in the file worth
 * stating. 2480's lifetime CHECK already makes a session unable to outlive 72
 * hours, so retention is structural and this sweep is hygiene on top of it —
 * exactly the relationship 2315 describes for contributions. A flag would let an
 * operator switch off the hygiene while believing the structural guarantee still
 * covered them, and the rows it removes are credentials nobody can use: expired
 * or revoked by definition. It is also the same posture as
 * `sensing_credential_cleanup`, the sibling pass directly below.
 *
 * The instant is passed IN rather than read inside the function, matching
 * `purge_expired_sensing_contributions` and `purge_expired_sensing_sessions`'s
 * own signature — both refuse a NULL instant — so the pass is deterministic and
 * a test can drive it.
 *
 * ABSENT RELATION IS REPORTED, NOT COUNTED. A database without 2480 (the table
 * reached production on 2026-09-16 and may not exist in every environment) makes
 * the RPC fail; that is `skipped` with a reason, never a successful erasure of
 * zero rows.
 */
export async function runSensingSessionCleanup(
  opts: { client?: any; now?: Date } = {},
): Promise<SweepResult> {
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return { purged: 0, skipped: true, reason: "no_client" };
  const now = (opts.now ?? new Date()).toISOString();
  try {
    const { data, error } = await db.rpc("purge_expired_sensing_sessions", { p_now: now });
    if (error) {
      logger.warn({ err: error }, "sensing session cleanup failed");
      return { purged: 0, skipped: true, reason: "error" };
    }
    // bigint over PostgREST can arrive as a STRING — the same trap
    // runMapTelemetryRetentionSweep documents above. Coerce, never typeof-guard.
    const purged = Number(data) || 0;
    // A count and nothing else. WHICH credentials expired is a fact about
    // contributors, and this pass exists partly so that fact stops existing.
    if (purged > 0) logger.info({ purged }, "sensing session cleanup removed expired/revoked credentials");
    return { purged, skipped: false, reason: null };
  } catch (err) {
    logger.warn({ err }, "sensing session cleanup threw");
    return { purged: 0, skipped: true, reason: "error" };
  }
}

/** The house window, `docs/ops/retention-policy.md:3` — "Window: 90 days". */
export const INPUT_TELEMETRY_RETENTION_DAYS = 90;

/**
 * Bound `input_assistance_telemetry_events` (migration 2950) to the house
 * 90-day window.
 *
 * ── WHY THIS PASS HAD TO SHIP WITH THE SINK ──────────────────────────────────
 * The §44 telemetry sink is now attached at app boot
 * (`travel-buddy-standalone/app/_layout.tsx`), so this table is the first thing
 * in the Input Intelligence lane that ACCUMULATES. This file's own header
 * records what happens when a store lands without its sweeper twice over —
 * migration 2315 shipped a purge function whose only reference in the repository
 * was its own definition, and `location_snapshots` carried `expires_at` for
 * months with nothing enforcing it, so readers filtered on expiry, the feature
 * looked correct, and rows accumulated forever. Turning on collection without
 * this pass would have been the third.
 *
 * ── WHY IT IS A DIRECT DELETE AND NOT AN RPC ────────────────────────────────
 * Every other pass here calls a `purge_*` SQL function its own migration
 * defined. 2950 defines none, and writing a migration is not this lane's to do.
 * A bounded DELETE over a timestamp column needs no function — and inventing a
 * migration to have one would have been the worse answer, because the migration
 * that owns this table is already committed and unapplied.
 *
 * ── WHY THERE IS NO FEATURE FLAG ─────────────────────────────────────────────
 * The house instinct is to ship an irreversible DELETE switched off. That is the
 * wrong polarity for a RETENTION control — `runMapTelemetryRetentionSweep`'s
 * header argues it at length: a retention flag shipped off declares a 90-day
 * privacy promise and then does not keep it. A flag here would need a seed row,
 * a seed row needs a migration, and the effect of shipping it unseeded is that
 * the promise is never kept. `sensing_credential_cleanup` sets the precedent for
 * `flag: null` and gives the test for when it applies: a flag protects rows a
 * reader can still see. These rows are not such rows. They carry no account id
 * by construction (2950 RAISEs if one is ever added), and every §57 metric over
 * them is windowed, so deleting rows past 90 days changes no answer
 * `scripts/reportInputMetrics.ts` can give inside its own window.
 *
 * ── AND IT IS A NO-OP TODAY, WHICH IS THE POINT ──────────────────────────────
 * 2950 is unapplied to production and to portava-ci, so the table does not exist
 * and this pass reports `error` rather than a purge. On the day the migration
 * lands the bound is ALREADY enforced, rather than being one more thing someone
 * has to remember to turn on afterwards.
 */
export async function runInputTelemetryRetentionSweep(
  opts: { client?: any; now?: Date } = {},
): Promise<SweepResult> {
  // Explicit null means "no client"; undefined means "use the service client".
  // NOT `opts.client ?? getServiceClient()` — see runIntelRetentionSweep's note
  // on why `??` opened a socket in CI.
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return { purged: 0, skipped: true, reason: "no_client" };

  const now = opts.now ?? new Date();
  const cutoff = new Date(
    now.getTime() - INPUT_TELEMETRY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  try {
    // `received_at` (the server's own clock), never `occurred_at` (the device's).
    // A device with a clock two years fast would otherwise keep its rows past the
    // window, and one two years slow would have them deleted on arrival.
    const { data, error } = await db
      .from("input_assistance_telemetry_events")
      .delete()
      .lt("received_at", cutoff)
      .select("id");
    if (error) {
      logger.warn({ err: error }, "input telemetry retention sweep failed");
      return { purged: 0, skipped: true, reason: "error" };
    }
    const purged = Array.isArray(data) ? data.length : 0;
    // A count and nothing else. WHICH events expired is a fact about sessions.
    if (purged > 0) logger.info({ purged }, "input telemetry retention removed expired rows");
    return { purged, skipped: false, reason: null };
  } catch (err) {
    logger.warn({ err }, "input telemetry retention sweep threw");
    return { purged: 0, skipped: true, reason: "error" };
  }
}

export const RETENTION_PASSES: readonly RetentionPass[] = [
  { name: "intel_retention_sweep", flag: "intel_retention_sweep_enabled", run: runIntelRetentionSweep },
  { name: "intel_contribution_retention", flag: "intel_contribution_retention_enabled", run: runIntelContributionRetentionSweep },
  { name: "input_telemetry_retention", flag: null, run: runInputTelemetryRetentionSweep },
  { name: "map_telemetry_retention", flag: "map_telemetry_retention_enabled", run: runMapTelemetryRetentionSweep },
  { name: "presence_cleanup", flag: "presence_cleanup_enabled", run: runPresenceCleanup },
  { name: "sensing_credential_cleanup", flag: null, run: runSensingCredentialCleanup },
  { name: "sensing_session_cleanup", flag: null, run: runSensingSessionCleanup },
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
