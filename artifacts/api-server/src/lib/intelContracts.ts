/**
 * Intelligence Gathering — canonical contracts (IG-01).
 *
 * ONE place for the vocabularies the Live Intelligence Graph is built from:
 * source classes, visibility, claim status, confidence bands, crowd levels,
 * capture surfaces, moderation states, presence levels, the claim-type registry
 * (TTL + hard expiry) and the feature-flag names.
 *
 * WHY THIS FILE EXISTS. The reconnaissance found the same concepts spelled
 * several different ways across the codebase, and every one of them was about
 * to become a permanent column: three source taxonomies, five visibility enums,
 * two crowd-level vocabularies, four TTL claim types against the spec's
 * thirteen. `canonical_events` blocks UPDATE, DELETE and TRUNCATE absolutely, so
 * a value written under the wrong vocabulary can never be corrected in place.
 * Resolving the vocabularies in a diff is cheap; discovering them at wiring time
 * is not. That is the whole job of this unit.
 *
 * RUNTIME EFFECT: NONE. This module is declarations plus pure functions. It
 * opens no client, reads no environment, touches no route and changes nothing
 * that renders. Wiring happens in IG-02 (storage) and later.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO — read before "tidying" it:
 *   * It does NOT rename lib/liveIntelligence.ts's 4-value SourceClass in place.
 *     That vocabulary is duplicated in compass/CompassUiBlocks.ts and is written
 *     verbatim into an LLM prompt (compass/CompassTools.ts:216), so renaming it
 *     would change model behaviour — the opposite of a no-op. Instead the eight
 *     canonical values live here, LEGACY_SOURCE_CLASS_MAP states the collapse
 *     explicitly, and the swap happens when a surface is next touched (IG-05).
 *   * It does NOT choose k for k-anonymity (lib/kAnonymity.ts owns the mechanism
 *     and deliberately refuses to choose); PRIVACY_THRESHOLD_V1 records the
 *     spec's values as data so a caller can pass them in.
 *   * It does NOT compute confidence. confidenceBand() maps an already-computed
 *     score to a display band; the scoring formula is IG-04's job, filling the
 *     seam lib/liveEnvelope.ts declares.
 */

// ── Source class — epistemic standing ────────────────────────────────────────
// What KIND of knowledge an assertion is. Distinct from `sources.origin`
// (migration 2121), which answers WHICH SUPPLIER produced a record. The two are
// orthogonal axes and must not be collapsed: 'sponsored' and 'portava_prediction'
// have no supplier home, and the fail-closed rules "a prediction is never
// rendered as an observation" and "an official claim is never rendered as
// independent community consensus" depend on exactly this distinction existing.
export const SOURCE_CLASSES = [
  "verified_firsthand",
  "firsthand_unverified",
  "official_signed",
  "sponsored",
  "imported_owned",
  "historical_pattern",
  "portava_prediction",
  "hearsay",
] as const;
export type SourceClass = (typeof SOURCE_CLASSES)[number];

/** User-facing label per source class. Every class must have one (T-01). */
export const SOURCE_CLASS_LABELS: Record<SourceClass, string> = {
  verified_firsthand:   "Live from verified visitor",
  firsthand_unverified: "Traveler report — unverified",
  official_signed:      "Official update",
  sponsored:            "Sponsored",
  imported_owned:       "Imported source",
  historical_pattern:   "Typical pattern",
  portava_prediction:   "Portava prediction",
  hearsay:              "Unverified tip",
};

/**
 * Classes that may NEVER be presented as a current observation of the world.
 * A prediction or a historical pattern is a statement about likelihood or the
 * past; rendering either as "live" is the single failure the spec's truth
 * boundary exists to prevent.
 */
export const NON_OBSERVATION_SOURCE_CLASSES: readonly SourceClass[] = [
  "historical_pattern",
  "portava_prediction",
] as const;

/** True when this class may back a user-facing LIVE label. */
export function mayRenderAsLive(cls: SourceClass): boolean {
  return !NON_OBSERVATION_SOURCE_CLASSES.includes(cls);
}

/** Classes that are one party talking about themselves — never consensus. */
export const NON_INDEPENDENT_SOURCE_CLASSES: readonly SourceClass[] = [
  "official_signed",
  "sponsored",
  "imported_owned",
] as const;

/** True when this class may be counted toward independent community consensus. */
export function mayCountAsConsensus(cls: SourceClass): boolean {
  return !NON_INDEPENDENT_SOURCE_CLASSES.includes(cls);
}

// ── Legacy vocabulary bridge ─────────────────────────────────────────────────
/**
 * The 4-value vocabulary currently rendered to users (lib/liveIntelligence.ts
 * SourceClass, duplicated as compass/CompassUiBlocks.ts UiSourceClass). Recorded
 * here so the collapse is explicit and mechanical rather than rediscovered.
 */
export const LEGACY_SOURCE_CLASSES = [
  "verified_live",
  "community_reported",
  "historical",
  "ai_inference",
] as const;
export type LegacySourceClass = (typeof LEGACY_SOURCE_CLASSES)[number];

/**
 * Total map from the legacy 4 onto the canonical 8. Typed as a total Record so
 * the compiler refuses a legacy value with no destination.
 *
 * `community_reported` maps to firsthand_unverified rather than
 * verified_firsthand: the legacy value carries no presence proof, and promoting
 * it would manufacture verification that was never performed.
 */
export const LEGACY_SOURCE_CLASS_MAP: Record<LegacySourceClass, SourceClass> = {
  verified_live:      "verified_firsthand",
  community_reported: "firsthand_unverified",
  historical:         "historical_pattern",
  ai_inference:       "portava_prediction",
};

// ── Visibility ───────────────────────────────────────────────────────────────
export const VISIBILITIES = [
  "public",
  "followers",
  "crew",
  "invite_only",
  "delayed",
  "aggregate_only",
  "private",
] as const;
export type Visibility = (typeof VISIBILITIES)[number];

// ── Claim status ─────────────────────────────────────────────────────────────
export const CLAIM_STATUSES = [
  "candidate",
  "active",
  "conflicting",
  "superseded",
  "expired",
  "retracted",
  "rejected",
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** Only these statuses may contribute to a computed live state. */
export const LIVE_ELIGIBLE_CLAIM_STATUSES: readonly ClaimStatus[] = [
  "active",
  "conflicting",
] as const;

// ── Moderation state ─────────────────────────────────────────────────────────
export const MODERATION_STATES = [
  "pending",
  "allowed",
  "restricted",
  "blocked",
  "removed",
] as const;
export type ModerationState = (typeof MODERATION_STATES)[number];

/** Fail-closed: only 'allowed' content may back a claim (the eventual spec rule,
 *  once a promotion path exists). */
export function isModerationEligible(state: ModerationState): boolean {
  return state === "allowed";
}

/**
 * PILOT moderation rule (owner ruling 2026-08-26). A full moderation/promotion
 * workflow is NOT required before Da Nang can operate — so 'pending' (unpromoted)
 * content still flows — but content that has been explicitly invalidated
 * (restricted / blocked / removed) must NEVER back a claim, snapshot, or live
 * label. This is a WHITELIST, so it is fail-closed: only these two states are
 * claimable, and any future moderation state is excluded until deliberately added.
 */
export const PILOT_CLAIMABLE_MODERATION_STATES = ["pending", "allowed"] as const;

/** True iff content in this moderation state may back a claim in the pilot. */
export function isPilotClaimable(state: string | null | undefined): boolean {
  return typeof state === "string" && (PILOT_CLAIMABLE_MODERATION_STATES as readonly string[]).includes(state);
}

// ── Capture surface ──────────────────────────────────────────────────────────
export const CAPTURE_SURFACES = [
  "quick_signal",
  "moment",
  "highlight",
  "postcard",
  "trail",
  "question",
  "mission",
  "followup",
] as const;
export type CaptureSurface = (typeof CAPTURE_SURFACES)[number];

// ── Party-size attestation (V1 independent-group signal, §privacy) ───────────
// The four answers to "Who are you here with?", captured only on label-eligible
// quick_signal observations. This is the RAW attestation, stored for measurement;
// the independent-group identity the privacy gate counts is the derived
// group_key (lib/intelGroupKey), not this bucket. Exact-party-size is never used
// in the public intelligence calculation beyond deriving the group.
export const PARTY_SIZE_BUCKETS = ["just_me", "one_other", "two_to_four", "five_plus"] as const;
export type PartySizeBucket = (typeof PARTY_SIZE_BUCKETS)[number];

// ── Commercial disclosure ────────────────────────────────────────────────────
export const COMMERCIAL_DISCLOSURES = [
  "none",
  "employee",
  "owner",
  "hosted",
  "complimentary",
  "affiliate",
  "paid",
] as const;
export type CommercialDisclosure = (typeof COMMERCIAL_DISCLOSURES)[number];

// ── Crowd level and trajectory ───────────────────────────────────────────────
// Six values. Note hidden_gems.crowd_level carries a different, narrower legacy
// vocabulary; that surface is reconciled when it is next touched, not here.
export const CROWD_LEVELS = [
  "dead",
  "quiet",
  "moderate",
  "busy",
  "packed",
  "unsafe_density",
] as const;
export type CrowdLevel = (typeof CROWD_LEVELS)[number];

/** unsafe_density is a safety claim, not a vibe: specialist review only. */
export const SPECIALIST_ONLY_CROWD_LEVELS: readonly CrowdLevel[] = ["unsafe_density"] as const;

export const TRAJECTORIES = [
  "emerging",
  "building",
  "peaking",
  "stable",
  "fragmenting",
  "relocating",
  "declining",
  "ending",
] as const;
export type Trajectory = (typeof TRAJECTORIES)[number];

// ── Presence ladder ──────────────────────────────────────────────────────────
export const PRESENCE_LEVELS = ["P0", "P1", "P2", "P3", "P4"] as const;
export type PresenceLevel = (typeof PRESENCE_LEVELS)[number];

export const PRESENCE_LEVEL_MEANING: Record<PresenceLevel, string> = {
  P0: "No qualifying proximity proof",
  P1: "Coarse — device within neighborhood/time window",
  P2: "Experience — device within geofence plus dwell/interaction check",
  P3: "Transaction — P2 plus receipt/booking/entry evidence",
  P4: "Assigned — P2/P3 plus mission nonce and contract",
};

/** Minimum presence for an ordinary live claim. */
export const MIN_PRESENCE_FOR_LIVE_CLAIM: PresenceLevel = "P2";

// ── Confidence bands ─────────────────────────────────────────────────────────
export const CONFIDENCE_BANDS = [
  "unverified",
  "provisional",
  "likely_current",
  "live",
  "strong",
] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];

/** Lower bound (inclusive) of each band. */
export const CONFIDENCE_BAND_FLOOR: Record<ConfidenceBand, number> = {
  unverified:     0,
  provisional:    0.35,
  likely_current: 0.55,
  live:           0.75,
  strong:         0.9,
};

/**
 * Map an already-computed 0..1 score to its display band. Fail-closed: a
 * non-finite or out-of-range score is 'unverified', never a stronger band.
 *
 * This does NOT compute confidence — see the header note.
 */
export function confidenceBand(score: number | null | undefined): ConfidenceBand {
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0) return "unverified";
  if (score >= CONFIDENCE_BAND_FLOOR.strong) return "strong";
  if (score >= CONFIDENCE_BAND_FLOOR.live) return "live";
  if (score >= CONFIDENCE_BAND_FLOOR.likely_current) return "likely_current";
  if (score >= CONFIDENCE_BAND_FLOOR.provisional) return "provisional";
  return "unverified";
}

/** Bands below this are excluded from computed Live state entirely. */
export const MIN_BAND_FOR_LIVE_STATE: ConfidenceBand = "likely_current";

// ── Claim-type registry ──────────────────────────────────────────────────────
/**
 * The thirteen Phase-1 claim types, with the TTL after which a claim stops being
 * live and the hard expiry beyond which it can never be extended.
 *
 * The dotted namespace (`family.type`) is deliberate and REPLACES the four flat
 * types seeded by migration 2122 (`crowd`, `vibe`, `price`, `structural`).
 * Because an unknown claim_type is treated as stale (fail-closed), shipping
 * dotted keys against the flat seed would fail silently — the seed migration
 * (2128) adds these rows, and the flat rows are retired only when their last
 * reader is gone.
 */
export interface ClaimTypeSpec {
  claimType: string;
  ttlSeconds: number;
  hardExpirySeconds: number;
  note: string;
}

export const CLAIM_TYPES: readonly ClaimTypeSpec[] = [
  { claimType: "crowd.level",           ttlSeconds: 2700,    hardExpirySeconds: 7200,     note: "How busy it is — 45 min, hard 120 min." },
  { claimType: "crowd.trajectory",      ttlSeconds: 2700,    hardExpirySeconds: 5400,     note: "Direction of change — 45 min, hard 90 min." },
  { claimType: "queue.wait",            ttlSeconds: 1200,    hardExpirySeconds: 2700,     note: "Queue wait — 20 min, hard 45 min." },
  { claimType: "access.walk_in",        ttlSeconds: 1800,    hardExpirySeconds: 7200,     note: "Walk-in acceptance — 30 min." },
  { claimType: "access.reservation",    ttlSeconds: 1209600, hardExpirySeconds: 7776000,  note: "Reservation policy — 14 days, hard 90 days." },
  { claimType: "access.dress",          ttlSeconds: 1814400, hardExpirySeconds: 7776000,  note: "Dress policy — 21 days, hard 90 days." },
  { claimType: "price.cover",           ttlSeconds: 604800,  hardExpirySeconds: 7776000,  note: "Cover price — 7 days, hard 90 days." },
  { claimType: "crowd.mix",             ttlSeconds: 5400,    hardExpirySeconds: 10800,    note: "Crowd composition bands — 90 min, hard 180 min." },
  { claimType: "music.current",         ttlSeconds: 5400,    hardExpirySeconds: 10800,    note: "Current genre — 90 min, hard 180 min." },
  { claimType: "inventory.status",      ttlSeconds: 1800,    hardExpirySeconds: 86400,    note: "Item/service availability — 30 min, hard 1 day." },
  { claimType: "service.wait",          ttlSeconds: 2700,    hardExpirySeconds: 7200,     note: "Service wait — 45 min." },
  { claimType: "transit.condition",     ttlSeconds: 1800,    hardExpirySeconds: 86400,    note: "Route/mode condition — 30 min; official clearance may end it sooner." },
  { claimType: "experience.next_move",  ttlSeconds: 1800,    hardExpirySeconds: 5400,     note: "Aggregate next-stop movement — 30 min. Cohort-gated." },
] as const;

/** The flat claim types seeded by 2122, kept for readers that still use them. */
export const LEGACY_CLAIM_TYPES = ["crowd", "vibe", "price", "structural"] as const;

// ── Temporal contract ────────────────────────────────────────────────────────
/**
 * The three times the spec requires be kept distinct. Upload time is never a
 * substitute for observation time.
 */
export interface TemporalEnvelope {
  /** When reality was observed. Server-clamped — see clampObservedAt. */
  observedAt: string;
  /** When the device captured the content. Optional; absent for manual reports. */
  capturedAt?: string | null;
  /** When the server received it. Never supplied by a client. */
  receivedAt: string;
}

export const MAX_OBSERVED_AT_SKEW_MS = 60_000;

/**
 * Clamp a client-supplied observation time to the server clock.
 *
 * WHY THIS IS REQUIRED. lib/freshnessPolicy.ts isStale() computes
 * `ageSeconds = now - observedAt` and returns `ageSeconds >= ttl`. A timestamp
 * in the FUTURE makes ageSeconds negative, so the comparison is false and the
 * claim reads as NOT stale — indefinitely, until real time catches up. That is
 * fail-OPEN, and it is reachable by clock skew or by a client that simply sends
 * a future time. Clamping at the contract boundary closes it for every caller
 * rather than patching each computation.
 *
 * Small skew (<= MAX_OBSERVED_AT_SKEW_MS) is clamped silently — device clocks
 * drift. Anything further ahead is rejected, because at that point it is not
 * drift.
 */
export function clampObservedAt(
  observedAt: string | number | Date,
  now: string | number | Date = Date.now(),
): { observedAt: string; clamped: boolean } | null {
  const o = toMs(observedAt);
  const n = toMs(now);
  if (!Number.isFinite(o) || !Number.isFinite(n)) return null;
  if (o > n + MAX_OBSERVED_AT_SKEW_MS) return null; // beyond drift — reject
  if (o > n) return { observedAt: new Date(n).toISOString(), clamped: true };
  return { observedAt: new Date(o).toISOString(), clamped: false };
}

function toMs(t: string | number | Date): number {
  if (t instanceof Date) return t.getTime();
  if (typeof t === "number") return t;
  return new Date(t).getTime();
}

// ── Idempotency ──────────────────────────────────────────────────────────────
/**
 * Every intelligence write carries one. The shape deliberately matches the
 * CHECK constraint already written for journey_observations, so the two
 * observation paths cannot drift apart on this.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

export function isValidIdempotencyKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    key.length >= 1 &&
    key.length <= IDEMPOTENCY_KEY_MAX_LENGTH &&
    IDEMPOTENCY_KEY_PATTERN.test(key)
  );
}

// ── Subject identity ─────────────────────────────────────────────────────────
/**
 * What an observation or claim is ABOUT.
 *
 * Ruling (owner decision D2): the canonical subject is public.places(id). A
 * subject that has no places row cannot be observed until it is resolved into
 * one — that is the point, not a limitation. `zoneId` is optional and required
 * only where conditions genuinely differ within a venue (rooftop vs ground
 * floor); two zones are two subjects, not a contradiction.
 */
export const SUBJECT_KINDS = ["experience", "zone", "neighborhood", "route", "event", "service"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export interface ExperienceRef {
  subjectKind: SubjectKind;
  /** places(id) for 'experience'. */
  subjectId: string;
  /** Optional intra-venue zone. */
  zoneId?: string | null;
}

// ── Privacy threshold ────────────────────────────────────────────────────────
/**
 * The spec's crowd-movement privacy thresholds, recorded as DATA so a caller can
 * pass them to lib/kAnonymity.ts. This module does not choose k on anyone's
 * behalf and does not apply these itself.
 *
 * Note for IG-04: these must be enforced by ONE shared gate covering the
 * existing Compass aggregate path as well, not by an intel-only module — see the
 * A0 packet §09.
 */
export const PRIVACY_THRESHOLD_V1 = {
  minUniqueActors: 15,
  minIndependentGroups: 5,
  maxSingleGroupShare: 0.2,
  timeBucketMinutes: 30,
  publicationDelayMinutes: 10,
  minVenueCohortForVenueGeography: 30,
} as const;

// ── Feature flags ────────────────────────────────────────────────────────────
/**
 * One flag per claim/capability family, all default OFF. These names do NOT end
 * in `_enabled`, so each needs a CLASSIFIED entry in
 * scripts/check-flag-polarity.mjs — that entry is part of this unit.
 */
export const INTEL_FLAGS = [
  "intel_capture_quick_signal",
  "intel_claim_projection_crowd",
  "intel_live_label_crowd",
  "intel_trail_followup",
  "intel_movement_prediction",
  "intel_missions",
  "intel_external_api",
  "intel_qiu_cash_pool",
] as const;
export type IntelFlag = (typeof INTEL_FLAGS)[number];

/**
 * A flag may only be honoured when everything it depends on is also on. Encoded
 * here so the chain is a contract rather than a convention.
 */
export const INTEL_FLAG_DEPENDENCIES: Record<IntelFlag, readonly IntelFlag[]> = {
  intel_capture_quick_signal:   [],
  intel_claim_projection_crowd: ["intel_capture_quick_signal"],
  intel_live_label_crowd:       ["intel_claim_projection_crowd"],
  intel_trail_followup:         ["intel_capture_quick_signal"],
  intel_movement_prediction:    ["intel_claim_projection_crowd"],
  intel_missions:               ["intel_capture_quick_signal"],
  intel_external_api:           ["intel_live_label_crowd"],
  intel_qiu_cash_pool:          ["intel_missions"],
};
