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
 * `pickWallImageRef` chooses the SMALLEST stored variant whose WIDTH covers the
 * frame's rendered pixel width. When that variant is absent it takes the next
 * wider one that is present; when nothing present is wide enough it takes the
 * widest one present. A video yields its still poster only — never the payload,
 * which is not an image and must never be warmed (§11/§31).
 *
 * ASPECT-AWARE WHEN IT CAN BE. A variant capped at DIM on its LONGEST edge is
 * `w × min(1, DIM / max(w, h))` wide, so a portrait variant is narrower than its
 * cap: a 9:16 original's feed variant is 844 px wide, not 1500. When the
 * original's `width` and `height` are known each variant's width is computed from
 * them; when either is unknown the cap itself stands in for the width (the
 * longest-edge rule, an upper bound) and the original counts as wide enough.
 *
 * ONE FUNCTION, TWO CALLERS. `WallImage` (components/objects/wallItemShared.tsx)
 * draws what this returns, and `prefetchWallMedia` (services/wallPrefetch.ts)
 * warms what this returns, for the same `targetPx`. They used to disagree: the
 * renderer drew `thumbnailUrl ?? url` while the prefetch warmed `url ??
 * thumbnailUrl`, so for every image with a thumbnail the warm-up fetched an
 * object the Wall never drew.
 *
 * Pure: no React Native import, so node:test can run it directly.
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

function positive(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * The rendered WIDTH of a variant capped at `cap` on its longest edge, from the
 * original's dimensions: `w × min(1, cap / max(w, h))`. With either dimension
 * unknown, the cap itself (the longest-edge rule). The original has no cap.
 */
export function wallVariantWidth(
  cap: number,
  width: number | null | undefined,
  height: number | null | undefined,
): number {
  if (!positive(width) || !positive(height)) return cap; // unknown shape: the longest-edge rule
  return width * Math.min(1, cap / Math.max(width, height));
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
  // Smallest first. Widths never decrease along the list, and on a tie the
  // earlier (smaller-capped) variant wins: the same pixels for fewer bytes.
  const tiers = [
    { ref: present(media.thumbnailUrl), width: wallVariantWidth(WALL_THUMBNAIL_DIM, media.width, media.height) },
    { ref: present(media.feedUrl), width: wallVariantWidth(WALL_FEED_DIM, media.width, media.height) },
    { ref: present(media.url), width: wallVariantWidth(Number.POSITIVE_INFINITY, media.width, media.height) },
  ].filter((t): t is { ref: string; width: number } => t.ref !== null);
  if (tiers.length === 0) return null;
  // The narrowest stored variant that is wide enough…
  const covering = tiers.find((t) => t.width >= target);
  if (covering) return covering.ref;
  // …else the widest stored variant (the first of equals).
  let widest = tiers[0];
  for (const t of tiers) if (t.width > widest.width) widest = t;
  return widest.ref;
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
