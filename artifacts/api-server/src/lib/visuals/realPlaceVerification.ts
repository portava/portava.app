/**
 * RealPlaceImageVerificationService — accuracy gate for specific named places.
 *
 * Every candidate image for a specific real-world place must pass through
 * verifyPlaceImage() before it is accepted. The function answers the eight
 * spec questions and returns a structured verdict:
 *
 *   Q1. Is this a specific named real-world place?
 *   Q2. Is there a verified real image of this place available?
 *   Q3. Is the image source permitted for use?
 *   Q4. Does the image match the canonical place being displayed?
 *   Q5. Was AI used to produce this image?
 *   Q6. Were verified real reference images used during AI generation?
 *   Q7. Do the defining visual characteristics of the place survive?
 *   Q8. Is a disclaimer required?
 *
 * Results carry: permitted, disclaimerRequired, disclaimerText,
 * accuracyStatus, and rejectionReason.
 */
import type {
  ImageAccuracyStatus,
  ImageSourceType,
  PlaceImageVerificationInput,
  PlaceImageVerificationResult,
} from "./types.js";

// ── Source permission policy ───────────────────────────────────────────────────

/**
 * Source types that are always permitted to be served as a primary image,
 * subject to canonical-place matching when applicable.
 */
const PERMITTED_SOURCES: ReadonlySet<ImageSourceType> = new Set<ImageSourceType>([
  "official",
  "trusted_provider",
  "tourism_authority",
  "verified_owner",
  "verified_user_photo",
  "reference_grounded_ai",
  "generic_ai_illustration",
  "category_fallback",
  "map_fallback",
]);

/**
 * Sources that are "real photo" quality — depict the actual place and carry no
 * inherent inaccuracy risk.
 */
const VERIFIED_REAL_SOURCES: ReadonlySet<ImageSourceType> = new Set<ImageSourceType>([
  "official",
  "trusted_provider",
  "tourism_authority",
  "verified_owner",
  "verified_user_photo",
]);

/**
 * AI or fallback sources that represent the place illustratively — require
 * disclaimers on specific real-place entities.
 */
const ILLUSTRATIVE_SOURCES: ReadonlySet<ImageSourceType> = new Set<ImageSourceType>([
  "reference_grounded_ai",
  "generic_ai_illustration",
  "category_fallback",
  "map_fallback",
]);

// ── Disclaimer copy ────────────────────────────────────────────────────────────

function buildDisclaimerText(source: ImageSourceType, usedReferences: boolean): string {
  switch (source) {
    case "reference_grounded_ai":
      return "AI-generated representation based on real reference images of this place.";
    case "generic_ai_illustration":
      return "AI-generated illustration — not a photo of the actual location.";
    case "category_fallback":
      return "Representative image — not a photo of the actual location.";
    case "map_fallback":
      return "Map view — not a photo of the actual location.";
    default:
      return usedReferences
        ? "AI-generated representation based on real reference images."
        : "AI-generated representation — not a photo of the actual location.";
  }
}

// ── Accuracy status derivation ─────────────────────────────────────────────────

function deriveAccuracyStatus(
  source: ImageSourceType,
  usedReferences: boolean,
  matchesCanonical: boolean,
): ImageAccuracyStatus {
  if (!matchesCanonical) return "rejected";
  if (VERIFIED_REAL_SOURCES.has(source)) return "verified_real";
  if (source === "reference_grounded_ai" && usedReferences) return "reference_grounded";
  if (ILLUSTRATIVE_SOURCES.has(source)) return "illustrative_only";
  return "unverified";
}

// ── Main verification entry point ──────────────────────────────────────────────

/**
 * Evaluate a candidate image against the eight spec questions and return a
 * structured verdict. Pure function — no DB access, no side effects.
 *
 * @param input - Describes the candidate image and the entity it depicts.
 * @returns A `PlaceImageVerificationResult` with all eight answers plus the
 *          actionable verdict fields (permitted, disclaimerRequired, etc.).
 */
export function verifyPlaceImage(input: PlaceImageVerificationInput): PlaceImageVerificationResult {
  const {
    imageSource,
    generatedWithAi,
    referenceImageUrls,
    canonicalPlaceId,
    isSpecificRealPlace,
    currentAccuracyStatus,
  } = input;

  // ── Q1: Is this a specific named real-world place? ────────────────────────
  const q1IsSpecificRealPlace = isSpecificRealPlace;

  // ── Q2: Is there a verified real image available? ─────────────────────────
  // We know a verified real image is present if the current source is one of
  // the verified-real tiers. The caller signals this via imageSource.
  const q2HasVerifiedRealImage = VERIFIED_REAL_SOURCES.has(imageSource);

  // ── Q3: Is the source permitted? ──────────────────────────────────────────
  const q3SourcePermitted = PERMITTED_SOURCES.has(imageSource);

  // ── Q4: Does the image match the canonical place? ─────────────────────────
  // We cannot do pixel-level vision analysis in this pure function, so we
  // trust the provenance chain:
  //   • If the image was sourced from an official/trusted/verified channel AND
  //     a canonical_place_id was set at ingestion, it matches by construction.
  //   • A previously rejected image is explicitly flagged non-matching.
  //   • Illustrative/AI images whose reference set was built from the entity's
  //     own assets are treated as "matching" for canonical purposes.
  //   • Without a canonical_place_id to compare against, we cannot confirm a
  //     match — treat as unconfirmed but not rejected (only illustrative).
  let q4MatchesCanonical: boolean;
  if (currentAccuracyStatus === "rejected") {
    q4MatchesCanonical = false;
  } else if (!canonicalPlaceId) {
    // No canonical ID set → cannot reject on mismatch; treat as matching
    q4MatchesCanonical = true;
  } else if (VERIFIED_REAL_SOURCES.has(imageSource)) {
    // Verified-real channels are trusted to provide the correct place image
    q4MatchesCanonical = true;
  } else {
    // Illustrative/AI: we provisionally accept — human review should confirm
    q4MatchesCanonical = true;
  }

  // ── Q5: Was AI used? ──────────────────────────────────────────────────────
  const q5GeneratedWithAi = generatedWithAi;

  // ── Q6: Were verified references used? ───────────────────────────────────
  const refUrls = referenceImageUrls ?? [];
  const q6UsedVerifiedReferences = generatedWithAi && refUrls.length > 0;

  // ── Q7: Do defining characteristics survive? ─────────────────────────────
  // For non-AI verified-real images: characteristics are inherently preserved.
  // For reference-grounded AI: the pipeline's reference-based prompt preserves them.
  // For generic AI or fallbacks: characteristics are NOT specifically preserved.
  let q7CharacteristicsPreserved: boolean;
  if (VERIFIED_REAL_SOURCES.has(imageSource)) {
    q7CharacteristicsPreserved = true;
  } else if (imageSource === "reference_grounded_ai" && q6UsedVerifiedReferences) {
    q7CharacteristicsPreserved = true;
  } else {
    q7CharacteristicsPreserved = false;
  }

  // ── Q8: Is a disclaimer required? ────────────────────────────────────────
  // Disclaimer is required when:
  //   - The entity is a specific real place AND
  //   - The image source is illustrative (AI or fallback)
  const q8DisclaimerRequired = q1IsSpecificRealPlace && ILLUSTRATIVE_SOURCES.has(imageSource);

  // ── Derive accuracy status ────────────────────────────────────────────────
  const accuracyStatus = deriveAccuracyStatus(imageSource, q6UsedVerifiedReferences, q4MatchesCanonical);

  // ── Permitted verdict ─────────────────────────────────────────────────────
  // An image is NOT permitted when:
  //   • Its source is not in the permitted set (unknown/unsupported source)
  //   • It has been confirmed to not match the canonical place (rejected status)
  //   • It's a generic AI illustration for a specific real place with no references
  //     (text-only generation for named real places is blocked by the prompt gate;
  //      this catches any that slip through)
  let permitted = q3SourcePermitted && q4MatchesCanonical;
  let rejectionReason: string | null = null;

  if (!q3SourcePermitted) {
    permitted = false;
    rejectionReason = `Image source '${imageSource}' is not permitted.`;
  } else if (!q4MatchesCanonical) {
    permitted = false;
    rejectionReason = "Image does not match the canonical place being displayed.";
  } else if (
    q1IsSpecificRealPlace &&
    imageSource === "generic_ai_illustration" &&
    !q6UsedVerifiedReferences
  ) {
    // Text-only AI generation for a named real place: block it.
    permitted = false;
    rejectionReason =
      "Text-only AI generation is not permitted for specific named real places. " +
      "Verified reference images are required.";
  }

  const disclaimerText = q8DisclaimerRequired
    ? buildDisclaimerText(imageSource, q6UsedVerifiedReferences)
    : null;

  return {
    // Eight spec answers
    isSpecificRealPlace: q1IsSpecificRealPlace,
    hasVerifiedRealImage: q2HasVerifiedRealImage,
    sourcePermitted: q3SourcePermitted,
    matchesCanonicalPlace: q4MatchesCanonical,
    generatedWithAi: q5GeneratedWithAi,
    usedVerifiedReferences: q6UsedVerifiedReferences,
    characteristicsPreserved: q7CharacteristicsPreserved,
    disclaimerRequired: q8DisclaimerRequired,

    // Actionable verdict
    permitted,
    accuracyStatus,
    disclaimerText,
    rejectionReason: permitted ? null : rejectionReason,
  };
}
