/**
 * Visual Generation System — shared types.
 *
 * Central contracts for the AI header/cover generation feature. Kept dependency-free
 * so the pure logic (prompt builder, hash, priority resolver, sanitizer) is unit
 * testable without a DB or provider.
 */

export type VisualPurpose =
  | "event_header"
  | "place_header"
  | "trip_cover"
  | "city_guide_cover"
  | "group_cover"
  | "stamp_artwork"
  | "generic_content_header";

export type VisualEntityType =
  | "event"
  | "place"
  | "trip"
  | "city_guide"
  | "group"
  | "content";

/**
 * Nine canonical source classifications for real-place image accuracy.
 * Ordered roughly highest-trust first; see priority.ts for numeric ranks.
 */
export type ImageSourceType =
  | "official"               // venue's own media or officially licensed photo
  | "trusted_provider"       // major licensed photo provider (Getty, Unsplash licensed, etc.)
  | "tourism_authority"      // national/city tourism board or CVB image
  | "verified_owner"         // venue owner-verified upload via the platform
  | "verified_user_photo"    // community photo explicitly verified by a moderator
  | "reference_grounded_ai"  // AI generation that used real reference images as input
  | "generic_ai_illustration"// AI generation with no real-place reference
  | "category_fallback"      // static branded fallback keyed on category
  | "map_fallback";          // last-resort map thumbnail / street-view capture

/**
 * Image provenance — backward-compatible superset of the legacy ImageSource union.
 * Old literal values (`user_upload`, `provider`, `portava_media`, `ai_generated`)
 * remain valid members so existing callers compile without change.
 */
export type ImageSource =
  | ImageSourceType
  // Legacy values kept for backward compatibility:
  | "user_upload"
  | "provider"
  | "portava_media"
  | "ai_generated";

/** Five accuracy states covering the full real-place verification lifecycle. */
export type ImageAccuracyStatus =
  | "verified_real"       // confirmed to depict the actual place
  | "reference_grounded"  // AI/illustration grounded in real reference assets
  | "illustrative_only"   // generic representation — clearly not a real photo
  | "unverified"          // default; no human or automated check performed yet
  | "rejected";           // confirmed NOT to depict the place; must be replaced

/**
 * Provenance metadata that travels alongside every image in the accuracy pipeline.
 * All fields are nullable — existing rows that predate the accuracy work carry none.
 */
export interface ImageProvenanceFields {
  /** Which of the nine source classifications applies. */
  imageSourceType?: ImageSourceType | null;
  /** Current accuracy assessment. Defaults to 'unverified'. */
  accuracyStatus?: ImageAccuracyStatus | null;
  /** Canonical places.id this visual is bound to (null for non-place entities). */
  canonicalPlaceId?: string | null;
  /** Provider's own place identifier (e.g. FSQ id, Google place_id). */
  providerPlaceId?: string | null;
  /** Direct URL to the source photo at the provider. */
  sourceUrl?: string | null;
  /** Provider name: 'getty', 'unsplash', 'tripadvisor', 'portava', 'user', … */
  sourceProvider?: string | null;
  /** SPDX license identifier or free-text description. */
  sourceLicense?: string | null;
  /** Attribution string required by the license. */
  sourceAttribution?: string | null;
  /** Array of reference_asset ids used as input during AI generation. */
  referenceAssetIds?: string[] | null;
  /** Count of reference images provided to the AI generator. */
  referenceImageCount?: number | null;
  /** True when the final image was produced by an AI model. */
  generatedWithAi?: boolean | null;
  /** Generation method used: 'dalle3', 'sdxl', 'flux', … */
  generationMethod?: string | null;
  /** Current verification pipeline state. */
  verificationStatus?: string | null;
  /** User id of the reviewer who last changed verification_status. */
  verifiedBy?: string | null;
  /** Timestamp of the last verification action. */
  verifiedAt?: string | null;
  /** When true, the UI must render a disclaimer alongside this image. */
  disclaimerRequired?: boolean | null;
  /** Disclaimer copy to show (e.g. "AI-generated representation"). */
  disclaimerText?: string | null;
  /** When this row was last reviewed by the accuracy pipeline. */
  lastAccuracyReviewedAt?: string | null;
  /** When a newer image replaced this one (terminal state). */
  replacedAt?: string | null;
}

export type GenerationStatus =
  | "not_requested"
  | "queued"
  | "generating"
  | "ready"
  | "failed"
  | "blocked"
  | "replaced";

export type VisualStyle =
  | "portava_editorial"
  | "cinematic_travel"
  | "premium_nightlife"
  | "tropical_social"
  | "urban_explorer"
  | "food_and_dining"
  | "outdoor_adventure"
  | "minimal_illustration"
  | "passport_poster"
  | "colorful_festival";

export interface VisualPreferences {
  people?: "auto" | "people" | "no_people";
  timeOfDay?: "auto" | "morning" | "afternoon" | "sunset" | "evening" | "night";
  renderMode?: "realistic" | "illustrated";
  mood?: string;
}

/** Normalized, sanitized fields the prompt builder is allowed to see. */
export interface VisualInputSnapshot {
  entityType: VisualEntityType;
  purpose: VisualPurpose;
  title?: string | null;
  category?: string | null;
  subcategory?: string | null;
  city?: string | null;
  neighborhood?: string | null;
  country?: string | null;
  description?: string | null;
  venue?: string | null;
  setting?: string | null;        // indoor | outdoor
  timeOfDay?: string | null;
  amenities?: string[];
  priceLevel?: string | null;
  traits?: string[];              // waterfront, rooftop, garden, tropical, ...
  style: VisualStyle;
  renderMode: "realistic" | "illustrated";
  people: "auto" | "people" | "no_people";
  promptVersion: string;
}

export interface ImageGenerationInput {
  purpose: VisualPurpose;
  snapshot: VisualInputSnapshot;
  finalPrompt: string;
  negativePrompt: string;
  style: VisualStyle;
  aspectRatio: string;
}

export interface ImageGenerationResult {
  ok: boolean;
  /** data: URL or https URL of the raw generated image (before derivative processing). */
  imageDataUrl?: string;
  provider: string;
  model?: string;
  costEstimate?: number;
  /** Set when ok=false. */
  failureCode?: "provider_rejected" | "provider_error" | "network" | "invalid_output";
  failureMessage?: string;
  /** True for failures that must NOT be retried (moderation/policy). */
  nonRetryable?: boolean;
}

export interface ModerationResult {
  allowed: boolean;
  status: "clean" | "blocked" | "flagged" | "unavailable";
  details?: Record<string, unknown>;
  reason?: string;
}

export interface ProviderHealth {
  status: "present" | "missing" | "disabled" | "invalid";
}

export interface ImageGenerationProvider {
  readonly name: string;
  generateImage(input: ImageGenerationInput): Promise<ImageGenerationResult>;
  moderateInput?(input: ImageGenerationInput): Promise<ModerationResult>;
  healthCheck?(): Promise<ProviderHealth>;
}

/** The single value every card/detail screen should render. */
export interface ResolvedHeaderImage {
  url: string;
  source: ImageSource;
  attribution?: string;
  generatedVisualId?: string;
  /** true for AI place representations — drives the "AI-generated representation" label. */
  isRepresentation: boolean;
  /** Accuracy classification; undefined when not yet assessed. */
  accuracyStatus?: ImageAccuracyStatus | null;
  /** When true the UI must show a disclaimer alongside this image. */
  disclaimerRequired?: boolean | null;
  /** Disclaimer copy to display (e.g. "AI-generated representation"). */
  disclaimerText?: string | null;
}
