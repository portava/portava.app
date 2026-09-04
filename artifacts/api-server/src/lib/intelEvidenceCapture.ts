/**
 * intelEvidenceCapture — the EVIDENCE station of the §21 pipeline.
 *
 *   Observation → Evidence → Claim → Confidence → Freshness → Correction
 *
 * §22's eighth map prompt is "Current photo/video". Seven of the eight prompts
 * are propositions and become CLAIMS; this one is not, and never will be. The
 * ruling that kept media out of the claim system is unchanged and is restated
 * here because this module is the place that could most easily break it:
 *
 *   A photo asserts no proposition. Ask which claim a photo of a bar makes and
 *   there is no answer — "it is busy"? "it is open"? The contributor stated
 *   none of those. It also cannot expire into "wrong": the picture stays an
 *   accurate picture of a moment forever, so any TTL would be a statement about
 *   the WORLD, and would belong to whatever claim the photo is evidence FOR.
 *
 * What changed is not the ruling but the destination. §21 already names the
 * station a photo belongs to, and migration 2130 already built the table for it
 * — `intel_evidence`, "artifacts supporting an observation". So media now
 * LANDS, as evidence bolted to an observation that a person already made, and
 * it still mints no claim type, no confidence and no map change.
 *
 * WHY EVIDENCE MAY NOT ARRIVE ALONE
 * =================================
 * `intel_evidence.observation_id` is NOT NULL and FKs `intel_observations`. A
 * standalone photo has nothing to support, and the only two ways to store one
 * would be to invent a claim for it (forbidden, and the whole point of the
 * ruling) or to loosen that column (which would turn an evidence table into an
 * unattached media store with no purpose, no retention rationale and no
 * lawful basis of its own — the intel_claim purpose covers CONTRIBUTIONS).
 *
 * So the caller must submit the observation FIRST and resend the media with
 * that observation's id. This is the §21 order made mechanical rather than
 * advisory. `routes/mapObservations.ts` refuses a media contribution carrying
 * no `observationId`, loudly, with the ruling as the reason.
 *
 * WHY A CLIENT `mediaUri` IS NEVER STORED AS SENT
 * ===============================================
 * A `mediaUri` is untrusted input. Stored raw it would be a pointer the server
 * later fetches or serves, i.e. an arbitrary-host injection (hotlink, tracker,
 * SSRF-on-render) and — worse here — a way to publish someone ELSE's private
 * object by guessing its key. The codebase already settled this twice, and this
 * module reuses the same two checks in the same order that `routes/stories.ts`
 * applies to a story's media:
 *
 *   1. `appStorageUrlInfo` — proves the bytes are OURS (an allowed bucket on
 *      our own storage origin, or a bare `<bucket>/<path>` key). Anything else
 *      is refused; nothing is coerced.
 *   2. `ownerFromPath(...) === actorId` — proves the bytes are THEIRS.
 *      appStorageUrlInfo says whose HOST, never whose OBJECT.
 *
 * What is persisted is the resulting `<bucket>/<path>` STORAGE KEY, which is
 * exactly what `intel_evidence.reference` is documented to hold ("A storage key
 * or external reference"), what `lib/dataRights` classifies it as, and what
 * `lib/storagePath` can resolve for deletion. No URL, no origin, no token.
 *
 * The object itself is one the contributor uploaded through POST
 * /api/media/upload, which strips EXIF/GPS before writing the bytes — so this
 * table does not become the second location store 2130's own column comment
 * warns against.
 *
 * WHAT THIS MODULE MAY NEVER DO
 * =============================
 *   • mint a claim, a claim type, a confidence, a band or a snapshot;
 *   • write an observation (that is IntelCaptureService's job, and duplicating
 *     it is the defect the map route's header already warns about);
 *   • raise confidence. `lib/intelProjectionAggregator` sets `hasEvidence`
 *     to a hardcoded `false` and this module deliberately does not change that:
 *     evidence quality is a scoring input nobody has ruled on for unmoderated
 *     contributor media, and wiring it here would make attaching a photo a
 *     one-tap confidence boost. That is the same failure mode as a paid
 *     contribution scoring higher, and §22 forbids it for the same reason.
 *
 * WHY UNMODERATED MEDIA IS SAFE TO STORE HERE TODAY
 * =================================================
 * `intel_evidence` has no moderation column, and this path adds none. It is
 * nevertheless not a publication surface:
 *
 *   • migration 2130 grants `authenticated` NOTHING on the table (only
 *     `intel_observations` and `intel_confirmations` get SELECT), and RLS is on
 *     with no policy for it — so it is service-role-only;
 *   • no read path exists: nothing in the projection, the API projection or any
 *     route selects from it, and `hasEvidence` is a constant;
 *   • the BYTES stay governed by the existing private-bucket rules
 *     (`lib/mediaAccess`), unchanged by this row — a reference does not widen
 *     access to an object.
 *
 * A read path for evidence therefore may not be added without a moderation
 * decision first. `test/mapMediaEvidence.test.ts` pins the "nothing reads it"
 * half of that so the assumption cannot rot silently.
 */
import { isFlagEnabled } from "./featureFlags.js";
import { clampObservedAt } from "./intelContracts.js";
import { hasValidIntelConsent } from "./intelConsent.js";
import { appStorageUrlInfo } from "./mediaUrl.js";
import { ownerFromPath } from "./mediaAccess.js";
import { INTEL_IDENTIFIABLE_RETENTION_SECONDS } from "./locationPurposes.js";

/**
 * §22's asset vocabulary mapped onto `intel_evidence.evidence_kind`.
 *
 * Identity, not translation — and that is the point. 2130's CHECK constraint
 * admitted 'photo' but not 'video', so before migration 2223 a video could only
 * have been stored by FILING IT AS A PHOTO, which is the mis-file this whole
 * unit exists to refuse. 2223 widens the constraint instead.
 */
export const MEDIA_EVIDENCE_KIND: Readonly<Record<string, string>> = {
  photo: "photo",
  video: "video",
};

/**
 * Provenance written into `intel_evidence.detail`.
 *
 * A CONSTANT, deliberately. `detail` is classified `contributor_licensed` and
 * "may contain personal data" precisely because it is where free text would go
 * — and the §22 payload carries no free text at all. Writing a server-derived
 * marker keeps that true by construction: this path cannot put contributor
 * prose, coordinates or a caption into the column.
 */
export const EVIDENCE_SOURCE_MAP_CONTRIBUTION = "map_contribution";

export interface EvidenceInput {
  /** The observation this artifact supports. Required — see the header. */
  observationId: string | null | undefined;
  /** The map object the contribution named; must match the observation's subject. */
  subjectId: string;
  /** Untrusted client reference. Validated, never stored as sent. */
  mediaUri: string;
  /** §22 asset type: 'photo' | 'video'. */
  mediaKind: string;
  /** Client capture time, clamped by the same contract the observation used. */
  observedAt: string | number | Date;
}

export type EvidenceRejection =
  /** The capture surface itself is off. */
  | "disabled"
  /** No valid, un-withdrawn Intelligence Contributions consent (D4). */
  | "consent_required"
  /** Media arrived with no observation to support. */
  | "evidence_requires_observation"
  /** Not an asset type §22 names. */
  | "unsupported_media_kind"
  /** Future-dated beyond the contract's drift allowance. */
  | "invalid_observed_at"
  /** Not a reference to an object in our own storage. */
  | "invalid_media_reference"
  /** Ours, but not the contributor's. */
  | "media_not_owned"
  /** No such observation, or not this actor's. The two are not distinguished. */
  | "unknown_observation"
  /** The observation is about a different subject than the contribution named. */
  | "observation_subject_mismatch"
  | "db_error";

export type EvidenceResult =
  | { ok: true; evidence: any; deduped: boolean }
  | { ok: false; reason: EvidenceRejection; detail?: string };

function reject(reason: EvidenceRejection, detail?: string): EvidenceResult {
  return { ok: false, reason, detail };
}

/**
 * Resolve an untrusted `mediaUri` to a storage key this actor owns.
 *
 * Exported because it is the security decision of this module and deserves to
 * be testable on its own, without a database. Returns the bucket-qualified key
 * to persist, or the reason it was refused.
 */
export function resolveOwnedMediaReference(
  mediaUri: string,
  actorId: string,
): { ok: true; reference: string } | { ok: false; reason: EvidenceRejection } {
  const ref = appStorageUrlInfo(mediaUri);
  // Not ours: an external host, a foreign origin, a bucket outside the media
  // allow-list, or a path-traversal attempt. Refused, never coerced.
  if (!ref) return { ok: false, reason: "invalid_media_reference" };
  // Ours, but whose? appStorageUrlInfo answers "which host", never "which
  // owner", so a guessed key for someone else's private object would pass it.
  if (ownerFromPath(ref.path) !== actorId) return { ok: false, reason: "media_not_owned" };
  return { ok: true, reference: `${ref.bucket}/${ref.path}` };
}

/**
 * Attach one media artifact to an existing observation.
 *
 * Every gate below is the SAME function the observation path used, called
 * again — not a second implementation of it. The capture flag, the consent
 * check and the observed-at clamp are `isFlagEnabled`, `hasValidIntelConsent`
 * and `clampObservedAt` themselves, so the two paths cannot drift on the rules
 * whose absence is invisible in a response.
 */
export async function attachMediaEvidence(
  sc: any,
  actorId: string,
  input: EvidenceInput,
): Promise<EvidenceResult> {
  // Gate 1 — the capture surface. Literal flag arg so check-flag-polarity can
  // resolve this stop statically. This is the SECOND half of the double gate:
  // the route has already required map_contributions_enabled, and evidence must
  // not be a way into the intel store while intel capture itself is switched
  // off. Ordered first, before consent, exactly as writeObservation orders it.
  if (!(await isFlagEnabled(sc, "intel_capture_quick_signal"))) return reject("disabled");

  // Gate 2 — D4 lawful basis. A photo of a place, tied to a person and a time,
  // is a contribution under the consent-based `intel_claim` purpose just as much
  // as the observation it supports. Fail-closed.
  if (!(await hasValidIntelConsent(sc, actorId))) return reject("consent_required");

  // Gate 3 — evidence cannot precede the observation it supports (§21).
  if (!input.observationId) return reject("evidence_requires_observation");

  const evidenceKind = MEDIA_EVIDENCE_KIND[input.mediaKind];
  if (!evidenceKind) return reject("unsupported_media_kind", String(input.mediaKind));

  // Gate 4 — the same clamp the observation passed. A device clock cannot buy a
  // future-dated artifact any more than it can buy a future-dated claim.
  const clamped = clampObservedAt(input.observedAt);
  if (!clamped) return reject("invalid_observed_at");

  // Gate 5 — the untrusted reference.
  const resolved = resolveOwnedMediaReference(input.mediaUri, actorId);
  if (!resolved.ok) return reject(resolved.reason);

  // Gate 6 — the parent observation must exist, be THIS actor's, and be about
  // the subject the contribution named.
  const { data: obs, error: obsErr } = await sc
    .from("intel_observations")
    .select("id, actor_id, subject_id")
    .eq("id", input.observationId)
    .maybeSingle();
  if (obsErr) return reject("db_error", "observation lookup");
  // A missing observation and another actor's observation collapse to ONE
  // answer on purpose: distinguishing them would turn this endpoint into an
  // oracle for "does this observation id exist", which is a contribution
  // someone else made about a place they were at.
  if (!obs || obs.actor_id !== actorId) return reject("unknown_observation");
  if (obs.subject_id !== input.subjectId) {
    return reject("observation_subject_mismatch", "the observation is about a different subject");
  }

  // Retention. `intel_evidence.expires_at` is a RETENTION deadline, not a truth
  // TTL — the ruling is explicit that a photo does not expire into "wrong", and
  // dataRights records the column as "when evidence goes, not what it contains".
  // Anchored to NOW rather than to observed_at so the declared deadline is the
  // one migration 2173's sweep actually enforces: that sweep deletes on
  // created_at < now() - 180d, and created_at is this instant. Anchoring to the
  // (earlier) observed_at would declare a deadline the sweep then missed.
  const expiresAt = new Date(Date.now() + INTEL_IDENTIFIABLE_RETENTION_SECONDS * 1000).toISOString();

  const row = {
    observation_id: input.observationId,
    actor_id: actorId,
    evidence_kind: evidenceKind,
    reference: resolved.reference,
    detail: { source: EVIDENCE_SOURCE_MAP_CONTRIBUTION },
    expires_at: expiresAt,
  };

  const { data, error } = await sc.from("intel_evidence").insert(row).select().single();
  if (error) {
    // Idempotency. One tap is regularly two events, and the table is append-only
    // so a duplicate cannot be cleaned up afterwards. Migration 2223 adds the
    // unique (observation_id, reference) index that makes the replay detectable
    // rather than merely unlikely; a 23505 is that replay.
    if (String((error as any).code) === "23505") {
      const { data: existing } = await sc
        .from("intel_evidence")
        .select("*")
        .eq("observation_id", input.observationId)
        .eq("reference", resolved.reference)
        .maybeSingle();
      if (existing) return { ok: true, evidence: existing, deduped: true };
    }
    return reject("db_error", String((error as any).message ?? ""));
  }

  // NOTE WHAT DOES NOT HAPPEN HERE: no claim, no confidence, no snapshot, no
  // reward, and no change to the observation — which is append-only anyway.
  return { ok: true, evidence: data, deduped: false };
}
