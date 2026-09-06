/**
 * sensingAnonStore — the typed contract over `sensing_contributions` (migration
 * 2315): the anonymous half of Sensing / World Experience Intelligence.
 *
 * ── THE OWNER RULING THIS IMPLEMENTS (2026-09-06), QUOTED IN FULL ────────────
 *   "A short-lived anonymous sensing contribution/aggregation store IS allowed
 *    even though intel_observations requires actor_id. It is not a second intel
 *    lifecycle. Existing intel evidence -> claims -> snapshots remains canonical.
 *    The anonymous store may only own privacy-reduced sensor contributions,
 *    rotating IDs, TTL, cohort/coverage aggregation and revocation. It must not
 *    duplicate claim/review/status/conflict/snapshot semantics and must not
 *    contain a permanent profiles/user FK."
 *
 * ── INERT BY CONSTRUCTION ───────────────────────────────────────────────────
 * Nothing imports this module outside its test. There is no route, no scheduler,
 * no feature flag, and no client. It is the foundation; the capture path that
 * would call `writeSensingContribution` does not exist and is a separate,
 * separately-ruled unit. The table it describes ships empty and stays empty.
 *
 * ── WHAT IT DOES NOT DO, AND WHY THAT IS THE POINT ──────────────────────────
 * It does not evaluate k-anonymity, choose a threshold, count groups, or decide
 * publication. `aggregateSensingCohort` ASSEMBLES truthful counts and hands them
 * to lib/privacyGate.evaluatePrivacy — the single publish decision point — and
 * to lib/intelIndependence.clusterByIndependence for the group accounting. A
 * second implementation of either would be a second threshold, which is the
 * failure privacyGate's own header is written against.
 *
 * It also stores no aggregate. Migration 2130 refused a second coverage model
 * and 2181 built the one that exists (`intel_coverage_snapshots`); the ruling
 * permits "cohort/coverage aggregation", so the aggregation here is a pure
 * read-time function whose result is returned and never written. A stored
 * aggregate would be a snapshot, and snapshots are what the ruling forbids
 * duplicating.
 *
 * ── ROTATING IDENTITY: WHY THE CLOCKS MUST MATCH ────────────────────────────
 * `rotation_id` is a server-keyed HMAC over (client-held secret, bucket start,
 * cohort key). Its period is EXACTLY PRIVACY_THRESHOLD_V1.timeBucketMinutes, the
 * window the aggregate covers. That is not a coincidence and must not drift:
 *
 *   * rotate FASTER than the window and one person contributes several distinct
 *     pseudonyms to the same aggregate, INFLATING distinctActors — the exact
 *     defect lib/privacyGate.ts records for CompassGraphEngine, which counts
 *     events and reports them as people;
 *   * rotate SLOWER and the pseudonym survives across aggregates, which is a
 *     trail.
 *
 * Same clock, so one person is exactly one rotation_id per aggregated cohort,
 * and nothing links two cohorts or two buckets.
 *
 * ── REVOCATION WITHOUT AN IDENTITY ──────────────────────────────────────────
 * The store has no user id to revoke BY, so revocation is a capability, not a
 * lookup. The contributing client generates a high-entropy secret and keeps it.
 * The server never stores that secret: it stores only
 * `revocation_tag = HMAC(server key, "sensing-revocation/v1" | bucket | secret)`,
 * a one-way digest nobody can invert (the server key is required to produce it,
 * so a database dump cannot be brute-forced either).
 *
 * To revoke, the holder presents the secret. `revokeSensingContributions`
 * recomputes the tag for EVERY bucket still inside the 72-hour TTL ceiling — at
 * most 145 of them — and deletes the rows that match. No identity is presented,
 * none is stored, and the operation is expressible with no join to any user
 * table because there is none to join to.
 *
 * THE ONE TRADE-OFF, STATED RATHER THAN BURIED: the tag is bucket-scoped but NOT
 * cohort-scoped, so within one 30-minute bucket a database reader can see that
 * several rows across different cohorts came from one holder. Cohort-scoping it
 * would erase that linkage — and would require the revoking client to remember
 * every cohort it ever contributed to, so a reinstall would leave rows
 * permanently unrevocable. A revocation that silently misses rows is a worse
 * failure than a 30-minute bounded linkage, so the linkage is what we take. An
 * owner who weighs it the other way should overrule this line specifically.
 *
 * ── GROUPS: NEVER INFERRED FROM SEPARATE PSEUDONYMS ─────────────────────────
 * `group_key` is normally NULL here, and that is correct rather than
 * unfinished. lib/intelGroupKey's ruling is explicit: an observation with no
 * verifiable independent-group identity "earns ZERO credit toward the >=5-group
 * requirement... we never INFER separate groups from separate actors." An
 * anonymous contribution has no attested party, so it gets no group. The
 * consequence is that an all-anonymous cohort CANNOT satisfy
 * PRIVACY_THRESHOLD_V1 and cannot publish — fail-closed, by the existing rule,
 * not by a new one. A capture path that does hold a crew token (a trip id, which
 * names no person) may supply it and earn the credit.
 */
import { createHmac } from "node:crypto";

import { PRIVACY_THRESHOLD_V1 } from "./intelContracts.js";
import { evaluatePrivacy, type PrivacyDecision, type PrivacyThreshold } from "./privacyGate.js";
import { clusterByIndependence } from "./intelIndependence.js";
import { deriveGroupKey, type GroupIdentity } from "./intelGroupKey.js";

/** The one table this module owns. */
export const SENSING_TABLE = "sensing_contributions";

/** Versioned HMAC contexts (house idiom: intelGroupKey's GROUP_KEY_CONTEXT). */
const ROTATION_CONTEXT = "sensing-rotation/v1";
const REVOCATION_CONTEXT = "sensing-revocation/v1";
const GROUP_SUBJECT_CONTEXT = "sensing-cohort/v1";

/** WHAT was sensed. Mirrors the CHECK in migration 2315. */
export const SENSING_SIGNAL_KINDS = [
  "crowd_density",
  "queue_length",
  "noise_level",
  "movement_pace",
  "availability",
] as const;
export type SensingSignalKind = (typeof SENSING_SIGNAL_KINDS)[number];

/**
 * HOW MUCH, reduced to a coarse band. Three values is the privacy reduction: a
 * raw magnitude is a fingerprint, a band is not. Mirrors the CHECK in 2315.
 */
export const SENSING_SIGNAL_BANDS = ["low", "moderate", "high"] as const;
export type SensingSignalBand = (typeof SENSING_SIGNAL_BANDS)[number];

/**
 * The rotation period, in minutes. Deliberately READ FROM the privacy threshold
 * rather than restated, so the two clocks cannot drift apart in a later edit.
 */
export const SENSING_ROTATION_PERIOD_MINUTES = PRIVACY_THRESHOLD_V1.timeBucketMinutes;
const PERIOD_MS = SENSING_ROTATION_PERIOD_MINUTES * 60_000;

/** The hard ceiling the migration's CHECK also enforces. "Short-lived", in code. */
export const SENSING_MAX_TTL_SECONDS = 72 * 60 * 60;
/** What a caller gets if it does not choose. Well inside the ceiling. */
export const SENSING_DEFAULT_TTL_SECONDS = 24 * 60 * 60;

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_COHORT_KEY_LENGTH = 128;

/** Minimal structural view of the PostgREST client (house idiom: intelConsent). */
export interface SensingDbClient {
  from(table: string): any;
}

/**
 * The HMAC key. Prefer a dedicated SENSING_ANON_STORE_SECRET so this store's
 * pseudonym stability is decoupled from every other rotation; fall back to
 * INTEL_GROUP_KEY_SECRET and then SESSION_SECRET, which lib/envValidation makes
 * a boot requirement so one is always present in a valid run.
 *
 * There is NO constant fallback, for intelGroupKey's reason: a guessable key
 * makes the digest reversible and turns a rotating pseudonym back into a stable
 * identifier. Fail closed instead.
 */
function sensingHmacKey(): string {
  const key =
    process.env.SENSING_ANON_STORE_SECRET ??
    process.env.INTEL_GROUP_KEY_SECRET ??
    process.env.SESSION_SECRET;
  if (!key) {
    throw new Error(
      "SENSING_ANON_STORE_SECRET, INTEL_GROUP_KEY_SECRET or SESSION_SECRET is required to derive sensing rotation ids (privacy-critical, no fallback).",
    );
  }
  return key;
}

/** Canonicalise an identity component so equal-in-Postgres inputs hash equally. */
function canon(value: string): string {
  return value.trim().toLowerCase();
}

function hmac(canonical: string): string {
  return createHmac("sha256", sensingHmacKey()).update(canonical).digest("hex");
}

/**
 * Floor an instant onto the rotation grid. Every contribution in the same bucket
 * shares this value, and it is the only time the table records.
 */
export function sensingBucketStartMs(atMs: number): number {
  if (!Number.isFinite(atMs)) {
    throw new Error("sensingBucketStartMs: a finite instant is required");
  }
  return Math.floor(atMs / PERIOD_MS) * PERIOD_MS;
}

/**
 * The rotating pseudonym for one (holder, bucket, cohort). Not a user id: it
 * changes every bucket and differs per cohort, so it neither trails a person
 * through time nor links the places they were in.
 */
export function deriveSensingRotationId(
  secret: string,
  bucketStartMs: number,
  cohortKey: string,
): string {
  const bucket = new Date(sensingBucketStartMs(bucketStartMs)).toISOString();
  return hmac(`${ROTATION_CONTEXT}|${bucket}|${canon(cohortKey)}|${canon(secret)}`);
}

/**
 * The revocation handle for one (holder, bucket). Cohort-agnostic on purpose:
 * "delete everything I contributed" must not require the holder to remember
 * where they were. See the module header for the linkage this costs.
 */
export function deriveSensingRevocationTag(secret: string, bucketStartMs: number): string {
  const bucket = new Date(sensingBucketStartMs(bucketStartMs)).toISOString();
  return hmac(`${REVOCATION_CONTEXT}|${bucket}|${canon(secret)}`);
}

/**
 * The independent-group token, delegated to lib/intelGroupKey rather than
 * reimplemented. The bucket is folded into the subject so the token ROTATES with
 * the pseudonym — a group key that outlived the bucket would be a stable
 * cross-time handle and would undo the rotation it sits next to.
 *
 * A null identity yields a null key, which earns zero group credit downstream.
 * That is the normal outcome for an anonymous contribution.
 */
export function deriveSensingGroupKey(
  cohortKey: string,
  bucketStartMs: number,
  identity: GroupIdentity | null,
): string | null {
  if (!identity || !cohortKey) return null;
  const bucket = new Date(sensingBucketStartMs(bucketStartMs)).toISOString();
  return deriveGroupKey(`${GROUP_SUBJECT_CONTEXT}|${canon(cohortKey)}|${bucket}`, identity);
}

/**
 * Every bucket whose rows can still be alive at `nowMs` — the search space a
 * revocation has to cover. Bounded by the TTL ceiling (at most 145 entries at a
 * 30-minute period), which is what makes identity-free revocation tractable:
 * without a ceiling this list would be unbounded and revocation would need a
 * lookup key, i.e. an identity.
 */
export function liveSensingBucketStarts(nowMs: number): number[] {
  const current = sensingBucketStartMs(nowMs);
  const horizon = nowMs - SENSING_MAX_TTL_SECONDS * 1000;
  const out: number[] = [];
  for (let b = current; b > horizon; b -= PERIOD_MS) out.push(b);
  return out;
}

/** What a caller hands the writer. Note the absence of any identity field. */
export interface SensingContributionInput {
  /** The client-held revocation/rotation secret. Never stored. */
  secret: string;
  /** Opaque cohort/coverage grouping label. Never a coordinate, never an FK. */
  cohortKey: string;
  signalKind: SensingSignalKind;
  signalBand: SensingSignalBand;
  /** Instant of the contribution; floored onto the rotation grid. */
  atMs: number;
  /** Evaluation clock. Defaults to Date.now(). */
  nowMs?: number;
  /** Lifetime from the bucket start. Defaults to 24h, hard-capped at 72h. */
  ttlSeconds?: number;
  /** An ATTESTED party identity, when one exists. Null (the norm) ⇒ no group. */
  groupIdentity?: GroupIdentity | null;
}

/** Exactly the columns migration 2315 declares, minus nothing and plus nothing. */
export interface SensingContributionRow {
  rotation_id: string;
  revocation_tag: string;
  group_key: string | null;
  cohort_key: string;
  bucket_start: string;
  signal_kind: SensingSignalKind;
  signal_band: SensingSignalBand;
  expires_at: string;
}

export type SensingRejectionReason =
  | "invalid_secret"
  | "invalid_cohort_key"
  | "invalid_signal_kind"
  | "invalid_signal_band"
  | "invalid_instant"
  | "invalid_ttl"
  | "already_expired"
  | "write_failed";

export type SensingBuildResult =
  | { ok: true; row: SensingContributionRow }
  | { ok: false; reason: SensingRejectionReason };

/**
 * Build one contribution row. PURE: no clock of its own beyond the one passed
 * in, no I/O, no randomness — every value is derived, so the same input always
 * produces the same row and the whole shape is testable without a database.
 *
 * Fail-closed on every malformed input. A refusal is a refusal, never a
 * substituted default: a silently corrected TTL or an invented band would be a
 * row asserting something nobody sensed.
 */
export function buildSensingContributionRow(input: SensingContributionInput): SensingBuildResult {
  const secret = typeof input?.secret === "string" ? input.secret.trim() : "";
  if (secret.length < 16) return { ok: false, reason: "invalid_secret" };

  const cohortKey = typeof input.cohortKey === "string" ? input.cohortKey.trim() : "";
  if (cohortKey.length === 0 || cohortKey.length > MAX_COHORT_KEY_LENGTH) {
    return { ok: false, reason: "invalid_cohort_key" };
  }

  if (!SENSING_SIGNAL_KINDS.includes(input.signalKind)) {
    return { ok: false, reason: "invalid_signal_kind" };
  }
  if (!SENSING_SIGNAL_BANDS.includes(input.signalBand)) {
    return { ok: false, reason: "invalid_signal_band" };
  }

  const nowMs = input.nowMs === undefined ? Date.now() : input.nowMs;
  if (!Number.isFinite(input.atMs) || !Number.isFinite(nowMs)) {
    return { ok: false, reason: "invalid_instant" };
  }
  const bucketStartMs = sensingBucketStartMs(input.atMs);
  // A bucket that has not started yet cannot have been sensed. Refusing forward
  // dating also stops a caller extending its own retention past the ceiling by
  // claiming a future bucket.
  if (bucketStartMs > sensingBucketStartMs(nowMs)) {
    return { ok: false, reason: "invalid_instant" };
  }

  const ttlSeconds = input.ttlSeconds === undefined ? SENSING_DEFAULT_TTL_SECONDS : input.ttlSeconds;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > SENSING_MAX_TTL_SECONDS) {
    return { ok: false, reason: "invalid_ttl" };
  }

  const expiresAtMs = bucketStartMs + ttlSeconds * 1000;
  // A row born expired is invisible to every reader and would only ever be
  // storage. Refuse it here rather than write it and filter it forever.
  if (expiresAtMs <= nowMs) return { ok: false, reason: "already_expired" };

  const groupKey = deriveSensingGroupKey(cohortKey, bucketStartMs, input.groupIdentity ?? null);

  return {
    ok: true,
    row: {
      rotation_id: deriveSensingRotationId(secret, bucketStartMs, cohortKey),
      revocation_tag: deriveSensingRevocationTag(secret, bucketStartMs),
      group_key: groupKey,
      cohort_key: cohortKey,
      bucket_start: new Date(bucketStartMs).toISOString(),
      signal_kind: input.signalKind,
      signal_band: input.signalBand,
      expires_at: new Date(expiresAtMs).toISOString(),
    },
  };
}

export type SensingWriteResult = { ok: true } | { ok: false; reason: SensingRejectionReason };

/**
 * Persist one contribution. Called by nothing today — the capture path is not
 * part of this foundation.
 */
export async function writeSensingContribution(
  sc: SensingDbClient,
  input: SensingContributionInput,
): Promise<SensingWriteResult> {
  const built = buildSensingContributionRow(input);
  if (!built.ok) return built;
  try {
    const { error } = await sc.from(SENSING_TABLE).insert(built.row);
    if (error) return { ok: false, reason: "write_failed" };
    return { ok: true };
  } catch {
    // supabase-js resolves on a DB error, so reaching here means a transport
    // failure. Either way the contribution did not land, and saying so is the
    // whole contract — a silent success would report privacy-relevant data as
    // stored when it is not.
    return { ok: false, reason: "write_failed" };
  }
}

/** The projection the aggregation reads. Note: no contribution_id, no tag. */
export interface SensingCohortRow {
  rotation_id: string;
  group_key: string | null;
  signal_kind: SensingSignalKind;
  signal_band: SensingSignalBand;
  expires_at: string;
}

/**
 * The columns the reader selects. `revocation_tag` is deliberately absent: the
 * aggregation has no use for it, and the one place its cross-cohort linkage
 * could be exploited is a process holding many rows at once. Keeping it out of
 * the read is a cheap structural narrowing of that exposure.
 */
const COHORT_SELECT = "rotation_id, group_key, signal_kind, signal_band, expires_at";

/**
 * Read one (cohort, bucket)'s live contributions. Expiry is filtered at the
 * database AND again in `aggregateSensingCohort`, on purpose: nothing sweeps
 * this table on a schedule, so "expired" has to mean "unreadable" everywhere
 * rather than "eventually deleted".
 */
export async function readSensingCohort(
  sc: SensingDbClient,
  params: { cohortKey: string; bucketStartMs: number; nowMs?: number },
): Promise<SensingCohortRow[]> {
  const nowIso = new Date(params.nowMs === undefined ? Date.now() : params.nowMs).toISOString();
  const bucketIso = new Date(sensingBucketStartMs(params.bucketStartMs)).toISOString();
  try {
    const { data, error } = await sc
      .from(SENSING_TABLE)
      .select(COHORT_SELECT)
      .eq("cohort_key", params.cohortKey)
      .eq("bucket_start", bucketIso)
      .gt("expires_at", nowIso);
    if (error || !Array.isArray(data)) return [];
    return data as SensingCohortRow[];
  } catch {
    // Fail-closed: an unreadable cohort is an empty cohort, which suppresses.
    return [];
  }
}

export interface SensingCohortAggregate {
  /** Live contributions considered (expired rows excluded). */
  contributions: number;
  /** Distinct PEOPLE, as distinct rotating pseudonyms within this one bucket. */
  distinctActors: number;
  /** Attested independent groups, from lib/intelIndependence. */
  distinctGroups: number;
  /** Largest group's actor share, from lib/intelIndependence. */
  maxGroupShare: number;
  /** The gate's verdict — this module never overrides it. */
  decision: PrivacyDecision;
  /**
   * The payload, present ONLY when the gate said publish. A suppressed
   * aggregate returns null rather than a body with a false flag beside it: a
   * caller that forgets to read the flag must get nothing, not everything.
   */
  published: { bands: Record<SensingSignalBand, number> } | null;
}

/**
 * Assemble the cohort and route the publish decision through the privacy gate.
 *
 * PURE. It counts, it clusters, it asks — it never decides. distinctActors is
 * counted over DISTINCT rotation_id, which is the truthful distinct-PERSON count
 * precisely because the pseudonym rotates on the aggregation clock (see header).
 */
export function aggregateSensingCohort(
  rows: readonly SensingCohortRow[],
  params: {
    bucketStartMs: number;
    nowMs: number;
    threshold?: PrivacyThreshold;
    sensitiveSubject?: boolean;
  },
): SensingCohortAggregate {
  const nowMs = params.nowMs;
  const live = (rows ?? []).filter((r) => {
    const exp = Date.parse(r?.expires_at ?? "");
    return Number.isFinite(exp) && exp > nowMs;
  });

  const actors = new Set<string>();
  for (const r of live) if (r.rotation_id) actors.add(r.rotation_id);

  // Group accounting is delegated, not reimplemented. Two of clusterByIndependence's
  // three merge detectors are STARVED here on purpose:
  //   * mediaRefs / sourceRefs are empty because an anonymous sensing
  //     contribution carries no evidence artifact and no supplier reference —
  //     there is nothing truthful to cluster on;
  //   * observedAtMs is NaN (which the module documents as "excluded from sync
  //     detection") because the only time this store knows is the bucket, which
  //     every row in the cohort shares. Feeding it in would read the whole
  //     cohort as perfectly synchronized and collapse every honest contributor
  //     into one cluster.
  // What survives is exactly the accounting we want: an attested group_key is a
  // group, a null group_key is no group, and the share is actor-based.
  const clustering = clusterByIndependence(
    live.map((r) => ({
      actorId: r.rotation_id,
      groupKey: r.group_key,
      valueKey: `${r.signal_kind}:${r.signal_band}`,
      observedAtMs: Number.NaN,
      mediaRefs: [] as readonly string[],
      sourceRefs: [] as readonly string[],
    })),
  );

  const bucketStartMs = sensingBucketStartMs(params.bucketStartMs);
  // The bucket END, not its start: an aggregate is only complete once its window
  // has closed, so the publication delay is measured from the later instant.
  const observedAt = bucketStartMs + PERIOD_MS;

  const decision = evaluatePrivacy(
    {
      distinctActors: actors.size,
      distinctGroups: clustering.distinctGroups,
      maxGroupShare: clustering.maxGroupShare,
      observedAt,
      now: nowMs,
      sensitiveSubject: params.sensitiveSubject,
    },
    params.threshold ?? PRIVACY_THRESHOLD_V1,
  );

  let published: SensingCohortAggregate["published"] = null;
  if (decision.publishable) {
    const bands: Record<SensingSignalBand, number> = { low: 0, moderate: 0, high: 0 };
    for (const r of live) {
      if (r.signal_band in bands) bands[r.signal_band] += 1;
    }
    published = { bands };
  }

  return {
    contributions: live.length,
    distinctActors: actors.size,
    distinctGroups: clustering.distinctGroups,
    maxGroupShare: clustering.maxGroupShare,
    decision,
    published,
  };
}

export interface SensingRevocationResult {
  ok: boolean;
  /** How many bucket tags were presented — the whole live TTL window. */
  bucketsCovered: number;
}

/**
 * Revoke every live contribution made by the holder of `secret`.
 *
 * The entire operation is: derive tags, delete by tag. No user id is read, none
 * is written, and no table outside `sensing_contributions` is touched — which is
 * the property that lets this store honour erasure while carrying no FK to
 * profiles or auth.users.
 */
export async function revokeSensingContributions(
  sc: SensingDbClient,
  params: { secret: string; nowMs?: number },
): Promise<SensingRevocationResult> {
  const secret = typeof params?.secret === "string" ? params.secret.trim() : "";
  if (secret.length < 16) return { ok: false, bucketsCovered: 0 };
  const nowMs = params.nowMs === undefined ? Date.now() : params.nowMs;
  if (!Number.isFinite(nowMs)) return { ok: false, bucketsCovered: 0 };

  const tags = liveSensingBucketStarts(nowMs).map((b) => deriveSensingRevocationTag(secret, b));
  try {
    const { error } = await sc.from(SENSING_TABLE).delete().in("revocation_tag", tags);
    if (error) return { ok: false, bucketsCovered: tags.length };
    return { ok: true, bucketsCovered: tags.length };
  } catch {
    // A revocation that failed must not report success — the rows are still there.
    return { ok: false, bucketsCovered: tags.length };
  }
}

/**
 * Physically remove expired rows. Deliberately NOT scheduled: this foundation
 * wires nothing into a live path. Until something calls it, the TTL is enforced
 * by the write-time CHECK and by every reader refusing expired rows, so an
 * unswept row is unreadable rather than merely undeleted.
 */
export async function purgeExpiredSensingContributions(
  sc: SensingDbClient,
  nowMs: number,
): Promise<{ ok: boolean }> {
  if (!Number.isFinite(nowMs)) return { ok: false };
  try {
    const { error } = await sc
      .from(SENSING_TABLE)
      .delete()
      .lte("expires_at", new Date(nowMs).toISOString());
    return { ok: !error };
  } catch {
    return { ok: false };
  }
}

/** True iff `value` has the stored digest shape. Used by the tests and callers. */
export function isSensingDigest(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}
