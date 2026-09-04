/**
 * POST /api/map/observations — Map Contributions ingest (Map spec §22).
 *
 *   flag: map_contributions_enabled (OFF by default)
 *
 * §22: "The map is also a low-friction capture surface. Contributions are
 * observations, not immediate truth", and the pipeline it names is
 *
 *   Map Prompt → Observation → Identity/Trust → Evidence Qualification
 *               → Claim System → Projection → Map changes
 *
 * THIS ROUTE IS THE FIRST TWO ARROWS ONLY. It turns a §22 map prompt answer
 * into one append-only `intel_observations` row — or, for the one prompt that
 * is an ARTIFACT rather than a proposition, into one append-only
 * `intel_evidence` row bolted to an observation that already exists — and
 * stops. Everything downstream already exists and already has a single owner:
 *
 *   evidence attachment     lib/intelEvidenceCapture.ts
 *   evidence qualification  services/intel/IntelCaptureService.ts
 *   claim system            IntelCaptureService.proposeClaim / system promotion
 *   projection              lib/intelProjection.ts (the SOLE writer of snapshots)
 *
 * A DUPLICATE CAPTURE PATH WOULD BE THE DEFECT, NOT THE FEATURE
 * ============================================================
 * `POST /v1/intel/observations` (routes/intel.ts) already carries consent, the
 * observed-at clamp, claim-type and value validation, idempotency, the
 * independent-group signal that feeds the k-anonymity gate, and the fail-closed
 * subject check. A second ingest that wrote `intel_observations` itself would
 * inevitably drift from those gates — and the first one to drift would be D4
 * consent, because it is the only one whose absence is invisible in the
 * response. So this file contains NO storage logic. It is a map-shaped FAÇADE:
 * it translates the client's `MapContribution` into a `CaptureInput` and calls
 * `writeObservation`. Every gate below is enforced by that service, not here:
 *
 *   consent (D4)      hasValidIntelConsent — refuse, fail-closed
 *   observed-at       clampObservedAt — a future timestamp is rejected
 *   claim vocabulary  PHASE1_CAPTURE_CLAIM_TYPES + validateClaimValue
 *   idempotency       unique (actor_id, idempotency_key)
 *   subject           resolves in public.places, or `unknown_subject`
 *
 * WHAT THIS ROUTE MAY NEVER DO
 * ============================
 * It never writes a claim, a confidence score, a band, or an
 * `intel_state_snapshot`. It never calls proposeClaim. A contribution becomes a
 * live map change only by earning it through the projection, and the response
 * below deliberately carries no confidence and no live value — a caller cannot
 * mistake the 201 for "the map now says this".
 *
 * That holds for evidence too, and there it is worth stating twice: attaching a
 * photo raises NOTHING. lib/intelProjectionAggregator scores evidence quality
 * from a hardcoded `hasEvidence = false`, and neither this route nor
 * lib/intelEvidenceCapture changes it. A one-tap confidence boost bought by
 * uploading a picture would be the same defect as one bought by paying.
 *
 * REWARDS NEVER TOUCH CONFIDENCE
 * ==============================
 * §22 / §37: "Rewards may incentivize participation but must never increase
 * factual confidence merely because the contribution was paid." The mechanism
 * here is structural, not a rule someone has to remember:
 *
 *   1. The §22 payload has no reward, payment or sponsorship field, and this
 *      route is `.strict()` — one cannot even be sent.
 *   2. This route never calls services/intel/RewardService.ts. The ledger is
 *      booked from FINALIZED outcomes (evaluateRewardEligibility requires
 *      `outcomeFinalized`); a just-captured observation is not one.
 *   3. The observation row it produces carries no reward column, so the
 *      evidence path (lib/intelProjectionAggregator.assembleClaimInput reads
 *      actor_id, presence_level, source_class, group_key, observed_at,
 *      moderation_state) has nothing reward-shaped to read even if it wanted
 *      to. `intel_reward_ledger` and `intel_observations` do not join.
 *
 * test/mapObservations.test.ts pins this end to end: a rewarded and an
 * unrewarded contribution are scored through the real aggregator and the real
 * confidence formula and must produce identical components and an identical
 * score.
 *
 * THE ACTOR COMES FROM THE TOKEN
 * ==============================
 * `actorId` is `requireUser`'s user id. A body actor field is not merely
 * ignored — the schema is strict, so a payload carrying one is REFUSED. A
 * capture attributes a factual claim to a person; silently dropping a
 * mis-attributed field would be the wrong kind of forgiving.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError, type ApiErrorCode } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import {
  ACTIVITY_LEVELS,
  MAP_OBJECT_KINDS,
  isForecastKind,
  type ActivityLevel,
  type MapObjectKind,
} from "../lib/mapObjects.js";
import {
  CLOSURE_STATES,
  CROWD_DIRECTIONS,
  EVENT_STATUS_STATES,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  VIBE_STATES,
  isValidIdempotencyKey,
  type ClosureState,
  type CrowdDirection,
  type CrowdLevel,
  type EventStatusState,
  type VibeState,
} from "../lib/intelContracts.js";
import { writeObservation, type CaptureInput } from "../services/intel/IntelCaptureService.js";
import { attachMediaEvidence } from "../lib/intelEvidenceCapture.js";
import { haversineKm } from "../lib/mapSearch.js";
import { KM_PER_DEGREE_LAT } from "../lib/mapAggregation.js";

const router = Router();

// ── The §22 prompt set ────────────────────────────────────────────────────────
//
// Mirrors CONTRIBUTION_KINDS in
// travel-buddy-standalone/src/features/map/truth/liveTruth.ts, in the spec's
// order. The server cannot import the React Native module, so the vocabulary is
// restated here and the tests pin every value — a drift between the two is a
// rejected contribution, which is loud, not a silently mis-stored one.

export const MAP_CONTRIBUTION_KINDS = [
  "crowd_level",
  "queue",
  "entry_access",
  "vibe",
  "event_status",
  "closure",
  "crowd_direction",
  "media",
] as const;
export type MapContributionKind = (typeof MAP_CONTRIBUTION_KINDS)[number];

export const QUEUE_LEVELS = ["none", "under_5m", "5_15m", "15_30m", "over_30m"] as const;
export const ENTRY_ACCESS_STATES = [
  "walk_straight_in",
  "line_at_door",
  "guest_list_only",
  "at_capacity",
  "entry_closed",
] as const;
// The four vocabularies whose option IS the claim value are now canonical and
// live in lib/intelContracts next to the TTL that governs them; they are
// re-exported here so the client-facing names still resolve from one module and
// lib/quickSignal's validators and this route's schema cannot drift apart —
// they are literally the same array.
export {
  VIBE_STATES,
  EVENT_STATUS_STATES,
  CLOSURE_STATES,
  CROWD_DIRECTIONS,
} from "../lib/intelContracts.js";

// MEDIA_KINDS stays here, and its staying here is the ruling: it is a
// vocabulary of ASSET TYPES, not of claim values, so it has no home in the
// claim contracts. See the media note below.
export const MEDIA_KINDS = ["photo", "video"] as const;

// ── Which prompts a map object may legally take ───────────────────────────────
//
// Mirrors KIND_PROMPTS in the client's liveTruth.ts. It is a SECOND gate, not
// the only one: `objectKind` arrives in the body and a client could lie about
// it. The gate that cannot be lied to is the capture service's subject check —
// `intel_observations.subject_id` FKs `public.places`, so an id that is not a
// place is refused as `unknown_subject` no matter what kind the body claims.
//
// ZONE KINDS RESOLVE TO AN ANCHOR PLACE (§22, Table 12). activity_zone,
// social_zone and crowd_flow are AREAS, not rows in `places`, so their
// `objectId` is a `geo_zones.id`, not a place id — and handed straight to the
// subject check it always failed as `unknown_subject`, silently discarding
// every zone contribution §22 explicitly allows (crowd_direction on a flow, a
// vibe on a social zone). `resolveZoneAnchorSubject` closes that: it reads the
// geo_zone, finds the nearest active place inside it, and observes AGAINST that
// place (`subject_id`) while recording the zone (`zone_id`) the contribution
// came from. It FAILS CLOSED — `unknown_subject`, never a mis-file — when the
// zone is unknown, has no usable geometry, or contains no place to anchor to.
// A person-, service-, safety- or forecast-kind subject still takes no prompt
// at all (KIND_PROMPTS below), so this path is reachable only for the three
// zone kinds §22 names.
export const KIND_PROMPTS: Record<MapObjectKind, readonly MapContributionKind[]> = {
  place: ["crowd_level", "queue", "entry_access", "vibe", "closure", "media"],
  hidden_gem: ["crowd_level", "queue", "entry_access", "vibe", "closure", "media"],
  trip_stop: ["crowd_level", "queue", "entry_access", "vibe", "closure", "media"],
  // A saved place is a venue the viewer chose (§16 Saved layer); the same
  // public observations a place takes apply to it. Mirrors the client's
  // liveTruth.ts entry — src/test/mapContributionClaimTypes.test.ts pins them.
  saved_place: ["crowd_level", "queue", "entry_access", "vibe", "closure", "media"],
  event: ["crowd_level", "queue", "entry_access", "vibe", "event_status", "crowd_direction", "media"],
  activity_zone: ["crowd_level", "crowd_direction"],
  social_zone: ["crowd_level", "vibe", "crowd_direction"],
  crowd_flow: ["crowd_direction"],
  meeting_point: ["crowd_level", "entry_access", "media"],
  // People, service availability, safety state and personal history are not
  // public observations of a physical state. §20: safety state is owned by the
  // Safety system and is not crowd-editable from a map prompt.
  crew_member: [],
  buddy_zone: [],
  safety_notice: [],
  memory: [],
  // §37: "Do not make predictions look like observations." You cannot observe a
  // forecast.
  prediction: [],
};

/** Whether this prompt is legal for this object kind (§22 semantics, not UI). */
export function isPromptAllowed(objectKind: MapObjectKind, kind: MapContributionKind): boolean {
  if (isForecastKind(objectKind)) return false;
  return (KIND_PROMPTS[objectKind] ?? []).includes(kind);
}

// ── Prompt → canonical claim ──────────────────────────────────────────────────
//
// THE ONE PLACE THE TWO VOCABULARIES MEET, AND THE ONE PLACE INFORMATION IS
// LOST. The map prompts were written for a person holding a phone; the claim
// system's vocabulary (lib/intelContracts CLAIM_TYPES + lib/quickSignal
// validators) is what the projection, the freshness policy and the confidence
// formula are all defined over.
//
// SEVEN of the eight prompts have an exact canonical claim. The eighth — media
// — has none and never will, and that is a ruling, not a gap. It is no longer
// DISCARDED, though: it now takes the evidence arrow instead of the claim
// arrow. See the media note below.
//
// HOW THE FOUR NEW ONES WERE ADDED, AND WHAT WAS NOT DONE
// ======================================================
// The earlier cut of this file refused vibe, event_status, closure and
// crowd_direction because adding them meant adding CLAIM_TYPES rows (TTL and
// hard expiry), value validators and freshness_policies rows — decisions that
// belong to lib/intelContracts and lib/quickSignal, not to a route. That was
// right: the work was owed elsewhere. It has now been done there, and this
// route still invents nothing — every arrow below lands on a claim type that
// lib/intelContracts declares, lib/quickSignal validates and migration 2220
// seeds a TTL for.
//
// The refusal that was NOT overturned, because it was never about missing
// plumbing:
//
//   • crowd_direction ≠ crowd.trajectory. Direction of FLOW ("people arriving")
//     is not the same fact as trajectory of INTENSITY ("the crowd is
//     building"), and 'passing_through' is neither. So crowd_direction did NOT
//     get mapped onto crowd.trajectory; it got its OWN claim type,
//     `crowd.direction`, with its own value shape (`{ direction }`, never
//     `{ trajectory }`) and its own — shorter — TTL. The two claims cannot be
//     confused by a reader or a query because they do not share a key.
//
// A refusal is visible (`unsupported_kind`, with the reason). A wrong mapping
// is invisible and ends up on the map as truth.

/**
 * The prompts that have an exact canonical claim.
 *
 * `media` is absent and must stay absent. This constant is not "the prompts
 * that work" — it is "the prompts that are PROPOSITIONS", and a photo is not
 * one. Media is accepted by this route through a different arrow entirely
 * (see below); adding it here would be minting it a claim.
 */
export const SUPPORTED_CONTRIBUTION_KINDS = [
  "crowd_level",
  "queue",
  "entry_access",
  "vibe",
  "event_status",
  "closure",
  "crowd_direction",
] as const;

/**
 * The prompts that map to NO CLAIM, each with the reason, so the hole is
 * documented not silent.
 *
 * MEDIA: THE RULING, NOT A TODO
 * =============================
 * A photo is EVIDENCE, not a claim, and §21's own pipeline says so by putting
 * them at different stations:
 *
 *     Observation → Evidence → Claim → Confidence → Freshness → Correction
 *
 * A claim is a proposition. It can be true, confirmed, contradicted, corrected
 * and expired — every station downstream of "Claim" is an operation on a
 * proposition. A photograph asserts none. Ask which claim a photo of a bar
 * makes and there is no answer: "it is busy"? "it is open"? "the vibe is going
 * off"? A contributor who tapped "Show what it looks like" made none of those
 * statements, and picking one for them is exactly the failure the
 * crowd_direction rule above exists to prevent — except worse, because a photo
 * would be forced to carry a claim invented wholesale rather than merely
 * approximated. It also cannot expire into "wrong": the picture stays an
 * accurate picture of a moment forever, so any TTL chosen for it would be a
 * statement about the WORLD, not about the artifact, and would therefore
 * belong to whatever claim the photo is evidence FOR.
 *
 * WHAT CHANGED: THE DESTINATION, NOT THE RULING
 * =============================================
 * The right home was already named and already built — `intel_evidence`
 * (migration 2130), "artifacts supporting an observation", keyed by
 * observation_id. It is now WIRED, in lib/intelEvidenceCapture.ts, and the
 * three pieces of work that were owed before it could be are done or accounted
 * for:
 *
 *   upload      the contributor uploads through POST /api/media/upload as they
 *               do for any other media; this route accepts only a reference to
 *               the object that produced, proved ours AND proved theirs.
 *   retention   2173 already sweeps intel_evidence at the ruled 180 days and
 *               2130's erase_intel_for_actor already deletes it on account
 *               deletion. Both were written before the table had a producer.
 *   moderation  intel_evidence has none, and none was invented. It does not
 *               need one YET because evidence is write-only: authenticated
 *               holds no grant on the table, no read path selects from it, and
 *               the aggregator's hasEvidence is a hardcoded false. A read path
 *               may not be added without ruling on moderation first.
 *
 * So this entry no longer means "media is dropped". It means media has NO CLAIM
 * TYPE — and, because §21 orders Observation before Evidence, that a media
 * contribution arriving ALONE, with no observation to support, is still
 * refused, with this string as the reason. Media that names its observation is
 * accepted, as evidence, on the evidence arrow.
 *
 * The schema below still REQUIRES `mediaUri` on a media contribution, and still
 * refuses to validate it there: a `mediaUri` is untrusted input, and the check
 * that matters (ours, and this contributor's) needs the actor, which a zod
 * schema does not have. It happens in lib/intelEvidenceCapture instead, where
 * the refusal is a named reason rather than a parse issue.
 */
export const UNSUPPORTED_CONTRIBUTION_KINDS: Readonly<Record<string, string>> = {
  media:
    "a photo is evidence, not a claim — it asserts no proposition to confirm, contradict or expire, so it has no claim type and never gets one; media is stored in intel_evidence attached to the observation it supports, so send that observation first and resend this with its observationId",
};

/**
 * ActivityLevel (six client values) → CrowdLevel (five canonical, excluding the
 * specialist-only unsafe_density). Order-preserving and collapsing only at the
 * top: very_busy and peak both land on `packed`, which is the strongest level
 * an ordinary contributor may report. `unsafe_density` is a safety claim under
 * specialist review (SPECIALIST_ONLY_CROWD_LEVELS) and is unreachable from any
 * map prompt by construction — there is no arrow into it below.
 */
export const ACTIVITY_TO_CROWD_LEVEL: Readonly<Record<ActivityLevel, CrowdLevel>> = {
  very_quiet: "dead",
  quiet: "quiet",
  moderate: "moderate",
  busy: "busy",
  very_busy: "packed",
  peak: "packed",
};

/** Queue band → queue.wait minutes. `over_30m` is open-ended (maxMinutes null). */
const QUEUE_TO_WAIT: Readonly<Record<string, { minMinutes: number; maxMinutes: number | null }>> = {
  none: { minMinutes: 0, maxMinutes: 0 },
  under_5m: { minMinutes: 0, maxMinutes: 5 },
  "5_15m": { minMinutes: 5, maxMinutes: 15 },
  "15_30m": { minMinutes: 15, maxMinutes: 30 },
  over_30m: { minMinutes: 30, maxMinutes: null },
};

/**
 * Entry state → access.walk_in { accepted }.
 *
 * `line_at_door` is accepted:true on purpose — a queue is not a refusal, and
 * how long that queue is has its own prompt and its own claim (queue.wait). The
 * three states that mean "you cannot simply walk in" are false.
 */
const ENTRY_TO_WALK_IN: Readonly<Record<string, boolean>> = {
  walk_straight_in: true,
  line_at_door: true,
  guest_list_only: false,
  at_capacity: false,
  entry_closed: false,
};

// ── What "supported" does NOT mean ────────────────────────────────────────────
//
// Being mappable is not being publishable. Two of the four new prompts carry a
// standing bar on ever reaching a LIVE label, recorded as data in
// lib/intelContracts (CLAIM_TYPE_LIVE_LABEL_RULING / NEVER_LIVE_CLAIM_VALUES,
// read via claimTypeLiveLabelRuling):
//
//   closure.state          never live, at any value
//   event.status'cancelled' never live
//
// The reason is subject matter, not source: a stranger's single unverified tap
// saying a business is shut, rendered as "Live: closed", takes a living
// business off the map, and nothing self-corrects it the way a stream of crowd
// taps self-corrects a crowd level. Those claims are still captured, still
// scored and still shown as what they are — a count of travellers reporting it.
//
// This route enforces none of that, and could not: it publishes nothing. The
// ruling is recorded where the live-label reader will find it, in the same
// spirit as PRIVACY_THRESHOLD_V1.

export interface MappedClaim {
  claimType: string;
  value: Record<string, unknown>;
}

/**
 * Map one §22 prompt answer to a canonical claim. Returns null for a prompt
 * with no Phase-1 claim, or an option outside the prompt's vocabulary — the
 * caller refuses a null, fail-closed, and never invents a claim.
 */
export function mapContributionToClaim(kind: string, value: string): MappedClaim | null {
  switch (kind) {
    case "crowd_level": {
      const level = ACTIVITY_TO_CROWD_LEVEL[value as ActivityLevel];
      return level ? { claimType: "crowd.level", value: { level } } : null;
    }
    case "queue": {
      const wait = QUEUE_TO_WAIT[value];
      return wait ? { claimType: "queue.wait", value: { ...wait } } : null;
    }
    case "entry_access": {
      const accepted = ENTRY_TO_WALK_IN[value];
      return accepted === undefined ? null : { claimType: "access.walk_in", value: { accepted } };
    }
    // The four identity mappings. The prompt option IS the claim value, so
    // these do not translate anything — they only assert that the option is in
    // the canonical vocabulary before wrapping it under the key that names the
    // fact. The membership check is not redundant with the zod schema: this
    // function is exported and called directly by tests and could be called
    // with an unparsed value, so it fails closed on its own.
    case "vibe":
      return (VIBE_STATES as readonly string[]).includes(value)
        ? { claimType: "vibe.state", value: { state: value as VibeState } }
        : null;
    case "event_status":
      return (EVENT_STATUS_STATES as readonly string[]).includes(value)
        ? { claimType: "event.status", value: { status: value as EventStatusState } }
        : null;
    case "closure":
      return (CLOSURE_STATES as readonly string[]).includes(value)
        ? { claimType: "closure.state", value: { state: value as ClosureState } }
        : null;
    case "crowd_direction":
      // NOT crowd.trajectory, and not `{ trajectory }`. See the section header.
      return (CROWD_DIRECTIONS as readonly string[]).includes(value)
        ? { claimType: "crowd.direction", value: { direction: value as CrowdDirection } }
        : null;
    default:
      return null;
  }
}

// ── Payload ───────────────────────────────────────────────────────────────────
//
// Exactly the client's `MapContribution` union, and `.strict()` on every member.
// Strictness is the actor rule made structural: a body carrying `actorId`,
// `userId`, `contributorId` — or a `reward`, `paid` or `sponsored` field — is
// REFUSED, not quietly stripped. Widening the payload is therefore a deliberate
// edit here, which is where a reviewer will see it.

const baseFields = {
  objectId: z.string().uuid(),
  objectKind: z.enum(MAP_OBJECT_KINDS),
  // Client capture time. ADVISORY: clampObservedAt rejects anything meaningfully
  // in the future, so a device clock cannot buy permanent freshness.
  observedAt: z.string().datetime(),
};

export const mapContributionSchema = z.discriminatedUnion("kind", [
  z.object({ ...baseFields, kind: z.literal("crowd_level"), value: z.enum(ACTIVITY_LEVELS) }).strict(),
  z.object({ ...baseFields, kind: z.literal("queue"), value: z.enum(QUEUE_LEVELS) }).strict(),
  z.object({ ...baseFields, kind: z.literal("entry_access"), value: z.enum(ENTRY_ACCESS_STATES) }).strict(),
  z.object({ ...baseFields, kind: z.literal("vibe"), value: z.enum(VIBE_STATES) }).strict(),
  z.object({ ...baseFields, kind: z.literal("event_status"), value: z.enum(EVENT_STATUS_STATES) }).strict(),
  z.object({ ...baseFields, kind: z.literal("closure"), value: z.enum(CLOSURE_STATES) }).strict(),
  z.object({ ...baseFields, kind: z.literal("crowd_direction"), value: z.enum(CROWD_DIRECTIONS) }).strict(),
  // The media member carries two extra fields and neither is loosened here.
  //
  //   mediaUri        REQUIRED but NOT validated by the schema. Proving a media
  //                   reference is ours AND this contributor's needs the actor,
  //                   which zod does not have; doing half the check here would
  //                   read as the whole check. lib/intelEvidenceCapture does it.
  //   observationId   OPTIONAL in the SCHEMA and REQUIRED by the ruling. It is
  //                   optional here so a client that sends none gets the §21
  //                   reason ("evidence attaches to an observation") rather
  //                   than a bare "observationId: Required" parse issue — and
  //                   so this schema stays exactly the client's
  //                   `MapContribution`, which does not carry the field yet.
  z
    .object({
      ...baseFields,
      kind: z.literal("media"),
      value: z.enum(MEDIA_KINDS),
      mediaUri: z.string().min(1),
      observationId: z.string().uuid().optional(),
    })
    .strict(),
]);

// ── Idempotency ───────────────────────────────────────────────────────────────

/**
 * Derive an idempotency key for a client that sends no Idempotency-Key header.
 *
 * A §22 prompt is one tap, and one tap on a phone is regularly two events. The
 * capture service dedupes on (actor_id, idempotency_key), but only if a key
 * exists — so the key is derived from the contribution itself:
 *
 *   map:<objectId>:<kind>:<value>:<minute of observedAt>
 *
 * The VALUE is in the key on purpose. Without it, a user who taps "busy" and
 * immediately corrects to "packed" would have the correction swallowed as a
 * replay of the first. With it, a double-tap of the same answer dedupes and a
 * changed answer is a new observation, which is what the claim system's
 * correction path is for.
 *
 * Sanitised to IDEMPOTENCY_KEY_PATTERN — the prompt vocabulary uses `_`, which
 * that pattern does not allow.
 */
export function deriveIdempotencyKey(
  objectId: string,
  kind: string,
  value: string,
  observedAt: string,
): string {
  const minute = Math.floor(new Date(observedAt).getTime() / 60_000);
  const raw = `map:${objectId}:${kind}:${value}:${Number.isFinite(minute) ? minute : 0}`;
  return raw.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, IDEMPOTENCY_KEY_MAX_LENGTH);
}

// ── Ingest ────────────────────────────────────────────────────────────────────

/** Service rejection reason → stable API error code (mirrors routes/intel.ts). */
const REASON_CODE: Readonly<Record<string, ApiErrorCode>> = {
  feature_disabled: "feature_disabled",
  // The capture surface itself is off (intel_capture_quick_signal). A map
  // contribution cannot bypass the intel capture gate by arriving from the map.
  disabled: "feature_disabled",
  // No valid Intelligence Contributions consent → 403, the D4 lawful-basis refusal.
  consent_required: "forbidden",
  invalid_payload: "invalid_payload",
  prompt_not_allowed: "invalid_payload",
  unsupported_kind: "invalid_payload",
  invalid_idempotency_key: "invalid_payload",
  invalid_observed_at: "invalid_payload",
  invalid_claim_type: "invalid_payload",
  invalid_value: "invalid_payload",
  unknown_subject: "not_found",
  db_error: "db_error",
  // ── Evidence-arrow rejections (lib/intelEvidenceCapture) ──────────────────
  // `evidence_requires_observation` never reaches here: a media contribution
  // with no observationId is refused earlier, as `unsupported_kind`, because
  // that IS what it is — a bare artifact with no proposition. It is mapped
  // anyway so the table stays a total function over the service's reasons.
  evidence_requires_observation: "invalid_payload",
  unsupported_media_kind: "invalid_payload",
  invalid_media_reference: "invalid_payload",
  media_not_owned: "forbidden",
  // Not `not_found`: distinguishing "no such observation" from "not yours"
  // would make this an oracle for other people's contributions.
  unknown_observation: "not_found",
  observation_subject_mismatch: "invalid_payload",
};

export type MapIngestResult =
  | { ok: true; observation: Record<string, any>; deduped: boolean }
  | { ok: true; evidence: Record<string, any>; observationId: string; deduped: boolean }
  | { ok: false; reason: string; code: ApiErrorCode; detail?: string };

function reject(reason: string, detail?: string): MapIngestResult {
  return { ok: false, reason, code: REASON_CODE[reason] ?? "invalid_payload", detail };
}

// ── §22 zone-kind subject resolution ──────────────────────────────────────────
//
// The three §22 zone kinds. A contribution to any of these carries a
// `geo_zones.id` as its `objectId`, not a place id — see the KIND_PROMPTS note.

export const ZONE_SUBJECT_KINDS = ["activity_zone", "social_zone", "crowd_flow"] as const;

export function isZoneSubjectKind(kind: MapObjectKind): boolean {
  return (ZONE_SUBJECT_KINDS as readonly string[]).includes(kind);
}

/**
 * Search radius when the geo_zone declares no `radius_meters` (polygon / city /
 * neighborhood zones). 500 m is one block: close enough that the anchor place is
 * plausibly "in" the zone, far enough that a small circle zone still finds one.
 */
export const ZONE_ANCHOR_DEFAULT_RADIUS_M = 500;

/**
 * Ceiling on the search radius, INCLUDING an explicit `radius_meters`. A `city`
 * zone can be kilometres across; anchoring a crowd-direction observation to a
 * place 8 km away would attribute it to somewhere the contributor never was.
 * 3 km is generous for a neighbourhood and still local.
 */
export const ZONE_ANCHOR_MAX_RADIUS_M = 3_000;

/** How many candidate places the bbox pre-filter may return before we pick the nearest. */
const ZONE_ANCHOR_CANDIDATE_LIMIT = 200;

type ZoneAnchorResult =
  | { ok: true; subjectId: string; zoneId: string }
  | { ok: false; detail: string };

/** The zone's anchor point: its declared centre, else its polygon centroid. */
function zoneAnchorPoint(zone: {
  center_lat?: unknown;
  center_lng?: unknown;
  polygon_geojson?: unknown;
}): { lat: number; lng: number } | null {
  // `== null` first: Number(null) is 0 (finite), so a null centre would
  // silently anchor the whole zone at (0, 0) in the Gulf of Guinea.
  const cLat = zone.center_lat == null ? NaN : Number(zone.center_lat);
  const cLng = zone.center_lng == null ? NaN : Number(zone.center_lng);
  if (Number.isFinite(cLat) && Number.isFinite(cLng)) return { lat: cLat, lng: cLng };

  // Polygon fallback: the mean of the outer ring's vertices. A centroid, not a
  // bounding-box centre, so a concave zone still anchors inside its own mass.
  const poly = zone.polygon_geojson as { coordinates?: unknown } | null | undefined;
  const outer = Array.isArray(poly?.coordinates) ? (poly!.coordinates as unknown[])[0] : null;
  if (!Array.isArray(outer) || outer.length === 0) return null;
  let sumLat = 0;
  let sumLng = 0;
  let n = 0;
  for (const p of outer) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const lng = Number(p[0]);
    const lat = Number(p[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    sumLat += lat;
    sumLng += lng;
    n += 1;
  }
  return n === 0 ? null : { lat: sumLat / n, lng: sumLng / n };
}

/**
 * Resolve a §22 zone contribution to the place it should be observed against.
 *
 * `intel_observations.subject_id` FKs `public.places`, and a zone is not a
 * place. This reads the `geo_zones` row named by `zoneObjectId`, finds the
 * NEAREST active place within the zone's radius, and returns that place as the
 * subject plus the zone id to record alongside it.
 *
 * FAIL-CLOSED, every branch: an unreadable/absent zone, a zone with no usable
 * geometry, an unreadable place list, or no place within range all return
 * `ok:false`. The caller maps that to `unknown_subject` — a refusal, never a
 * guess. It never widens the FK or invents a subject.
 */
export async function resolveZoneAnchorSubject(
  sc: any,
  zoneObjectId: string,
): Promise<ZoneAnchorResult> {
  let zoneRow: any = null;
  try {
    const { data, error } = await sc
      .from("geo_zones")
      .select("id, zone_type, center_lat, center_lng, radius_meters, polygon_geojson")
      .eq("id", zoneObjectId)
      .maybeSingle();
    if (error) return { ok: false, detail: `geo_zone read failed for ${zoneObjectId}` };
    zoneRow = data;
  } catch {
    return { ok: false, detail: `geo_zone read threw for ${zoneObjectId}` };
  }
  if (!zoneRow) return { ok: false, detail: `no geo_zone ${zoneObjectId}` };

  const anchor = zoneAnchorPoint(zoneRow);
  if (!anchor) return { ok: false, detail: `geo_zone ${zoneObjectId} has no usable geometry` };

  const declared = Number(zoneRow.radius_meters);
  const radiusM = Math.min(
    ZONE_ANCHOR_MAX_RADIUS_M,
    Number.isFinite(declared) && declared > 0 ? declared : ZONE_ANCHOR_DEFAULT_RADIUS_M,
  );
  const radiusKm = radiusM / 1000;

  // A bbox pre-filter around the anchor keeps the scan bounded; the nearest is
  // then chosen by true great-circle distance and re-checked against the radius,
  // so a corner of the bbox that lies outside the circle cannot anchor.
  const dLat = radiusKm / KM_PER_DEGREE_LAT;
  const cosLat = Math.max(0.01, Math.cos((anchor.lat * Math.PI) / 180));
  const dLng = radiusKm / (KM_PER_DEGREE_LAT * cosLat);

  let placeRows: any[] | null = null;
  try {
    const { data, error } = await sc
      .from("places")
      .select("id, latitude, longitude")
      .eq("status", "active")
      .is("merged_into_place_id", null)
      .gte("latitude", anchor.lat - dLat)
      .lte("latitude", anchor.lat + dLat)
      .gte("longitude", anchor.lng - dLng)
      .lte("longitude", anchor.lng + dLng)
      .limit(ZONE_ANCHOR_CANDIDATE_LIMIT);
    if (error || !Array.isArray(data)) return { ok: false, detail: `place read failed near geo_zone ${zoneObjectId}` };
    placeRows = data as any[];
  } catch {
    return { ok: false, detail: `place read threw near geo_zone ${zoneObjectId}` };
  }

  let bestId: string | null = null;
  let bestKm = Infinity;
  for (const r of placeRows) {
    const lat = Number(r?.latitude);
    const lng = Number(r?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || typeof r?.id !== "string") continue;
    const km = haversineKm(anchor.lat, anchor.lng, lat, lng);
    if (km <= radiusKm && km < bestKm) {
      bestKm = km;
      bestId = r.id;
    }
  }
  if (bestId === null) {
    return { ok: false, detail: `no active place within ${radiusM}m of geo_zone ${zoneObjectId}` };
  }
  return { ok: true, subjectId: bestId, zoneId: String(zoneRow.id) };
}

/**
 * Record one map contribution as an intel observation.
 *
 * Exported so the tests drive the whole gate chain against a fake client. The
 * express handler below adds only authentication, rate limiting and status
 * mapping — no rule lives there that is not exercised here.
 */
export async function ingestMapContribution(
  sc: any,
  actorId: string,
  body: unknown,
  opts: { idempotencyKey?: string | null } = {},
): Promise<MapIngestResult> {
  // Flag arg is a LITERAL so check-flag-polarity can resolve this stop statically.
  if (!(await isFlagEnabled(sc, "map_contributions_enabled"))) return reject("feature_disabled");

  const parsed = mapContributionSchema.safeParse(body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return reject("invalid_payload", issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid contribution");
  }
  const c = parsed.data;

  if (!isPromptAllowed(c.objectKind, c.kind)) {
    return reject("prompt_not_allowed", `the ${c.kind} prompt is not applicable to a ${c.objectKind}`);
  }

  // ── The evidence arrow ──────────────────────────────────────────────────────
  //
  // Taken BEFORE the claim mapping, and it is the only branch in this function.
  // A media contribution has no claim to map, so falling through to
  // mapContributionToClaim would refuse it — which is exactly what happened
  // before, and is still what happens to a media contribution that names no
  // observation.
  //
  // The order inside the branch matters. "Which observation does this support?"
  // is asked FIRST, before the asset is looked at at all: a bare photo is not a
  // §22 contribution regardless of whether its URI would have validated, and
  // answering with a media error would suggest a better URI could fix it.
  if (c.kind === "media") {
    if (!c.observationId) {
      // §21 orders Observation before Evidence. This is the same refusal the
      // route has always given a bare media contribution, and the same reason
      // string — the ruling — now ending in what to do instead.
      return reject("unsupported_kind", `${c.kind} cannot be recorded on its own: ${UNSUPPORTED_CONTRIBUTION_KINDS.media}`);
    }
    const attached = await attachMediaEvidence(sc, actorId, {
      observationId: c.observationId,
      subjectId: c.objectId,
      mediaUri: c.mediaUri,
      mediaKind: c.value,
      observedAt: c.observedAt,
    });
    if (!attached.ok) return reject(attached.reason, attached.detail);
    // No claim, no confidence, no snapshot, no reward — and no observation
    // either: this arrow attaches to one, it does not create one.
    return { ok: true, evidence: attached.evidence, observationId: c.observationId, deduped: attached.deduped };
  }

  const mapped = mapContributionToClaim(c.kind, c.value);
  if (!mapped) {
    const why = UNSUPPORTED_CONTRIBUTION_KINDS[c.kind] ?? "no canonical claim type for this prompt";
    return reject("unsupported_kind", `${c.kind} cannot be recorded yet: ${why}`);
  }

  // §22 zone kinds are AREAS, not places. Resolve the geo_zone in `objectId` to
  // the nearest active place inside it, and observe against THAT place while
  // recording the zone. Fail-closed (unknown_subject) when the zone cannot be
  // anchored — never widen the FK, never guess a subject. Place-shaped kinds
  // pass straight through: their objectId already IS the place id.
  let subjectId = c.objectId;
  let zoneId: string | null = null;
  if (isZoneSubjectKind(c.objectKind)) {
    const anchored = await resolveZoneAnchorSubject(sc, c.objectId);
    if (!anchored.ok) return reject("unknown_subject", anchored.detail);
    subjectId = anchored.subjectId;
    zoneId = anchored.zoneId;
  }

  // The idempotency key is derived from the CLIENT's objectId (the zone), not
  // the resolved anchor place, so two travellers reporting the same zone from
  // the same tap do not collide: dedup is per (actor, their own contribution).
  const idempotencyKey = isValidIdempotencyKey(opts.idempotencyKey)
    ? opts.idempotencyKey
    : deriveIdempotencyKey(c.objectId, c.kind, c.value, c.observedAt);

  const input: CaptureInput = {
    subjectId,
    // The subject kind the intel system stores. `experience` is the service's
    // own default; the map's own object kind is not a subject kind.
    subjectKind: "experience",
    zoneId,
    claimType: mapped.claimType,
    value: mapped.value,
    observedAt: c.observedAt,
    capturedAt: null,
    idempotencyKey,
    // Deliberately NOT set, and each omission is a fail-closed default:
    //   visibility        → 'private'. A map tap is not consent to publish; the
    //                       projection is what makes an aggregate public.
    //   presenceLevel     → 'P0'. There is no proximity proof in a §22 payload,
    //                       and P0 scores presence 0 in deriveComponents, so one
    //                       unverified tap cannot reach a live band alone. That
    //                       is exactly "observations, not immediate truth".
    //   partySize/partyId → absent ⇒ group_key null ⇒ counts as a person, never
    //                       as an independent group in the k-anonymity gate.
    captureSurface: "quick_signal",
  };

  const result = await writeObservation(sc, actorId, input);
  if (!result.ok) return reject(result.reason, result.detail);

  // NOTE WHAT DOES NOT HAPPEN HERE: no proposeClaim, no claim insert, no
  // snapshot write, no confidence computed, no reward booked. The observation
  // is now evidence, and it earns a map change through the projection or not at
  // all.
  return { ok: true, observation: result.observation, deduped: result.deduped };
}

// ── Response envelope ─────────────────────────────────────────────────────────
//
// Carries no confidence, no band, and no live value — a 201 here means "your
// observation was recorded", never "the map now says this". `state: "observed"`
// is the whole claim being made.

function envelope(observation: any, kind: string): Record<string, unknown> {
  return {
    id: observation.id,
    objectId: observation.subject_id,
    kind,
    claimType: observation.claim_type,
    value: observation.value,
    observedAt: observation.observed_at,
    validUntil: observation.expires_at,
    state: "observed",
    // The §22 framing, echoed so a client that renders the server's copy cannot
    // present a contribution as an accepted fact.
    note: "Recorded as an observation. It does not change the live map on its own.",
  };
}

/**
 * The evidence envelope.
 *
 * Carries no claim type, no value, no confidence and no `validUntil` — an
 * artifact makes no assertion, so there is nothing for it to be valid UNTIL.
 * It does not echo the storage key back either: the client sent the reference,
 * knows it, and returning the resolved key would make this endpoint a cheap way
 * to ask "did that key resolve, and to what?".
 */
function evidenceEnvelope(evidence: any, observationId: string, kind: string): Record<string, unknown> {
  return {
    id: evidence.id,
    observationId,
    kind,
    evidenceKind: evidence.evidence_kind,
    state: "evidence_attached",
    note: "Attached as evidence to your observation. It supports that observation; it makes no claim of its own and does not change the live map.",
  };
}

// ── Rate limit ────────────────────────────────────────────────────────────────
//
// A §22 prompt is a single tap on a sheet that is always one tap away, which
// makes it the most spammable write on the map. Twenty a minute is far above
// any honest rate of walking between places and answering prompts.
export const MAP_OBSERVATION_RATE_LIMIT = { id: "map_observations", limit: 20, windowMs: 60_000 };

router.post(
  "/map/observations",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;

    const sc = getServiceClient();
    if (!sc) {
      // Message deliberately names no credential: check-guard-coverage reads a
      // file that mentions a Supabase credential variable as one that can reach
      // the database, and a route behind requireUser is not that file.
      sendError(res, "server_not_configured", "The service client is not configured");
      return;
    }

    // Rate limiting runs BEFORE the flag read — unlike routes/mapTelemetry.ts,
    // which checks its flag first. A disabled analytics endpoint is harmless to
    // hammer; a disabled capture endpoint should still not be a free loop.
    const rl = checkRateLimit(
      MAP_OBSERVATION_RATE_LIMIT.id,
      user.id,
      MAP_OBSERVATION_RATE_LIMIT.limit,
      MAP_OBSERVATION_RATE_LIMIT.windowMs,
    );
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many contributions. Please wait.");
      return;
    }

    const headerKey = req.header("Idempotency-Key") ?? req.header("idempotency-key") ?? null;
    const result = await ingestMapContribution(sc, user.id, req.body ?? {}, { idempotencyKey: headerKey });

    if (!result.ok) {
      // Fail-soft on the flag only, in the sibling's idiom: the capture sheet
      // should not show an error for a capability that is simply not switched
      // on yet. `accepted: 0` keeps it honest — nothing was recorded, and the
      // response never claims otherwise.
      if (result.code === "feature_disabled") {
        res.json({ ok: true, accepted: 0, enabled: false });
        return;
      }
      sendError(res, result.code, result.detail ?? result.reason);
      return;
    }

    const kind = (req.body as any)?.kind;
    const kindLabel = typeof kind === "string" ? kind : "";
    if ("evidence" in result) {
      res.status(result.deduped ? 200 : 201).json({
        ok: true,
        accepted: 1,
        deduped: result.deduped,
        evidence: evidenceEnvelope(result.evidence, result.observationId, kindLabel),
      });
      return;
    }
    res.status(result.deduped ? 200 : 201).json({
      ok: true,
      accepted: 1,
      deduped: result.deduped,
      observation: envelope(result.observation, kindLabel),
    });
  }),
);

export default router;
