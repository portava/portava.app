/**
 * Intelligence Gathering — capture service (IG-03).
 *
 * The PRODUCER the built projection (lib/intelProjection.ts) and read path
 * (lib/liveClaimRead.ts) have been waiting for: it turns a Quick Signal / Moment
 * selection into an append-only intel_observations row, and drives the claim
 * lifecycle (propose -> approve -> confirm -> correct) over intel_claims /
 * intel_confirmations.
 *
 * SHADOW: every write is a fail-closed no-op unless `intel_capture_quick_signal`
 * is enabled. Migration 2130 already created the tables, RLS, append-only
 * triggers, the (actor_id, idempotency_key) unique index and the service_role
 * grants — this module only writes through them.
 *
 * FAIL-CLOSED SUBJECT CHECK: a NON-NULL intel_observations.subject_id FKs
 * public.places(id). In production places holds 0 rows (the Replit backfill is
 * pending), so a real capture would hit a foreign-key 500. This service verifies
 * the subject resolves FIRST and returns a clean `unknown_subject` rejection
 * instead — the 0-rows blocker surfaces as validation, never a stack trace.
 *
 * ── §18.3: A SUBJECT MAY BE UNKNOWN, AND THAT IS AN ANSWER ───────────────────
 * `subjectId` is NULLABLE here, and the schema is nullable with it (migration
 * 3002). The spec's entity reconciliation has four outcomes — Place, Event,
 * Temporary world object, Unknown — and until 3002 the last two could not be
 * STORED, because `subject_id` was `NOT NULL REFERENCES places(id)`. That
 * requirement is what produced the nearest-place snap §14 and §18.3 both forbid
 * by name ("Never assign to the nearest place merely to satisfy a foreign key").
 *
 * So an unowned cluster is written with `subjectId: null`, the zone it was seen
 * in, and a subject kind of `unknown` or `temporary_world_object`
 * (lib/sensingSubjectReconciliation owns that vocabulary and the rule that
 * PROXIMITY IS NOT OWNERSHIP). This service refuses an unowned capture that
 * names no zone — `unknown_subject`, fail-closed — because a cluster with
 * neither an owner nor a place to be in is not an observation of anywhere.
 *
 * Note what does NOT follow: proposeClaim REFUSES an unresolved subject
 * (`unresolved_subject`). intel_claims.subject_id is still NOT NULL REFERENCES
 * places(id), deliberately — a published claim is a proposition about a PLACE,
 * and minting one for an unowned cluster would be the same snap by another
 * route.
 *
 * ── THE CONTRIBUTOR IDENTITY IS NOT AN ACCOUNT ID ────────────────────────────
 * `actorId` is still passed in and still used for consent, crew membership and
 * the group key — those are decisions ABOUT THE PERSON MAKING THE REQUEST, taken
 * before anything is stored. What is STORED is not an account id: migration 3002
 * dropped `actor_id`'s foreign key to profiles and put a BEFORE INSERT trigger on
 * the three contribution tables that replaces the submitted account id with a
 * rotating, non-reversible contributor token. Sensing §3: "World-intelligence
 * contribution records should not carry a permanent profiles.id / account
 * user_id foreign key."
 *
 * The one place that has to KNOW about the swap is the idempotent-replay lookup
 * below, because it reads a row back by contributor identity. It handles both
 * schemas on purpose — 3002 is in the tree and has NOT been applied — and the
 * pre-3002 branch becomes dead the day it is.
 */
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { affectedRows } from "../../lib/affectedRows.js";
import {
  CLAIM_TYPES,
  COMMERCIAL_DISCLOSURES,
  MODERATION_STATES,
  VISIBILITIES,
  PRESENCE_LEVELS,
  MIN_PRESENCE_FOR_LIVE_CLAIM,
  clampObservedAt,
  disclosureSourceClass,
  isValidIdempotencyKey,
  isPilotClaimable,
  type CommercialDisclosure,
  type Visibility,
  type PresenceLevel,
  type PartySizeBucket,
} from "../../lib/intelContracts.js";
import { PHASE1_CAPTURE_CLAIM_TYPES, validateClaimValue } from "../../lib/quickSignal.js";
import { projectClaimValue } from "../../lib/intelValueProjection.js";
import { PHASE1_TRAIL_CAPTURE_CLAIM_TYPES, validateTrailClaimValue, mustAggregate } from "../../lib/trailFollowup.js";
import { deriveGroupKey, type GroupIdentity } from "../../lib/intelGroupKey.js";
import { readSharedCrewMembership } from "../../domain/trips/invariants/tripMembership.js";
import { resolveActiveCrewId } from "../../lib/activeCrew.js";
import { hasValidIntelConsent } from "../../lib/intelConsent.js";
import { logger } from "../../lib/logger.js";
import { verifyPresence, type PresenceVerificationOutcome } from "./PresenceVerifier.js";
import { isUnownedSubjectKind } from "../../lib/sensingSubjectReconciliation.js";

/**
 * Capture surfaces, each gated by its own flag (spec §26 flag registry):
 *   quick_signal → intel_capture_quick_signal
 *   trail        → intel_trail_followup
 * The mapping is applied in surfaceFlagEnabled() with literal flag args so
 * check-flag-polarity can resolve each stop statically.
 */
export const CAPTURE_SURFACES = ["quick_signal", "trail"] as const;
export type CaptureSurface = (typeof CAPTURE_SURFACES)[number];

/**
 * The claim types each surface may emit. The trail surface (IG-06) persists only
 * the contracted, aggregate-gated going-next claim (PHASE1_TRAIL_CAPTURE_CLAIM_TYPES
 * — see its docstring for why exit_reason is not there). A client selects the
 * surface explicitly (routes/intel.ts `captureSurface`); nothing infers it.
 */
const SURFACE_CLAIMS: Record<CaptureSurface, readonly string[]> = {
  quick_signal: PHASE1_CAPTURE_CLAIM_TYPES,
  trail: PHASE1_TRAIL_CAPTURE_CLAIM_TYPES,
};

function validateForSurface(surface: CaptureSurface, claimType: string, value: unknown): boolean {
  return surface === "trail"
    ? validateTrailClaimValue(claimType, value)
    : validateClaimValue(claimType, value);
}

/**
 * Whether the surface's gating flag is on — AND, for a surface whose flag has a
 * dependency, whether that dependency is on too.
 *
 * INTEL_FLAG_DEPENDENCIES (lib/intelContracts) says "a flag may only be honoured
 * when everything it depends on is also on", and lists
 * `intel_trail_followup → intel_capture_quick_signal`. Until 2026-09-05 that
 * chain was declared and pinned by a test but enforced NOWHERE for this surface:
 * the trail flag alone opened the write path, so `intel_trail_followup` could be
 * honoured with its dependency off. lib/liveClaimRead.liveLabelsServable is the
 * precedent — it walks its whole chain by hand for the same reason.
 *
 * The flag args below are LITERALS on purpose — check-flag-polarity resolves each
 * isFlagEnabled() call statically and cannot follow SURFACE_FLAG[surface]. Keep
 * them literal so each stop is visible. Order matters: the surface's own flag is
 * read first, so an off trail flag still short-circuits before anything else.
 */
async function surfaceFlagEnabled(sc: any, surface: CaptureSurface): Promise<boolean> {
  if (surface === "trail") {
    if (!(await isFlagEnabled(sc, "intel_trail_followup"))) return false;
    return isFlagEnabled(sc, "intel_capture_quick_signal");
  }
  return isFlagEnabled(sc, "intel_capture_quick_signal");
}

/** The capture lifecycle (propose/approve/confirm) is shared across surfaces; it
 *  runs while ANY capture surface is enabled. Literal flag args (see above). */
async function captureSystemEnabled(sc: any): Promise<boolean> {
  return (
    (await isFlagEnabled(sc, "intel_capture_quick_signal")) ||
    (await isFlagEnabled(sc, "intel_trail_followup"))
  );
}

export interface CaptureInput {
  /**
   * places(id), or NULL for the two §18.3 outcomes that have no canonical owner
   * (`unknown`, `temporary_world_object`). A null subject REQUIRES `zoneId`.
   */
  subjectId: string | null;
  subjectKind?: string;           // default 'experience'; 'unknown' / 'temporary_world_object' when subjectId is null
  zoneId?: string | null;
  claimType: string;              // must be in SURFACE_CLAIMS[captureSurface]
  value: Record<string, unknown>; // validated against the claim type
  observedAt: string | number | Date;
  capturedAt?: string | null;
  visibility?: Visibility;        // default 'private'
  idempotencyKey: string;
  presenceLevel?: string;         // from a presence attestation; default 'P0'
  presenceAttestation?: Record<string, unknown> | null;
  captureSurface?: CaptureSurface; // default 'quick_signal'
  // §22 Table 30 commercial disclosure. Optional; omitted/unknown ⇒ 'none'
  // (fail-closed). A non-'none' disclosure records the observation under a
  // NON_INDEPENDENT source class (disclosureSourceClass) so a disclosed-commercial
  // report never counts as independent community consensus.
  commercialDisclosure?: CommercialDisclosure;
  // V1 independent-group signal (§privacy). partySize is the raw "who are you here
  // with?" answer; partyId is the observer's active Trip Crew id (validated here).
  // Both optional → group_key resolves to null (fail-closed) for older clients.
  partySize?: PartySizeBucket;
  partyId?: string | null;
}

export type CaptureResult =
  | { ok: true; observation: any; deduped: boolean }
  | { ok: false; reason: "disabled" | "consent_required" | "invalid_idempotency_key" | "invalid_observed_at" | "unknown_subject" | "invalid_claim_type" | "invalid_value" | "db_error"; detail?: string };

function ttlFor(claimType: string): { ttlSeconds: number; hardExpirySeconds: number } | null {
  const spec = CLAIM_TYPES.find((c) => c.claimType === claimType);
  return spec ? { ttlSeconds: spec.ttlSeconds, hardExpirySeconds: spec.hardExpirySeconds } : null;
}

// ── Presence attestation gate (finding H2) ───────────────────────────────────
// presence_level arrives from the client request body and is later weighted as
// CONFIDENCE downstream (lib/intelProjectionAggregator PRESENCE_STRENGTH, where
// P4 == 1.0 — "Live from verified visitor" strength). So a client that simply
// asserts a high presence — with no proximity proof at all — was being treated
// as a strongly-attested live visitor.
//
// A "live-grade" presence (>= MIN_PRESENCE_FOR_LIVE_CLAIM, i.e. P2 and up) is by
// the ladder's own definition a claim that the contributor was verifiably
// present: geofence + dwell (P2), receipt/entry evidence (P3) or a mission nonce
// (P4). It may therefore only stand when a server-side attestation actually
// backs it. No such verifier exists in the capture path today (there is no
// geofence / proximity / dwell check available here, and the HTTP route forwards
// no attestation payload), so, per the fail-closed rule, an unattested
// live-grade claim is CLAMPED down to the highest level BELOW the live floor
// (the "unverified ceiling"). Below-floor presence (P0/P1 — no proof / coarse
// neighborhood) needs no attestation and passes through unchanged.
//
// `verifyAttestation` is the seam a real proximity/geofence/receipt verifier
// plugs into later; until one exists it defaults to "unverifiable" so every
// live-grade claim clamps. The attestation record stores claimed-vs-stored so
// nothing is silently dropped and the projection layer can tell attested from
// unattested.
const MIN_LIVE_PRESENCE_INDEX = PRESENCE_LEVELS.indexOf(MIN_PRESENCE_FOR_LIVE_CLAIM);
const UNVERIFIED_PRESENCE_CEILING: PresenceLevel =
  PRESENCE_LEVELS[Math.max(0, MIN_LIVE_PRESENCE_INDEX - 1)];

/** A client presence level, normalised onto the ladder; anything malformed → P0 (fail-closed). */
function normalisePresenceLevel(level: unknown): PresenceLevel {
  return typeof level === "string" && (PRESENCE_LEVELS as readonly string[]).includes(level)
    ? (level as PresenceLevel)
    : "P0";
}

const presenceRank = (level: PresenceLevel): number => PRESENCE_LEVELS.indexOf(level);

export interface ResolvedPresence {
  /** What is stored in presence_level and weighted downstream. */
  presenceLevel: PresenceLevel;
  /** Provenance stored in presence_attestation — claimed vs stored, never dropped. */
  attestation: Record<string, unknown>;
}

/**
 * Resolve the presence level that may actually be STORED for an observation.
 *
 * A live-grade claim (>= MIN_PRESENCE_FOR_LIVE_CLAIM) survives only if
 * `verifyAttestation` confirms a server-side attestation; otherwise it is clamped
 * to UNVERIFIED_PRESENCE_CEILING. Below-floor claims pass through. The returned
 * attestation record always records both the claimed and the stored level.
 */
export function resolvePresenceAttestation(
  claimedLevelRaw: unknown,
  claimedAttestation: Record<string, unknown> | null | undefined,
  verifyAttestation: (
    level: PresenceLevel,
    attestation: Record<string, unknown> | null | undefined,
  ) => boolean = () => false,
): ResolvedPresence {
  const claimed = normalisePresenceLevel(claimedLevelRaw);
  const isLiveGrade = presenceRank(claimed) >= MIN_LIVE_PRESENCE_INDEX;
  const attested = isLiveGrade && verifyAttestation(claimed, claimedAttestation) === true;
  const presenceLevel: PresenceLevel =
    isLiveGrade && !attested ? UNVERIFIED_PRESENCE_CEILING : claimed;
  return {
    presenceLevel,
    attestation: {
      claimed,
      stored: presenceLevel,
      attested,
      clamped: presenceLevel !== claimed,
      liveGradeFloor: MIN_PRESENCE_FOR_LIVE_CLAIM,
      reason: !isLiveGrade ? "below_live_floor" : attested ? "attested" : "clamped_unattested",
      // The raw client-supplied attestation, recorded but never trusted or dropped.
      client: claimedAttestation ?? null,
    },
  };
}

// ── Presence verification (unit I3, P2/P3/P4) ────────────────────────────────
// The verifier that plugs into the seam above. Consulted ONLY when
// `intel_presence_verification_enabled` is on AND the claim is live-grade; in
// every other case the result is exactly resolvePresenceAttestation's, so with
// the flag OFF the capture path is byte-identical to before this unit landed.
//
// The verifier reports what the SERVER-HELD evidence supports (Table 13 rungs:
// geofence + dwell/interaction ⇒ P2, + receipt ⇒ P3, + mission nonce ⇒ P4). The
// stored level is the LOWER of the claim and that verdict: verification can only
// ever lower a claim, never inflate it, and any verifier failure is P1.

export interface ResolvedPresenceForCapture extends ResolvedPresence {
  /** Present only when the verifier actually ran (flag ON + live-grade claim). */
  verification?: PresenceVerificationOutcome;
}

export interface PresenceCaptureContext {
  actorId: string;
  /** Null for an unowned (§18.3 unknown / temporary_world_object) capture. */
  subjectId: string | null;
  subjectKind: string;
  claimType: string;
  /** Server-clamped ISO observed_at. */
  observedAt: string;
  capturedAt: string | null;
}

export async function resolvePresenceForCapture(
  sc: any,
  claimedLevelRaw: unknown,
  claimedAttestation: Record<string, unknown> | null | undefined,
  ctx: PresenceCaptureContext,
): Promise<ResolvedPresenceForCapture> {
  const claimed = normalisePresenceLevel(claimedLevelRaw);
  const isLiveGrade = presenceRank(claimed) >= MIN_LIVE_PRESENCE_INDEX;
  // Below the live floor nothing is verified — unchanged behaviour, no flag read.
  if (!isLiveGrade) return resolvePresenceAttestation(claimedLevelRaw, claimedAttestation);
  // §18.3 unowned subject: there is no place to geofence against, no saved_place
  // to interact with and no mission to redeem, so PresenceVerifier has nothing to
  // verify — every one of its rungs is keyed on a places row. Clamping (the
  // no-verifier path) is the fail-closed answer, not a reason to invent a place.
  if (ctx.subjectId == null) return resolvePresenceAttestation(claimedLevelRaw, claimedAttestation);
  // Flag OFF (or unreadable — isFlagEnabled is fail-closed) ⇒ today's clamp, byte-identical.
  if (!(await isFlagEnabled(sc, "intel_presence_verification_enabled"))) {
    return resolvePresenceAttestation(claimedLevelRaw, claimedAttestation);
  }

  const verification = await verifyPresence(sc, {
    actorId: ctx.actorId,
    subjectId: ctx.subjectId,
    subjectKind: ctx.subjectKind,
    claimType: ctx.claimType,
    observedAt: ctx.observedAt,
    capturedAt: ctx.capturedAt,
    claimedLevel: claimed,
    attestation: claimedAttestation,
  });
  // Never above the claim, never above the evidence.
  const presenceLevel: PresenceLevel =
    presenceRank(verification.level) < presenceRank(claimed) ? verification.level : claimed;
  const attested = presenceRank(presenceLevel) >= MIN_LIVE_PRESENCE_INDEX;
  return {
    presenceLevel,
    attestation: {
      claimed,
      stored: presenceLevel,
      attested,
      clamped: presenceLevel !== claimed,
      liveGradeFloor: MIN_PRESENCE_FOR_LIVE_CLAIM,
      reason: attested ? "attested" : "clamped_unverified",
      client: claimedAttestation ?? null,
      // Server-written verdict (coarse buckets + references, never a coordinate).
      // `verifier.geofence === "inside"` is what a LATER capture's dwell check
      // reads back from this observation — server-set, so a client cannot forge it.
      verifier: { version: 1, method: verification.method, level: verification.level, ...verification.evidence },
    },
    verification,
  };
}

/**
 * Append the audit row for a verification attempt (intel_presence_verifications,
 * migration 2276). Best-effort AFTER the observation is stored: a failed audit
 * write is logged — observable, never silent — but does not undo the capture.
 */
async function recordPresenceVerification(
  sc: any, observationId: string, actorId: string, verification: PresenceVerificationOutcome,
): Promise<boolean> {
  const { error } = await sc.from("intel_presence_verifications").insert({
    observation_id: observationId,
    actor_id: actorId,
    method: verification.method,
    level_reached: verification.level,
    evidence: verification.evidence,
    verified_at: new Date().toISOString(),
  });
  if (error) {
    logger.warn({ err: error, observationId }, "intel presence verification record write failed");
    return false;
  }
  return true;
}

/**
 * Find the row a 23505 on (actor_id, idempotency_key) says already exists.
 *
 * TWO SCHEMAS, ON PURPOSE. `3002_intel_contribution_identity.sql` drops
 * `actor_id`'s foreign key to profiles and puts a BEFORE INSERT trigger on
 * intel_observations that replaces the submitted account id with a rotating,
 * non-reversible contributor token. It is IN THE TREE and has NOT been applied,
 * so this lookup must be correct against both shapes:
 *
 *   pre-3002   the stored actor_id IS the account id  -> filter on it directly
 *   post-3002  the stored actor_id is a token         -> ask the database for
 *              this actor's token (public.intel_contributor_token, service_role
 *              only) and filter on that
 *
 * Order matters only for cost: the direct filter is one round trip and is the
 * whole answer before the migration lands, so it runs first and the RPC is only
 * reached when it finds nothing — which, after the migration, is always.
 *
 * FAILURE IS NOT SILENCE. A lookup that cannot answer returns `ok:false` and the
 * caller reports db_error so the client retries; it never reports a dedup it did
 * not verify, and never returns someone else's row. In particular it does NOT
 * fall back to matching on `idempotency_key` alone: a derived key (see
 * routes/mapObservations.deriveIdempotencyKey) is a function of the
 * CONTRIBUTION, not of the contributor, so two travellers tapping the same
 * prompt in the same minute share one — and handing back the other person's
 * observation id would be a disclosure, not a dedup.
 */
type ReplayLookup =
  | { ok: true; observation: any | null }
  | { ok: false; error: unknown; detail: string };

async function findReplayedObservation(
  sc: any, actorId: string, idempotencyKey: string,
): Promise<ReplayLookup> {
  const { data: direct, error: directErr } = await sc
    .from("intel_observations").select("*")
    .eq("actor_id", actorId).eq("idempotency_key", idempotencyKey).maybeSingle();
  if (directErr) return { ok: false, error: directErr, detail: String((directErr as any).message ?? "") };
  if (direct) return { ok: true, observation: direct };

  // Post-3002: the stored identity is a token this process cannot derive (the
  // pepper is unreadable by every application role — that is the point), so the
  // database is asked for it.
  let token: string | null = null;
  try {
    const { data, error } = await sc.rpc("intel_contributor_token", { p_actor_id: actorId });
    if (error) return { ok: false, error, detail: `contributor token lookup: ${String((error as any).message ?? "")}` };
    token = typeof data === "string" ? data : (Array.isArray(data) && typeof data[0] === "string" ? data[0] : null);
  } catch (err) {
    // A client without .rpc, or a database without 3002 applied. Nothing more can
    // be established, and the safe direction is to say so.
    return { ok: false, error: err, detail: "contributor token lookup unavailable" };
  }
  if (!token) return { ok: false, error: null, detail: "contributor token lookup returned nothing" };

  const { data: byToken, error: tokenErr } = await sc
    .from("intel_observations").select("*")
    .eq("actor_id", token).eq("idempotency_key", idempotencyKey).maybeSingle();
  if (tokenErr) return { ok: false, error: tokenErr, detail: String((tokenErr as any).message ?? "") };
  return { ok: true, observation: byToken ?? null };
}

/**
 * Write one observation. Fail-closed no-op when the flag is off. Idempotent: a
 * replay of the same (actor_id, idempotency_key) returns the stored row.
 */
export async function writeObservation(sc: any, actorId: string, input: CaptureInput): Promise<CaptureResult> {
  const surface: CaptureSurface = input.captureSurface ?? "quick_signal";
  if (!(await surfaceFlagEnabled(sc, surface))) return { ok: false, reason: "disabled" };

  // D4 lawful-basis gate (server-authoritative, fail-closed). An intel observation
  // is a contribution under the consent-based `intel_claim` purpose, so no capture
  // — on ANY surface, via ANY caller, direct API included — is written without
  // valid, un-withdrawn consent. Client state cannot satisfy this; only the
  // service-role-owned intel_contribution_consent row can.
  if (!(await hasValidIntelConsent(sc, actorId))) return { ok: false, reason: "consent_required" };

  if (!isValidIdempotencyKey(input.idempotencyKey)) return { ok: false, reason: "invalid_idempotency_key" };

  const clamped = clampObservedAt(input.observedAt);
  if (!clamped) return { ok: false, reason: "invalid_observed_at" };

  if (!SURFACE_CLAIMS[surface].includes(input.claimType))
    return { ok: false, reason: "invalid_claim_type", detail: `${input.claimType} is not a contracted claim on the ${surface} capture surface` };
  if (!validateForSurface(surface, input.claimType, input.value)) return { ok: false, reason: "invalid_value", detail: input.claimType };

  // ── KEY PROJECTION (lib/intelValueProjection) ──────────────────────────────
  // The validators above check the keys they NAME; none of them rejects an extra
  // one. `value` is a client-supplied `z.record(z.string(), z.unknown())`, and it
  // does not stay here — 2174's promote copies `o.value` verbatim into
  // intel_claims.value, the aggregator carries it to intel_state_snapshots.value,
  // and lib/intelApiProjection emits that as a REDISTRIBUTABLE field. So an
  // unnamed key (free text, a coordinate) rode a validated claim all the way to a
  // column lib/dataRights classifies personal:false. Project to the named keys —
  // then re-validate, so a projection that dropped something required refuses the
  // write rather than storing a shape nothing downstream can read.
  const projectedValue = projectClaimValue(input.claimType, input.value);
  if (!projectedValue || !validateForSurface(surface, input.claimType, projectedValue)) {
    return { ok: false, reason: "invalid_value", detail: input.claimType };
  }

  const visibility: Visibility = input.visibility && VISIBILITIES.includes(input.visibility) ? input.visibility : "private";

  // ── SUBJECT RESOLUTION (§18.3) ────────────────────────────────────────────
  // Two shapes, and the second one is the whole point of this unit.
  //
  //   OWNED    subjectId names a places row. Resolved fail-closed, exactly as
  //            before — never let the places FK throw a 500.
  //   UNOWNED  subjectId is null. The §18.3 outcomes `unknown` and
  //            `temporary_world_object`, keyed on the ZONE the activity was seen
  //            in. There is no place to look up, and looking for a nearby one is
  //            the snap §14 forbids.
  //
  // The two refusals below are the fail-closed halves of the unowned shape:
  // a null subject with no zone names nowhere at all, and a null subject with an
  // OWNED subject kind is a caller that lost its answer on the way here. Both are
  // also refused by intel_observations_subject_resolution_check (migration 3002),
  // so a caller that bypasses this service still cannot write either shape.
  const subjectKind = input.subjectKind ?? "experience";
  const unowned = input.subjectId == null;
  if (unowned) {
    if (!input.zoneId) {
      return { ok: false, reason: "unknown_subject", detail: "an unowned observation must name the zone it was observed in" };
    }
    if (!isUnownedSubjectKind(subjectKind)) {
      return { ok: false, reason: "unknown_subject", detail: `subject_kind '${subjectKind}' requires a subject id` };
    }
  } else {
    if (isUnownedSubjectKind(subjectKind)) {
      return { ok: false, reason: "unknown_subject", detail: `subject_kind '${subjectKind}' must not carry a place id` };
    }
    const { data: subj, error: subjErr } = await sc.from("places").select("id").eq("id", input.subjectId).maybeSingle();
    if (subjErr) return { ok: false, reason: "db_error", detail: "subject lookup" };
    if (!subj) return { ok: false, reason: "unknown_subject", detail: input.subjectId ?? "" };
  }

  // Presence attestation gate (H2): a client-asserted live-grade presence is not
  // trusted without a server-verified attestation. With
  // intel_presence_verification_enabled OFF (the default) no verifier runs and
  // every unattested live-grade claim is clamped to the unverified ceiling; ON,
  // services/intel/PresenceVerifier may confirm P2/P3/P4 from server-held
  // evidence (unit I3). Resolved after the subject check so an unknown subject
  // never spends a mission nonce.
  const presence = await resolvePresenceForCapture(sc, input.presenceLevel, input.presenceAttestation, {
    actorId,
    subjectId: input.subjectId,
    subjectKind,
    claimType: input.claimType,
    observedAt: clamped.observedAt,
    capturedAt: input.capturedAt ?? null,
  });

  const ttl = ttlFor(input.claimType);
  const expiresAt = ttl ? new Date(new Date(clamped.observedAt).getTime() + ttl.ttlSeconds * 1000).toISOString() : null;

  // V1 independent-group signal. Only label-eligible (quick_signal) captures feed a
  // public live label, so only they carry a group signal. Hierarchy, fail-closed:
  //   1. a client-supplied partyId that is a SHARED crew (≥2 members) the actor is on;
  //   2. else a SERVER-RESOLVED active shared crew -> a shared crew token. This is
  //      AUTHORITATIVE over the answer below, so a crew member cannot split the crew
  //      by omitting partyId and self-reporting "just me";
  //   3. else "just me" -> a per-actor solo token (a lone visitor is its own group);
  //   4. else / unknown -> null (counts as a person, never as a group).
  // Both crew paths require a SHARED crew so a solo trip cannot mint a per-person
  // crew key (which would SPLIT a crew — the leak the signal exists to prevent).
  let groupIdentity: GroupIdentity | null = null;
  let partySizeBucket: PartySizeBucket | null = null;
  if (surface === "quick_signal") {
    partySizeBucket = input.partySize ?? null;
    // DISCRIMINATING read, not the discarding wrapper. `isSharedCrewMember`
    // collapses "not on this trip" and "nobody could read this trip" into the
    // same `false`, and the two demand opposite treatments here. Collapsing them
    // is safe for AUTHORIZATION — nothing is granted on an unread roster — but
    // this is not an authorization question. It asks whether three observations
    // are one group or three, and a fail-closed `false` answers that about data
    // nobody looked at: every member of a real crew falls through to the solo/
    // none branch and the crew enters the corpus as N independent reports of one
    // fact. `tripMembership.ts`'s own header calls that "a SPLIT, i.e. the exact
    // leak the crew signal exists to prevent (NOT a harmless merge)", and its
    // doc comment records converting this caller as owed work. census-trips
    // §74.3; pinned by `src/test/intelCrewSplitOnDegradedRead.test.ts`.
    const asserted = input.partyId
      ? await readSharedCrewMembership(sc, input.partyId, actorId)
      : null;
    if (asserted && !asserted.readable) {
      // Neither available answer is true. The token cannot be GRANTED, because
      // nothing verified the actor is on that trip; and it cannot be silently
      // downgraded, because that is the split. So the capture is refused the way
      // the subject lookup above is refused — retryable, and nothing enters the
      // corpus carrying an independence claim that was never established.
      return { ok: false, reason: "db_error", detail: "crew membership" };
    }
    if (asserted?.member) {
      groupIdentity = { kind: "crew", crewId: input.partyId! };
    } else {
      const activeCrewId = await resolveActiveCrewId(sc, actorId, new Date());
      if (activeCrewId) {
        groupIdentity = { kind: "crew", crewId: activeCrewId };
      } else if (input.partySize === "just_me") {
        groupIdentity = { kind: "solo", actorId };
      }
    }
  }
  // The group key folds the SUBJECT in so the same crew at two venues produces two
  // unlinkable keys (lib/intelGroupKey). An unowned cluster has no place id, so the
  // zone takes that role — a coarse area, never a position, and prefixed so a zone
  // id can never collide with a place id in the digest.
  const groupSubject = input.subjectId ?? `zone:${input.zoneId ?? ""}`;
  const groupKey = deriveGroupKey(groupSubject, groupIdentity);

  // §22 Table 30 commercial disclosure. Fail-closed: an unknown/omitted value is
  // 'none'. A DISCLOSED commercial relationship (non-'none') records the
  // observation under the NON_INDEPENDENT `sponsored` source class
  // (disclosureSourceClass), which is the "official/community separation" that
  // keeps a disclosed-commercial report out of independent community consensus —
  // it never overwrites confidence, only its epistemic standing.
  const commercialDisclosure: CommercialDisclosure =
    input.commercialDisclosure && (COMMERCIAL_DISCLOSURES as readonly string[]).includes(input.commercialDisclosure)
      ? input.commercialDisclosure
      : "none";

  const row = {
    // The INGEST CREDENTIAL, not what is stored. Migration 3002's BEFORE INSERT
    // trigger replaces this with a rotating, non-reversible contributor token
    // before the row exists; there is no longer a foreign key to profiles for it
    // to satisfy. Sending the account id is what lets the database derive the
    // token (and what lets erase_intel_for_actor find it again).
    actor_id: actorId,
    subject_kind: subjectKind,
    subject_id: input.subjectId,
    zone_id: input.zoneId ?? null,
    claim_type: input.claimType,
    // The PROJECTED value — never the raw client object. See the projection above.
    value: projectedValue,
    source_class: disclosureSourceClass(commercialDisclosure),
    capture_surface: surface,
    visibility,
    moderation_state: "pending",
    commercial_disclosure: commercialDisclosure,
    presence_level: presence.presenceLevel,
    presence_attestation: presence.attestation,
    observed_at: clamped.observedAt,
    captured_at: input.capturedAt ?? null,
    expires_at: expiresAt,
    idempotency_key: input.idempotencyKey,
    group_key: groupKey,
    party_size_bucket: partySizeBucket,
  };

  const { data, error } = await sc.from("intel_observations").insert(row).select().single();
  if (error) {
    // Unique (actor_id, idempotency_key) -> idempotent replay: return the stored row.
    if (String((error as any).code) === "23505") {
      const replay = await findReplayedObservation(sc, actorId, input.idempotencyKey);
      // The direction here is already safe — a replay we cannot confirm falls
      // through to the db_error below and the client retries, rather than being
      // told a write happened that we cannot show. What was NOT safe is the
      // silence: the reported detail was the 23505, which reads as "your
      // idempotency key collided" when the truth is "the replay lookup failed",
      // and no operator would ever see the second fact.
      if (!replay.ok) {
        logger.warn({ err: replay.error, actorId }, "intel observation replay lookup failed after 23505");
        return { ok: false, reason: "db_error", detail: `replay lookup failed: ${replay.detail}` };
      }
      if (replay.observation) return { ok: true, observation: replay.observation, deduped: true };
    }
    return { ok: false, reason: "db_error", detail: String((error as any).message ?? "") };
  }
  // Unit I3 audit row — only when the verifier actually ran (flag ON + live-grade
  // claim). A deduped replay never reaches here, so a record is written once.
  if (presence.verification && data?.id) {
    await recordPresenceVerification(sc, data.id, actorId, presence.verification);
  }
  return { ok: true, observation: data, deduped: false };
}

/**
 * Table 5 `source_label` for a claim proposed from an observation of a given
 * source class. Registry: official | verified_firsthand | consensus |
 * historical | prediction | sponsored | unverified. A single proposal is never
 * "consensus" — that label is earned by the projection over a cohort, not
 * asserted at propose time. Unknown/malformed → 'unverified' (fail-closed).
 */
export const SOURCE_LABEL_BY_CLASS: Readonly<Record<string, string>> = {
  official_signed: "official",
  verified_firsthand: "verified_firsthand",
  firsthand_unverified: "unverified",
  hearsay: "unverified",
  imported_owned: "unverified",
  sponsored: "sponsored",
  historical_pattern: "historical",
  portava_prediction: "prediction",
};

export function sourceLabelFor(sourceClass: unknown): string {
  return (typeof sourceClass === "string" && SOURCE_LABEL_BY_CLASS[sourceClass]) || "unverified";
}

export type ProposeResult =
  | { ok: true; claim: any; deduped: boolean }
  | { ok: false; reason: string; claim?: undefined };

/**
 * Create a CANDIDATE claim from an approved observation (moment approval step 1).
 *
 * IDEMPOTENT per (observation, claim_type) — migration 2274's partial unique
 * index intel_claims_one_per_observation_type. A replay (double press, retried
 * request, re-run job) hits 23505 and the STORED candidate is returned with
 * `deduped: true`; before 2274 every call inserted another candidate row
 * (routes/intel.ts header). Table 5: the claim carries its lineage root
 * (observation_id), its registry source_label and a lineage record.
 */
export async function proposeClaim(sc: any, observation: any): Promise<ProposeResult> {
  const surface: CaptureSurface = (observation.capture_surface as CaptureSurface) ?? "quick_signal";
  if (!(await surfaceFlagEnabled(sc, surface))) return { ok: false, reason: "disabled" };
  // Moderation (owner pilot ruling): explicitly-invalidated content
  // (restricted/blocked/removed) may never back a claim. 'pending' still flows
  // (promotion is deferred for the pilot). Fail-closed whitelist.
  if (!isPilotClaimable(observation.moderation_state)) return { ok: false, reason: "not_moderated" };
  // Privacy invariant (spec §4): a movement claim is aggregate-only — never a
  // single-user published claim. Capture keeps the observation; propose refuses.
  if (mustAggregate(observation.claim_type)) return { ok: false, reason: "must_aggregate" };
  // §18.3, the half that is NOT about storage. An observation whose subject
  // reconciled to `unknown` or `temporary_world_object` is STORED (3002 made
  // that possible) but may not become a CLAIM: intel_claims.subject_id is still
  // NOT NULL REFERENCES places(id), deliberately, because a claim is a published
  // proposition about a PLACE. Refusing here is what keeps that a ruling rather
  // than a foreign-key 500 — and picking a place for it would be the nearest-
  // place snap arriving one stage later.
  if (observation.subject_id == null) return { ok: false, reason: "unresolved_subject" };
  const ttl = ttlFor(observation.claim_type);
  const base = new Date(observation.observed_at).getTime();
  const observationId: string | null = typeof observation.id === "string" && observation.id.length > 0 ? observation.id : null;
  const claim = {
    subject_kind: observation.subject_kind,
    subject_id: observation.subject_id,
    zone_id: observation.zone_id ?? null,
    claim_type: observation.claim_type,
    value: observation.value,
    status: "candidate",
    source_count: 1,
    observed_at: observation.observed_at,
    expires_at: ttl ? new Date(base + ttl.ttlSeconds * 1000).toISOString() : null,
    hard_expires_at: ttl ? new Date(base + ttl.hardExpirySeconds * 1000).toISOString() : null,
    // Table 5 (2274). observation_id is the lineage root and the idempotency key.
    observation_id: observationId,
    source_label: sourceLabelFor(observation.source_class),
    // Table 5 lineage: "observation, evidence, confirmations, algorithm and
    // correction ancestry". At propose time only the observation is known; the
    // rest is filled by the pipeline stages that produce it (evidence links,
    // confirmations, the projection's algorithm_version, a correction's
    // superseded_by). Ids and classes only — no actor, no coordinates.
    lineage: {
      observation_id: observationId,
      capture_surface: surface,
      source_class: observation.source_class ?? null,
      presence_level: observation.presence_level ?? null,
      moderation_state_at_propose: observation.moderation_state ?? null,
      evidence: [],
      confirmations: [],
      algorithm_version: null,
      correction_of: null,
    },
  };
  const { data, error } = await sc.from("intel_claims").insert(claim).select().single();
  if (error) {
    // 23505 on (observation_id, claim_type) → idempotent replay: return the
    // stored candidate. Any other 23505 (e.g. 2174's one-live-per-key index)
    // finds no row here and is reported as the error it is.
    if (String((error as any).code) === "23505" && observationId) {
      const { data: existing, error: replayErr } = await sc
        .from("intel_claims").select("*")
        .eq("observation_id", observationId).eq("claim_type", observation.claim_type).maybeSingle();
      // Same shape as writeObservation's replay lookup: safe direction, but an
      // unreadable intel_claims used to be reported as the constraint violation
      // itself. The comment above distinguishes an idempotent replay from
      // 2174's one-live-per-key index by whether a row is found — a read that
      // FAILED finds no row either, so it silently masqueraded as the latter.
      if (replayErr) {
        logger.warn({ err: replayErr, observationId }, "intel claim replay lookup failed after 23505");
        return { ok: false, reason: `replay lookup failed: ${String(replayErr.message ?? "db_error")}` };
      }
      if (existing) return { ok: true, claim: existing, deduped: true };
    }
    return { ok: false, reason: String((error as any).message ?? "db_error") };
  }
  return { ok: true, claim: data, deduped: false };
}

/**
 * Promote a candidate claim to active (moment approval step 2). This is the ADMIN/
 * exceptional path (the route gates it behind requireAdmin); the autonomous path is
 * system_promote_admissible_intel_claims. Records promotion_source='admin' for
 * provenance parity with system promotion.
 */
export async function approveClaim(sc: any, claimId: string): Promise<{ ok: boolean; reason?: string }> {
  if (!(await captureSystemEnabled(sc))) return { ok: false, reason: "disabled" };
  // `.eq("status","candidate")` is a compare-and-swap and nothing above it reads
  // the claim, so this statement matches zero rows whenever the id names no
  // claim, or names one that is no longer a candidate (already active, or
  // rejected). Zero matched rows is NOT an error — PostgREST answers 204 and
  // supabase-js resolves `{ data: null, error: null }`, the same shape the
  // winning caller sees — so reading only `error` reported `{ok:true}` and the
  // route answered `{ok:true}` for a promotion that never happened. Approval is
  // the trust gate of this lifecycle (candidate → active → publishable): an
  // admin being told a claim is live when it is still a candidate is the one
  // thing this step must not do. `.select()` makes it RETURNING; the refusal
  // uses the function's own {ok:false, reason} contract, which routes/intel.ts
  // already maps to its db_error response.
  const { data, error } = await sc
    .from("intel_claims")
    .update({ status: "active", promotion_source: "admin" })
    .eq("id", claimId)
    .eq("status", "candidate")
    .select("id");
  if (error) return { ok: false, reason: String((error as any).message ?? "db_error") };
  if (affectedRows(data) === 0) {
    return { ok: false, reason: "claim not found, or no longer a candidate — nothing was promoted" };
  }
  return { ok: true };
}

/**
 * Record one independent confirmation. One-per-actor is enforced by a unique index.
 *
 * PRESENCE IS NOT TAKEN ON THE CLIENT'S WORD (parity with writeObservation).
 * `presenceLevel` arrives from the request body, and intel_confirmations is a
 * truth table: a row saying P4 asserts "verified assigned visitor". It was
 * stored verbatim, so any caller could write that about itself. It is now put
 * through the SAME gate capture uses — resolvePresenceAttestation, with no
 * verifier — so a live-grade claim with nothing backing it clamps to the
 * unverified ceiling (P1) and only below-floor levels pass through. A
 * confirmation carries no subject/claim context and no attestation payload, so
 * there is nothing for PresenceVerifier to verify here; if a confirmation
 * surface ever offers evidence, this is the seam that consumes it.
 */
export async function confirmClaim(
  sc: any, claimId: string, actorId: string,
  stance: "agree" | "disagree" | "unsure", observedAt: string, presenceLevel = "P0",
): Promise<{ ok: boolean; reason?: string; deduped?: boolean }> {
  if (!(await captureSystemEnabled(sc))) return { ok: false, reason: "disabled" };
  // D4 consent gate — a confirmation IS an intel contribution (it writes an
  // actor-linked intel_confirmations row), so it must clear the same consent
  // check writeObservation enforces. Without this a user who WITHDREW consent
  // could still contribute confirmations.
  if (!(await hasValidIntelConsent(sc, actorId))) return { ok: false, reason: "consent_required" };
  const clamped = clampObservedAt(observedAt);
  if (!clamped) return { ok: false, reason: "invalid_observed_at" };
  // Server-derived, never the client's number (see the header). Malformed ⇒ P0.
  const presence = resolvePresenceAttestation(presenceLevel, null);
  const { error } = await sc.from("intel_confirmations").insert({
    claim_id: claimId, actor_id: actorId, stance, presence_level: presence.presenceLevel, observed_at: clamped.observedAt,
  });
  if (error) {
    if (String((error as any).code) === "23505") return { ok: true, deduped: true };
    return { ok: false, reason: String((error as any).message ?? "db_error") };
  }
  return { ok: true, deduped: false };
}

/**
 * §24 "Correction invalidation targets and completion status" — what one
 * correction invalidates, and how far the invalidation has got.
 *
 * A correction supersedes the prior claim; the dependent read models are the
 * CURRENT-STATE snapshots keyed to the same (subject, claim_type) — one per
 * zone — which lib/intelProjectionScheduler either re-derives from the
 * corrected claim set or force-expires (no live-eligible claim left behind the
 * key) on its next pass. That pass is the completion; it emits
 * `intel.correction.invalidation.completed` for the keys it expired. This record
 * is logged (never persisted with identities — no actor id, no coordinates)
 * and returned so a caller can show "your correction is propagating".
 */
export interface CorrectionInvalidation {
  prior_claim_id: string;
  subject_id: string;
  claim_type: string;
  /** The correcting observation (append-only; the future claim is proposed from it). */
  observation_id: string | null;
  superseded: boolean;
  /** Current-state snapshots this correction invalidates (dependent read models). */
  snapshot_targets: Array<{ id: string; zone_id: string; privacy_eligible: boolean }>;
  completion:
    /** prior superseded; snapshots await the next projection pass */
    | "superseded_pending_projection"
    /** the prior was not supersedable (wrong subject/type, or already superseded/expired) — nothing invalidated */
    | "prior_not_supersedable"
    /** the prior was superseded but the target read failed — the pass will still reconcile; targets unknown */
    | "targets_unreadable";
}

/**
 * Correct a claim: append a NEW observation (never rewrite) and mark the prior
 * claim superseded. Correction propagation is the spec's central invariant —
 * a value is only ever superseded, never edited in place.
 */
export async function correctClaim(
  sc: any, actorId: string, priorClaimId: string, input: CaptureInput,
): Promise<CaptureResult & { supersededPrior?: boolean; invalidation?: CorrectionInvalidation }> {
  const written = await writeObservation(sc, actorId, input);
  if (!written.ok) return written;
  // A correction supersedes a CLAIM, and a claim is always about a place
  // (proposeClaim refuses an unresolved subject). So an unowned correcting
  // observation has nothing it could legitimately supersede: the new observation
  // is kept — it is still evidence — and the supersede is skipped rather than
  // aimed at whatever claim id the caller happened to send. Scoping the UPDATE
  // by a null subject_id would match nothing anyway; saying so is better than
  // discovering it.
  if (input.subjectId == null) {
    const unresolved: CorrectionInvalidation = {
      prior_claim_id: priorClaimId,
      subject_id: "",
      claim_type: input.claimType,
      observation_id: typeof written.observation?.id === "string" ? written.observation.id : null,
      superseded: false,
      snapshot_targets: [],
      completion: "prior_not_supersedable",
    };
    logger.info(
      { event: "intel.correction.invalidation", ...unresolved, target_count: 0, reason: "unresolved_subject" },
      "intel correction: unowned observation supersedes nothing",
    );
    return { ...written, supersededPrior: false, invalidation: unresolved };
  }
  const correctedSubjectId: string = input.subjectId;
  // Scope the supersede to the SAME subject + claim_type the correction observes,
  // and only from a supersedable status. Previously this filtered on id alone, so
  // any claim id (obtained from another place's live label) could be flipped to
  // 'superseded' — silently blanking an unrelated place's live intelligence. The
  // spec's correction-propagation invariant is that a supersede derives from a new
  // observation OF THAT SAME subject/claim.
  const { data: superseded, error } = await sc
    .from("intel_claims")
    .update({ status: "superseded" })
    .eq("id", priorClaimId)
    .eq("subject_id", correctedSubjectId)
    .eq("claim_type", input.claimType)
    .in("status", ["active", "conflicting", "candidate"])
    .select("id");
  const supersededPrior = !error && Array.isArray(superseded) && superseded.length > 0;

  // §24: name the invalidation targets. Read-only; the projection pass does the
  // re-derivation/expiry. A failed read is reported, never hidden as "no targets".
  const invalidation: CorrectionInvalidation = {
    prior_claim_id: priorClaimId,
    subject_id: correctedSubjectId,
    claim_type: input.claimType,
    observation_id: typeof written.observation?.id === "string" ? written.observation.id : null,
    superseded: supersededPrior,
    snapshot_targets: [],
    completion: supersededPrior ? "superseded_pending_projection" : "prior_not_supersedable",
  };
  if (supersededPrior) {
    const { data: snaps, error: snapErr } = await sc
      .from("intel_state_snapshots")
      .select("id, zone_id, privacy_eligible")
      .eq("subject_id", correctedSubjectId)
      .eq("claim_type", input.claimType);
    if (snapErr) {
      invalidation.completion = "targets_unreadable";
    } else {
      invalidation.snapshot_targets = ((snaps as Array<{ id: string; zone_id: string | null; privacy_eligible: boolean }> | null) ?? [])
        .map((s) => ({ id: s.id, zone_id: s.zone_id ?? "", privacy_eligible: s.privacy_eligible === true }));
    }
  }
  logger.info(
    { event: "intel.correction.invalidation", ...invalidation, target_count: invalidation.snapshot_targets.length },
    "intel correction: invalidation targets",
  );
  return { ...written, supersededPrior, invalidation };
}
