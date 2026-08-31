/**
 * features/media — canonical client media projection types (spec §5/§6/§10/§33).
 *
 * These describe what the CLIENT receives AFTER server-side privacy, eligibility,
 * provenance, and ranking have resolved (spec §42). The client never computes
 * truth or eligibility — it renders the projection it is handed and distinguishes
 * observed / inferred / predicted states visually (§2, §46).
 *
 * Pure type module: no runtime imports, so it is safe to import from node:test
 * pure-logic suites.
 */

// ── Observation / evidence class (§2, §8, §35, §46) ───────────────────────────
// Observed, inferred, user-claimed, generated, and predicted information must
// remain visually distinguishable. A photo/video is never truth automatically.
export type ObservationClass =
  | 'observed' // directly captured, fresh evidence candidate
  | 'inferred' // derived by the intelligence layer, not directly observed
  | 'user_claimed' // asserted by a person, not corroborated
  | 'generated' // AI/fallback imagery — lowest evidence weight
  | 'predicted'; // forecast / likely-next state (§17)

// ── Freshness (§10, §17, §39) ─────────────────────────────────────────────────
export type FreshnessClass = 'live' | 'fresh' | 'recent' | 'historical';

// ── Confidence of the current picture (§13, §18, §23) ─────────────────────────
export type ConfidenceState = 'low' | 'moderate' | 'strong';

// ── Privacy (§33) — media visibility and location visibility are independent ──
export type MediaVisibility =
  | 'public'
  | 'followers'
  | 'following'
  | 'trip_crew'
  | 'shared_moment'
  | 'private';

export type LocationVisibility =
  | 'hidden'
  | 'country'
  | 'city'
  | 'neighborhood'
  | 'place'
  | 'precise_private';

// ── Intelligence eligibility (§10) ────────────────────────────────────────────
// The client treats this as read-only projected metadata used only for display
// language ("Fresh perspective", "Strong current picture"), never as a gate it
// re-evaluates.
export interface IntelligenceEligibility {
  eligible: boolean;
  reasons: string[];
  freshnessClass: FreshnessClass;
  captureConfidence: number;
  locationConfidence: number;
  provenanceConfidence: number;
  expiresAt?: string;
}

// ── Contributor (§14, §25, §27, §46) ──────────────────────────────────────────
// Creator identity is visible but secondary in world-first lenses. Contributor
// reliability is an evidence signal, NOT a follower/popularity count.
export interface MediaContributor {
  id: string;
  displayName: string;
  username?: string | null;
  avatarUrl?: string | null;
  verified: boolean;
  /** Evidence-trust label, e.g. "Trusted nightlife contributor" (§14). */
  trustLabel?: string | null;
}

// ── A single projected media object handed to the client (§5, §14) ────────────
export interface MediaProjection {
  id: string;
  mediaType: 'image' | 'video';
  /** Thumbnail / poster reference (may be a bare bucket path — hydrate before render). */
  thumbnailUrl: string | null;
  /** Full media reference when the projection is expanded. */
  url?: string | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  capturedAt?: string | null;
  observationClass: ObservationClass;
  freshness: FreshnessClass;
  /** Minutes since capture/update when the server computes it (for freshness copy). */
  ageMinutes?: number | null;
  /** Perspective group key this media belongs to (§12), e.g. 'street'. */
  perspectiveKey?: string | null;
  /** Short human freshness/last-updated label, never a fake "live now". */
  freshnessLabel?: string | null;
  contributor?: MediaContributor | null;
  place?: { id: string | null; name: string | null } | null;
  /** Resolved category / perspective context (§7), e.g. "nightlife" — for context copy. */
  category?: string | null;
  /** Short caption / on-the-ground note (§14 "It's filling up fast."). */
  note?: string | null;
  /** Pre-computed "why you're seeing this" explanation (§47) for WhyThisSheet. */
  whyThis?: string | null;
}

// ── Result envelope (mirrors services/mediaFeed.ts convention) ────────────────
export type ProjectionErrorKind =
  | 'auth'
  | 'server'
  | 'network'
  | 'not_found'
  | 'empty'
  | 'unknown';

export interface ProjectionOk<T> {
  ok: true;
  data: T;
}
export interface ProjectionErr {
  ok: false;
  data: null;
  errorKind: ProjectionErrorKind;
  message: string;
}
export type ProjectionResult<T> = ProjectionOk<T> | ProjectionErr;
