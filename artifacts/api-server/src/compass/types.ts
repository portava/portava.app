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
  /** Number of accounts this user has blocked. */
  blockCount: number;
  /** Number of accounts that have blocked this user. */
  blockerCount: number;
  trustScore: number | null;
  trustLevel: string | null;
  activeUserScore: number | null;
  hasActiveTrip: boolean;
  hasActiveBooking: boolean;
  upcomingTripWithin48h: boolean;
  currentCity: string | null;
  currentCountry: string | null;
  safeReturnActive: boolean;
  computedAt: string;
}

/** Safe public subset of a CompassProfile (no block counts, no raw scores). */
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
