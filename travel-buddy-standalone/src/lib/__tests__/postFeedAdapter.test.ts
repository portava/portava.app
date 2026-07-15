/**
 * Regression tests for the Pulse Wall adapter. The critical contract: the
 * structured `media` array (which carries stamp_overlay jsonb, thumbnails,
 * and video type) must survive the PostRow -> PulseFeedItem transformation.
 * A silent drop here renders every stamp overlay invisible in the feed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryToStamp, postRowToFeedItem, timeAgo } from '../postFeedAdapter.ts';
import type { PostRow } from '../../services/posts.ts';

function basePost(overrides: Record<string, unknown> = {}): PostRow {
  return {
    id: 'post-1',
    authorId: 'user-1',
    tripId: null,
    content: 'Sunset over Shibuya',
    mediaUrls: ['https://cdn.example.com/a.jpg'],
    visibility: 'public',
    status: 'published',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    likeCount: 3,
    commentCount: 1,
    likedByMe: false,
    canLike: true,
    canComment: true,
    canShare: true,
    category: 'food',
    locationCity: 'Tokyo',
    locationName: 'Shibuya',
    ...overrides,
  } as unknown as PostRow;
}

test('structured media (incl. stamp_overlay) survives the adapter verbatim', () => {
  const overlayBlob = {
    stampDefinitionId: '50000000-0000-0000-0000-000000000d01',
    label: 'Tokyo',
    style: 'white',
    x: 0.78,
    y: 0.8,
    scale: 0.28,
  };
  const media = [
    {
      id: 'm1',
      url: 'https://cdn.example.com/a.jpg',
      thumbnail_url: 'https://cdn.example.com/a_thumb.jpg',
      media_type: 'image',
      width: 1200,
      height: 1500,
      sort_order: 0,
      processing_status: 'ready',
      stamp_overlay: overlayBlob,
    },
  ];
  const item = postRowToFeedItem(basePost({ media }));
  assert.ok(item.media, 'media array must be passed through');
  assert.equal(item.media?.length, 1);
  // Same reference — no lossy re-mapping of the raw jsonb.
  assert.equal(item.media?.[0]?.stamp_overlay, overlayBlob);
  assert.equal(item.media?.[0]?.media_type, 'image');
  assert.equal(item.mediaUrl, 'https://cdn.example.com/a.jpg');
});

test('legacy posts without structured media keep working (media stays undefined)', () => {
  const item = postRowToFeedItem(basePost());
  assert.equal(item.media, undefined);
  assert.equal(item.mediaUrl, 'https://cdn.example.com/a.jpg');
});

test('core feed fields map through (caption, city, visibility)', () => {
  const item = postRowToFeedItem(basePost({ visibility: 'trip_only' }));
  assert.equal(item.caption, 'Sunset over Shibuya');
  assert.equal(item.city, 'Tokyo');
  assert.equal(item.visibility, 'private'); // trip_only maps to private
  assert.equal(item.type, 'post');
});

test('categoryToStamp capitalizes and falls back to Travel', () => {
  assert.equal(categoryToStamp('food'), 'Food');
  assert.equal(categoryToStamp(null), 'Travel');
  assert.equal(categoryToStamp(undefined), 'Travel');
});

test('timeAgo buckets recent timestamps', () => {
  assert.equal(timeAgo(new Date().toISOString()), 'just now');
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  assert.equal(timeAgo(fiveMinAgo), '5m ago');
});
