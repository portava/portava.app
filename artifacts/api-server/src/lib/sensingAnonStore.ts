/**
 * sensingAnonStore — the typed contract over the anonymous sensing store
 * (migration 2315, public.sensing_anon_contributions).
 *
 * ── WHAT THIS IS, AND WHAT IT IS NOT ─────────────────────────────────────────
 * The owner ruling this implements, verbatim:
 *
 *   "A short-lived anonymous sensing contribution/aggregation store IS allowed
 *    even though intel_observations requires actor_id. It is not a second intel
 *    lifecycle. Existing intel evidence -> claims -> snapshots remains canonical.
 *    The anonymous store may only own privacy-reduced sensor contributions,
 *    rotating IDs, TTL, cohort/coverage aggregation and revocation. It must not
 *    duplicate claim/review/status/conflict/snapshot semantics and must not
 *    contain a permanent profiles/user FK."
 *
 * So this module writes, reads, expires and revokes contributions, and nothing
 * else. There is no promote(), no confirm(), no supersede(), no status
 * transition, no conflict predicate and no snapshot: a contribution is written
 * once, counted while fresh, and then expires or is revoked. Every claim in this
 * product is still made by intel_observations -> intel_claims ->
 * intel_state_snapshots, which this file does not import, read or write.
 *
 * ── INERT ────────────────────────────────────────────────────────────────────
 * Nothing outside this module's tests imports it. There is no route, scheduler,
 * job or feature flag behind it. It is a contract, waiting for a decision to use
 * it.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE ROTATING ID, AND HOW REVOCATION WORKS WITHOUT AN IDENTITY
 * ══════════════════════════════════════════════════════════════════════════════
 * The hard problem: to revoke your contributions you must prove they are yours,
 * and the usual proof is an account. There is no account here — that is the whole
 * point of the store — so the proof has to be a CRYPTOGRAPHIC one instead of an
 * IDENTITY one.
 *
 * A device holds one long-lived random `deviceSecret` that NEVER leaves it.
 *
 *   epochSecret  = HMAC(deviceSecret, "sensing-anon/epoch/v1|<epoch>")
 *                    device-only. Never transmitted, never stored.
 *   commitment   = SHA-256(epochSecret)
 *                    a ONE-WAY commitment. This is what a contribution carries.
 *   token        = HMAC(serverPepper, "sensing-anon/contributor/v1|<epoch>|<commitment>")
 *                    derived SERVER-side and stored as contributor_token.
 *
 * Writing:    the device sends {commitment, epoch, reduced payload}. The server
 *             derives the token and stores it. No identity is presented because
 *             none exists.
 * Counting:   within one epoch the token is stable, so distinct contributors are
 *             countable. Across epochs it is a fresh PRF output, so no long-lived
 *             pseudonym accumulates and two epochs cannot be joined.
 * Revoking:   the device REVEALS `epochSecret` for the epochs it wants erased.
 *             The server re-derives commitment -> token and deletes those rows.
 *             It has proved ownership by exhibiting the preimage of a stored
 *             commitment, which only the holder of `deviceSecret` can produce.
 *
 * Four properties that make this hold up:
 *
 *   1. NO IDENTITY IS EVER PRESENTED. `SensingRevocation` has exactly two fields,
 *      an epoch number and a secret. There is no field an account id could
 *      occupy, and the SQL function it calls takes only (epoch, token).
 *   2. KNOWING A TOKEN IS NOT ENOUGH TO REVOKE. contributor_token is stored in
 *      the clear; if it were the revocation credential, anyone with table access
 *      could erase anyone's contributions. Revocation needs the epochSecret,
 *      which is a preimage nobody else has.
 *   3. REVEALING ONE EPOCH REVEALS NO OTHER. Each epochSecret is an independent
 *      HMAC output under deviceSecret, so disclosing epoch 7 tells the server
 *      nothing about epoch 6 or 8. Revocation is therefore scoped, not total.
 *   4. THE WORK IS BOUNDED BY THE TTL. Rows live at most 72 hours, so "revoke
 *      everything" means walking only the handful of unexpired epochs — the
 *      device never needs an index of what it has ever sent.
 *
 * THE SERVER PEPPER, AND ITS ONE FAILURE MODE. contributor_token is keyed under a
 * server pepper so a leaked table cannot be correlated by an outsider who learns a
 * device secret. The cost is that revocation depends on the pepper being the same
 * one the row was written under: if the pepper is rotated, rows written before the
 * rotation become unrevokable and survive to their expiry instead. Because the
 * store is short-lived by construction, the blast radius of that mistake is
 * bounded at 72 hours — but the pepper should still be treated as stable, exactly
 * as lib/intelGroupKey documents for its own key.
 *
 * ── FAIL-CLOSED ──────────────────────────────────────────────────────────────
 * Every derivation refuses rather than guesses: no pepper, no token (throw, never
 * a constant fallback, or the token would be forgeable). Every read reports
 * failure as failure — `readSensingCohort` returns a discriminated result and
 * never an empty array standing in for an error, so a broken read cannot be
 * mistaken for an empty cohort or, worse, be papered over with a count.
 */
import { createHmac, createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PRIVACY_THRESHOLD_V1, MAX_OBSERVED_AT_SKEW_MS } from "./intelContracts.js";

/** The store. */
export const SENSING_TABLE = "sensing_anon_contributions";

/**
 * How far in the past a contribution's time bucket may lie, in seconds.
 *
 * Equal to the TTL ceiling on purpose: a reading older than the longest any row
 * can live has no cohort it could honestly still be counted in. The forward
 * bound is the intel path's MAX_OBSERVED_AT_SKEW_MS (60 s), reused rather than
 * restated. Both are mirrored by the CHECK migration 2340 adds on
 * (time_bucket, created_at); the SQL remains authoritative and this exists so a
 * caller is refused before the round trip with a named error.
 *
 * Before 2340 the only timestamp check was that the claimed epoch matched the
 * instant — and a device chooses both, so a reading twenty hours in the future
 * or a week in the past was stored into a cohort it had no business in.
 */
export const SENSING_MAX_OBSERVATION_AGE_SECONDS = 72 * 60 * 60;

/**
 * How long a contributor token stays stable before it rotates.
 *
 * It must be a whole multiple of the privacy time bucket, or a cohort could
 * straddle a rotation boundary and one contributor would appear as two — an
 * INFLATED distinct-actor count, the one direction of error the privacy gate
 * cannot tolerate. 3600 over a 30-minute bucket satisfies that; a guard test
 * pins the relationship so a later edit to either number cannot break it
 * silently.
 */
export const SENSING_ROTATION_PERIOD_SECONDS = 3600;

/** Default lifetime of one contribution. Mirrors the `journey_observation` purpose's 24h. */
export const SENSING_DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/**
 * Hard ceiling, mirroring the CHECK in 2315. "Short-lived" is enforced by the
 * database; this constant exists so a caller is refused before the round trip,
 * not so the rule lives in two places — the SQL remains authoritative.
 */
export const SENSING_MAX_TTL_SECONDS = 72 * 60 * 60;

/**
 * Which reduction pipeline produced `signalBucket`. The MEANING of the ordinal
 * lives here, in code under review, and not in a SQL vocabulary — see 2315's
 * "why there is no sensor / channel vocabulary".
 */
export const SENSING_REDUCTION_VERSION = 1;

/** The ordinal band, matching the CHECK in 2315. */
export const SENSING_BUCKET_MIN = 0;
export const SENSING_BUCKET_MAX = 4;

const EPOCH_CONTEXT = "sensing-anon/epoch/v1";
const CONTRIBUTOR_CONTEXT = "sensing-anon/contributor/v1";
const GROUP_CONTEXT = "sensing-anon/group/v1";

/**
 * The server pepper. Prefer a dedicated SENSING_CONTRIBUTOR_PEPPER; fall back to
 * INTEL_GROUP_KEY_SECRET and then SESSION_SECRET, which the server requires at
 * boot (lib/envValidation), so one is always present in a valid run. There is NO
 * constant fallback: a guessable pepper would let anyone mint or recognise a
 * contributor token, which is the whole security of this design.
 */
function sensingPepper(): string {
  const secret =
    process.env.SENSING_CONTRIBUTOR_PEPPER ??
    process.env.INTEL_GROUP_KEY_SECRET ??
    process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "SENSING_CONTRIBUTOR_PEPPER, INTEL_GROUP_KEY_SECRET or SESSION_SECRET is required to derive a sensing contributor token (privacy-critical, no fallback).",
    );
  }
  return secret;
}

/**
 * Canonicalise an identity-ish component before hashing. Same hazard, and same
 * fix, as lib/intelGroupKey: two representations of one value that the validators
 * treat as equal must not hash to two tokens, or one contributor SPLITS into two
 * and inflates the cohort.
 */
function canon(s: string): string {
  return s.trim().toLowerCase();
}

// ── Rotation ─────────────────────────────────────────────────────────────────

/** The rotation epoch containing `atMs`. Monotonic, aligned to the period. */
export function rotationEpochFor(atMs: number): number {
  if (!Number.isFinite(atMs)) throw new Error("rotationEpochFor: instant must be finite");
  return Math.floor(atMs / 1000 / SENSING_ROTATION_PERIOD_SECONDS);
}

/**
 * DEVICE SIDE. Derives the per-epoch secret from the device's long-lived secret.
 * Exported so the contract is testable and so a future client has one definition
 * to implement — it is never called on a request path, and `deviceSecret` must
 * never be transmitted.
 */
export function deriveEpochSecret(deviceSecret: string, epoch: number): string {
  if (!deviceSecret) throw new Error("deriveEpochSecret: device secret is required");
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error("deriveEpochSecret: epoch must be a non-negative integer");
  return createHmac("sha256", deviceSecret).update(`${EPOCH_CONTEXT}|${epoch}`).digest("hex");
}

/**
 * The one-way commitment a contribution carries. SHA-256 of the epoch secret: the
 * server can verify a revealed secret against it, and cannot run it backwards.
 */
export function revocationCommitment(epochSecret: string): string {
  if (!epochSecret) throw new Error("revocationCommitment: epoch secret is required");
  return createHash("sha256").update(canon(epochSecret)).digest("hex");
}

/**
 * SERVER SIDE. The rotating contributor token actually stored. Keyed under the
 * server pepper, so it is not derivable by anyone holding only the commitment.
 */
export function deriveContributorToken(epoch: number, commitment: string): string {
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error("deriveContributorToken: epoch must be a non-negative integer");
  if (!commitment) throw new Error("deriveContributorToken: commitment is required");
  return createHmac("sha256", sensingPepper())
    .update(`${CONTRIBUTOR_CONTEXT}|${epoch}|${canon(commitment)}`)
    .digest("hex");
}

/**
 * SERVER SIDE. The independent-group token, or null.
 *
 * Null is the fail-closed answer and the common one: a contribution with no
 * verifiable party signal earns ZERO group credit in the privacy gate. We never
 * infer that two contributors are two parties — that inference is exactly how a
 * single organised group reads as broad independent corroboration
 * (lib/intelGroupKey's central rule, reused rather than restated).
 *
 * Like intelGroupKey, the epoch is folded INSIDE the HMAC, so a party's token
 * rotates with the contributor tokens and no cross-epoch party graph exists.
 */
export function deriveGroupToken(epoch: number, groupTag: string | null | undefined): string | null {
  if (!groupTag) return null;
  if (!Number.isInteger(epoch) || epoch < 0) return null;
  return createHmac("sha256", sensingPepper())
    .update(`${GROUP_CONTEXT}|${epoch}|${canon(groupTag)}`)
    .digest("hex");
}

// ── Cohort / coverage grouping ───────────────────────────────────────────────

/**
 * Floor an instant to the shared privacy time bucket. The precise moment a device
 * sensed anything is never stored; the bucket is.
 */
export function sensingTimeBucket(
  atMs: number,
  minutes: number = PRIVACY_THRESHOLD_V1.timeBucketMinutes,
): string {
  if (!Number.isFinite(atMs)) throw new Error("sensingTimeBucket: instant must be finite");
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("sensingTimeBucket: bucket minutes must be positive");
  const width = minutes * 60_000;
  return new Date(Math.floor(atMs / width) * width).toISOString();
}

/**
 * The cohort/coverage grouping key. Deterministic and canonicalised, so the
 * writer and the aggregation can never disagree about which rows form one cohort.
 */
export function sensingCohortKey(
  zoneId: string,
  timeBucketIso: string,
  reductionVersion: number = SENSING_REDUCTION_VERSION,
): string {
  if (!zoneId) throw new Error("sensingCohortKey: zoneId is required");
  if (!timeBucketIso) throw new Error("sensingCohortKey: time bucket is required");
  if (!Number.isInteger(reductionVersion) || reductionVersion < 1) {
    throw new Error("sensingCohortKey: reductionVersion must be a positive integer");
  }
  return `v${reductionVersion}|${canon(zoneId)}|${timeBucketIso}`;
}

// ── Row and input shapes ─────────────────────────────────────────────────────

/**
 * One stored contribution. Note what is ABSENT and cannot be added without
 * failing 2315's postconditions: any account or device handle, and any of
 * status / claim_type / value / confidence / conflict / snapshot / review.
 */
export interface SensingContributionRow {
  contributor_token: string;
  rotation_epoch: number;
  group_token: string | null;
  zone_id: string;
  time_bucket: string;
  cohort_key: string;
  signal_bucket: number;
  reduction_version: number;
  created_at: string;
  expires_at: string;
}

/**
 * What a device submits. There is deliberately no field for an account, a device
 * id, or a session — the type makes an identity unrepresentable, not merely
 * unused.
 */
export interface SensingContributionInput {
  /** SHA-256 of the device's epoch secret. The device's only credential. */
  commitment: string;
  /** The rotation epoch the commitment belongs to. */
  rotationEpoch: number;
  /** Optional verifiable party signal; absent means zero group credit. */
  groupTag?: string | null;
  /** Coarse zone label. Never a coordinate. */
  zoneId: string;
  /** When the reading was taken. Reduced to a time bucket before storage. */
  observedAtMs: number;
  /** The reduced ordinal, 0..4. Unitless; meaning pinned by reductionVersion. */
  signalBucket: number;
  ttlSeconds?: number;
  reductionVersion?: number;
}

export type SensingBuildResult =
  | { ok: true; row: SensingContributionRow }
  | { ok: false; error: string };

/**
 * Build the row for one contribution. PURE — takes its instant, touches no clock
 * and no database — so the whole validation and derivation surface is testable
 * without one.
 */
export function buildSensingContributionRow(
  input: SensingContributionInput,
  nowMs: number,
): SensingBuildResult {
  if (!input) return { ok: false, error: "input_required" };
  if (!Number.isFinite(nowMs)) return { ok: false, error: "now_invalid" };
  if (!input.commitment || typeof input.commitment !== "string") return { ok: false, error: "commitment_required" };
  if (!Number.isInteger(input.rotationEpoch) || input.rotationEpoch < 0) return { ok: false, error: "epoch_invalid" };
  if (!input.zoneId || typeof input.zoneId !== "string") return { ok: false, error: "zone_required" };
  if (!Number.isFinite(input.observedAtMs)) return { ok: false, error: "observed_at_invalid" };
  if (
    !Number.isInteger(input.signalBucket) ||
    input.signalBucket < SENSING_BUCKET_MIN ||
    input.signalBucket > SENSING_BUCKET_MAX
  ) {
    return { ok: false, error: "signal_bucket_out_of_range" };
  }

  const reductionVersion = input.reductionVersion ?? SENSING_REDUCTION_VERSION;
  if (!Number.isInteger(reductionVersion) || reductionVersion < 1) return { ok: false, error: "reduction_version_invalid" };

  const ttlSeconds = input.ttlSeconds ?? SENSING_DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) return { ok: false, error: "ttl_invalid" };
  // Refuse before the round trip. The CHECK in 2315 is still the authority; this
  // only means a caller gets a named error instead of a constraint violation.
  if (ttlSeconds > SENSING_MAX_TTL_SECONDS) return { ok: false, error: "ttl_exceeds_maximum" };

  // The epoch a contribution claims must be the epoch it was actually sensed in,
  // or a device could pin one epoch forever and defeat rotation.
  if (rotationEpochFor(input.observedAtMs) !== input.rotationEpoch) {
    return { ok: false, error: "epoch_does_not_match_observation" };
  }

  // Impossible instants (§4.3 "Reject impossible timestamps"). The epoch check
  // above binds the epoch to the instant; nothing bound the instant to the
  // clock, so a device could date a reading into a cohort nobody had reached
  // yet, or one long past. Beyond the intel path's drift allowance is not skew.
  if (input.observedAtMs > nowMs + MAX_OBSERVED_AT_SKEW_MS) {
    return { ok: false, error: "observed_at_in_future" };
  }

  const timeBucket = sensingTimeBucket(input.observedAtMs);
  // Bounded at BUCKET granularity, because the bucket is what the row stores and
  // what 2340's CHECK compares against created_at.
  if (Date.parse(timeBucket) < nowMs - SENSING_MAX_OBSERVATION_AGE_SECONDS * 1000) {
    return { ok: false, error: "observed_at_too_old" };
  }
  const zoneId = canon(input.zoneId);

  return {
    ok: true,
    row: {
      contributor_token: deriveContributorToken(input.rotationEpoch, input.commitment),
      rotation_epoch: input.rotationEpoch,
      group_token: deriveGroupToken(input.rotationEpoch, input.groupTag ?? null),
      zone_id: zoneId,
      time_bucket: timeBucket,
      cohort_key: sensingCohortKey(zoneId, timeBucket, reductionVersion),
      signal_bucket: input.signalBucket,
      reduction_version: reductionVersion,
      created_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + ttlSeconds * 1000).toISOString(),
    },
  };
}

/** True when this contribution's TTL has run out as of `nowMs`. */
export function isSensingContributionExpired(row: SensingContributionRow, nowMs: number): boolean {
  if (!row || !row.expires_at) return true; // fail-closed: unreadable expiry is expired
  const expires = Date.parse(row.expires_at);
  if (!Number.isFinite(expires)) return true;
  return expires <= nowMs;
}

// ── Writer ───────────────────────────────────────────────────────────────────

/**
 * `duplicate: true` means the store already held this contributor's reading for
 * this cohort and wrote nothing — a replay, or an honest retry. Either way the
 * caller's intent is satisfied, so it is a SUCCESS, distinguished so a caller
 * can count replays without ever seeing a second row.
 */
export type SensingWriteResult = { ok: true; duplicate: boolean } | { ok: false; error: string };

/** Postgres unique_violation. Raised by 2340's replay key. */
const UNIQUE_VIOLATION = "23505";

/** Insert one contribution. The client is injected; this module names no credential. */
export async function recordSensingContribution(
  db: SupabaseClient,
  input: SensingContributionInput,
  nowMs: number = Date.now(),
): Promise<SensingWriteResult> {
  const built = buildSensingContributionRow(input, nowMs);
  if (!built.ok) return { ok: false, error: built.error };
  try {
    const { error } = await db.from(SENSING_TABLE).insert(built.row);
    if (error) {
      // Anti-replay (§4.3). The natural identity of a contribution is
      // (cohort_key, contributor_token) — 2340 makes it UNIQUE, so a replay is a
      // unique violation and a unique violation is a no-op, not a failure. The
      // same shape lib/placeIdBridge and intelAttributionScheduler use.
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) return { ok: true, duplicate: true };
      return { ok: false, error: error.message ?? "insert_failed" };
    }
    return { ok: true, duplicate: false };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "insert_threw" };
  }
}

// ── Reader ───────────────────────────────────────────────────────────────────

/**
 * The largest page this reader will fetch. A cohort bigger than this is reported
 * INCOMPLETE rather than truncated-and-counted, because a partial page produces a
 * number that looks like a cohort and is not one.
 */
export const SENSING_READ_LIMIT = 5000;

/**
 * A read either produced the whole cohort, or it did not. There is no third state
 * and no empty-array-means-error: an aggregate built on a silent failure is a
 * confident wrong answer, which is precisely what the privacy gate exists to
 * prevent.
 *
 * `reportedCount` on the failure branch is the count the transport claimed, kept
 * ONLY so a caller can log it. It is deliberately on the FAILURE branch, where no
 * consumer may use it as a cohort size.
 */
export type SensingReadResult =
  | { ok: true; complete: boolean; rows: readonly SensingContributionRow[] }
  | { ok: false; complete: false; rows: readonly SensingContributionRow[]; error: string; reportedCount: number | null };

/** Read one cohort's unexpired contributions. */
export async function readSensingCohort(
  db: SupabaseClient,
  cohortKey: string,
  nowIso: string,
  limit: number = SENSING_READ_LIMIT,
): Promise<SensingReadResult> {
  if (!cohortKey) return { ok: false, complete: false, rows: [], error: "cohort_key_required", reportedCount: null };
  if (!nowIso) return { ok: false, complete: false, rows: [], error: "now_required", reportedCount: null };
  try {
    const { data, error, count } = await db
      .from(SENSING_TABLE)
      .select(
        "contributor_token, rotation_epoch, group_token, zone_id, time_bucket, cohort_key, signal_bucket, reduction_version, created_at, expires_at",
        { count: "exact" },
      )
      .eq("cohort_key", cohortKey)
      .gt("expires_at", nowIso)
      .limit(limit);
    if (error) {
      return {
        ok: false,
        complete: false,
        rows: [],
        error: error.message ?? "read_failed",
        reportedCount: typeof count === "number" ? count : null,
      };
    }
    const rows = (data ?? []) as SensingContributionRow[];
    // A full page is indistinguishable from a truncated one, so it is reported as
    // incomplete. The aggregation refuses on that, which is the safe direction.
    return { ok: true, complete: rows.length < limit, rows };
  } catch (e) {
    return {
      ok: false,
      complete: false,
      rows: [],
      error: e instanceof Error ? e.message : "read_threw",
      reportedCount: null,
    };
  }
}

// ── Revocation ───────────────────────────────────────────────────────────────

/**
 * Everything needed to revoke, and nothing more. Two fields, neither of which is
 * or can hold an identity.
 */
export interface SensingRevocation {
  rotationEpoch: number;
  /** The device's per-epoch secret, revealed only to revoke. */
  epochSecret: string;
}

/**
 * The token a revocation targets. PURE, so the identity-free proof can be
 * asserted in a test without a database: commitment = SHA-256(epochSecret), then
 * the same server-pepper derivation the writer used.
 */
export function revocationTargetToken(revocation: SensingRevocation): string {
  if (!revocation?.epochSecret) throw new Error("revocationTargetToken: epoch secret is required");
  if (!Number.isInteger(revocation.rotationEpoch) || revocation.rotationEpoch < 0) {
    throw new Error("revocationTargetToken: epoch must be a non-negative integer");
  }
  return deriveContributorToken(revocation.rotationEpoch, revocationCommitment(revocation.epochSecret));
}

export type SensingRevokeResult = { ok: true; revoked: number } | { ok: false; error: string };

/**
 * Revoke every contribution made under one device-epoch. The device proves
 * ownership by exhibiting the preimage of a stored commitment; no account, no
 * device id and no session is presented, because the store holds none.
 */
export async function revokeSensingContributions(
  db: SupabaseClient,
  revocation: SensingRevocation,
): Promise<SensingRevokeResult> {
  let token: string;
  try {
    token = revocationTargetToken(revocation);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "revocation_input_invalid" };
  }
  try {
    const { data, error } = await db.rpc("revoke_sensing_contributions", {
      p_rotation_epoch: revocation.rotationEpoch,
      p_contributor_token: token,
    });
    if (error) return { ok: false, error: error.message ?? "revoke_failed" };
    // Coerce, do not type-check. The function returns bigint, and PostgREST does
    // NOT always emit int8 as a JSON number (it exceeds the JS safe-integer
    // range), so a `typeof data === "number"` guard silently reports 0 for every
    // successful revocation — a contributor told nothing was erased when their
    // rows were. lib/intelRetentionScheduler carries the same fix for the same
    // reason.
    return { ok: true, revoked: Number(data) || 0 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "revoke_threw" };
  }
}

/**
 * Apply a revocation to an in-memory set of rows. The database function is the
 * production path; this is the same predicate, exposed so the identity-free
 * property is provable and so a caller can reason about it locally.
 */
export function applySensingRevocation(
  rows: readonly SensingContributionRow[],
  revocation: SensingRevocation,
): SensingContributionRow[] {
  const token = revocationTargetToken(revocation);
  return rows.filter((r) => !(r.rotation_epoch === revocation.rotationEpoch && r.contributor_token === token));
}

// ── Retention ────────────────────────────────────────────────────────────────

export type SensingPurgeResult = { ok: true; deleted: number } | { ok: false; error: string };

/**
 * TTL hygiene. The database CHECK already caps a row's life at 72 hours, so this
 * removes expired rows rather than being the thing that makes them short-lived —
 * a sweep that never runs cannot lengthen a contribution's life here.
 */
export async function purgeExpiredSensingContributions(
  db: SupabaseClient,
  nowIso: string,
): Promise<SensingPurgeResult> {
  if (!nowIso) return { ok: false, error: "now_required" };
  try {
    const { data, error } = await db.rpc("purge_expired_sensing_contributions", { p_now: nowIso });
    if (error) return { ok: false, error: error.message ?? "purge_failed" };
    // Same bigint-over-PostgREST hazard as revokeSensingContributions above: a
    // type-check reports 0 for every real sweep, which is exactly how a working
    // purge reads as an idle one in the logs.
    return { ok: true, deleted: Number(data) || 0 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "purge_threw" };
  }
}
