/**
 * useEntityHeaderImage — returns the best available image URL for any entity
 * type (trip, event, place, hidden_gem) following the source-priority chain:
 *
 *   user_upload → official → provider → portava_media → ai_generated → category_fallback
 *
 * Always resolves to a non-null URL — the bundled category fallback asset
 * guarantees every card has an image. Returns null only when even the fallback
 * asset is missing (should never happen in a healthy build).
 *
 * Usage:
 *   const imageUrl = useEntityHeaderImage({ url: event.coverUrl, entityType: 'event', category: event.category });
 */
import { useMemo } from 'react';
import { resolveHeaderImage } from '../lib/visuals/resolveHeaderImage.ts';
import type { HeaderCandidate, HeaderImageSource } from '../lib/visuals/resolveHeaderImage.ts';
import { fallbackUriFor } from '../lib/visuals/fallbackAssets.ts';

export interface EntityHeaderImageInput {
  /** Primary image URL from the entity (coverUrl, imageUrl, headerImageUrl, etc.). */
  url?: string | null;
  /** Source classification for the primary URL. Defaults to 'provider'. */
  source?: HeaderImageSource;
  /**
   * Additional candidates already resolved elsewhere (e.g. an FSQ photo).
   * They are merged with the primary URL before priority-sorting.
   */
  extraCandidates?: HeaderCandidate[];
  /** Entity type passed to fallbackSlug ('event' → generic-event, else generic-place). */
  entityType?: string;
  /** Category string used to select a category-keyed fallback asset. */
  category?: string | null;
}

export function useEntityHeaderImage({
  url,
  source = 'provider',
  extraCandidates,
  entityType,
  category,
}: EntityHeaderImageInput): string | null {
  // extraCandidates is memoised by reference in callers — no deep comparison needed.
  return useMemo(() => {
    const candidates: HeaderCandidate[] = [];
    if (url) candidates.push({ url, source });
    if (extraCandidates) {
      for (const c of extraCandidates) {
        if (c.url) candidates.push(c);
      }
    }
    const resolved = resolveHeaderImage(candidates, {
      entityType,
      category,
      fallbackUrlFor: fallbackUriFor,
    });
    return resolved?.url ?? null;
  }, [url, source, extraCandidates, entityType, category]);
}
