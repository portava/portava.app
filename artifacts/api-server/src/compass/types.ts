/**
 * Compass Phase 1 — shared TypeScript types.
 *
 * These types are the single source of truth used by CompassProfileService,
 * CompassContextEngine, CompassIntentModeEngine, and the /api/compass route.
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
  /** Whether the user has any pending delayed posts (post_status = pending_exit/pending_delay). */
  hasPendingDelayedPosts: boolean;
  /**
   * Whether the user has any trips scheduled in the future but beyond the 48h arrival window.
   * Triggers the planning_ahead context state.
   */
  hasFutureTripScheduled: boolean;
}

/** The resolved situational context for a user at a given moment. */
export interface CompassContext {
  contextState: CompassContextState;
  signals: CompassSignals;
  /** ISO timestamp when this context was computed. */
  computedAt: string;
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
  /** Total count of accounts this user has blocked (derived from blockedUserIds.length). */
  blockCount: number;
  /** Total count of accounts that have blocked this user (derived from blockerUserIds.length). */
  blockerCount: number;
  trustScore: number | null;
  trustLevel: string | null;
  activeUserScore: number | null;
  hasActiveTrip: boolean;
  hasActiveBooking: boolean;
  upcomingTripWithin48h: boolean;
  /** Has a trip scheduled in the future, beyond the 48h arrival window. */
  hasFutureTripScheduled: boolean;
  currentCity: string | null;
  currentCountry: string | null;
  safeReturnActive: boolean;
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
