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
 * FAIL-CLOSED SUBJECT CHECK: intel_observations.subject_id FKs public.places(id).
 * In production places holds 0 rows (the Replit backfill is pending), so a real
 * capture would hit a foreign-key 500. This service verifies the subject resolves
 * FIRST and returns a clean `unknown_subject` rejection instead — the 0-rows
 * blocker surfaces as validation, never a stack trace.
 */
import { isFlagEnabled } from "../../lib/featureFlags.js";
import {
  CLAIM_TYPES,
  MODERATION_STATES,
  VISIBILITIES,
  clampObservedAt,
  isValidIdempotencyKey,
  isPilotClaimable,
  type Visibility,
  type PartySizeBucket,
} from "../../lib/intelContracts.js";
import { PHASE1_CAPTURE_CLAIM_TYPES, validateClaimValue } from "../../lib/quickSignal.js";
import { validateTrailClaimValue, mustAggregate } from "../../lib/trailFollowup.js";
import { deriveGroupKey, type GroupIdentity } from "../../lib/intelGroupKey.js";
import { isSharedCrewMember } from "../../lib/tripMembership.js";
import { resolveActiveCrewId } from "../../lib/activeCrew.js";

/**
 * Capture surfaces, each gated by its own flag (spec §26 flag registry):
 *   quick_signal → intel_capture_quick_signal
 *   trail        → intel_trail_followup
 * The mapping is applied in surfaceFlagEnabled() with literal flag args so
 * check-flag-polarity can resolve each stop statically.
 */
export type CaptureSurface = "quick_signal" | "trail";

/**
 * The claim types each surface may emit. The trail surface (IG-06) persists only
 * the contracted, aggregate-gated going-next claim; exit_reason mapping exists in
 * lib/trailFollowup for the mobile prompt but is not yet a contracted claim.
 */
const SURFACE_CLAIMS: Record<CaptureSurface, readonly string[]> = {
  quick_signal: PHASE1_CAPTURE_CLAIM_TYPES,
  trail: ["experience.next_move"],
};

function validateForSurface(surface: CaptureSurface, claimType: string, value: unknown): boolean {
  return surface === "trail"
    ? validateTrailClaimValue(claimType, value)
    : validateClaimValue(claimType, value);
}

/**
 * Whether the surface's gating flag is on. The flag args below are LITERALS on
 * purpose — check-flag-polarity resolves each isFlagEnabled() call statically and
 * cannot follow SURFACE_FLAG[surface]. Keep them literal so each stop is visible.
 */
async function surfaceFlagEnabled(sc: any, surface: CaptureSurface): Promise<boolean> {
  return surface === "trail"
    ? isFlagEnabled(sc, "intel_trail_followup")
    : isFlagEnabled(sc, "intel_capture_quick_signal");
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
  subjectId: string;              // places(id)
  subjectKind?: string;           // default 'experience'
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
  // V1 independent-group signal (§privacy). partySize is the raw "who are you here
  // with?" answer; partyId is the observer's active Trip Crew id (validated here).
  // Both optional → group_key resolves to null (fail-closed) for older clients.
  partySize?: PartySizeBucket;
  partyId?: string | null;
}

export type CaptureResult =
  | { ok: true; observation: any; deduped: boolean }
  | { ok: false; reason: "disabled" | "invalid_idempotency_key" | "invalid_observed_at" | "unknown_subject" | "invalid_claim_type" | "invalid_value" | "db_error"; detail?: string };

function ttlFor(claimType: string): { ttlSeconds: number; hardExpirySeconds: number } | null {
  const spec = CLAIM_TYPES.find((c) => c.claimType === claimType);
  return spec ? { ttlSeconds: spec.ttlSeconds, hardExpirySeconds: spec.hardExpirySeconds } : null;
}

/**
 * Write one observation. Fail-closed no-op when the flag is off. Idempotent: a
 * replay of the same (actor_id, idempotency_key) returns the stored row.
 */
export async function writeObservation(sc: any, actorId: string, input: CaptureInput): Promise<CaptureResult> {
  const surface: CaptureSurface = input.captureSurface ?? "quick_signal";
  if (!(await surfaceFlagEnabled(sc, surface))) return { ok: false, reason: "disabled" };

  if (!isValidIdempotencyKey(input.idempotencyKey)) return { ok: false, reason: "invalid_idempotency_key" };

  const clamped = clampObservedAt(input.observedAt);
  if (!clamped) return { ok: false, reason: "invalid_observed_at" };

  if (!SURFACE_CLAIMS[surface].includes(input.claimType)) return { ok: false, reason: "invalid_claim_type", detail: input.claimType };
  if (!validateForSurface(surface, input.claimType, input.value)) return { ok: false, reason: "invalid_value", detail: input.claimType };

  const visibility: Visibility = input.visibility && VISIBILITIES.includes(input.visibility) ? input.visibility : "private";
  const presenceLevel = input.presenceLevel ?? "P0";

  // Fail-closed subject resolution — never let the places FK throw a 500.
  const { data: subj, error: subjErr } = await sc.from("places").select("id").eq("id", input.subjectId).maybeSingle();
  if (subjErr) return { ok: false, reason: "db_error", detail: "subject lookup" };
  if (!subj) return { ok: false, reason: "unknown_subject", detail: input.subjectId };

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
    if (input.partyId && (await isSharedCrewMember(sc, input.partyId, actorId))) {
      groupIdentity = { kind: "crew", crewId: input.partyId };
    } else {
      const activeCrewId = await resolveActiveCrewId(sc, actorId, new Date());
      if (activeCrewId) {
        groupIdentity = { kind: "crew", crewId: activeCrewId };
      } else if (input.partySize === "just_me") {
        groupIdentity = { kind: "solo", actorId };
      }
    }
  }
  const groupKey = deriveGroupKey(input.subjectId, groupIdentity);

  const row = {
    actor_id: actorId,
    subject_kind: input.subjectKind ?? "experience",
    subject_id: input.subjectId,
    zone_id: input.zoneId ?? null,
    claim_type: input.claimType,
    value: input.value,
    source_class: "firsthand_unverified",
    capture_surface: surface,
    visibility,
    moderation_state: "pending",
    commercial_disclosure: "none",
    presence_level: presenceLevel,
    presence_attestation: input.presenceAttestation ?? null,
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
      const { data: existing } = await sc
        .from("intel_observations").select("*")
        .eq("actor_id", actorId).eq("idempotency_key", input.idempotencyKey).maybeSingle();
      if (existing) return { ok: true, observation: existing, deduped: true };
    }
    return { ok: false, reason: "db_error", detail: String((error as any).message ?? "") };
  }
  return { ok: true, observation: data, deduped: false };
}

/** Create a CANDIDATE claim from an approved observation (moment approval step 1). */
export async function proposeClaim(sc: any, observation: any): Promise<{ ok: boolean; claim?: any; reason?: string }> {
  const surface: CaptureSurface = (observation.capture_surface as CaptureSurface) ?? "quick_signal";
  if (!(await surfaceFlagEnabled(sc, surface))) return { ok: false, reason: "disabled" };
  // Moderation (owner pilot ruling): explicitly-invalidated content
  // (restricted/blocked/removed) may never back a claim. 'pending' still flows
  // (promotion is deferred for the pilot). Fail-closed whitelist.
  if (!isPilotClaimable(observation.moderation_state)) return { ok: false, reason: "not_moderated" };
  // Privacy invariant (spec §4): a movement claim is aggregate-only — never a
  // single-user published claim. Capture keeps the observation; propose refuses.
  if (mustAggregate(observation.claim_type)) return { ok: false, reason: "must_aggregate" };
  const ttl = ttlFor(observation.claim_type);
  const base = new Date(observation.observed_at).getTime();
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
  };
  const { data, error } = await sc.from("intel_claims").insert(claim).select().single();
  if (error) return { ok: false, reason: String((error as any).message ?? "db_error") };
  return { ok: true, claim: data };
}

/** Promote a candidate claim to active (moment approval step 2). */
export async function approveClaim(sc: any, claimId: string): Promise<{ ok: boolean; reason?: string }> {
  if (!(await captureSystemEnabled(sc))) return { ok: false, reason: "disabled" };
  const { error } = await sc.from("intel_claims").update({ status: "active" }).eq("id", claimId).eq("status", "candidate");
  if (error) return { ok: false, reason: String((error as any).message ?? "db_error") };
  return { ok: true };
}

/** Record one independent confirmation. One-per-actor is enforced by a unique index. */
export async function confirmClaim(
  sc: any, claimId: string, actorId: string,
  stance: "agree" | "disagree" | "unsure", observedAt: string, presenceLevel = "P0",
): Promise<{ ok: boolean; reason?: string; deduped?: boolean }> {
  if (!(await captureSystemEnabled(sc))) return { ok: false, reason: "disabled" };
  const clamped = clampObservedAt(observedAt);
  if (!clamped) return { ok: false, reason: "invalid_observed_at" };
  const { error } = await sc.from("intel_confirmations").insert({
    claim_id: claimId, actor_id: actorId, stance, presence_level: presenceLevel, observed_at: clamped.observedAt,
  });
  if (error) {
    if (String((error as any).code) === "23505") return { ok: true, deduped: true };
    return { ok: false, reason: String((error as any).message ?? "db_error") };
  }
  return { ok: true, deduped: false };
}

/**
 * Correct a claim: append a NEW observation (never rewrite) and mark the prior
 * claim superseded. Correction propagation is the spec's central invariant —
 * a value is only ever superseded, never edited in place.
 */
export async function correctClaim(
  sc: any, actorId: string, priorClaimId: string, input: CaptureInput,
): Promise<CaptureResult & { supersededPrior?: boolean }> {
  const written = await writeObservation(sc, actorId, input);
  if (!written.ok) return written;
  const { error } = await sc.from("intel_claims").update({ status: "superseded" }).eq("id", priorClaimId);
  return { ...written, supersededPrior: !error };
}
