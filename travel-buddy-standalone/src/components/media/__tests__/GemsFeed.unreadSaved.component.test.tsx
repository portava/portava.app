/**
 * GemsFeed — an unread saved state reaches the save store as unread
 * (census-media §47).
 *
 * The gems feed answers the viewer's saved state as `null` when its read
 * failed. GemsFeed seeded the save store with `hasSaved ?? false`, so an
 * unread state was stored as "not saved" — and seed() never replaces an id it
 * already holds. Pinned here: an unread (null) saved state is handed to seed()
 * as null (which the store does not record — useMediaSave.unreadSeed), and a
 * measured true/false as itself.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, act } from '@testing-library/react-native';

// NOTE: intentional exhaustive stub — insets are not under test.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// NOTE: intentional exhaustive stub — the viewer is not under test.
jest.mock('../../../context/SessionContext.tsx', () => ({
  useSession: () => ({ userId: 'viewer-1', isAuthed: true }),
}));

// NOTE: intentional exhaustive stub — the feed answers the two items below.
let mockItems: unknown[] = [];
jest.mock('../../../hooks/useGemsFeed.ts', () => ({
  useGemsFeed: () => ({
    items: mockItems, loading: false, loadingMore: false, error: null, errorKind: null,
    hasMore: false, refresh: () => {}, loadMore: () => {},
  }),
}));

// NOTE: intentional exhaustive stub — records what GemsFeed seeds.
const mockSeed = jest.fn();
jest.mock('../../../hooks/useMediaSave.ts', () => ({
  useMediaSave: () => ({ seed: (...a: unknown[]) => mockSeed(...a), toggleSave: async () => {}, isSaved: () => false, savedSet: {} }),
}));

// NOTE: intentional exhaustive stub — each item's overlay is pinned in its own
// suites (GemsItemOverlay.*); only the seed is under test here.
jest.mock('../GemsItemOverlay.tsx', () => ({ GemsItemOverlay: () => null }));
// NOTE: intentional exhaustive stub — the filter bar is not under test.
jest.mock('../GemsFilterBar.tsx', () => ({ GemsFilterBar: () => null }));
// NOTE: intentional exhaustive stub — the sheets are closed.
jest.mock('../MediaCommentSheet.tsx', () => ({ MediaCommentSheet: () => null }));
// NOTE: intentional exhaustive stub — the sheets are closed.
jest.mock('../MediaMoreMenu.tsx', () => ({ MediaMoreMenu: () => null }));
// NOTE: intentional exhaustive stub — the sheets are closed.
jest.mock('../WhyThisSheet.tsx', () => ({ WhyThisSheet: () => null }));

import { GemsFeed } from '../GemsFeed.tsx';

function gem(id: string, hasSaved: boolean | null) {
  return {
    id, sourceType: 'gem', gemId: `${id}-gem`, caption: '', tags: [], createdAt: '2026-10-01T00:00:00.000Z',
    creator: { id: 'c1', username: 'c', displayName: 'C', avatarUrl: null, isPrivate: false, isVerified: false, followersCount: null, followingCount: null, bio: null },
    media: [], stats: { viewCount: 0, likeCount: 0, saveCount: 0, commentCount: 0 }, location: null,
    viewerState: { hasLiked: false, hasSaved, isFollowingCreator: false, hasFollowRequestPending: false },
  };
}

it('an unread saved state is seeded as null; measured states as themselves', async () => {
  mockItems = [gem('a', null), gem('b', true), gem('c', false)];
  await render(<GemsFeed nearMeEnabled={false} />);
  await act(async () => { await Promise.resolve(); });
  expect(mockSeed).toHaveBeenCalledWith([
    { id: 'a', savedByMe: null },
    { id: 'b', savedByMe: true },
    { id: 'c', savedByMe: false },
  ]);
});
