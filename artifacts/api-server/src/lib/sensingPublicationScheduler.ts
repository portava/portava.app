/**
 * sensingPublicationScheduler — the PUBLISHER census-sensing §21.4 named as
 * blocker #2 for S39 and S24: *"Nothing publishes. `publishThroughDifferencingGate`
 * has no caller outside tests, so `sensing_published_aggregates` is empty."*
 *
 * ── WHAT ONE PASS DOES ──────────────────────────────────────────────────────
 * For every cohort (zone × privacy time bucket × reduction version) that holds
 * an unexpired contribution in the current or the previous bucket:
 *
 *   1. read the cohort                 lib/sensingAnonStore.readSensingCohort
 *   2. aggregate it under the k-gate   lib/sensingCoverageAggregate (k, groups,
 *                                      share, publication delay — the same gate
 *                                      that protects the count everywhere else)
 *   3. hand a PUBLISHABLE aggregate to lib/sensingDifferencingGate.
 *      publishThroughDifferencingGate, which compares it with the cohort's last
 *      publication, refuses a change smaller than the independent-group floor
 *      (S24), and records what it decides to serve in 3110's durable store.
 *
 * A cohort the k-gate withholds never reaches the differencing gate: a
 * suppression has no row (buildPublicationRow's own rule), so "withheld" and
 * "published" stay distinguishable in the store as well as in the counts.
 *
 * ── THE TWO GATES IN FRONT OF IT, IN THIS ORDER ──────────────────────────────
 * (1) THE `surface` CONSENT SCOPE, checked before any client is obtained and
 *     before any read. §21.4 orders the publisher AFTER the scope grant: a
 *     publication exists to be surfaced, and nothing may be prepared for a
 *     surface the contributors' policy does not permit. The policy is a
 *     parameter defaulting to the one in force, exactly as
 *     compass/CompassSensingPresenceProducer takes it, so the property can be
 *     proven against a granting policy without the production constant
 *     changing. Every production caller takes the default, which refuses.
 * (2) `sensing_publication_enabled` (3313, seeded FALSE) — the operational
 *     switch, read fail-closed. It cannot substitute for (1): with the scope
 *     ungranted the flag is never read.
 *
 * Then the schema gate every sensing sweep has: the pass probes for 2315's
 * table and does nothing where it is absent (production today).
 *
 * ── WHAT IT NEVER DOES ───────────────────────────────────────────────────────
 * It is the only writer of `sensing_published_aggregates` besides the retention
 * sweep's purge. It never reads a contributor token into a log, never renders
 * anything, and cannot be driven by a request: it runs on its own clock, which
 * is what keeps a conversation (the reader) from choosing WHEN a cohort is
 * published — the differencing attack CompassSensingPresenceProducer's header
 * describes. Counts only in logs; never a zone, a cohort key or a token.
 */
import { logger } from "./logger.js";
import { getServiceClient } from "./supabase.js";
import { isFlagEnabled } from "./featureFlags.js";
import { sensingStorePresent } from "./sensingAnonService.js";
import { readSensingCohort, SENSING_TABLE, sensingTimeBucket } from "./sensingAnonStore.js";
import { aggregateSensingCohort } from "./sensingCoverageAggregate.js";
import { publishThroughDifferencingGate, type DifferencingReason } from "./sensingDifferencingGate.js";
import { PRIVACY_THRESHOLD_V1 } from "./intelContracts.js";
import {
  SENSING_ANON_POLICY_V1,
  type ContributionPurposeScope,
  type IntelligenceContributionPolicy,
} from "./sensingContributionPolicy.js";

/** The capability flag 3313 seeds FALSE. Literal, `*_enabled` ⇒ fail-closed. */
export const SENSING_PUBLICATION_FLAG = "sensing_publication_enabled";

/**
 * The scope a publication requires. The SAME string the producer gates on
 * (`compass/CompassSensingPresenceProducer.SENSING_SURFACE_SCOPE`); spelled
 * here rather than imported so lib/ does not depend on compass/, and pinned
 * equal by sensingPublicationScheduler.test.ts.
 */
export const SENSING_PUBLICATION_SCOPE: ContributionPurposeScope = "surface";

/** How many privacy buckets back a pass looks, counting the current one. */
export const SENSING_PUBLICATION_LOOKBACK_BUCKETS = 2;

/** Cap on distinct cohorts one pass will consider. Bounds the reads, not just the writes. */
export const SENSING_PUBLICATION_MAX_COHORTS_PER_PASS = 500;

const STARTUP_DELAY_MS = 11 * 60 * 1000;

function parseEnvFloat(raw: string | undefined, def: number): number {
  const v = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(v) && v > 0 ? v : def;
}

/** Default: one pass per 15 minutes — half a privacy bucket, longer than the publication delay. */
export const SENSING_PUBLICATION_INTERVAL_SECONDS = parseEnvFloat(
  process.env["SENSING_PUBLICATION_INTERVAL_SECONDS"],
  900,
);
export const SENSING_PUBLICATION_INTERVAL_MS = SENSING_PUBLICATION_INTERVAL_SECONDS * 1000;

let _timer: ReturnType<typeof setTimeout> | null = null;

export type SensingPublicationSkipReason =
  | "surface_scope_not_granted"
  | "no_client"
  | "capability_off"
  | "store_absent"
  | "cohorts_unreadable";

export interface SensingPublicationPassResult {
  skipped: boolean;
  reason: SensingPublicationSkipReason | null;
  /** Distinct cohorts considered. */
  cohorts: number;
  /** Publications RECORDED this pass, by the differencing reason that admitted them. */
  published: number;
  publishedBy: Partial<Record<DifferencingReason, number>>;
  /** The k-gate withheld the aggregate; the differencing gate was not consulted. */
  withheld: number;
  /** Publishable, but the change since the last publication was below the floor (S24). */
  belowMinimum: number;
  /** The previous publication could not be read, or the record did not land. Never served. */
  failed: number;
}

export interface SensingPublicationPassOptions {
  /** Explicit null means "no client"; undefined means the service client. See lib/sensingRetentionScheduler. */
  client?: any;
  now?: Date;
  /** Defaults to the one policy in force. Tests may pass a granting policy; production never does. */
  policy?: IntelligenceContributionPolicy;
  maxCohorts?: number;
}

function sensingPublicationScopeGranted(policy: IntelligenceContributionPolicy): boolean {
  return (policy?.purposeScopes ?? []).includes(SENSING_PUBLICATION_SCOPE);
}

interface CohortRef {
  cohort_key: string;
  zone_id: string;
  time_bucket: string;
  reduction_version: number;
}

const SKIPPED = (reason: SensingPublicationSkipReason): SensingPublicationPassResult => ({
  skipped: true,
  reason,
  cohorts: 0,
  published: 0,
  publishedBy: {},
  withheld: 0,
  belowMinimum: 0,
  failed: 0,
});

/** One publication pass. Never throws; every failure is a counted refusal. */
export async function runSensingPublicationPass(
  opts: SensingPublicationPassOptions = {},
): Promise<SensingPublicationPassResult> {
  // (1) CONSENT FIRST, before a client exists and before any read.
  if (!sensingPublicationScopeGranted(opts.policy ?? SENSING_ANON_POLICY_V1)) {
    return SKIPPED("surface_scope_not_granted");
  }

  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return SKIPPED("no_client");

  // (2) The operational switch, fail-closed.
  if (!(await isFlagEnabled(db, SENSING_PUBLICATION_FLAG))) return SKIPPED("capability_off");

  // (3) The schema gate every sensing sweep has.
  if (!(await sensingStorePresent(db))) return SKIPPED("store_absent");

  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const bucketMs = PRIVACY_THRESHOLD_V1.timeBucketMinutes * 60_000;
  const sinceIso = sensingTimeBucket(nowMs - (SENSING_PUBLICATION_LOOKBACK_BUCKETS - 1) * bucketMs);
  const maxCohorts = Number.isInteger(opts.maxCohorts) && (opts.maxCohorts as number) > 0
    ? (opts.maxCohorts as number)
    : SENSING_PUBLICATION_MAX_COHORTS_PER_PASS;

  // Which cohorts are live? Distinct keys over the unexpired rows of the
  // lookback window. Only the four identity columns are selected: no token,
  // no group, no feature.
  let refs: CohortRef[];
  try {
    const { data, error } = await db
      .from(SENSING_TABLE)
      .select("cohort_key, zone_id, time_bucket, reduction_version")
      .gt("expires_at", nowIso)
      .gte("time_bucket", sinceIso)
      .limit(maxCohorts * 50);
    if (error) {
      logger.warn({ error: (error as any)?.message ?? String(error) }, "sensing publication pass: cohort listing failed");
      return SKIPPED("cohorts_unreadable");
    }
    const byKey = new Map<string, CohortRef>();
    for (const r of (data as CohortRef[]) ?? []) {
      if (!r || typeof r.cohort_key !== "string" || r.cohort_key === "") continue;
      if (!byKey.has(r.cohort_key)) byKey.set(r.cohort_key, r);
      if (byKey.size >= maxCohorts) break;
    }
    refs = [...byKey.values()];
  } catch (e) {
    logger.warn({ err: e }, "sensing publication pass: cohort listing threw");
    return SKIPPED("cohorts_unreadable");
  }

  const result: SensingPublicationPassResult = {
    skipped: false,
    reason: null,
    cohorts: refs.length,
    published: 0,
    publishedBy: {},
    withheld: 0,
    belowMinimum: 0,
    failed: 0,
  };

  for (const ref of refs) {
    // SURFACE read: only contributions whose own contributor consented to
    // being shown count toward the k-gate (3315). A cohort of fifteen people
    // of whom fourteen consented is a cohort of fourteen here.
    const read = await readSensingCohort(db, ref.cohort_key, nowIso, undefined, { surfaceOnly: true });
    const aggregate = aggregateSensingCohort(read, { nowMs });
    if (aggregate.publishable !== true) {
      // The k-gate (or an unreadable / incomplete read) withheld it. Not a
      // publication, not a failure of this pass, and never a row.
      result.withheld += 1;
      continue;
    }
    const decision = await publishThroughDifferencingGate(
      db,
      {
        cohortKey: ref.cohort_key,
        zoneId: ref.zone_id,
        timeBucketIso: ref.time_bucket,
        reductionVersion: ref.reduction_version,
      },
      aggregate,
      nowMs,
    );
    if (decision.recorded) {
      result.published += 1;
      result.publishedBy[decision.reason] = (result.publishedBy[decision.reason] ?? 0) + 1;
    } else if (decision.reason === "delta_below_minimum") {
      result.belowMinimum += 1;
    } else {
      // previous_unreadable / publication_not_recorded / not_publishable — the
      // last cannot happen past the check above, and is counted if it does.
      result.failed += 1;
    }
  }

  // Counts only. Which zone or cohort was published is a fact about a cohort.
  logger.info(
    {
      cohorts: result.cohorts,
      published: result.published,
      publishedBy: result.publishedBy,
      withheld: result.withheld,
      belowMinimum: result.belowMinimum,
      failed: result.failed,
    },
    "sensing publication pass",
  );
  return result;
}

export function startSensingPublicationScheduler(): void {
  if (_timer !== null) return;
  logger.info(
    {
      startupDelayMs: STARTUP_DELAY_MS,
      intervalMs: SENSING_PUBLICATION_INTERVAL_MS,
      gates: [
        `the contribution policy must grant '${SENSING_PUBLICATION_SCOPE}' (an owner consent act; ungranted today)`,
        `${SENSING_PUBLICATION_FLAG} must be true (3313 seeds it false)`,
        "sensing_anon_contributions must exist in this database",
      ],
    },
    "SensingPublicationScheduler scheduled (refuses on every gate until the owner acts)",
  );
  _timer = setTimeout(function tick() {
    void runSensingPublicationPass().finally(() => {
      _timer = setTimeout(tick, SENSING_PUBLICATION_INTERVAL_MS);
    });
  }, STARTUP_DELAY_MS);
}

export function stopSensingPublicationScheduler(): void {
  if (_timer !== null) {
    clearTimeout(_timer);
    _timer = null;
  }
}
