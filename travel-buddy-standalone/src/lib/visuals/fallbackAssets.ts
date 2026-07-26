/**
 * Bundled static fallback assets — one WebP per category.
 *
 * Metro bundler requires static `require()` calls (not dynamic strings) so
 * every asset must be listed explicitly here. The `fallbackUriFor(slug)`
 * helper is the single entry point used by PlaceCard, EventCard, and any other
 * surface that calls resolveHeaderImage with a `fallbackUrlFor` callback.
 *
 * Slugs must exactly match the `fallbackSlug()` return values in
 * resolveHeaderImage.ts and categoryFallbackProvider.ts.
 */
import { Image } from 'react-native';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ASSET_MAP: Record<string, number> = {
  'generic-place':      require('../../../assets/fallbacks/generic-place.webp'),
  'generic-event':      require('../../../assets/fallbacks/generic-event.webp'),
  restaurant:           require('../../../assets/fallbacks/restaurant.webp'),
  cafe:                 require('../../../assets/fallbacks/cafe.webp'),
  nightclub:            require('../../../assets/fallbacks/nightclub.webp'),
  'cocktail-bar':       require('../../../assets/fallbacks/cocktail-bar.webp'),
  hotel:                require('../../../assets/fallbacks/hotel.webp'),
  beach:                require('../../../assets/fallbacks/beach.webp'),
  landmark:             require('../../../assets/fallbacks/landmark.webp'),
  attraction:           require('../../../assets/fallbacks/attraction.webp'),
  shopping:             require('../../../assets/fallbacks/shopping.webp'),
  wellness:             require('../../../assets/fallbacks/wellness.webp'),
  'outdoor-adventure':  require('../../../assets/fallbacks/outdoor-adventure.webp'),
  festival:             require('../../../assets/fallbacks/festival.webp'),
  meetup:               require('../../../assets/fallbacks/meetup.webp'),
  concert:              require('../../../assets/fallbacks/concert.webp'),
  'food-event':         require('../../../assets/fallbacks/food-event.webp'),
  'sports-event':       require('../../../assets/fallbacks/sports-event.webp'),
};

/**
 * Resolve a bundled fallback WebP URI for the given slug.
 *
 * Returns a `file://` or `asset://` URI that can be passed directly to an
 * Image `source` prop or as a URL string to DisplayMediaImage.
 *
 * Returns `null` only when the slug is unrecognised (should not happen if
 * `fallbackSlug()` in resolveHeaderImage.ts is kept in sync).
 */
export function fallbackUriFor(slug: string): string | null {
  const assetId = ASSET_MAP[slug];
  if (assetId == null) return null;
  try {
    return Image.resolveAssetSource(assetId).uri;
  } catch {
    return null;
  }
}
