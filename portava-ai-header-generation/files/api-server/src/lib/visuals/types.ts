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

/** Image provenance, highest-trust first. Order matters — see priority.ts. */
export type ImageSource =
  | "user_upload"
  | "official"
  | "provider"
  | "portava_media"
  | "ai_generated"
  | "category_fallback";

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
}
