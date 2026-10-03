/**
 * mapServerFeedItem — the Watch mapper keeps an unread count unread
 * (census-media §47).
 *
 * The server answers a count it could not read as `null`. The mapper turned an
 * unread `stampItCount` into 0 (`?? 0`), the same lie the server stopped
 * telling. Pinned here: every unread count and flag reaches the UI item as
 * `null`; measured values pass through unchanged; an ABSENT stampItCount (an
 * older server) is still 0, as mediaFeed.fetchItemById.test.ts pins — absent
 * is not unread.
 *
 * Run with: pnpm test:component
 */
import { mapServerFeedItem } from '../mediaFeed.ts';

type Raw = Parameters<typeof mapServerFeedItem>[0];

function raw(stats: Partial<Raw['stats']>, viewerState: Partial<Raw['viewerState']> = {}): Raw {
  return {
    id: 'p1',
    sourceType: 'post',
    caption: 'c',
    tags: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    creator: {
      id: 'u1', username: 'u', displayName: 'U', avatarUrl: null, isPrivate: false,
      isVerified: false, followersCount: null, followingCount: null, bio: null,
    },
    media: [{ id: 'm1', type: 'video', url: 'https://x/v.mp4', thumbnailUrl: null, durationSeconds: 3, width: null, height: null, sortOrder: 0 }],
    stats: { viewCount: 1, likeCount: 2, saveCount: 3, commentCount: 4, stampItCount: 5, ...stats },
    location: null,
    viewerState: { hasLiked: true, hasSaved: true, isFollowingCreator: true, hasFollowRequestPending: false, ...viewerState },
    linkedEntity: null,
  } as unknown as Raw;
}

describe('mapServerFeedItem — unread counts and flags', () => {
  it('every unread count reaches the UI item as null, never 0', () => {
    const item = mapServerFeedItem(raw({ likeCount: null, saveCount: null, commentCount: null, stampItCount: null }));
    expect(item.likeCount).toBeNull();
    expect(item.saveCount).toBeNull();
    expect(item.commentCount).toBeNull();
    expect(item.stampItCount).toBeNull();
  });

  it('every unread flag reaches the UI item as null, never false', () => {
    const item = mapServerFeedItem(raw({}, { hasLiked: null, hasSaved: null, isFollowingCreator: null }));
    expect(item.likedByMe).toBeNull();
    expect(item.savedByMe).toBeNull();
    expect(item.creator.isFollowing).toBeNull();
  });

  it('measured values pass through unchanged', () => {
    const item = mapServerFeedItem(raw({}));
    expect([item.likeCount, item.saveCount, item.commentCount, item.stampItCount]).toEqual([2, 3, 4, 5]);
    expect([item.likedByMe, item.savedByMe, item.creator.isFollowing]).toEqual([true, true, true]);
  });

  it('an absent stampItCount (an older server) is still 0; only null is unread', () => {
    const r = raw({});
    delete (r.stats as { stampItCount?: number | null }).stampItCount;
    expect(mapServerFeedItem(r).stampItCount).toBe(0);
  });
});
