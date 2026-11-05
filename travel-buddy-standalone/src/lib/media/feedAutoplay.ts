/**
 * feedAutoplay — which Pulse feed card plays its video by itself.
 *
 * 2026-11-04, the owner: "videos should play on auto". Feed cards drew a still
 * poster with a play triangle, and nothing moved until the post was opened.
 * Now the first post card that is mostly on screen and shows a video plays it,
 * muted and looping, in place of the poster (components/media/
 * FeedAutoplayVideo.tsx); every other card keeps its poster, so one decoder
 * runs at a time however fast the feed is scrolled.
 *
 * Pure — no React Native imports — so node:test can load it.
 */
import { isVideoRef } from './videoPosterRef.ts';

/** The slice of a PulseFeedItem this needs. */
export interface FeedAutoplayItem {
  id: string;
  type: string;
  mediaUrl?: string | null;
  media?: ReadonlyArray<{ url?: string | null; media_type?: string | null }> | null;
}

/** How much of a card must be on screen before it plays. */
export const FEED_AUTOPLAY_VISIBLE_PERCENT = 60;

/**
 * The video a post card shows, or null. The card's own rule (PulseFeedCard's
 * PostCard): its first media item is typed video, or, when it has no media item
 * at all, its media URL names a video file (the #776 camera-video case). Only
 * post cards play; every other card type has no video.
 */
export function pulseCardVideoRef(item: FeedAutoplayItem): string | null {
  if (item.type !== 'post') return null;
  const first = item.media?.[0];
  const ref = first?.url ?? item.mediaUrl ?? null;
  if (typeof ref !== 'string' || ref.length === 0) return null;
  if (first) return first.media_type === 'video' ? ref : null;
  return isVideoRef(ref) ? ref : null;
}

/**
 * The id of the card that should play: the first viewable card (in list order)
 * that shows a video, or null when none on screen does. `viewable` is a
 * FlatList onViewableItemsChanged `viewableItems` array.
 */
export function firstAutoplayCardId(
  viewable: ReadonlyArray<{ item: unknown; isViewable: boolean; index?: number | null }>,
): string | null {
  const ordered = [...viewable].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  for (const token of ordered) {
    if (!token.isViewable) continue;
    const item = token.item as FeedAutoplayItem | null | undefined;
    if (item && typeof item.id === 'string' && pulseCardVideoRef(item) !== null) return item.id;
  }
  return null;
}
