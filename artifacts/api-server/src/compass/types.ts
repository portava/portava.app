/**
 * Compass shared TypeScript types — Phase 1 (profile/context/intent) + Phase 2 (items/pipeline).
 *
 * Single source of truth for all Compass engines.
 */

// ── Intent modes ──────────────────────────────────────────────────────────────

export type CompassIntentModeName =
  | 'explore_now'
  | 'plan_ahead'
  | 'arrival_mode'
  | 'night_mode'
  | 'social_mode'
  | 'safety_mode'
  | 'creator_mode'
  | 'budget_mode'
  | 'private_mode';

export interface CompassIntentMode {
  primary: CompassIntentModeName;
  /** Ranked list of secondary modes that are also active (may be empty). */
  secondary: CompassIntentModeName[];
}

// ── Context states ────────────────────────────────────────────────────────────

export type CompassContextState =
  | 'normal'
  | 'exploring_now'
  | 'planning_ahead'
  | 'arrival_mode'
  | 'night_mode'
  | 'safety_mode'
  | 'private_mode'
  | 'creator_mode'
  | 'budget_mode'
  | 'active_booking_mode'
  | 'active_trip_mode';

/** Raw signals fed into the context engine alongside the profile. */
export interface CompassSignals {
  /** Current server-side UTC hour (0–23). */
  hourUtc: number;
  /** Whether a safe-return session is currently active for the user. */
  safeReturnActive: boolean;
  /** Whether the user has an active rent-a-buddy booking right now. */
  activeBooking: boolean;
  /** Whether the user's next trip starts within the next 48 hours. */
  upcomingTripWithin48h: boolean;
  /** Whether the user currently has an ongoing trip (start ≤ now ≤ end). */
  activeTripNow: boolean;
  /** Whether the user has any pending delayed posts. */
  hasPendingDelayedPosts: boolean;
  /** Whether the user has trips scheduled in the future beyond the 48h window. */
  hasFutureTripScheduled: boolean;
}

/** The resolved situational context for a user at a given moment. */
export interface CompassContext {
  contextState: CompassContextState;
  signals: CompassSignals;
  /** ISO timestamp when this context was computed. */
  computedAt: string;
  /**
   * place_id → count of place_view rank_events in the last 30 days for the
   * viewing user.  Injected by CompassFeedBuilder before the pipeline runs;
   * drives the ×1.15 place-affinity boost in CompassScoringEngine.
   * Optional so existing callers that build CompassContext directly (tests,
   * context-resolver) do not need to change.
   */
  placeAffinities?: Record<string, number>;
  /**
   * Map spec §13 TemporaryIntent — the request-scoped "what I want right now"
   * addend (bored / eat / party / …) with its two sliders. Optional and
   * ephemeral: set only when the client sent a live intent (the recommendations
   * route parses and re-checks its expiry via CompassTemporaryIntent), never
   * read from or written back to the stored profile. Drives the intent boost in
   * CompassScoringEngine. Absent ⇒ zero boost, cleanly.
   */
  temporaryIntent?: import("./CompassTemporaryIntent.js").TemporaryIntentContext | null;
}

// ── User profile ──────────────────────────────────────────────────────────────

export interface CompassProfile {
  userId: string;
  preferredCities: string[];
  preferredLanguages: string[];
  budgetStyle: string | null;
  travelStyles: string[];
  socialStyle: string | null;
  safetyPreference: 'standard' | 'cautious' | 'relaxed';
  visibilityPreference: 'public' | 'semi_private' | 'private';
  /**
   * IDs of users this user has blocked.
   * Used by downstream Compass phases to exclude these users from scoring/results.
   */
  blockedUserIds: string[];
  /**
   * IDs of users who have blocked this user.
   * Used by downstream Compass phases to exclude this user from their results.
   */
  blockerUserIds: string[];
  /**
   * IDs of users this user has muted (hide from feed, not a full block).
   * Loaded from user_interactions where interaction_type = 'mute'.
   */
  mutedUserIds: string[];
  /** Total count of accounts this user has blocked. */
  blockCount: number;
  /** Total count of accounts that have blocked this user. */
  blockerCount: number;
  trustScore: number | null;
  trustLevel: string | null;
  activeUserScore: number | null;
  hasActiveTrip: boolean;
  hasActiveBooking: boolean;
  upcomingTripWithin48h: boolean;
  hasFutureTripScheduled: boolean;
  currentCity: string | null;
  currentCountry: string | null;
  safeReturnActive: boolean;
  /** Resolved age of the viewer (used for age-gate checks in Safety Filter). */
  viewerAge?: number;
  /**
   * Category weight adjustments from feedback (itemType → delta, range -10..+10).
   * Loaded from compass_user_preferences.category_weights.
   * Applied as a score bonus/penalty post-pipeline so hide_category/show_more
   * feedback influences the very next feed build.
   *
   * null when the user has never set travel-interest preferences (new users).
   * All callsites must guard against null before calling Object.keys() or indexing.
   */
  categoryWeights: Record<string, number> | null;
  /**
   * Item IDs the user has dismissed via "not_interested" feedback.
   * These items are filtered out before the feed pipeline runs.
   */
  ignoredItemIds: string[];
  /**
   * Hashtag slugs the user has muted via feedback.
   * Content strongly associated with these hashtags is downranked.
   */
  mutedHashtags: string[];
  computedAt: string;
}

/** Safe public subset of a CompassProfile (no block arrays, no raw scores). */
export interface CompassProfilePublic {
  userId: string;
  budgetStyle: string | null;
  travelStyles: string[];
  safetyPreference: string;
  currentCity: string | null;
  trustLevel: string | null;
  hasActiveTrip: boolean;
  hasActiveBooking: boolean;
}

// ── API response ──────────────────────────────────────────────────────────────

export interface CompassContextResponse {
  contextState: CompassContextState;
  intentMode: CompassIntentMode;
  profile: CompassProfilePublic;
  computedAt: string;
}

export interface CompassFallbackResponse {
  fallback: true;
  contextState: 'normal';
  intentMode: { primary: 'explore_now'; secondary: [] };
}

// ── Phase 2: Content item interfaces ─────────────────────────────────────────

/**
 * Content type discriminator. All Compass pipeline stages use this union.
 */
export type CompassItemType =
  | 'event'
  | 'post'
  | 'user'
  | 'buddy'
  | 'trip'
  | 'stamp'
  | 'notification'
  | 'suggestion'
  | 'place'
  | 'hidden_gem'
  | 'traveler';

/**
 * Universal content item interface for the Compass pipeline.
 *
 * All four pipeline gates (Safety → Eligibility → Privacy → Scoring) operate
 * on this interface. Each gate checks only the fields it cares about; unused
 * fields are ignored. Concrete content adapters map domain objects to this shape
 * before calling `runPipeline()`.
 *
 * Index signature `[key: string]: unknown` allows extra domain-specific data to
 * be carried through the pipeline without type errors.
 */
export interface CompassItem {
  /** Stable unique identifier for the item (DB UUID or composite key). */
  id: string;
  /** Content type — drives type-specific checks in all four gates. */
  type: CompassItemType;

  // ── Authorship ─────────────────────────────────────────────────────────────
  /** User ID of the content creator (used for block checks). */
  authorId?: string;
  /** For 'user' items: the user being shown (same as authorId for profiles). */
  targetUserId?: string;
  /** Cached trust score of the author (0–100). */
  authorTrustScore?: number | null;

  // ── Safety signals ─────────────────────────────────────────────────────────
  /** True if the item or its author has been suspended by an admin. */
  isSuspended?: boolean;
  /** True if the viewing user has already reported this specific item. */
  isReportedByViewer?: boolean;
  /** How many times this item has been reported in total. */
  reportCount?: number;
  /** True if the item has an adult-service flag (rent-a-buddy safety). */
  hasAdultServiceFlag?: boolean;
  /** True if the item contains off-app payment signals. */
  hasOffAppPaymentSignal?: boolean;
  /** True if the item contains an unsafe-intent signal. */
  hasUnsafeIntentSignal?: boolean;
  /** True if the item is hidden (user set to hidden or admin hidden). */
  isHidden?: boolean;
  /** True if the event/trip/stamp has expired. */
  isExpired?: boolean;
  /** True if the event/booking has been cancelled. */
  isCancelled?: boolean;
  /** Minimum viewer age required to see this item (0 = no restriction). */
  minAgeRequired?: number;
  /** True if this is a delayed post awaiting location-exit before publication. */
  isDelayedPost?: boolean;
  /** ISO timestamp when the delayed post becomes eligible for publication. */
  publishEligibleAt?: string;

  // ── Eligibility signals ────────────────────────────────────────────────────
  /** True if this content type requires the author to be verified. */
  requiresVerification?: boolean;
  /** True if the author has passed verification for this content type. */
  isVerified?: boolean;
  /** For 'event' items: maximum number of attendees. */
  capacity?: number;
  /** For 'event' items: current attendee count. */
  currentAttendees?: number;
  /**
   * Visibility scope:
   *   'public'       — visible to everyone
   *   'circle_only'  — visible only to trust-circle members
   *   'trip_only'    — visible only to trip members
   *   'private'      — visible only to the author
   */
  visibilityScope?: 'public' | 'circle_only' | 'trip_only' | 'private';
  /** True if the viewing user is in the item's trust circle. */
  viewerIsInCircle?: boolean;
  /** True if the viewing user is a member of the item's trip. */
  viewerIsInTrip?: boolean;
  /** For 'buddy' items: must be 'active' to accept bookings. */
  buddyStatus?: string;

  // ── Temporal authorship signals ────────────────────────────────────────────
  /**
   * ISO timestamp when the author first joined the platform.
   * Used by fair-exposure eligibility to detect recently-joined users.
   */
  authorJoinedAt?: string;
  /**
   * ISO timestamp when the author was approved as a Rent-a-Buddy on the
   * platform. Used in addition to `authorJoinedAt` so that older users
   * newly approved as Buddies also qualify for fair-exposure slots.
   */
  buddyApprovedAt?: string;

  // ── Privacy fields (scrubbed by Privacy Guard) ─────────────────────────────
  /** Exact GPS latitude — ALWAYS stripped by Privacy Guard. */
  exactLat?: number;
  /** Exact GPS longitude — ALWAYS stripped by Privacy Guard. */
  exactLng?: number;
  /** Exact street address — ALWAYS stripped by Privacy Guard. */
  exactAddress?: string;
  /** Hotel/accommodation address — ALWAYS stripped by Privacy Guard. */
  hotelAddress?: string;
  /** Safe-return session route data — ALWAYS stripped by Privacy Guard. */
  safeReturnRoute?: unknown;
  /** Emergency contact details — ALWAYS stripped by Privacy Guard. */
  emergencyContacts?: unknown;
  /** Internal admin notes — ALWAYS stripped by Privacy Guard. */
  adminNotes?: string;
  /** Identity document data — ALWAYS stripped by Privacy Guard. */
  idDocument?: unknown;
  /** Private booking notes — ALWAYS stripped by Privacy Guard. */
  privateBookingNotes?: string;
  /** True if the item is unpublished (draft/scheduled). */
  isUnpublished?: boolean;
  /** Sanitized public post latitude (for delayed posts, stripped until eligible). */
  publicLat?: number;
  /** Sanitized public post longitude. */
  publicLng?: number;
  /** Public location label text. */
  publicLocationLabel?: string;
  /** Human-readable location text (rewritten by Privacy Guard when GPS was stripped). */
  locationText?: string;

  // ── Location (for scoring + privacy text) ─────────────────────────────────
  /** City name where the item is located (used for city-match scoring). */
  city?: string;
  /** Neighbourhood within the city (used for privacy text). */
  neighbourhood?: string;
  /** Country code or name. */
  country?: string;

  // ── Scoring signals ────────────────────────────────────────────────────────
  /** Interest/activity tags on this item (matched against viewer's travel styles). */
  interestTags?: string[];
  /** BCP-47 language code of the item's content. */
  languageCode?: string;
  /** ISO timestamp when the item was created (for freshness decay). */
  createdAt?: string;
  /** Base quality score 0–10 assigned by the content layer. */
  qualityScore?: number;
  /** True if the item has been rejected by the moderation pipeline. */
  isModerationRejected?: boolean;
  /** True if the account or content has been soft-deleted. */
  isDeleted?: boolean;
  /** True if the item has been flagged as spam. */
  isSpam?: boolean;
  /** How many times this item has already been shown to this viewer. */
  repeatCount?: number;
  /**
   * Diversity score 0–1: pre-computed by feed builder (Phase 3).
   * Higher = underrepresented item type in recent feed → gets diversity boost.
   */
  diversityScore?: number;
  /**
   * Fair-exposure score 0–1: pre-computed by feed builder (Phase 3).
   * Higher = author hasn't appeared recently → gets fair-exposure boost.
   */
  fairExposureScore?: number;
  /** Risk score 0–1: higher = more risk signals from moderation pipeline. */
  riskScore?: number;
  /** Safety tier: "standard" | "cautious" | "relaxed" (from content moderation). */
  safetyTier?: string;
  /** Group type: "solo" | "couple" | "group" | "family" (for social compat). */
  groupType?: string;
  /** ISO timestamp when the event expires (for expiredSoon penalty). */
  expiresAt?: string;

  // ── Content body (may be stripped for unpublished items) ──────────────────
  contentBody?: string;
  contentUrl?: string;

  /**
   * Canonical place ID for this item (e.g. the place page UUID for a stamp,
   * post, or event tied to a specific venue).  Used by the place-affinity
   * boost in CompassScoringEngine: a ×1.15 multiplier fires when the viewer
   * has ≥2 place_view events for this place in the last 30 days.
   */
  placeId?: string | null;

  // ── Catch-all for domain-specific fields carried through the pipeline ──────
  [key: string]: unknown;
}

/** A CompassItem annotated with its pipeline result (after all four gates). */
export interface ScoredCompassItem extends CompassItem {
  finalScore: number;
}

// ── Convenience type aliases for each content subtype ────────────────────────

export type CompassEvent        = CompassItem & { type: 'event' };
export type CompassPost         = CompassItem & { type: 'post' };
export type CompassUser         = CompassItem & { type: 'user' };
export type CompassBuddy        = CompassItem & { type: 'buddy' };
export type CompassTrip         = CompassItem & { type: 'trip' };
export type CompassStamp        = CompassItem & { type: 'stamp' };
export type CompassNotification = CompassItem & { type: 'notification' };
export type CompassSuggestion   = CompassItem & { type: 'suggestion' };
