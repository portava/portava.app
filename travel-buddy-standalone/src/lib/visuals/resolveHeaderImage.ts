/**
 * Client-side header image resolver — mirrors the server priority ladder
 * (api-server/src/lib/visuals/priority.ts). ONE resolver for every card and detail
 * screen so no component re-implements image priority or guesses which URL to show.
 *
 * Priority (highest first): user_upload → official → provider → portava_media →
 * ai_generated → category_fallback.
 *
 * Pure + dependency-free so it can be unit tested and shared across screens.
 */

export type HeaderImageSource =
  | 'user_upload'
  | 'official'
  | 'provider'
  | 'portava_media'
  | 'ai_generated'
  | 'category_fallback';

const RANK: Record<HeaderImageSource, number> = {
  user_upload: 6,
  official: 5,
  provider: 4,
  portava_media: 3,
  ai_generated: 2,
  category_fallback: 1,
};

export function sourceRank(s: HeaderImageSource): number {
  return RANK[s] ?? 0;
}

export interface HeaderCandidate {
  url: string | null | undefined;
  source: HeaderImageSource;
  attribution?: string;
  generatedVisualId?: string;
  /** Nine-category source type from the accuracy pipeline. */
  imageSourceType?: string | null;
  /** When true the UI must show a disclaimer. */
  disclaimerRequired?: boolean | null;
  /** Disclaimer copy to display. */
  disclaimerText?: string | null;
}

export interface ResolvedHeaderImage {
  url: string;
  source: HeaderImageSource;
  attribution?: string;
  generatedVisualId?: string;
  /** true for AI place representations → drives the "AI-generated representation" label. */
  isRepresentation: boolean;
  /** Nine-category source classification from the accuracy pipeline (passed through from candidate). */
  imageSourceType?: string | null;
  /** When true the UI must show a disclaimer alongside this image. */
  disclaimerRequired?: boolean | null;
  /** Disclaimer copy to display (passed through from candidate). */
  disclaimerText?: string | null;
}

/** Category → static fallback slug (keep in sync with the server fallback map). */
const CATEGORY_FALLBACK: Record<string, string> = {
  restaurant: 'restaurant',
  cafe: 'cafe',
  café: 'cafe',
  nightclub: 'nightclub',
  bar: 'cocktail-bar',
  'cocktail bar': 'cocktail-bar',
  hotel: 'hotel',
  beach: 'beach',
  landmark: 'landmark',
  attraction: 'attraction',
  'tourist attraction': 'attraction',
  shopping: 'shopping',
  wellness: 'wellness',
  outdoor: 'outdoor-adventure',
  'outdoor adventure': 'outdoor-adventure',
  festival: 'festival',
  meetup: 'meetup',
  concert: 'concert',
  'food event': 'food-event',
  'sports event': 'sports-event',
};

/** Local bundled fallback assets. Point this at your asset require map if needed. */
export function fallbackSlug(category: string | null | undefined, entityType: string): string {
  const key = (category ?? '').trim().toLowerCase();
  if (key && CATEGORY_FALLBACK[key]) return CATEGORY_FALLBACK[key];
  return entityType === 'event' ? 'generic-event' : 'generic-place';
}

/**
 * Resolve the winning header image from all candidates, appending a category
 * fallback so a card is NEVER imageless. `fallbackUrlFor` lets the caller supply a
 * bundled-asset URL (e.g. from a require() map) for the resolved slug.
 */
export function resolveHeaderImage(
  candidates: HeaderCandidate[],
  opts: {
    entityType?: string;
    category?: string | null;
    fallbackUrlFor?: (slug: string) => string | null;
  } = {},
): ResolvedHeaderImage | null {
  const usable = candidates.filter((c) => typeof c.url === 'string' && c.url.trim() !== '');

  // Always have a fallback candidate available at the bottom of the ladder.
  const slug = fallbackSlug(opts.category, opts.entityType ?? '');
  const fbUrl = opts.fallbackUrlFor?.(slug) ?? null;
  if (fbUrl) usable.push({ url: fbUrl, source: 'category_fallback' });

  if (usable.length === 0) return null;
  usable.sort((a, b) => sourceRank(b.source) - sourceRank(a.source));
  const win = usable[0];
  return {
    url: win.url as string,
    source: win.source,
    attribution: win.attribution,
    generatedVisualId: win.generatedVisualId,
    isRepresentation: win.source === 'ai_generated' && opts.entityType === 'place',
    imageSourceType: win.imageSourceType ?? null,
    disclaimerRequired: win.disclaimerRequired ?? null,
    disclaimerText: win.disclaimerText ?? null,
  };
}

/** Convenience: build candidates from a normalized entity with header fields. */
export function candidatesFromEntity(entity: {
  userUploadUrl?: string | null;
  officialUrl?: string | null;
  providerUrl?: string | null;
  portavaMediaUrl?: string | null;
  headerImageUrl?: string | null;      // ai_generated (server-applied)
  headerImageSource?: HeaderImageSource | null;
  headerImageGeneratedId?: string | null;
  headerImageAttribution?: string | null;
}): HeaderCandidate[] {
  const out: HeaderCandidate[] = [];
  if (entity.userUploadUrl) out.push({ url: entity.userUploadUrl, source: 'user_upload' });
  if (entity.officialUrl) out.push({ url: entity.officialUrl, source: 'official' });
  if (entity.providerUrl) out.push({ url: entity.providerUrl, source: 'provider' });
  if (entity.portavaMediaUrl) out.push({ url: entity.portavaMediaUrl, source: 'portava_media' });
  if (entity.headerImageUrl && entity.headerImageSource === 'ai_generated') {
    out.push({
      url: entity.headerImageUrl,
      source: 'ai_generated',
      attribution: entity.headerImageAttribution ?? undefined,
      generatedVisualId: entity.headerImageGeneratedId ?? undefined,
    });
  }
  return out;
}
