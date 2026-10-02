/**
 * features/media — mediaMapCover: the image a Media Map cluster is drawn with
 * (spec §39 "Map thumbnails"; census-media §24 and §29, MD300).
 *
 * `GET /media/map` sends each cluster ONE cover the server chose after every
 * gate it applies to this viewer (`mediaProjection.mapMediaMapWithCovers`), and
 * the `map_thumbnails` cache stores exactly that choice (`mediaOffline.
 * mediaMapOffline`). This module only says which of the cover's references the
 * screen draws. It never picks a cover of its own, and it never draws a video
 * file as a thumbnail: a video's `url` is the video itself, so a video is drawn
 * only by its server-derived poster (`thumbnailUrl`). A cluster with no cover,
 * or with a cover that carries no image, is drawn as it was before covers.
 *
 * The reference is handed to `CachedImage`, which signs it (and, offline,
 * serves the cache's own copy); nothing here builds or signs a URL.
 *
 * Pure and framework-free — safe for node:test.
 */
import type { MediaMapCluster } from './mediaMapStore.ts';

function ref(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** The image reference to draw for this cluster's cover, or null to draw it without one. */
export function clusterCoverImage(cluster: MediaMapCluster): string | null {
  const cover: unknown = (cluster as { cover?: unknown }).cover;
  if (!cover || typeof cover !== 'object' || Array.isArray(cover)) return null;
  const m = cover as { id?: unknown; mediaType?: unknown; url?: unknown; thumbnailUrl?: unknown };
  if (!ref(m.id)) return null;
  const thumb = ref(m.thumbnailUrl);
  if (m.mediaType === 'video') return thumb;
  return thumb ?? ref(m.url);
}
