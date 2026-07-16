/**
 * Pure adapter: converts API PostRow objects into PulseFeedItem shapes for the
 * Pulse Wall. Lives outside the screen component so node:test can cover it —
 * a dropped field here (e.g. structured media with stamp_overlay) silently
 * kills downstream rendering, which is exactly what the regression tests catch.
 */
import type { PostRow } from '../services/posts.ts';
import type { PulseFeedItem } from '../types/models.ts';

/** Convert a real PostRow from the API into a PulseFeedItem for the Pulse Wall. */
export function postRowToFeedItem(p: PostRow): PulseFeedItem {
  return {
    id: p.id,
    type: 'post',
    city: p.locationCity ?? 'Traveler Post',
    author: {
      id: p.authorId,
      name: p.author?.name ?? 'Traveler',
      avatarUrl: p.author?.avatarUrl ?? '',
    },
    createdAt: p.createdAt,
    timeAgo: timeAgo(p.createdAt),
    tags: [categoryToStamp(p.category)],
    categoryFallback: !p.category,
    mediaUrl: p.mediaUrls[0],
    // Structured media passthrough — carries thumbnail/video info AND the
    // stamp_overlay jsonb that PulseFeedCard renders via MediaStampOverlay.
    media: p.media,
    caption: p.content,
    source: 'user',
    neighborhood: p.locationName ?? undefined,
    visibility: p.visibility === 'trip_only' ? 'private' : (p.visibility as 'public' | 'private'),
    likeCount: p.likeCount,
    commentCount: p.commentCount,
    likedByMe: p.likedByMe,
    canLike: p.canLike,
    canComment: p.canComment,
    canShare: p.canShare,
    spanTags: p.tags,
    spanHashtags: p.hashtagUsages,
  };
}

/** Map a PostCategory slug to a human-readable stamp label. Falls back to 'Travel'. */
export function categoryToStamp(cat: string | null | undefined): string {
  if (!cat) return 'Travel';
  return cat.charAt(0).toUpperCase() + cat.slice(1);
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
