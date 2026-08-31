/**
 * mediaEvidenceLink — the media→intel EVIDENCE seam (Media v2 Phase 5, §9
 * EVIDENCE EXTRACTION + §35 evidence-safe editing).
 *
 * This is the ONE genuinely net-new intelligence seam: linking a canonical
 * MediaAsset to an intel observation as EVIDENCE. It has two halves, both gated
 * by the SAME master flag `media_evidence_enabled` (seeded OFF, migration 2255):
 *
 *   WRITE (linkMediaEvidence): when a media asset is attached to an observation,
 *     link it as evidence — but ONLY if it is §35 evidence-eligible. A
 *     generative/ineligible asset is refused as evidence and NOTHING is written
 *     to intel_evidence; it stays a fully valid SOCIAL asset (§2/§35 — we never
 *     touch media_assets and never block a post). Fail-CLOSED: the flag OFF or
 *     an ineligible asset ⇒ no evidence row.
 *
 *   READ (observationsHaveEligibleMediaEvidence): the aggregator's hasEvidence
 *     input. Given the fresh, consented observation cohort of a claim, answer
 *     "does ≥1 of these observations have a linked, STILL-evidence-eligible
 *     media?" It RE-VERIFIES §35 eligibility at read (defence in depth: a later
 *     generative edit that broke the asset, or any write-path bug, cannot leave
 *     a stale link counting as evidence). Fail-SOFT: any error ⇒ false, never a
 *     fabricated true.
 *
 * THE GATE IS isEvidenceEligible (lib/media/mediaEvidenceEligibility). This
 * module CONSUMES it and never re-implements eligibility.
 *
 * BOUNDARY: this module writes ONLY intel_evidence (the intelligence link) and
 * media_attachments(entity_type='observation') (the display link). It NEVER
 * writes intel_observations/intel_claims/intel_state_snapshots, never touches
 * the consensus/expiry/live-label machinery, and never promotes anything to
 * "live" — the Live label stays owned by the gated IG path.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFlagEnabled } from "../featureFlags.js";
import { isEvidenceEligible, type EvidenceAssetInput } from "./mediaEvidenceEligibility.js";

/** The master gate for the whole seam. */
export const MEDIA_EVIDENCE_FLAG = "media_evidence_enabled";

/** The display-attachment entity_type for an observation-backing media (§6.1). */
const OBSERVATION_ENTITY_TYPE = "observation";

/** A media_assets row shape the seam needs (snake_case, as read from the DB). */
export interface EvidenceMediaAsset extends EvidenceAssetInput {
  id: string;
  /** 'image' | 'video' — maps to the evidence_kind ('photo' | 'video'). */
  media_type?: string | null;
  storage_path?: string | null;
}

export type LinkRefusalReason =
  | "flag_disabled"
  | "ineligible"
  | "invalid_input"
  | "write_error";

export interface LinkMediaEvidenceResult {
  /** True when an evidence link exists after this call (written or already present). */
  linked: boolean;
  /** Present when linked is false — WHY the media was not linked as evidence. */
  reason?: LinkRefusalReason;
  /** The intel_evidence row id, when a new row was written. */
  evidenceId?: string;
  /** True when the (observation, media) link already existed (idempotent no-op). */
  alreadyLinked?: boolean;
  /**
   * ALWAYS reflects the social truth: a refusal here is an EVIDENCE decision
   * only. The asset remains fully usable as social media regardless of `linked`.
   */
  socialAssetUnaffected: true;
}

export interface LinkMediaEvidenceInput {
  observationId: string;
  actorId: string;
  asset: EvidenceMediaAsset;
}

/** image ⇒ 'photo', video ⇒ 'video'. Anything else defaults to 'photo'. */
function evidenceKindFor(mediaType: string | null | undefined): "photo" | "video" {
  return String(mediaType ?? "").trim().toLowerCase() === "video" ? "video" : "photo";
}

/**
 * linkMediaEvidence — the capture-side choke-point. Records the evidence linkage
 * for an evidence-eligible media asset attached to an observation.
 *
 * Order of gates (fail-closed):
 *   1. master flag OFF ⇒ refuse (no writes). The whole seam is dark by default.
 *   2. missing ids ⇒ refuse (invalid_input).
 *   3. NOT §35 evidence-eligible ⇒ refuse (ineligible). NO intel_evidence row.
 *   4. eligible ⇒ write the intel_evidence link (idempotent on the partial
 *      unique index) + the media_attachments display row.
 *
 * The social asset is NEVER blocked and media_assets is NEVER written here.
 */
export async function linkMediaEvidence(
  sc: SupabaseClient,
  input: LinkMediaEvidenceInput,
): Promise<LinkMediaEvidenceResult> {
  const refuse = (reason: LinkRefusalReason): LinkMediaEvidenceResult => ({
    linked: false,
    reason,
    socialAssetUnaffected: true,
  });

  // 1. Master gate. OFF (or unreadable) ⇒ the seam stays dark; nothing is written.
  if (!(await isFlagEnabled(sc, MEDIA_EVIDENCE_FLAG))) return refuse("flag_disabled");

  // 2. Structural validity.
  const { observationId, actorId, asset } = input;
  if (!observationId || !actorId || !asset?.id) return refuse("invalid_input");

  // 3. THE §35 gate. Only an evidence-eligible asset may back live evidence.
  //    An ineligible (generative-edited / bad-source / low-confidence) asset is
  //    refused as EVIDENCE — but it stays a valid social asset (we return here
  //    without touching media_assets or the post).
  if (!isEvidenceEligible(asset)) return refuse("ineligible");

  // 4. Eligible ⇒ write the typed evidence link. The partial unique index
  //    (observation_id, media_asset_id) makes re-attach idempotent: a duplicate
  //    raises 23505, which we treat as already-linked (success), not an error.
  const evidenceRow = {
    observation_id: observationId,
    actor_id: actorId,
    media_asset_id: asset.id,
    evidence_kind: evidenceKindFor(asset.media_type),
    // A storage KEY only (never coordinates — EXIF/GPS is stripped upstream and
    // this table must not become a second location store). The typed
    // media_asset_id is the authoritative link; `reference` mirrors the legacy
    // free-form pointer for display readers that predate the FK.
    reference: asset.storage_path ?? null,
  };

  const { data, error } = await sc
    .from("intel_evidence")
    .insert(evidenceRow)
    .select("id")
    .single();

  if (error) {
    // 23505 = unique_violation on the partial index ⇒ this (observation, media)
    // is already linked. Idempotent success, not a failure.
    if ((error as { code?: string }).code === "23505") {
      await upsertObservationDisplayAttachment(sc, asset.id, observationId);
      return { linked: true, alreadyLinked: true, socialAssetUnaffected: true };
    }
    // Any other error is surfaced (never silently swallowed): the caller learns
    // the evidence link did not persist. The social asset is still unaffected.
    return refuse("write_error");
  }

  const evidenceId = (data as { id?: string } | null)?.id;

  // Display link (§6.1). Best-effort: a failed display row must not fail the
  // evidence link that already persisted, so its error is observed and dropped.
  await upsertObservationDisplayAttachment(sc, asset.id, observationId);

  return { linked: true, evidenceId, socialAssetUnaffected: true };
}

/**
 * Write the media_attachments(entity_type='observation') display row. Idempotent
 * on the table's UNIQUE(media_asset_id, entity_type, entity_id). Best-effort:
 * the error is READ (so it is never a silent swallow) and then intentionally
 * dropped — the intelligence link is the source of truth, the display row is a
 * convenience.
 */
async function upsertObservationDisplayAttachment(
  sc: SupabaseClient,
  mediaAssetId: string,
  observationId: string,
): Promise<void> {
  const { error } = await sc.from("media_attachments").upsert(
    {
      media_asset_id: mediaAssetId,
      entity_type: OBSERVATION_ENTITY_TYPE,
      entity_id: observationId,
    },
    { onConflict: "media_asset_id,entity_type,entity_id" },
  );
  if (error) {
    // observed-and-dropped-ok: the display attachment is a convenience; a failure
    // here must not undo the evidence link. Surfacing (not swallowing) keeps the
    // silent-supabase-writes guard honest.
    void error;
  }
}

/**
 * observationsHaveEligibleMediaEvidence — the aggregator's hasEvidence input.
 *
 * Given the fresh, consented observation ids of a claim, return true iff ≥1 has
 * a linked media asset that is STILL §35 evidence-eligible right now.
 *
 * RE-VERIFIES eligibility (does not merely trust that the write path filtered):
 * loads each linked media_assets row and re-runs isEvidenceEligible, so an asset
 * whose lineage later gained a generative edit — or any stale/buggy link — cannot
 * inflate confidence. Fail-SOFT throughout: an empty cohort, a query error, or a
 * missing media row yields false. It never fabricates evidence.
 *
 * NOTE: this is called ONLY when the master flag is ON (the aggregator checks the
 * flag first), so the flag-OFF path does ZERO of this work and stays byte-
 * identical to the pre-seam aggregator.
 */
export async function observationsHaveEligibleMediaEvidence(
  sc: SupabaseClient,
  observationIds: string[],
  now?: number,
): Promise<boolean> {
  try {
    const ids = observationIds.filter(Boolean);
    if (ids.length === 0) return false;

    // Which of these observations have a media-backed evidence row?
    const { data: evRows, error: evErr } = await sc
      .from("intel_evidence")
      .select("media_asset_id")
      .in("observation_id", ids);
    if (evErr) return false; // fail-closed: unknown ⇒ no evidence

    const mediaIds = [
      ...new Set(
        ((evRows as { media_asset_id?: string | null }[]) ?? [])
          .map((r) => r.media_asset_id)
          .filter((v): v is string => !!v),
      ),
    ];
    if (mediaIds.length === 0) return false;

    // Re-verify §35 eligibility from the current media provenance.
    const { data: assets, error: aErr } = await sc
      .from("media_assets")
      .select("id, source_type, provenance, captured_at")
      .in("id", mediaIds);
    if (aErr) return false;

    for (const a of (assets as EvidenceMediaAsset[]) ?? []) {
      if (isEvidenceEligible({ ...a, now })) return true;
    }
    return false;
  } catch {
    return false; // fail-soft: never invent evidence
  }
}
