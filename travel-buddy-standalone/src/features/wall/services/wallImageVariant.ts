/**
 * wallImageVariant — which stored image a Wall frame draws, and therefore which
 * one the prefetch warms (Wall spec §33 "Images: responsive variants +
 * CDN/cache", §31 "prefetch media for the next small number of visible objects").
 *
 * The server stores up to three objects per `post_media` image and reports each
 * one it actually has (existence is reported, never inferred — migration 0208):
 *
 *   thumbnailUrl   longest edge ≤ WALL_THUMBNAIL_DIM (400)   post_media.thumbnail_url
 *   feedUrl        longest edge ≤ WALL_FEED_DIM (1500)       post_media.feed_url (0208)
 *   url            the original (≤ 2048 after processing)    post_media.public_url
 *
 * `pickWallImageRef` chooses the SMALLEST stored variant that covers the frame's
 * rendered pixel width. When that variant is absent it takes the next larger one
 * that is present; when nothing at or above the target is present it takes the
 * largest smaller one. A video yields its still poster only — never the payload,
 * which is not an image and must never be warmed (§11/§31).
 *
 * ONE FUNCTION, TWO CALLERS. `WallImage` (components/objects/wallItemShared.tsx)
 * draws what this returns, and `prefetchWallMedia` (services/wallPrefetch.ts)
 * warms what this returns, for the same `targetPx`. They used to disagree: the
 * renderer drew `thumbnailUrl ?? url` while the prefetch warmed `url ??
 * thumbnailUrl`, so for every image with a thumbnail the warm-up fetched an
 * object the Wall never drew.
 *
 * The thresholds compare the target against each variant's LONGEST-EDGE cap,
 * which is an upper bound on its width — a portrait variant is narrower than its
 * cap. Pure: no React Native import, so node:test can run it directly.
 */

import type { DisplayMedia, WallObjectType, WallProjection } from '../types/wallProjection.ts';

/** Server `THUMBNAIL_DIM` (artifacts/api-server/src/lib/mediaProcessing.ts). Pinned equal by test. */
export const WALL_THUMBNAIL_DIM = 400;

/** Server `FEED_DIM` (artifacts/api-server/src/lib/mediaProcessing.ts). Pinned equal by test. */
export const WALL_FEED_DIM = 1500;

/**
 * The pixel width a Wall image frame is drawn at, from the window: every Wall
 * frame is at most the window's width, so window width × device scale is a
 * deterministic upper bound that the renderer (`useWindowDimensions()`) and the
 * prefetch (`Dimensions.get('window')`) compute identically, with no layout pass.
 * A non-finite or non-positive input yields 0 (the smallest variant).
 */
export function wallImageTargetPx(window: { width: number; scale: number }): number {
  const w = Number(window?.width);
  const s = Number(window?.scale);
  if (!Number.isFinite(w) || !Number.isFinite(s) || w <= 0 || s <= 0) return 0;
  return Math.ceil(w * s);
}

function present(ref: string | null | undefined): string | null {
  return typeof ref === 'string' && ref.trim().length > 0 ? ref : null;
}

/**
 * The stored image a frame `targetPx` wide should draw, or null when there is
 * nothing drawable (no media, still processing, or a video with no poster).
 */
export function pickWallImageRef(
  media: DisplayMedia | null | undefined,
  targetPx: number,
): string | null {
  if (!media || media.processing) return null;
  // Video: the still poster only, never the payload (§11/§31).
  if (media.kind === 'video') return present(media.thumbnailUrl);

  const target = Number.isFinite(targetPx) && targetPx > 0 ? targetPx : 0;
  // Smallest first. The original has no cap: it is the largest thing stored.
  const tiers: Array<{ cap: number; ref: string | null }> = [
    { cap: WALL_THUMBNAIL_DIM, ref: present(media.thumbnailUrl) },
    { cap: WALL_FEED_DIM, ref: present(media.feedUrl) },
    { cap: Number.POSITIVE_INFINITY, ref: present(media.url) },
  ];
  const covering = tiers.findIndex((t) => target <= t.cap);
  // The covering variant, else the next larger one that is present…
  for (let i = covering; i < tiers.length; i++) {
    if (tiers[i].ref) return tiers[i].ref;
  }
  // …else the largest smaller one that is present.
  for (let i = covering - 1; i >= 0; i--) {
    if (tiers[i].ref) return tiers[i].ref;
  }
  return null;
}

/**
 * The object types whose renderer draws an image frame (`WallImage`, fed
 * `projection.media?.[0]`): Post, video (its poster), Postcard, Shared Moment
 * and Discovery. A social update and a contextual opportunity draw no media,
 * even when the projection carries some (a Buddy opportunity carries the Buddy's
 * cover photo). Pinned against the real renderers by
 * components/objects/__tests__/WallImage.variant.component.test.tsx.
 */
export const WALL_IMAGE_OBJECT_TYPES: ReadonlySet<WallObjectType> = new Set<WallObjectType>([
  'social_post',
  'video',
  'postcard',
  'shared_moment',
  'discovery',
]);

/** The one media item the Wall draws for a projection, or undefined when it draws none. */
export function drawnWallMediaOf(projection: WallProjection): DisplayMedia | undefined {
  return WALL_IMAGE_OBJECT_TYPES.has(projection.objectType) ? projection.media?.[0] : undefined;
}
