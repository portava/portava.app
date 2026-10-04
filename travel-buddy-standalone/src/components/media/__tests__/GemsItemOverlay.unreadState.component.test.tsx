/**
 * GemsItemOverlay — a count or a follow state the server could not read
 * (census-media §47).
 *
 * The gems feed answers an unread save / comment / stamp count as `null` and an
 * unread follow graph as `isFollowingCreator: null`. The overlay drew
 * `String(count || '')` (unread looked like a measured 0), seeded the Stamp
 * with `likeCount ?? 0`, and showed "Follow" whenever `!isFollowingCreator`,
 * so a viewer who already follows the creator was told they did not.
 * Pinned here:
 *
 *   1. an unread comment, save or stamp count draws the "—" mark;
 *   2. an unread follow state shows no Follow button (it asserts nothing),
 *      while a measured "not following" still shows it and a measured
 *      "following" still hides it;
 *   3. measured counts are unchanged.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

// NOTE: intentional exhaustive stub — insets are not under test.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// NOTE: intentional exhaustive stub — no layover session is under test.
jest.mock('../../../context/LayoverSessionContext.tsx', () => ({
  useLayoverSessionContext: () => ({ session: null }),
}));

// NOTE: intentional exhaustive stub — the scrim is decoration only.
jest.mock('expo-linear-gradient', () => {
  const { View } = require('react-native');
  return { LinearGradient: (props: object) => <View {...props} /> };
});

// NOTE: intentional exhaustive stub — the quick-action chips are not under test.
jest.mock('../../PlaceQuickActions.tsx', () => ({
  PlaceQuickActions: () => null,
}));

import { GemsItemOverlay } from '../GemsItemOverlay.tsx';
import type { GemsFeedItem } from '../../../hooks/useGemsFeed.ts';
import { UNREAD_COUNT_MARK } from '../../../lib/unreadCount.ts';

function makeGem(
  stats: Partial<GemsFeedItem['stats']> = {},
  viewerState: Partial<GemsFeedItem['viewerState']> = {},
): GemsFeedItem {
  return {
    id: 'gem-1',
    sourceType: 'gem',
    gemId: 'gem-1-gem',
    caption: 'The back staircase.',
    tags: [],
    createdAt: '2026-09-15T09:00:00.000Z',
    creator: {
      id: 'creator-1', username: 'maya.okafor', displayName: 'Maya Okafor', avatarUrl: null,
      isPrivate: false, isVerified: false, followersCount: null, followingCount: null, bio: null,
    },
    media: [{ id: 'm-1', type: 'image', url: 'https://example.com/a.jpg', thumbnailUrl: null, provenanceLabel: null }],
    stats: { viewCount: 5400, likeCount: 212, saveCount: 64, commentCount: 18, ...stats },
    location: null,
    viewerState: { hasLiked: false, hasSaved: false, isFollowingCreator: false, hasFollowRequestPending: false, ...viewerState },
  };
}

async function renderGem(item: GemsFeedItem) {
  await render(
    <GemsItemOverlay item={item} onSave={() => {}} onShare={() => {}} onMore={() => {}} onComment={() => {}} onFollowCreator={() => {}} />,
  );
}

describe('GemsItemOverlay — unread counts', () => {
  it('unread save, comment and stamp counts each draw the mark', async () => {
    await renderGem(makeGem({ likeCount: null, saveCount: null, commentCount: null }));
    expect(screen.getAllByText(UNREAD_COUNT_MARK)).toHaveLength(3);
    expect(screen.queryByText('0')).toBeNull();
  });

  it('measured counts are unchanged', async () => {
    await renderGem(makeGem());
    expect(screen.queryByText(UNREAD_COUNT_MARK)).toBeNull();
    expect(screen.getByText('18')).toBeTruthy();
    expect(screen.getByText('64')).toBeTruthy();
    expect(screen.getByText('212')).toBeTruthy();
  });

  it('a measured 0 draws nothing (unchanged)', async () => {
    await renderGem(makeGem({ likeCount: 0, saveCount: 0, commentCount: 0 }));
    expect(screen.queryByText(UNREAD_COUNT_MARK)).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
  });
});

describe('GemsItemOverlay — an unread follow state', () => {
  it('shows no Follow button when the follow graph could not be read', async () => {
    await renderGem(makeGem({}, { isFollowingCreator: null }));
    expect(screen.queryByLabelText('Follow Maya Okafor')).toBeNull();
  });

  it('still shows Follow for a measured "not following"', async () => {
    await renderGem(makeGem({}, { isFollowingCreator: false }));
    expect(screen.getByLabelText('Follow Maya Okafor')).toBeTruthy();
  });

  it('still hides Follow for a measured "following"', async () => {
    await renderGem(makeGem({}, { isFollowingCreator: true }));
    expect(screen.queryByLabelText('Follow Maya Okafor')).toBeNull();
  });
});
