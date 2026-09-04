/**
 * Pure API-row -> model mappers for passport stamps.
 * Kept free of side-effectful imports (supabase, fetch) so they can be
 * unit-tested in Node directly.
 */
import type { StampDefinition, PassportStampNew } from './passportStamps.ts';
import type { PassportStamp, StampVerification } from '../types/models.ts';

/**
 * Stamp sources that constitute CANONICAL provenance (§12 / TABLE 16). A stamp
 * from one of these is a verified travel fact — the server issued it from a real
 * event, trip, contribution or partner, not from an editable profile field.
 */
const CANONICAL_VERIFIED_SOURCES = new Set([
  'system',
  'system_observed',
  'trip_derived',
  'event_verified',
  'contribution_earned',
  'buddy_derived',
  'partner_verified',
  'admin_issued',
]);

/** Sources that are a traveler's own claim — reported, never verified (§12). */
const SELF_REPORTED_SOURCES = new Set(['self_reported', 'self', 'profile', 'user']);

/** Verification levels that do NOT amount to a real verification. */
const UNVERIFIED_LEVELS = new Set(['', 'unverified', 'none', 'self', 'self_reported', 'pending']);

/**
 * Derive the §12 verification treatment from a stamp's provenance. Verified
 * requires canonical provenance (a genuine verification level OR a canonical
 * source); a self-reported source is 'reported'; anything else is 'decorative'
 * so a stamp with unknown provenance can never impersonate a verified one.
 */
export function deriveStampVerification(
  sourceType: string | null | undefined,
  verificationLevel: string | null | undefined,
): StampVerification {
  const src = (sourceType ?? '').trim().toLowerCase();
  const lvl = (verificationLevel ?? '').trim().toLowerCase();
  if (lvl && !UNVERIFIED_LEVELS.has(lvl)) return 'verified';
  if (CANONICAL_VERIFIED_SOURCES.has(src)) return 'verified';
  if (SELF_REPORTED_SOURCES.has(src)) return 'reported';
  return 'decorative';
}

/**
 * Convert a v2 PassportStampNew into the legacy PassportStamp shape used by
 * older passport UI (stamp collection strip, full view, destination grouping).
 * Single source of truth — StampCard re-exports this as `toLegacy`.
 */
export function toLegacyStamp(s: PassportStampNew): PassportStamp {
  const label =
    s.titleOverride ?? s.definition?.name ?? s.city ?? s.country ?? s.stampType.replace(/_/g, ' ').toUpperCase();
  const kind = (
    s.stampType === 'city'        ? 'city'
    : s.stampType === 'plan'      ? 'plan'
    : s.stampType === 'hidden_gem'? 'gem'
    : s.stampType === 'safe_return'? 'safe'
    : s.stampType === 'host'      ? 'host'
    : 'city'
  ) as PassportStamp['kind'];
  const sub: string[] = [];
  if (s.city && s.country) sub.push(s.country);
  if (s.earnedAt) sub.push(new Date(s.earnedAt).getFullYear().toString());
  return {
    id: s.id,
    kind,
    label,
    sublabel: sub.join(' · ') || undefined,
    earnedAt: s.earnedAt,
    locked: s.isRevoked,
    verification: deriveStampVerification(s.sourceType, s.verificationLevel),
    universalArtworkUrl: s.definition?.universalArtworkUrl ?? undefined,
    city: s.city ?? null,
  };
}

export function mapDefinition(d: any): StampDefinition | null {
  if (!d) return null;
  return {
    slug:        d.slug ?? '',
    name:        d.name ?? '',
    iconUrl:     d.icon_url ?? d.iconUrl ?? null,
    universalArtworkUrl: d.universal_artwork_url ?? d.universalArtworkUrl ?? null,
    rarity:      d.rarity ?? 'common',
    stampType:   d.stamp_type ?? d.stampType ?? 'city',
    category:    d.category ?? null,
    description: d.description ?? null,
  };
}

export function mapStamp(r: any): PassportStampNew {
  const def = mapDefinition(r.definition ?? r.stamp_definitions ?? null);
  return {
    id:                 r.id,
    stampDefinitionId:  r.stamp_definition_id ?? r.stampDefinitionId ?? null,
    definition:         def,
    stampType:          def?.stampType ?? r.stamp_type ?? r.stampType ?? 'city',
    country:            r.country ?? null,
    city:               r.city ?? null,
    neighborhood:       r.neighborhood ?? null,
    titleOverride:      r.title_override ?? r.titleOverride ?? null,
    placeId:            r.place_id ?? r.placeId ?? null,
    planId:             r.plan_id ?? r.planId ?? null,
    tripId:             r.trip_id ?? r.tripId ?? null,
    sourceType:         r.source_type ?? r.sourceType ?? 'system',
    verificationLevel:  r.verification_level ?? r.verificationLevel ?? 'unverified',
    visibility:         r.visibility ?? 'public',
    displayOnPassport:  r.display_on_passport ?? r.displayOnPassport ?? true,
    isRevoked:          r.is_revoked ?? r.isRevoked ?? false,
    earnedAt:           r.earned_at ?? r.earnedAt ?? new Date().toISOString(),
    createdAt:          r.created_at ?? r.createdAt ?? new Date().toISOString(),
    catalogId:          r.catalog_id ?? r.catalogId ?? null,
    // Active artwork URL sourced from joined catalog row or pre-fetched batch map
    activeArtworkUrl:   r.activeArtworkUrl ?? r.active_artwork_url ?? r.universal_stamp_catalog?.active_artwork_url ?? null,
  };
}
