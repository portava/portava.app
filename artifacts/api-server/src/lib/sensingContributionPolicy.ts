/**
 * sensingContributionPolicy — the S1 privacy contract for anonymous sensing.
 *
 * Sensing spec step S1 (docs/specs/Portava_Sensing_World_Experience_Intelligence_
 * Upgrade_Architecture_v1.txt:242): "Define purpose scopes, contribution
 * credential/session, rotating IDs, retention, precision ladder, sensitive
 * locations, cohort thresholds and revocation USING EXISTING POLICY
 * PRIMITIVES." And §4.2: "introduce a canonical contribution-session contract
 * if no equivalent exists. It should represent authorization and sampling
 * policy, not world truth. … Do not add this table blindly."
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 * The CONTRACT — a typed policy object carrying every property §4.2 lists for
 * IntelligenceContributionSession, each one bound to the primitive that already
 * owns it, plus one pure admission function a future ingest would call. It is
 * the S0 reuse map's answer to "no existing owner to extend": the SESSION has no
 * owner, but every PROPERTY of the session does, and this file composes them
 * rather than inventing a parallel policy store.
 *
 *   purpose_scopes        §3's seven verbs, verbatim (CONTRIBUTION_PURPOSE_SCOPES)
 *   credential            the rotating commitment lib/sensingAnonStore derives
 *   precision_ceiling     lib/presence/domain/types PRECISION_LADDER
 *   sampling_policy       2340's replay key: one contribution per cohort
 *   retention_policy      2315's 72 h ceiling and the store's 24 h default
 *   privacy_budget        the part that exists (per cohort) and the part that
 *                         is an owner decision (per device), stated as such
 *   expiry / revocation   rotation epochs and the epoch-secret reveal
 *   client_capability     reduction_version
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
 * There is NO issuer, NO table and NO route. Issuing a session to a device is
 * exactly the auth-posture decision docs/architecture/sensing-input-gap.md §3.2
 * classifies as the owner's — whether a caller with no account may obtain a
 * credential, or an account presents a token and the identity is discarded.
 * This file has no standing to take it, so `IssuedContributionSession` is a
 * type and `sessionIsActive` a predicate; nothing here creates one. Nothing
 * here reaches a database or a clock: every function takes its instant.
 *
 * ── THE FOUR SCOPES THAT ARE NOT GRANTED, AND WHY THAT IS THE POINT ──────────
 * §3 requires that "collect, retain, aggregate, infer, personalize, surface and
 * share are distinct permissions". The owner ruling permits the anonymous store
 * to own "privacy-reduced sensor contributions, rotating IDs, TTL,
 * cohort/coverage aggregation and revocation" — collect, retain, aggregate.
 * It says nothing about inferring from, personalising on, surfacing or sharing
 * an aggregate, so those four are NOT GRANTED here, and an input that requests
 * one is refused. The verbs are distinct permissions precisely because the
 * default for the ones nobody decided is "no".
 */
import { FEATURE_PRECISION_CEILING, type LocationPrecision } from "../presence/domain/types.js";
import { PRIVACY_THRESHOLD_V1 } from "./intelContracts.js";
import {
  SENSING_DEFAULT_TTL_SECONDS,
  SENSING_MAX_TTL_SECONDS,
  SENSING_MAX_OBSERVATION_AGE_SECONDS,
  SENSING_REDUCTION_VERSION,
  SENSING_ROTATION_PERIOD_SECONDS,
  buildSensingContributionRow,
  rotationEpochFor,
  type SensingContributionInput,
  type SensingContributionRow,
} from "./sensingAnonStore.js";

// ── Purpose scopes ───────────────────────────────────────────────────────────

/** §3's seven verbs, verbatim. Each is a DISTINCT permission. */
export const CONTRIBUTION_PURPOSE_SCOPES = [
  "collect",
  "retain",
  "aggregate",
  "infer",
  "personalize",
  "surface",
  "share",
] as const;
export type ContributionPurposeScope = (typeof CONTRIBUTION_PURPOSE_SCOPES)[number];

/**
 * The scopes the owner ruling grants the anonymous store, and no others.
 * "privacy-reduced sensor contributions" ⇒ collect; "TTL" ⇒ retain (bounded);
 * "cohort/coverage aggregation" ⇒ aggregate. infer / personalize / surface /
 * share are owner decisions and read as NOT granted.
 */
export const SENSING_ANON_GRANTED_SCOPES: readonly ContributionPurposeScope[] = [
  "collect",
  "retain",
  "aggregate",
] as const;

export function isContributionPurposeScope(v: unknown): v is ContributionPurposeScope {
  return typeof v === "string" && (CONTRIBUTION_PURPOSE_SCOPES as readonly string[]).includes(v);
}

// ── The contract ─────────────────────────────────────────────────────────────

/**
 * §4.2's IntelligenceContributionSession, as the POLICY half — everything that
 * is true of every session under one policy version. The issued half (id,
 * starts_at, expires_at, revoked_at) is `IssuedContributionSession`.
 */
export interface IntelligenceContributionPolicy {
  policyVersion: 1;
  /** Which of §3's verbs this policy grants. */
  purposeScopes: readonly ContributionPurposeScope[];
  /**
   * Whether capture may run in the background. NOT DECIDED: client capture is
   * an owner decision (sensing-input-gap.md §3.2, "Client capture at all").
   * Recorded as a value rather than omitted so the gap is visible in the type.
   */
  captureMode: "foreground" | "background" | "either" | "not_decided";
  precision: {
    /**
     * The precision a CONTRIBUTION is stored at. 2315 stores a coarse
     * `zone_id` and no coordinate, which is the ladder's `zone` rung.
     */
    contribution: LocationPrecision;
    /**
     * The precision any INDIVIDUAL may ever be rendered at from this path —
     * the ladder's own crowd_intelligence ceiling (`presence_only`). Only
     * k-gated aggregates leave the store, so no individual is rendered at all;
     * the ceiling is stated so a consumer that tried would be refused by the
     * ladder rather than by convention.
     */
    renderedIndividual: LocationPrecision;
  };
  sampling: {
    /** 2340's replay key: at most one contribution per contributor per cohort. */
    maxContributionsPerCohort: 1;
    /** The cohort's time width — the shared privacy bucket. */
    cohortMinutes: number;
  };
  retention: {
    defaultTtlSeconds: number;
    /** 2315's structural ceiling. A longer row is unrepresentable. */
    maxTtlSeconds: number;
  };
  privacyBudget: {
    /** Bounded by the replay key. */
    maxContributionsPerCohort: 1;
    /**
     * Per-device budget across zones and epochs. NULL = NOT DECIDED: the abuse
     * budget and what it is keyed on is an owner decision (sensing-input-gap.md
     * §3.2, "The abuse budget"). A null here means "no budget beyond the
     * cohort key", which is the honest current state, not a permission.
     */
    maxCohortsPerEpoch: number | null;
  };
  credential: {
    kind: "rotating_commitment";
    /** How long one contributor token stays stable. */
    rotationPeriodSeconds: number;
    /**
     * How many epochs back a credential is still accepted. Equal to the
     * observation-age ceiling in epochs: a credential older than any reading
     * it could carry is stale by construction.
     */
    validityEpochsBack: number;
  };
  revocation: {
    kind: "epoch_secret_reveal";
    /** Revealing one epoch's secret revokes that epoch only. */
    scope: "per_epoch";
  };
  clientCapability: {
    /** The reduction pipeline version an input must declare. */
    reductionVersion: number;
  };
}

/** The one policy in force. Every value is bound to the primitive that owns it. */
export const SENSING_ANON_POLICY_V1: IntelligenceContributionPolicy = Object.freeze({
  policyVersion: 1,
  purposeScopes: SENSING_ANON_GRANTED_SCOPES,
  captureMode: "not_decided",
  precision: {
    contribution: "zone",
    renderedIndividual: FEATURE_PRECISION_CEILING.crowd_intelligence,
  },
  sampling: {
    maxContributionsPerCohort: 1,
    cohortMinutes: PRIVACY_THRESHOLD_V1.timeBucketMinutes,
  },
  retention: {
    defaultTtlSeconds: SENSING_DEFAULT_TTL_SECONDS,
    maxTtlSeconds: SENSING_MAX_TTL_SECONDS,
  },
  privacyBudget: {
    maxContributionsPerCohort: 1,
    maxCohortsPerEpoch: null,
  },
  credential: {
    kind: "rotating_commitment",
    rotationPeriodSeconds: SENSING_ROTATION_PERIOD_SECONDS,
    validityEpochsBack: Math.ceil(SENSING_MAX_OBSERVATION_AGE_SECONDS / SENSING_ROTATION_PERIOD_SECONDS),
  },
  revocation: { kind: "epoch_secret_reveal", scope: "per_epoch" },
  clientCapability: { reductionVersion: SENSING_REDUCTION_VERSION },
}) as IntelligenceContributionPolicy;

/**
 * The issued half of §4.2. A TYPE ONLY: nothing in this tree issues one, because
 * who may obtain a session is the auth-posture decision the owner has not made.
 * Note what is absent — there is no field for an account, device or
 * installation id, for the same reason 2315 refuses those column names.
 */
export interface IssuedContributionSession {
  sessionId: string;
  policy: IntelligenceContributionPolicy;
  startsAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

/** Pure: active iff started, not expired, not revoked, as of `nowMs`. Fail-closed on bad dates. */
export function sessionIsActive(session: IssuedContributionSession, nowMs: number): boolean {
  if (!session || !Number.isFinite(nowMs)) return false;
  if (session.revokedAt !== null) return false;
  const starts = Date.parse(session.startsAt);
  const expires = Date.parse(session.expiresAt);
  if (!Number.isFinite(starts) || !Number.isFinite(expires)) return false;
  return starts <= nowMs && nowMs < expires;
}

// ── Admission ────────────────────────────────────────────────────────────────

/**
 * A decimal coordinate pair smuggled into the zone label. `zone_id` is plain
 * text with no FK (2315), so nothing else stops "40.7128,-74.0060" arriving as
 * a zone. Fail-closed and cheap; a geohash or plus code is not caught here and
 * would need the owner's zone vocabulary (sensing-input-gap.md layer 4).
 */
const COORDINATE_LIKE = /^\s*[-+]?\d{1,3}(?:\.\d+)?\s*[,;/\s]\s*[-+]?\d{1,3}(?:\.\d+)?\s*$/;

/** A contribution as an ingest would receive it: the store's input plus the scopes it asks for. */
export interface SensingAdmissionInput extends SensingContributionInput {
  /** Scopes the caller requests. Absent ⇒ the granted set (collect/retain/aggregate). */
  purposeScopes?: readonly string[];
}

export type SensingAdmissionReason =
  | "policy_required"
  | "input_required"
  | "scope_unknown"
  | "scope_not_granted"
  | "zone_looks_like_coordinates"
  | "ttl_exceeds_retention_policy"
  | "reduction_version_unsupported"
  | "credential_epoch_future"
  | "credential_epoch_stale"
  | string; // the store's own named refusals pass through unchanged

export type SensingAdmission =
  | { admitted: true; row: SensingContributionRow }
  | { admitted: false; reason: SensingAdmissionReason; scope?: string };

/**
 * Would this contribution be admitted under this policy, as of `nowMs`?
 *
 * Order: the cheapest, most absolute refusals first (a scope nobody granted is
 * refused before any arithmetic), then precision, retention, capability and
 * credential validity, then the store's own validation — whose row is what an
 * admitted contribution becomes. PURE: no clock, no I/O, no identity.
 */
export function admitSensingContribution(
  input: SensingAdmissionInput,
  nowMs: number,
  policy: IntelligenceContributionPolicy = SENSING_ANON_POLICY_V1,
): SensingAdmission {
  if (!policy) return { admitted: false, reason: "policy_required" };
  if (!input || !Number.isFinite(nowMs)) return { admitted: false, reason: "input_required" };

  // Purpose scopes — distinct permissions, default deny.
  const requested = input.purposeScopes ?? policy.purposeScopes;
  for (const s of requested) {
    if (!isContributionPurposeScope(s)) return { admitted: false, reason: "scope_unknown", scope: String(s) };
    if (!policy.purposeScopes.includes(s)) return { admitted: false, reason: "scope_not_granted", scope: s };
  }

  // Precision ceiling — the label may not be a coordinate.
  if (typeof input.zoneId === "string" && COORDINATE_LIKE.test(input.zoneId)) {
    return { admitted: false, reason: "zone_looks_like_coordinates" };
  }

  // Retention policy — refused before the store's own ceiling so the reason
  // names the POLICY, which may be tighter than the schema.
  const ttl = input.ttlSeconds ?? policy.retention.defaultTtlSeconds;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > policy.retention.maxTtlSeconds) {
    return { admitted: false, reason: "ttl_exceeds_retention_policy" };
  }

  // Client capability.
  const rv = input.reductionVersion ?? policy.clientCapability.reductionVersion;
  if (rv !== policy.clientCapability.reductionVersion) {
    return { admitted: false, reason: "reduction_version_unsupported" };
  }

  // Credential validity — the rotating commitment is bound to an epoch, and an
  // epoch is a window on the clock.
  if (Number.isInteger(input.rotationEpoch)) {
    const current = rotationEpochFor(nowMs);
    if (input.rotationEpoch > current) return { admitted: false, reason: "credential_epoch_future" };
    if (input.rotationEpoch < current - policy.credential.validityEpochsBack) {
      return { admitted: false, reason: "credential_epoch_stale" };
    }
  }

  // Everything else — commitment, epoch/instant binding, observation-time
  // bounds, bucket range — is the store's, and its named refusals pass through.
  const built = buildSensingContributionRow({ ...input, ttlSeconds: ttl, reductionVersion: rv }, nowMs);
  if (!built.ok) return { admitted: false, reason: built.error };
  return { admitted: true, row: built.row };
}
