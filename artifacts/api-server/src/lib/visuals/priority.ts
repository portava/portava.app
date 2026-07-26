/**
 * Centralized image priority resolver.
 *
 * ONE place decides which image an entity actually shows. Every card/detail screen
 * must consume this (or the normalized API field derived from it) instead of
 * re-implementing the ladder. Mirrors the client resolver in travel-buddy.
 *
 * Priority (highest first) — nine canonical source types:
 *   1. official            — venue's own media or officially licensed photo
 *   2. trusted_provider    — major licensed photo provider (Getty, Unsplash licensed, …)
 *   3. tourism_authority   — national/city tourism board or CVB image
 *   4. verified_owner      — venue owner-verified upload via the platform
 *   5. verified_user_photo — community photo explicitly verified by a moderator
 *   6. reference_grounded_ai — AI generation grounded in real reference images
 *   7. generic_ai_illustration — AI generation with no real-place reference
 *   8. category_fallback   — static branded fallback keyed on category
 *   9. map_fallback        — last-resort map thumbnail / street-view capture
 *
 * Legacy source values (user_upload, provider, portava_media, ai_generated)
 * are kept for backward compatibility and mapped to equivalent tiers.
 */
import type {
  ImageAccuracyStatus,
  ImageProvenanceFields,
  ImageSource,
  ImageSourceType,
  ResolvedHeaderImage,
} from "./types.js";

/**
 * Numeric rank for each source. Higher = higher priority.
 * Nine canonical types span 0–8; legacy values mapped to equivalent tiers.
 */
const RANK: Record<ImageSource, number> = {
  // ── Nine canonical ImageSourceType classifications ─────────────────────────
  official:               8,  // venue's own / officially licensed — highest trust
  trusted_provider:       7,  // major licensed provider (Getty, Unsplash licensed, …)
  tourism_authority:      6,  // national/city tourism board or CVB image
  verified_owner:         5,  // venue owner-verified upload via platform
  verified_user_photo:    4,  // community photo verified by a moderator
  reference_grounded_ai:  3,  // AI generation grounded in real reference images
  generic_ai_illustration:2,  // AI generation with no real-place reference
  category_fallback:      1,  // static branded fallback keyed on category
  map_fallback:           0,  // last resort: map thumbnail / street-view capture

  // ── Legacy values (kept for backward compatibility) ────────────────────────
  user_upload:    9,  // manually selected by a user — highest priority of all
  provider:       7,  // trusted external provider — equivalent to trusted_provider
  portava_media:  5,  // approved Portava media — equivalent to verified_owner
  ai_generated:   3,  // AI-generated — equivalent to reference_grounded_ai
};

export function sourceRank(s: ImageSource): number {
  return RANK[s] ?? 0;
}

/** Rank of verified_user_photo — used as the disclaimer threshold. */
const VERIFIED_USER_PHOTO_RANK = RANK["verified_user_photo"];

/**
 * A candidate image from some source.
 * url null/empty means "not available".
 * canonicalPlaceId should be set when the image is bound to a specific place row;
 * used by resolveHeaderImage to reject wrong-place candidates.
 */
export interface HeaderCandidate extends Partial<ImageProvenanceFields> {
  url: string | null | undefined;
  source: ImageSource;
  attribution?: string;
  generatedVisualId?: string;
  /**
   * The canonical places.id this image was ingested against.
   * resolveHeaderImage will reject candidates whose canonicalPlaceId does not
   * match the entity's own canonical ID when one is set.
   */
  canonicalPlaceId?: string | null;
}

/**
 * Resolve the winning header image from all available candidates.
 *
 * - Candidates with a mismatched canonicalPlaceId (when the entity has one set)
 *   are rejected before scoring.
 * - AI place images are flagged isRepresentation.
 * - For specific real places, images ranked below verified_user_photo get
 *   disclaimerRequired=true and a populated disclaimerText.
 * - All provenance fields from the winning HeaderCandidate pass through to the
 *   ResolvedHeaderImage output.
 *
 * Returns null only when nothing (not even a fallback) is available.
 */
export function resolveHeaderImage(
  candidates: HeaderCandidate[],
  opts: {
    entityType?: string;
    /** The canonical places.id for this entity (when set, mismatched candidates are dropped). */
    canonicalPlaceId?: string | null;
    /** True when this entity is a specific named real-world location. */
    isSpecificRealPlace?: boolean | null;
  } = {},
): ResolvedHeaderImage | null {
  // 1. Filter: must have a non-empty URL.
  let usable = candidates.filter((c) => typeof c.url === "string" && c.url.trim() !== "");

  // 2. Canonical-place guard: reject candidates whose canonicalPlaceId does not
  //    match the entity's own canonical ID, when one is set on the entity.
  if (opts.canonicalPlaceId) {
    usable = usable.filter(
      (c) =>
        // Candidates with no canonicalPlaceId recorded are allowed through
        // (they predate the accuracy work or come from sources that don't set it).
        c.canonicalPlaceId == null || c.canonicalPlaceId === opts.canonicalPlaceId,
    );
  }

  if (usable.length === 0) return null;

  // 3. Sort highest-rank first; tie-break by most recently verified.
  usable.sort((a, b) => {
    const rankDiff = sourceRank(b.source) - sourceRank(a.source);
    if (rankDiff !== 0) return rankDiff;
    // Same source rank → prefer the more recently verified candidate.
    const aAt = a.verifiedAt ?? "";
    const bAt = b.verifiedAt ?? "";
    return bAt.localeCompare(aAt);
  });
  const win = usable[0];

  const isPlace = opts.entityType === "place";
  const isAiSource =
    win.source === "ai_generated" ||
    win.source === "reference_grounded_ai" ||
    win.source === "generic_ai_illustration";

  // 4. Disclaimer: specific real places with sub-verified_user_photo sources.
  const belowVerifiedThreshold = sourceRank(win.source) < VERIFIED_USER_PHOTO_RANK;
  const needsDisclaimer = !!opts.isSpecificRealPlace && belowVerifiedThreshold;

  let disclaimerText: string | null = win.disclaimerText ?? null;
  if (needsDisclaimer && !disclaimerText) {
    // Derive a sensible default disclaimer based on source.
    if (win.source === "reference_grounded_ai") {
      disclaimerText = "AI-generated representation based on real reference images of this place.";
    } else if (win.source === "generic_ai_illustration" || win.source === "ai_generated") {
      disclaimerText = "AI-generated illustration — not a photo of the actual location.";
    } else if (win.source === "map_fallback") {
      disclaimerText = "Map view — not a photo of the actual location.";
    } else {
      disclaimerText = "Representative image — not a photo of the actual location.";
    }
  }

  return {
    url: win.url as string,
    source: win.source,
    attribution: win.attribution,
    generatedVisualId: win.generatedVisualId,
    isRepresentation: isAiSource && isPlace,

    // Provenance pass-through from the winning candidate
    accuracyStatus: win.accuracyStatus ?? null,
    disclaimerRequired: needsDisclaimer ? true : (win.disclaimerRequired ?? null),
    disclaimerText: needsDisclaimer ? disclaimerText : (win.disclaimerText ?? null),
  };
}

/**
 * Guard for the async worker: may a freshly generated AI image be applied to the
 * entity? Only if nothing higher-priority arrived while it was generating, and the
 * entity's current image isn't newer than when generation started.
 */
export function mayApplyGenerated(current: {
  source?: ImageSource | null;
  updatedAt?: string | null;
}, generationStartedAt: string): boolean {
  // A higher-or-equal priority real source already present → do not overwrite.
  if (current.source && sourceRank(current.source) > sourceRank("ai_generated")) return false;
  // The entity image changed after we started generating → a newer upload won.
  if (current.updatedAt && current.updatedAt > generationStartedAt) return false;
  return true;
}
