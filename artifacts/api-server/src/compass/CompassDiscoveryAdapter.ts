/**
 * CompassDiscoveryAdapter — maps DiscoveryPlace objects to CompassItems
 * so they can be run through the Compass pipeline when
 * COMPASS_V1_RULE_BASED_ENABLED is true.
 *
 * Field mapping:
 *   id          → CompassItem.id
 *   name        → CompassItem.contentBody  (used in scoring display)
 *   category    → CompassItem.interestTags
 *   distanceKm  → CompassItem.distanceKm   (carried through)
 *   rating      → CompassItem.qualityScore (normalised 0–10)
 *   isOpenNow   → CompassItem.isHidden     (false when definitely closed)
 *   type        → "suggestion"             (discovery places are suggestions)
 *
 * Privacy: no exact coords forwarded — lat/lng from OSM are public data
 * but we map them to the privacy-safe publicLat/publicLng fields so the
 * Privacy Guard can apply its labelling logic.
 */

export interface DiscoveryPlaceLike {
  id:           string;
  name:         string;
  category:     string;
  type:         string | null;
  distanceKm:   number | null;
  lat:          number | null;
  lng:          number | null;
  tags:         string[];
  rating:       number | null;
  isOpenNow:    boolean | null;
  openingHours: string | null;
}

import type { CompassItem } from "./types.js";

export function discoveryPlaceToCompassItem(place: DiscoveryPlaceLike): CompassItem {
  const openNow = place.isOpenNow;
  return {
    id:           `discovery:${place.id}`,
    type:         "suggestion",
    contentBody:  place.name,
    // OSM venue type as a suggestion subtype tag
    interestTags: [place.category, ...(place.tags ?? [])].filter(Boolean),
    // OSM coordinates are public — expose as public (non-exact) coords
    publicLat:    place.lat ?? undefined,
    publicLng:    place.lng ?? undefined,
    // Hide items that are definitely closed
    isHidden:     openNow === false,
    // Quality from rating (normalised 0–10)
    qualityScore: place.rating !== null ? Math.min(10, place.rating * 2) : 5,
    distanceKm:   place.distanceKm ?? undefined,
  };
}

export function compassItemToDiscoveryPlace(item: CompassItem): DiscoveryPlaceLike {
  return {
    id:           item.id.replace(/^discovery:/, ""),
    name:         String(item.contentBody ?? ""),
    category:     (item.interestTags ?? [])[0] ?? "places",
    type:         (item.interestTags ?? [])[1] ?? null,
    distanceKm:   (item.distanceKm as number | null) ?? null,
    lat:          (item.publicLat as number | null) ?? null,
    lng:          (item.publicLng as number | null) ?? null,
    tags:         (item.interestTags ?? []).slice(1),
    rating:       item.qualityScore !== undefined ? Math.min(5, item.qualityScore / 2) : null,
    isOpenNow:    item.isHidden === false ? true : item.isHidden === true ? false : null,
    openingHours: null,
  };
}
