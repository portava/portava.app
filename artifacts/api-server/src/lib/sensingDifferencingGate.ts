/**
 * sensingDifferencingGate — the anti-differencing control §3 requires and the
 * census (S24) found absent: "Anti-differencing as such is absent — no
 * query-set-size auditing, no noise, no repeated-query budget."
 *
 * ── THE ATTACK ───────────────────────────────────────────────────────────────
 * Two publications of the same cohort that differ by one contributor leak that
 * contributor: "the count went from 17 to 18 after Alice walked in" is a
 * presence fact about Alice, and a k-floor on each publication alone does not
 * stop it — both 17 and 18 clear k = 15. The same holds for a cohort read
 * before and after one revocation.
 *
 * ── THE CONTROL ──────────────────────────────────────────────────────────────
 * A cohort may be RE-published only when its distinct-contributor count has
 * moved by at least `minDelta` since the last publication, or has not moved
 * at all (a re-serve of the same value leaks nothing new). A small non-zero
 * movement is suppressed — the previously published value stands. `minDelta`
 * defaults to the privacy threshold's independent-group floor, so a change
 * smaller than a whole independent party is never published.
 *
 * This is deliberately a rule over PUBLISHED values only — it needs no token
 * set and no memory of who was in the cohort, because keeping either would be
 * the tracking store the design forbids. The caller keeps the last published
 * aggregate (a de-identified value) and hands it back in.
 *
 * PURE RULE: no clock, publishes nothing. WHERE that previous value LIVES is the durable half at the foot of this file (3110).
 */
import { PRIVACY_THRESHOLD_V1 } from "./intelContracts.js";
import type { SensingCohortAggregate } from "./sensingCoverageAggregate.js";

export type DifferencingReason = "no_previous" | "unchanged" | "delta_at_least_minimum" | "delta_below_minimum" | "not_publishable" | "previous_unreadable" | "publication_not_recorded";

export interface DifferencingDecision {
  /** Whether `current` may be served as a NEW publication. */
  publish: boolean;
  reason: DifferencingReason;
  /** The aggregate a consumer should serve: `current` when publish, else the previous. */
  serve: SensingCohortAggregate | null;
}

export interface DifferencingOptions {
  /** Minimum change in distinct contributors between publications. Default: the independent-group floor. */
  minDelta?: number;
}

export function evaluateDifferencing(
  previous: SensingCohortAggregate | null,
  current: SensingCohortAggregate,
  options: DifferencingOptions = {},
): DifferencingDecision {
  const minDelta = options.minDelta ?? PRIVACY_THRESHOLD_V1.minIndependentGroups;
  if (!Number.isInteger(minDelta) || minDelta < 1) throw new Error("evaluateDifferencing: minDelta must be a positive integer");

  // The privacy gate speaks first: an unpublishable cohort is never served,
  // and a previously published value is NOT re-served in its place — that would
  // reveal that the cohort has since fallen below k.
  if (!current || current.publishable !== true) return { publish: false, reason: "not_publishable", serve: null };

  if (!previous || previous.publishable !== true) return { publish: true, reason: "no_previous", serve: current };

  const delta = Math.abs(current.distinctActors - previous.distinctActors);
  if (delta === 0) return { publish: true, reason: "unchanged", serve: current };
  if (delta >= minDelta) return { publish: true, reason: "delta_at_least_minimum", serve: current };
  return { publish: false, reason: "delta_below_minimum", serve: previous };
}

// ═════════════════════════════════════════════════════════════════════════════
// THE DURABLE LAST-PUBLISHED STORE (migration 3110, UNAPPLIED)
// ═════════════════════════════════════════════════════════════════════════════
//
// Everything above is pure and takes `previous` as an argument. That is the
// right shape for the rule and the wrong shape for a deployment, because it
// leaves one question unanswered: WHERE DOES `previous` LIVE?
//
// If it lives in a process's memory, the gate is not a control. It resets on
// every deploy, every restart and every extra replica, and a reset reads as
// `no_previous` — which PUBLISHES. The failure mode of forgetting is the unsafe
// direction, which is the direction an attacker would induce.
//
// intel_state_snapshots cannot be that memory. It is one row per
// (subject, zone, claim) upserted in place as evidence arrives, so by the time
// a publisher reads it, it already holds the CURRENT value. A gate handed
// (current, current) always sees delta 0, answers `unchanged`, and publishes
// every time — a control structurally incapable of refusing.
//
// So 3110 adds `sensing_published_aggregates`: APPEND-ONLY (service_role holds
// no UPDATE, asserted in its postconditions), one row per publication, k-floor
// and 72-hour TTL both structural, no identity column and no foreign key at all.
// The functions below are the only shape in which this module touches it, and
// they read failure as failure — see readLastPublishedAggregate.
//
// TWO PROPERTIES OF THIS MODULE SURVIVE THE CHANGE UNTOUCHED, and
// src/test/sensingDifferencingGate.test.ts pins both:
//
//   * IT STILL KEEPS NO PER-PERSON IDENTIFIER OF ANY KIND. Nothing below reads
//     or stores the opaque per-contributor or per-party identifiers the
//     contribution store derives — the values here are counts that already
//     cleared the privacy gate. That is why this file names none of them, and
//     why the column list it selects contains none either.
//   * IT STILL READS NO CLOCK. Every function takes its instant, as before.
//
// It also names no vendor SDK: the store is reached through the structural port
// below rather than an imported client type, so the gate stays a rule about
// published values and the transport stays somebody else's concern.
//
// THE TWO NEW `DifferencingReason` MEMBERS belong to this half and only this
// half. `previous_unreadable` and `publication_not_recorded` both mean "we
// refused for a reason that is not about the cohort", and they are kept DISTINCT
// from `not_publishable` deliberately: "the privacy gate refused this cohort"
// and "we could not establish what we last published" are different facts, and
// collapsing them would hide an outage behind a privacy suppression — the same
// distinction lib/sensingCoverageAggregate draws between `read_failed` and a
// k-suppression.
//
// The union above is kept on ONE LINE, and this note lives down here, for the
// reason routes/index.ts gives for registering at its tail: census-sensing.md
// cites lines 46 and 63 of this file by number, and src/test/docCitations.test.ts
// checks that those citations still resolve.

/**
 * The minimum a durable-store client must offer. Structural on purpose — see
 * above: a privacy control should not have to name a database vendor to keep a
 * number. Any Supabase-shaped client satisfies it.
 */
export interface PublicationStore {
  from(table: string): any;
}

/** The store 3110 creates. */
export const SENSING_PUBLISHED_TABLE = "sensing_published_aggregates";

/** 3110's TTL ceiling, mirrored so a caller is refused before the round trip. */
export const SENSING_PUBLICATION_MAX_TTL_SECONDS = 72 * 60 * 60;
/** Default life of one publication record. One day, matching the store's own default. */
export const SENSING_PUBLICATION_DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/** One row of 3110, minus `id`. Note the absence of any contributor or identity column. */
export interface SensingPublishedAggregateRow {
  cohort_key: string;
  zone_id: string;
  time_bucket: string;
  reduction_version: number;
  distinct_contributors: number;
  distinct_groups: number;
  max_group_share: number;
  contribution_count: number;
  median_signal_bucket: number | null;
  observed_at: string | null;
  published_at: string;
  expires_at: string;
}

export interface PublicationIdentity {
  cohortKey: string;
  zoneId: string;
  /** The cohort's time bucket, ISO. Already floored by lib/sensingAnonStore. */
  timeBucketIso: string;
  reductionVersion: number;
}

export type PublicationBuildResult =
  | { ok: true; row: SensingPublishedAggregateRow }
  | { ok: false; error: string };

/**
 * Build the row that records one publication. PURE — takes its instant.
 *
 * Refuses an UNPUBLISHABLE aggregate by name rather than writing it. 3110's
 * k-floor CHECK would refuse it too, and the CHECK remains the authority; this
 * exists so the refusal has a name before the round trip, and so the property
 * is provable without a database.
 */
export function buildPublicationRow(
  identity: PublicationIdentity,
  aggregate: SensingCohortAggregate,
  nowMs: number,
  ttlSeconds: number = SENSING_PUBLICATION_DEFAULT_TTL_SECONDS,
): PublicationBuildResult {
  if (!identity || !identity.cohortKey) return { ok: false, error: "cohort_key_required" };
  if (!identity.zoneId) return { ok: false, error: "zone_required" };
  if (!identity.timeBucketIso || !Number.isFinite(Date.parse(identity.timeBucketIso))) {
    return { ok: false, error: "time_bucket_invalid" };
  }
  if (!Number.isInteger(identity.reductionVersion) || identity.reductionVersion < 1) {
    return { ok: false, error: "reduction_version_invalid" };
  }
  if (!Number.isFinite(nowMs)) return { ok: false, error: "now_invalid" };
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) return { ok: false, error: "ttl_invalid" };
  if (ttlSeconds > SENSING_PUBLICATION_MAX_TTL_SECONDS) return { ok: false, error: "ttl_exceeds_maximum" };
  // An unpublishable aggregate is a SUPPRESSION. A suppression has no row here:
  // recording one would make "this cohort was served" indistinguishable from
  // "this cohort was refused", and the gate would later compare against a value
  // nobody ever saw.
  if (!aggregate || aggregate.publishable !== true) return { ok: false, error: "aggregate_not_publishable" };

  return {
    ok: true,
    row: {
      cohort_key: identity.cohortKey,
      zone_id: identity.zoneId,
      time_bucket: identity.timeBucketIso,
      reduction_version: identity.reductionVersion,
      distinct_contributors: aggregate.distinctActors,
      distinct_groups: aggregate.distinctGroups,
      max_group_share: aggregate.maxGroupShare,
      contribution_count: aggregate.contributions,
      median_signal_bucket: aggregate.medianSignalBucket,
      observed_at: aggregate.observedAt,
      published_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + ttlSeconds * 1000).toISOString(),
    },
  };
}

/**
 * The aggregate a stored publication represents. PURE, and deliberately total:
 * a row exists only because a publishable aggregate was served, so `publishable`
 * is true and `reason` is null by construction rather than by a stored flag —
 * there is no column a later writer could set to make an unpublishable value
 * look publishable.
 */
export function aggregateFromPublicationRow(row: SensingPublishedAggregateRow): SensingCohortAggregate {
  return {
    publishable: true,
    reason: null,
    distinctActors: row.distinct_contributors,
    distinctGroups: row.distinct_groups,
    maxGroupShare: Number(row.max_group_share),
    contributions: row.contribution_count,
    observedAt: row.observed_at,
    medianSignalBucket: row.median_signal_bucket,
    // 3110's publication row carries no 3312 feature statistics (S39's
    // publisher would decide what to publish); a stored publication therefore
    // re-reads as "features unknown", never as invented ones.
    features: null,
  };
}

/**
 * The last publication of one cohort that has not expired, or null.
 *
 * A DISCRIMINATED RESULT, never a null standing in for an error. `null` on the
 * success branch means "we looked and this cohort has never been published";
 * a failed read is `ok: false` and the caller must NOT treat it as no_previous,
 * because no_previous publishes. lib/sensingAnonStore's readSensingCohort makes
 * the same distinction for the same reason.
 */
export type LastPublishedRead =
  | { ok: true; row: SensingPublishedAggregateRow | null }
  | { ok: false; error: string };

export async function readLastPublishedAggregate(
  db: PublicationStore,
  cohortKey: string,
  nowIso: string,
): Promise<LastPublishedRead> {
  if (!db) return { ok: false, error: "no_client" };
  if (!cohortKey) return { ok: false, error: "cohort_key_required" };
  if (!nowIso) return { ok: false, error: "now_required" };
  try {
    const { data, error } = await db
      .from(SENSING_PUBLISHED_TABLE)
      .select(
        "cohort_key, zone_id, time_bucket, reduction_version, distinct_contributors, distinct_groups, max_group_share, contribution_count, median_signal_bucket, observed_at, published_at, expires_at",
      )
      .eq("cohort_key", cohortKey)
      .gt("expires_at", nowIso)
      .order("published_at", { ascending: false })
      .limit(1);
    if (error) return { ok: false, error: error.message ?? "read_failed" };
    const rows = (data ?? []) as SensingPublishedAggregateRow[];
    return { ok: true, row: rows.length > 0 ? rows[0]! : null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "read_threw" };
  }
}

export type PublicationWriteResult = { ok: true } | { ok: false; error: string };

/** Record one publication. INSERT only — 3110 grants no UPDATE to anybody. */
export async function recordPublishedAggregate(
  db: PublicationStore,
  row: SensingPublishedAggregateRow,
): Promise<PublicationWriteResult> {
  if (!db) return { ok: false, error: "no_client" };
  try {
    const { error } = await db.from(SENSING_PUBLISHED_TABLE).insert(row);
    if (error) return { ok: false, error: error.message ?? "insert_failed" };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "insert_threw" };
  }
}

export interface DurableDifferencingDecision extends DifferencingDecision {
  /** Whether this decision was written to the durable store as a new publication. */
  recorded: boolean;
  /** Set when the decision could not be taken safely, or the record could not be written. */
  error?: string;
}

/**
 * The gate, over DURABLE state: read the cohort's last publication, decide, and
 * — only when the decision is to publish — record the new one.
 *
 * FAIL-CLOSED IN THE ONE DIRECTION THAT MATTERS. If the previous publication
 * cannot be read, this returns `publish: false` with reason
 * `previous_unreadable` and serves nothing. It does NOT fall through to
 * `no_previous`, which is what a `?? null` would have done and which publishes:
 * "we could not look" must never be answered with the same verdict as "there is
 * nothing to compare against". That is the identical hazard
 * lib/sensingCoverageAggregate keeps `read_failed` distinct from a k-suppression
 * for, one layer up.
 *
 * A publication whose RECORD did not land is not served either. A value served
 * without a durable record is a value the next call would compare against
 * nothing, which re-opens the differencing attack the moment it happens.
 */
export async function publishThroughDifferencingGate(
  db: PublicationStore,
  identity: PublicationIdentity,
  current: SensingCohortAggregate,
  nowMs: number,
  options: DifferencingOptions & { ttlSeconds?: number } = {},
): Promise<DurableDifferencingDecision> {
  const nowIso = new Date(nowMs).toISOString();

  const read = await readLastPublishedAggregate(db, identity?.cohortKey ?? "", nowIso);
  if (!read.ok) {
    return { publish: false, reason: "previous_unreadable", serve: null, recorded: false, error: read.error };
  }

  const previous = read.row ? aggregateFromPublicationRow(read.row) : null;
  const decision = evaluateDifferencing(previous, current, options);
  if (!decision.publish) return { ...decision, recorded: false };

  const built = buildPublicationRow(identity, current, nowMs, options.ttlSeconds ?? SENSING_PUBLICATION_DEFAULT_TTL_SECONDS);
  if (!built.ok) {
    return { publish: false, reason: "publication_not_recorded", serve: null, recorded: false, error: built.error };
  }
  const written = await recordPublishedAggregate(db, built.row);
  if (!written.ok) {
    return { publish: false, reason: "publication_not_recorded", serve: null, recorded: false, error: written.error };
  }
  return { ...decision, recorded: true };
}

/** The purge's outcome. Same shape as the contribution sweep's, for the same reason. */
export type PublicationPurgeResult = { ok: true; deleted: number } | { ok: false; error: string };

/**
 * Sweep publications past their TTL.
 *
 * ── WHY THIS BINDING EXISTS, AND WHAT ITS ABSENCE WAS ───────────────────────
 * 3110 ships `purge_expired_sensing_publications(timestamptz)` SECURITY DEFINER,
 * and nothing called it. `check:security-definer-oracles` is the guard that
 * noticed, and its finding is worth restating because "unused function" sounds
 * harmless and this is not:
 *
 *   "NOTHING references it … Over PostgREST it is
 *    POST /rpc/purge_expired_sensing_publications, and Supabase's default
 *    privileges grant EXECUTE on it to anon and authenticated, so its entire
 *    remaining effect is to answer an authorization question for anyone who
 *    asks."
 *
 * There is a second cost on top of the reachability one, and it is the reason
 * the remedy here is to WIRE rather than to ledger: the store's 72-hour TTL is
 * a privacy bound, and a bound nothing enforces is a bound that does not hold.
 * A last-published aggregate that outlives its window is a longer-lived record
 * of a cohort than the policy permits.
 *
 * The caller is `lib/sensingRetentionScheduler`, beside the contribution sweep,
 * because they are the same job: one hourly pass that removes what has aged out
 * of the sensing stores. It is deliberately NOT a second scheduler.
 */
export async function purgeExpiredSensingPublications(
  db: PublicationStore,
  nowIso: string,
): Promise<PublicationPurgeResult> {
  if (!nowIso) return { ok: false, error: "now_required" };
  const rpc = (db as unknown as { rpc?: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }> }).rpc;
  if (typeof rpc !== "function") return { ok: false, error: "client_exposes_no_rpc" };
  try {
    const { data, error } = await rpc.call(db, "purge_expired_sensing_publications", { p_now: nowIso });
    if (error) return { ok: false, error: error.message ?? "purge_failed" };
    // A bigint arrives over PostgREST as a string. `Number(data) || 0` is the
    // house idiom (lib/sensingAnonStore.purgeExpiredSensingContributions says
    // why): a typeof check reports 0 for every real sweep, which is exactly how
    // a working purge reads as an idle one in the logs.
    return { ok: true, deleted: Number(data) || 0 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "purge_threw" };
  }
}
