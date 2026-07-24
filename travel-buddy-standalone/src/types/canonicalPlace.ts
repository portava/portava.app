/**
 * Canonical external-place types.
 *
 * CanonicalPlace is the normalised envelope returned by
 * GET /api/places/canonical/:id (flag: external_places_enabled).
 *
 * Mirrors the server-side shape; any field not present in the response
 * should be treated as absent/undefined by callers.
 */

// ── Status ────────────────────────────────────────────────────────────────────

export type PlaceStatus =
  | 'active'
  | 'closed'
  | 'temporarily_closed'
  | 'moved';

// ── Report categories (place-specific) ────────────────────────────────────────

/**
 * Reason codes for reporting a canonical place.
 * Used by PlaceReportSheet and submitted via submitModerationReport
 * with subjectType: 'place'.
 *
 * Server endpoint: POST /api/places/:id/report (may need to be created;
 * client POSTs to the general moderation endpoint and falls back gracefully
 * on any non-OK response).
 */
export type PlaceReportCategory =
  | 'wrong_place'
  | 'wrong_photo'
  | 'duplicate'
  | 'closed'
  | 'incorrect_address'
  | 'incorrect_category'
  | 'outdated_image';

// ── Source freshness ──────────────────────────────────────────────────────────

export interface PlaceFieldFreshness {
  name?: string;
  address?: string;
  coordinates?: string;
  category?: string;
  [key: string]: string | undefined;
}

// ── Source record ─────────────────────────────────────────────────────────────

export interface PlaceSource {
  provider: string;
  externalId: string;
  lastSyncedAt?: string;
}

// ── Canonical place envelope ──────────────────────────────────────────────────

export interface CanonicalPlace {
  id: string;
  name: string;
  category: string;
  coordinates: { lat: number; lng: number };
  address: string | null;
  city: string | null;
  neighborhood: string | null;
  countryCode: string | null;
  status: PlaceStatus;
  /** Expo Router href the detail screen lives at — e.g. /place/abc123 */
  detailRoute: string;
  /** Attribution strings from each data provider (OSM, Foursquare, etc.). */
  attribution: string[];
  sources: PlaceSource[];
  fieldFreshness: PlaceFieldFreshness;
  /** Provider rating (e.g. Foursquare). Display separately from travelerScore. */
  rating?: number | null;
  /** Provider name for rating (e.g. "Foursquare"). */
  ratingProvider?: string | null;
  /** Portava traveler score — distinct from provider rating, never blended. */
  travelerScore?: number | null;
  /** Cover image URL (may be null; falls back to category artwork). */
  imageUrl?: string | null;
}
