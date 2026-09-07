/**
 * sensingAnonService — the SERVICE-ROLE bindings for the anonymous sensing store.
 *
 * lib/sensingAnonStore is a contract: every function there takes an injected
 * SupabaseClient and names no credential. This module is the other half — the
 * three places a server process holding the service-role key is permitted to
 * touch that store, bound to the real client, with the preconditions that only
 * a live process can check.
 *
 * ── WHAT THIS IS ALLOWED TO BE, VERBATIM ─────────────────────────────────────
 *
 *   "A short-lived anonymous sensing contribution/aggregation store IS allowed
 *    even though intel_observations requires actor_id. It is not a second intel
 *    lifecycle. Existing intel evidence -> claims -> snapshots remains canonical.
 *    The anonymous store may only own privacy-reduced sensor contributions,
 *    rotating IDs, TTL, cohort/coverage aggregation and revocation. It must not
 *    duplicate claim/review/status/conflict/snapshot semantics and must not
 *    contain a permanent profiles/user FK."
 *
 * Three of the five things that enumeration names live here:
 *
 *   recordAnonSensingContribution     "privacy-reduced sensor contributions"
 *   revokeAnonSensingContributions    "revocation"
 *   assessSensingCohortCoverage       "cohort/coverage aggregation"
 *
 * The fourth, TTL, is lib/sensingRetentionScheduler. The fifth, rotating IDs, is
 * a property of the derivation in lib/sensingAnonStore and needs no binding.
 *
 * ── WHAT THIS DELIBERATELY IS NOT ────────────────────────────────────────────
 * There is NO route here, and no route anywhere calls this. A transport is the
 * step that turns an inert store into a reachable surface, and it forces three
 * privacy decisions this file has no standing to make — the auth posture for a
 * caller with no account, what an anonymous submission budget is keyed on, and
 * how a device is told to reveal an epoch secret. Those are recorded as owner
 * decisions in docs/architecture/sensing-input-gap.md §3.2 and are not taken
 * here. Likewise there is no feature flag, no groupTag producer, no signal
 * vocabulary and no published aggregate: this module computes a decision and
 * hands it back, exactly as lib/sensingCoverageAggregate does.
 *
 * So each function below is an entry point a future, owner-approved caller can
 * use. They are live code with live preconditions; src/test/sensingAnonStore
 * .test.ts holds the allowlist of files permitted to reference this store, so a
 * new caller is a visible act in a diff rather than a quiet one.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE TWO PRECONDITIONS, AND WHY THEY ARE CHECKED HERE AND NOT IN THE STORE
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 1. THE STORE MUST EXIST.
 *
 * Migration 2315 is applied to portava-ci and NOT to production. A process that
 * calls purge/revoke/insert against a database without the table gets an error
 * per attempt, forever, and the store's own functions cannot tell that apart
 * from a transient failure. So this module PROBES for the table and refuses
 * rather than attempts: `store_absent` is a distinct answer from `error`, in the
 * same spirit as lib/intelRetentionScheduler distinguishing `disabled` from
 * `error` — a permanently failing path that reads as a transient one is how a
 * broken job survives a year of green logs.
 *
 * A positive probe is cached for the life of the process (a table does not stop
 * existing); a negative one is NOT cached, so applying 2315 starts the path
 * without needing a restart.
 *
 * 2. A DEDICATED PEPPER MUST BE CONFIGURED.
 *
 * This is the sharp one, and it is the reason this gate exists at all.
 *
 * `sensingPepper()` in lib/sensingAnonStore reads SENSING_CONTRIBUTOR_PEPPER,
 * then INTEL_GROUP_KEY_SECRET, then SESSION_SECRET, and throws if none is set.
 * Only the third has a configured source in this repository. So without this
 * gate, every contributor_token in a real deployment would be keyed on the
 * SESSION-SIGNING SECRET — and the store's own header records the consequence:
 * rotating the pepper makes every row written before the rotation UNREVOKABLE
 * until it expires. Rotating a session secret is a routine security action taken
 * for entirely unrelated reasons. Coupling a privacy guarantee to it means an
 * ordinary credential rotation silently destroys contributors' ability to
 * withdraw, with no error anywhere and no way to notice.
 *
 * The fix is NOT to weaken the store's fallback chain. That chain is correct for
 * a contract module and its unit tests, and its final `throw` is the
 * fail-closed behaviour rather than a gap. The fix is that the only path which
 * can create a real row, or revoke one, requires the dedicated secret. Because
 * SENSING_CONTRIBUTOR_PEPPER is FIRST in the store's chain, requiring it here is
 * exactly equivalent to guaranteeing that every token this server derives — on
 * the write AND on the matching revocation — is keyed under the dedicated pepper
 * and never under SESSION_SECRET.
 *
 * The length floor is part of the same property: the whole security of the
 * design is that a contributor token is not forgeable, so a short or placeholder
 * pepper is a forgeable one. SESSION_SECRET is documented in .env.example as
 * "random 32+ char"; the same floor applies here, checked rather than assumed.
 *
 * Aggregation does NOT require the pepper: it counts tokens already stored and
 * derives nothing. Requiring a secret it does not use would be theatre, and
 * would make a coverage read fail for a reason that has nothing to do with it.
 *
 * ── FAIL-CLOSED, AND NEVER LOGGING THE CREDENTIAL ────────────────────────────
 * Every function returns a discriminated result with a named reason, never a
 * bare boolean. Nothing here logs an epoch secret, a commitment, a contributor
 * token or the pepper — not at debug, not inside an error object. A revocation
 * secret in a log line IS the credential, and a log is a place a contributor
 * never agreed their proof would be kept.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceClient } from "./supabase.js";
import { logger } from "./logger.js";
import {
  SENSING_TABLE,
  recordSensingContribution,
  readSensingCohort,
  revokeSensingContributions,
  sensingCohortKey,
  sensingTimeBucket,
  SENSING_REDUCTION_VERSION,
  type SensingContributionInput,
  type SensingRevocation,
} from "./sensingAnonStore.js";
import {
  aggregateSensingCohort,
  type SensingAggregateOptions,
  type SensingCohortAggregate,
} from "./sensingCoverageAggregate.js";

/**
 * The dedicated pepper's variable name. Kept as a constant so the gate and the
 * documentation cannot drift from the name the store actually reads first —
 * src/test/sensingAnonService.test.ts asserts this exact string appears in
 * lib/sensingAnonStore.ts, which is what makes the equivalence argument above
 * true rather than merely claimed.
 */
export const SENSING_PEPPER_ENV = "SENSING_CONTRIBUTOR_PEPPER";

/**
 * Minimum accepted pepper length. Matches the "random 32+ char secret" already
 * documented for SESSION_SECRET in .env.example. A pepper shorter than this is
 * refused rather than warned about: a guessable pepper lets anyone mint or
 * recognise a contributor token, which is the entire security of the scheme.
 */
export const SENSING_PEPPER_MIN_LENGTH = 32;

/**
 * Why a service call did nothing. Every one of these is a REFUSAL, not a
 * failure to be retried into success:
 *
 *   no_client            the process holds no service-role client at all
 *   store_absent         2315 is not applied to this database
 *   pepper_unconfigured  SENSING_CONTRIBUTOR_PEPPER is unset or blank
 *   pepper_too_weak      it is set but shorter than the floor
 *   invalid_input        the store's own validation refused the input
 *   error                the database rejected or the call threw
 */
export type SensingServiceReason =
  | "no_client"
  | "store_absent"
  | "pepper_unconfigured"
  | "pepper_too_weak"
  | "invalid_input"
  | "error";

// ── Preconditions ────────────────────────────────────────────────────────────

/**
 * True only when a dedicated pepper of adequate length is configured.
 *
 * Deliberately does NOT accept the store's INTEL_GROUP_KEY_SECRET or
 * SESSION_SECRET fallbacks — see the header. Returns a reason rather than a
 * boolean so the caller can say which of the two problems it is; it never
 * returns, logs or hashes the value.
 */
export function sensingPepperPosture(): { ok: true } | { ok: false; reason: SensingServiceReason } {
  const raw = process.env[SENSING_PEPPER_ENV];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { ok: false, reason: "pepper_unconfigured" };
  if (value.length < SENSING_PEPPER_MIN_LENGTH) return { ok: false, reason: "pepper_too_weak" };
  return { ok: true };
}

/** Cached POSITIVE probe result. Never caches absence — see the header. */
let _storePresent = false;
/** So the absence is logged once per process rather than once per pass. */
let _loggedAbsent = false;

/** Test hook: forget the cached probe. Must only be called from test files. */
export function _resetSensingStorePresence(): void {
  _storePresent = false;
  _loggedAbsent = false;
}

/**
 * Is the store actually in this database?
 *
 * A HEAD select of one column: it returns no rows and no contributor data, so
 * the probe itself reads nothing about anybody. Any error at all — the table
 * missing (PostgREST answers PGRST205 for an unknown relation), the database
 * unreachable, a permission problem — is answered `false`, because every one of
 * those means "do not run an irreversible DELETE or an INSERT against this
 * database". Fail-closed in the only direction that is safe.
 */
export async function sensingStorePresent(db: SupabaseClient | any): Promise<boolean> {
  if (!db) return false;
  if (_storePresent) return true;
  try {
    const { error } = await db
      .from(SENSING_TABLE)
      .select("cohort_key", { head: true })
      .limit(1);
    if (error) {
      if (!_loggedAbsent) {
        _loggedAbsent = true;
        logger.info(
          { code: (error as any)?.code ?? null },
          "sensing anon store is not present in this database — sensing service calls will refuse",
        );
      }
      return false;
    }
    _storePresent = true;
    return true;
  } catch {
    // A thrown probe is indistinguishable from an absent table for our purposes,
    // and both answers are "do not touch the store".
    return false;
  }
}

/**
 * The client the store bindings use.
 *
 * `"client" in opts` rather than `opts.client ?? getServiceClient()`: `??` does
 * NOT short-circuit on an explicit null, so a unit test passing `client: null`
 * would get a REAL client and open a socket. lib/intelRetentionScheduler
 * documents that exact defect; this is the same shape for the same reason.
 */
function resolveClient(opts: { client?: any }): any {
  return "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
}

// ── 1. Writing a contribution from a service-role process ────────────────────

export type SensingRecordResult =
  | { ok: true }
  | { ok: false; reason: SensingServiceReason; error?: string };

/**
 * Write one privacy-reduced contribution.
 *
 * The input type has no field an account, device or session could occupy — that
 * is a property of `SensingContributionInput`, not of this function — so there
 * is nothing here to strip. What this adds over the store's own writer is the
 * two preconditions and a named refusal, so a caller can distinguish "the store
 * is not deployed here" from "your input was invalid" from "the insert failed".
 *
 * The table is service_role only with RLS on and no anon/authenticated policy
 * (2315), so this is the only shape a write can take: there is no
 * PostgREST-direct option and granting the anon role INSERT is refused by the
 * migration's postconditions.
 */
export async function recordAnonSensingContribution(
  input: SensingContributionInput,
  opts: { client?: any; nowMs?: number } = {},
): Promise<SensingRecordResult> {
  const pepper = sensingPepperPosture();
  if (!pepper.ok) return { ok: false, reason: pepper.reason };

  const db = resolveClient(opts);
  if (!db) return { ok: false, reason: "no_client" };
  if (!(await sensingStorePresent(db))) return { ok: false, reason: "store_absent" };

  let result;
  try {
    result = await recordSensingContribution(db, input, opts.nowMs ?? Date.now());
  } catch (e) {
    // buildSensingContributionRow throws only on a malformed cohort key or
    // instant; the pepper throw cannot fire because the posture check above
    // already proved a pepper is set. Either way this is not a success.
    logger.warn({ err: e }, "sensing contribution write threw");
    return { ok: false, reason: "error" };
  }
  if (result.ok) return { ok: true };

  // The store's named validation errors (commitment_required, ttl_exceeds_
  // maximum, epoch_does_not_match_observation, ...) are refusals of the INPUT;
  // anything else came back from the database.
  const isValidation = VALIDATION_ERRORS.has(result.error);
  if (!isValidation) logger.warn({ error: result.error }, "sensing contribution insert failed");
  return { ok: false, reason: isValidation ? "invalid_input" : "error", error: result.error };
}

/**
 * The store's own pre-flight refusals, enumerated from
 * buildSensingContributionRow. Kept as a set rather than a substring match so a
 * database error message that happens to contain one of these words is not
 * misreported as a caller mistake.
 */
const VALIDATION_ERRORS = new Set([
  "input_required",
  "now_invalid",
  "commitment_required",
  "epoch_invalid",
  "zone_required",
  "observed_at_invalid",
  "signal_bucket_out_of_range",
  "reduction_version_invalid",
  "ttl_invalid",
  "ttl_exceeds_maximum",
  "epoch_does_not_match_observation",
]);

// ── 2. Server-side revocation ────────────────────────────────────────────────

export type SensingRevokeServiceResult =
  | { ok: true; revoked: number }
  | { ok: false; reason: SensingServiceReason; error?: string };

/**
 * Revoke every contribution a device made in one rotation epoch, from a
 * device-presented epoch secret.
 *
 * THE PROOF IS CRYPTOGRAPHIC, NOT AN IDENTITY. The device reveals the epoch
 * secret whose SHA-256 it committed to when it contributed; the server
 * re-derives commitment -> contributor_token under the server pepper and deletes
 * by (epoch, token). Nothing on this path is or could be an account: the input
 * has exactly two fields, the SQL function takes exactly (bigint, text), and the
 * table holds no identity column it could have consulted instead.
 *
 * Knowing a stored token is NOT enough to revoke. contributor_token is stored in
 * the clear, so if it were the credential, anyone with table access could erase
 * anyone's contributions. The credential is the PREIMAGE, which only the holder
 * of the device secret can produce.
 *
 * THE PEPPER GATE IS LOad-BEARING HERE, not just on the write. Re-derivation has
 * to happen under the same pepper the row was written under. Requiring the
 * dedicated pepper on both sides is what makes that true across a SESSION_SECRET
 * rotation — the failure mode the store's header calls out, where prior rows
 * become unrevokable and survive to their expiry.
 *
 * Zero rows deleted is a SUCCESS, not a failure: it means nothing of that
 * device-epoch was still stored — already expired, already swept, or never
 * written. There is nothing to report to a contributor except that they now have
 * nothing there.
 */
export async function revokeAnonSensingContributions(
  revocation: SensingRevocation,
  opts: { client?: any } = {},
): Promise<SensingRevokeServiceResult> {
  const pepper = sensingPepperPosture();
  if (!pepper.ok) return { ok: false, reason: pepper.reason };

  const db = resolveClient(opts);
  if (!db) return { ok: false, reason: "no_client" };
  if (!(await sensingStorePresent(db))) return { ok: false, reason: "store_absent" };

  let result;
  try {
    result = await revokeSensingContributions(db, revocation);
  } catch (e) {
    // Never widen this to include the input: `e` may carry the caller's frame,
    // but the revocation object holds the epoch secret and must not be logged.
    logger.warn({ err: e instanceof Error ? e.message : "threw" }, "sensing revocation threw");
    return { ok: false, reason: "error" };
  }
  if (!result.ok) {
    logger.warn({ error: result.error }, "sensing revocation failed");
    return { ok: false, reason: "error", error: result.error };
  }
  // Count only. Which epoch was revoked is itself a fact about one contributor.
  if (result.revoked > 0) logger.info({ revoked: result.revoked }, "sensing contributions revoked");
  return { ok: true, revoked: result.revoked };
}

// ── 3. Cohort / coverage aggregation ─────────────────────────────────────────

export interface SensingCohortRequest {
  /** The coarse zone label the cohort is grouped on. Never a coordinate. */
  zoneId: string;
  /** Any instant inside the wanted time bucket; it is floored, never stored. */
  observedAtMs: number;
  reductionVersion?: number;
}

export type SensingCoverageResult =
  | { ok: true; cohortKey: string; aggregate: SensingCohortAggregate }
  | { ok: false; reason: SensingServiceReason; error?: string };

/**
 * Read one cohort and turn it into a publish DECISION.
 *
 * The decision is `aggregateSensingCohort`'s, unchanged — this function computes
 * the cohort key, performs the read, and hands the READ RESULT (not rows) to the
 * aggregation, which is what makes it impossible to aggregate a failed read.
 * There is no threshold arithmetic here and no second copy of the privacy gate.
 *
 * NOTE THE ASYMMETRY IN THE RETURN, IT IS DELIBERATE. `ok: false` means we never
 * looked (no client, store absent). A read that failed or came back incomplete
 * returns `ok: true` with an aggregate whose reason is `read_failed` or
 * `read_incomplete` and `publishable: false` — because that distinction is
 * precisely what lib/sensingCoverageAggregate exists to preserve: "we could not
 * look" must never be collapsed into "we looked and there were too few people".
 *
 * A `publishable: true` verdict is a PERMISSION, not an instruction. Nothing
 * here publishes anything; whether an aggregate reaches a user-visible surface
 * is an owner decision (sensing-input-gap.md §3.2) and no consumer exists.
 */
export async function assessSensingCohortCoverage(
  request: SensingCohortRequest,
  opts: { client?: any } & SensingAggregateOptions = {},
): Promise<SensingCoverageResult> {
  const db = resolveClient(opts);
  if (!db) return { ok: false, reason: "no_client" };
  if (!(await sensingStorePresent(db))) return { ok: false, reason: "store_absent" };

  const nowMs = opts.nowMs ?? Date.now();
  let cohortKey: string;
  try {
    cohortKey = sensingCohortKey(
      request.zoneId,
      sensingTimeBucket(request.observedAtMs),
      request.reductionVersion ?? SENSING_REDUCTION_VERSION,
    );
  } catch (e) {
    return { ok: false, reason: "invalid_input", error: e instanceof Error ? e.message : "cohort_key_invalid" };
  }

  const read = await readSensingCohort(db, cohortKey, new Date(nowMs).toISOString());
  if (!read.ok) logger.warn({ error: read.error }, "sensing cohort read failed");

  return {
    ok: true,
    cohortKey,
    aggregate: aggregateSensingCohort(read, {
      nowMs,
      threshold: opts.threshold,
      sensitiveSubject: opts.sensitiveSubject,
    }),
  };
}
