/**
 * MediaViewer — a count or flag the server could not read (census-media §47).
 *
 * GET /media/feed/:id answers an unread comment / save / stamp count as
 * `null` and an unread saved / stamped flag as `null`. The viewer drew
 * `count > 0 ? count : nothing` (unread looked like a measured 0) and
 * defaulted `activePost?.saveCount ?? 0`. Pinned here:
 *
 *   1. an unread comment and save count draw the "—" mark, labelled
 *      "<action>, count unavailable";
 *   2. the rail's Stamp is seeded with the unread count as null (drawn as the
 *      mark by StampButton), never 0, and an unread "stamped" flag as not
 *      stamped only for the icon (initialIsStamped false), never as a count;
 *   3. an unread saved flag reaches the save store as null (which the store
 *      does not record), never false;
 *   4. measured counts draw as before.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, screen, act } from '@testing-library/react-native';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentional exhaustive stub — insets are not under test.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useLocalSearchParams: () => ({ id: 'm-1' }),
}));

// NOTE: intentional exhaustive stub — the viewer only reads userId.
jest.mock('../../../src/context/SessionContext.tsx', () => ({
  useSession: () => ({ userId: 'viewer-1', isAuthed: true }),
}));

// NOTE: intentional exhaustive stub — every flag off (the World shell's
// action rail is not drawn, as in the H8 renders).
jest.mock('../../../src/context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({ isEnabled: () => false }),
}));

// NOTE: intentional exhaustive stub — the post read resolves with the post
// each case sets in mockPost (counts and flags read or unread).
let mockPost: Record<string, unknown> = {};
jest.mock('../../../src/services/mediaFeed.ts', () => ({
  fetchMediaFeedItemById: async (id: string) => ({ ok: true, data: { id, ...mockPost } }),
}));

// NOTE: intentional exhaustive stub — records what the viewer seeds into the
// save store; the store's own handling of null is pinned in
// useMediaSave.unreadSeed.component.test.tsx.
const mockSeed = jest.fn();
jest.mock('../../../src/hooks/useMediaSave.ts', () => ({
  useMediaSave: () => ({ seed: (...a: unknown[]) => mockSeed(...a), toggleSave: () => {}, isSaved: () => false, savedSet: {} }),
}));

// NOTE: intentional exhaustive stub — share analytics not under test.
jest.mock('../../../src/services/mediaInteractions.ts', () => ({
  recordMediaShare: async () => {},
}));

// NOTE: intentional exhaustive stub — records the seed the rail's Stamp is
// given; StampButton's own drawing of an unread count is pinned in
// StampButton.unreadCount.component.test.tsx.
const mockStampProps = jest.fn();
jest.mock('../../../src/components/stamps/StampButton.tsx', () => ({
  StampButton: (props: unknown) => { mockStampProps(props); return null; },
}));
// NOTE: intentional exhaustive stub — the comment sheet is closed here.
jest.mock('../../../src/components/media/MediaCommentSheet.tsx', () => ({
  MediaCommentSheet: () => null,
}));
// NOTE: intentional exhaustive stub — the World shell's action rail is off.
jest.mock('../../../src/features/media/components/MediaActionRail.tsx', () => ({
  MediaActionRail: () => null,
}));
// NOTE: intentional exhaustive stub — the page's image is not under test.
jest.mock('../../../src/components/CachedImage', () => ({
  CachedImage: () => null,
}));
// NOTE: intentional exhaustive stub — the quick-action chips are content inside the left column.
jest.mock('../../../src/components/PlaceQuickActions.tsx', () => ({
  PlaceQuickActions: () => null,
}));

// NOTE: intentional exhaustive stub — no video plays in this test.
jest.mock('expo-av', () => {
  const { View } = require('react-native');
  return { Video: (props: object) => <View {...props} />, ResizeMode: { COVER: 'cover' } };
});

// NOTE: intentional exhaustive stub — the scrim is decoration.
jest.mock('expo-linear-gradient', () => {
  const { View } = require('react-native');
  return { LinearGradient: (props: object) => <View {...props} /> };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import MediaViewer from '../[id].tsx';
import { setViewerContext, clearViewerContext } from '../../../src/lib/viewerContext.ts';
import { UNREAD_COUNT_MARK } from '../../../src/lib/unreadCount.ts';

const BASE = {
  videoUrl: null, posterUrl: null, caption: 'A caption.',
  creator: { id: 'creator-1', username: 'maya.okafor', displayName: 'Maya Okafor', avatarUrl: null },
  place: { name: 'Palácio da Luz', city: 'Lisbon' },
};

async function renderViewer(post: Record<string, unknown>) {
  mockPost = { ...BASE, ...post };
  setViewerContext([{ id: 'm-1', posterUrl: null, thumbnailUrl: null, mediaType: 'image' as const }], 'm-1');
  await render(<MediaViewer />);
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function lastStampProps(): { initialCount: unknown; initialIsStamped: unknown } {
  const calls = mockStampProps.mock.calls;
  return calls[calls.length - 1][0] as { initialCount: unknown; initialIsStamped: unknown };
}

afterEach(() => {
  clearViewerContext();
  mockSeed.mockReset();
  mockStampProps.mockReset();
});

describe('MediaViewer — unread counts and flags', () => {
  it('unread comment and save counts draw the mark, labelled unavailable', async () => {
    await renderViewer({ likeCount: null, commentCount: null, saveCount: null, likedByMe: null, savedByMe: null, stampItCount: null });
    expect(screen.getAllByText(UNREAD_COUNT_MARK)).toHaveLength(2);
    expect(screen.getByLabelText('Comment, count unavailable')).toBeTruthy();
    expect(screen.getByLabelText('Save, count unavailable')).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('the Stamp is seeded with the unread count as null, never 0', async () => {
    await renderViewer({ likeCount: null, commentCount: 1, saveCount: 1, likedByMe: null, savedByMe: false, stampItCount: 0 });
    expect(lastStampProps().initialCount).toBeNull();
    expect(lastStampProps().initialIsStamped).toBe(false);
  });

  it('an unread saved flag reaches the save store as null, never false', async () => {
    await renderViewer({ likeCount: 1, commentCount: 1, saveCount: 1, likedByMe: false, savedByMe: null, stampItCount: 0 });
    expect(mockSeed).toHaveBeenCalledWith([{ id: 'm-1', savedByMe: null }]);
  });

  it('measured counts draw as before', async () => {
    await renderViewer({ likeCount: 214, commentCount: 17, saveCount: 58, likedByMe: true, savedByMe: true, stampItCount: 0 });
    expect(screen.queryByText(UNREAD_COUNT_MARK)).toBeNull();
    expect(screen.getByText('17')).toBeTruthy();
    expect(screen.getByText('58')).toBeTruthy();
    expect(lastStampProps().initialCount).toBe(214);
    expect(lastStampProps().initialIsStamped).toBe(true);
  });
});
