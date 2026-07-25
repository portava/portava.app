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
 * Server endpoint: POST /api/moderation/report with subjectType:'place'
 * stores the report in moderation_reports (migration 2029).
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

// ── Opening hours ─────────────────────────────────────────────────────────────

/**
 * One day's open/close window. dayOfWeek follows JS Date convention:
 * 0 = Sunday, 1 = Monday, …, 6 = Saturday.
 * open/close are local-time strings in "HH:MM" format (24-hour).
 */
export type NormalizedOpeningHours = {
  dayOfWeek: number;
  open: string;
  close: string;
}[];

// ── Price level ───────────────────────────────────────────────────────────────

/**
 * Normalised price tier derived from provider data (FSQ price 1–4, etc.).
 * 'free' = no cost to enter/use; 'very_expensive' = fine dining / luxury.
 */
export type PriceLevel =
  | 'free'
  | 'inexpensive'
  | 'moderate'
  | 'expensive'
  | 'very_expensive';

// ── Canonical place envelope ──────────────────────────────────────────────────

export interface CanonicalPlace {
  // ── Required fields ──────────────────────────────────────────────────────
  id: string;
  name: string;
  category: string;

  // ── Location ──────────────────────────────────────────────────────────────
  coordinates: { lat: number; lng: number };
  /** Unstructured address string (legacy / fallback display). */
  address: string | null;
  /** Structured address — line 1 (street number + street name). */
  addressLine1?: string | null;
  /** Structured address — line 2 (unit, suite, floor, etc.). */
  addressLine2?: string | null;
  /** Full human-readable formatted address (provider-supplied). */
  formattedAddress?: string | null;
  postalCode?: string | null;
  /** State, province, or administrative region. */
  region?: string | null;
  city: string | null;
  neighborhood: string | null;
  countryCode: string | null;

  // ── Status & routing ──────────────────────────────────────────────────────
  status: PlaceStatus;
  /** Expo Router href the detail screen lives at — e.g. /place/abc123 */
  detailRoute: string;

  // ── Images ────────────────────────────────────────────────────────────────
  /**
   * Primary cover image URL resolved via the 5-tier priority chain on the
   * server (Portava verified → provider photo → user-contributed → null).
   * Null means no image is available; UI falls back to category artwork.
   */
  headerImageUrl?: string | null;
  /** Additional gallery image URLs (ordered; may be empty). */
  galleryImages?: string[];
  /** Legacy cover image — superseded by headerImageUrl; kept for back-compat. */
  imageUrl?: string | null;

  // ── Contact ───────────────────────────────────────────────────────────────
  phone?: string | null;
  internationalPhone?: string | null;
  website?: string | null;
  bookingUrl?: string | null;

  // ── Ratings & reviews ─────────────────────────────────────────────────────
  /** Provider rating (e.g. Foursquare). Display separately from travelerScore. */
  rating?: number | null;
  /** Provider name for rating (e.g. "Foursquare"). */
  ratingProvider?: string | null;
  /** Number of ratings/reviews backing the provider rating. */
  reviewCount?: number | null;
  /** Portava traveler score — distinct from provider rating, never blended. */
  travelerScore?: number | null;

  // ── Pricing ───────────────────────────────────────────────────────────────
  priceLevel?: PriceLevel | null;

  // ── Hours ─────────────────────────────────────────────────────────────────
  /** Structured weekly opening hours. Null when not available from provider. */
  openingHours?: NormalizedOpeningHours | null;
  /**
   * Real-time open/closed status. Null when the provider doesn't supply it
   * (e.g. ingested dataset rather than live API). Never inferred from hours.
   */
  isOpenNow?: boolean | null;

  // ── Amenities ─────────────────────────────────────────────────────────────
  /** Normalised amenity tags (e.g. 'wifi', 'parking', 'outdoor_seating'). */
  amenities?: string[];

  // ── Provenance ────────────────────────────────────────────────────────────
  /** Attribution strings from each data provider (OSM, Foursquare, etc.). */
  attribution: string[];
  sources: PlaceSource[];
  fieldFreshness: PlaceFieldFreshness;
}
