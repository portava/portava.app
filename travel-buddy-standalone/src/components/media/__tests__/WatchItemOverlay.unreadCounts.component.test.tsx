/**
 * WatchItemOverlay — a count the server could not read (census-media §47).
 *
 * Since §47 the Watch feed answers a comment, save or stamp count it could not
 * read as `null` (and names the read in `failedSources`) instead of a cached or
 * made-up 0. The rail drew `count > 0 ? count : nothing`, so an unread count
 * looked exactly like a measured zero. Pinned here:
 *
 *   1. an unread comment, save or stamp count draws the "—" mark, labelled
 *      "<action>, count unavailable" for a screen reader;
 *   2. a measured 0 still draws nothing, and a measured count its number
 *      (unchanged).
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { View } from 'react-native';
import { render, screen } from '@testing-library/react-native';

// NOTE: intentional exhaustive stub — navigation is not under test.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
}));

// NOTE: intentional exhaustive stub — safe-area insets are not under test.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('expo-linear-gradient', () => {
  const { View } = require('react-native');
  // NOTE: intentional exhaustive stub — the scrim is decoration only.
  return { LinearGradient: (props: object) => <View {...props} /> };
});

// NOTE: intentional exhaustive stub — useFollow network + auth behaviour is
// not under test; a stable non-loading state is sufficient.
jest.mock('../../../hooks/useFollow', () => ({
  useFollow: () => ({
    isFollowing: false, loading: false, toggling: false, followsYou: false,
    followersCount: 0, followingCount: 0, toggle: jest.fn(),
  }),
}));

import { WatchItemOverlay } from '../WatchItemOverlay.tsx';
import type { MediaFeedItem } from '../../../types/media.ts';
import { UNREAD_COUNT_MARK } from '../../../lib/unreadCount.ts';

function makeItem(overrides: Partial<MediaFeedItem> = {}): MediaFeedItem {
  return {
    id: 'item-1',
    videoUrl: 'https://example.com/video.mp4',
    posterUrl: null,
    duration: null,
    creator: { id: 'creator-1', displayName: 'Jane Doe', username: 'janedoe', avatarUrl: null, isFollowing: false },
    caption: 'Hello',
    hashtags: [],
    place: null,
    linkedEntity: null,
    audioLabel: null,
    likeCount: 10,
    commentCount: 2,
    saveCount: 3,
    likedByMe: false,
    savedByMe: false,
    ...overrides,
  };
}

async function renderOverlay(item: MediaFeedItem, stampVisualCount: number | null) {
  await render(
    <WatchItemOverlay
      item={item}
      currentUserId="viewer-1"
      isSaved={false}
      onComment={jest.fn()}
      onSave={jest.fn()}
      onMore={jest.fn()}
      stampGroupRef={React.createRef<View>()}
      stampVisualIsStamped={false}
      stampVisualCount={stampVisualCount}
      stampButtonStyle={{}}
      onStampPress={jest.fn()}
    />,
  );
}

describe('WatchItemOverlay — an unread count is never drawn as zero', () => {
  it('unread comment, save and stamp counts each draw the mark, labelled unavailable', async () => {
    await renderOverlay(makeItem({ commentCount: null, saveCount: null }), null);
    expect(screen.getAllByText(UNREAD_COUNT_MARK)).toHaveLength(3);
    expect(screen.getByLabelText('Comment, count unavailable')).toBeTruthy();
    expect(screen.getByLabelText('Save, count unavailable')).toBeTruthy();
    expect(screen.getByLabelText('Stamp, count unavailable')).toBeTruthy();
  });

  it('only the unread count draws the mark; a measured count keeps its number', async () => {
    await renderOverlay(makeItem({ commentCount: null, saveCount: 12 }), 4);
    expect(screen.getAllByText(UNREAD_COUNT_MARK)).toHaveLength(1);
    expect(screen.getByLabelText('Comment, count unavailable')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
  });

  it('a measured 0 still draws nothing (unchanged)', async () => {
    await renderOverlay(makeItem({ commentCount: 0, saveCount: 0 }), 0);
    expect(screen.queryByText(UNREAD_COUNT_MARK)).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.queryByLabelText('Comment, count unavailable')).toBeNull();
  });
});
