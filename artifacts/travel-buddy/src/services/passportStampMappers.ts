/**
 * Pure API-row -> model mappers for passport stamps.
 * Kept free of side-effectful imports (supabase, fetch) so they can be
 * unit-tested in Node directly.
 */
import type { StampDefinition, PassportStampNew } from './passportStamps';

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
