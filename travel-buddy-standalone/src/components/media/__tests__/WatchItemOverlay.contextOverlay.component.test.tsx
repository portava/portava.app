/**
 * WatchItemOverlay — the overlay half of the owner's surface decision F2 as a
 * flag (census-media §34): MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED, seeded OFF (3341).
 *
 *   OFF — exactly today: Stamp is the first rail control, and Stamp, comment,
 *         save and the Stamp It count are all drawn; no Compass control; the
 *         place is a chip under the caption.
 *   ON  — Ask Compass is the first rail control; no Stamp/comment/save count
 *         and no Stamp It count; the place leads the left column and opens
 *         that place's perspectives through the §14 entry context.
 *
 * Query-only cases share this file; each press has its own file (one press
 * commit per file — .agents/memory/rntl-react19-renderer-budget.md).
 */
import React from 'react';
import { View } from 'react-native';
import { render, screen } from '@testing-library/react-native';

// NOTE: intentional exhaustive stub — only router.push is needed.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
}));

// NOTE: intentional stub — insets are not under test.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('expo-linear-gradient', () => {
  const { View: V } = require('react-native');
  return { LinearGradient: ({ children, ...rest }: any) => <V {...rest}>{children}</V> };
});

// NOTE: intentional stub — follow network/auth is not under test.
jest.mock('../../../hooks/useFollow', () => ({
  useFollow: () => ({ isFollowing: false, loading: false, toggling: false, followsYou: false, followersCount: 0, followingCount: 0, toggle: jest.fn() }),
}));

// NOTE: exhaustive stub intentional — each test sets the flags it is about.
let mockFlags: Record<string, boolean> = {};
jest.mock('../../../context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({ isEnabled: (key: string) => mockFlags[key] ?? false, loading: false }),
}));

import { WatchItemOverlay, type WatchItemOverlayProps } from '../WatchItemOverlay.tsx';
import type { MediaFeedItem } from '../../../types/media.ts';

function makeItem(overrides: Partial<MediaFeedItem> = {}): MediaFeedItem {
  return {
    id: 'item-1',
    videoUrl: 'https://example.com/video.mp4',
    posterUrl: null,
    duration: null,
    creator: { id: 'creator-1', displayName: 'Jane Doe', username: 'janedoe', avatarUrl: null, isFollowing: false },
    caption: 'Sunset from the pier',
    hashtags: [],
    place: { id: 'place-abc', name: 'An Thuong', city: 'Da Nang', country: 'Vietnam' },
    linkedEntity: null,
    audioLabel: null,
    likeCount: 10,
    commentCount: 23,
    saveCount: 31,
    likedByMe: false,
    savedByMe: false,
    stampItCount: 44,
    ...overrides,
  } as MediaFeedItem;
}

const PROPS: Omit<WatchItemOverlayProps, 'item'> = {
  currentUserId: 'viewer-1',
  isSaved: false,
  onComment: jest.fn(),
  onSave: jest.fn(),
  onMore: jest.fn(),
  stampGroupRef: React.createRef<View>(),
  stampVisualIsStamped: false,
  stampVisualCount: 57,
  stampButtonStyle: undefined,
  onStampPress: jest.fn(),
};

const railLabels = () => screen.getAllByRole('button').map((b) => b.props.accessibilityLabel as string);

describe('WatchItemOverlay — F2 overlay flag OFF is exactly today', () => {
  it('Stamp leads the rail with its count, comment and save carry theirs, and the Stamp It count is drawn', async () => {
    mockFlags = {};
    await render(<WatchItemOverlay item={makeItem()} {...PROPS} />);
    const labels = railLabels();
    expect(labels).not.toContain('Ask Compass about this');
    expect(labels.indexOf('Stamp')).toBeLessThan(labels.indexOf('Comment'));
    for (const count of ['57', '23', '31', '44']) expect(screen.getByText(count)).toBeTruthy();
    // the place is today's chip under the caption, not a header
    expect(screen.queryByTestId('watch-context-place')).toBeNull();
    expect(screen.getByLabelText('Go to An Thuong')).toBeTruthy();
  });
});

describe('WatchItemOverlay — F2 overlay flag ON', () => {
  it('Ask Compass is the first rail control, ahead of Stamp, comment and save', async () => {
    mockFlags = { MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED: true };
    await render(<WatchItemOverlay item={makeItem()} {...PROPS} />);
    const labels = railLabels();
    const compass = labels.indexOf('Ask Compass about this');
    expect(compass).toBeGreaterThanOrEqual(0);
    for (const social of ['Stamp', 'Comment', 'Save']) expect(compass).toBeLessThan(labels.indexOf(social));
    // Stamp, comment and save stay available
    expect(labels).toEqual(expect.arrayContaining(['Stamp', 'Comment', 'Save']));
  });

  it('draws no Stamp, comment, save or Stamp It count', async () => {
    mockFlags = { MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED: true };
    await render(<WatchItemOverlay item={makeItem({ id: 'item-2' })} {...PROPS} />);
    for (const count of ['57', '23', '31', '44']) expect(screen.queryByText(count)).toBeNull();
  });

  it('the place leads the left column, ahead of the creator, and the chip is not drawn twice', async () => {
    mockFlags = { MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED: true };
    await render(<WatchItemOverlay item={makeItem({ id: 'item-3' })} {...PROPS} />);
    expect(screen.getByTestId('watch-context-place')).toBeTruthy();
    expect(screen.getByLabelText("See An Thuong's perspectives")).toBeTruthy();
    expect(screen.queryByLabelText('Go to An Thuong')).toBeNull();
    const texts = screen.getAllByText(/An Thuong · Da Nang|Jane Doe/).map((t) => t.props.children);
    expect(texts[0]).toBe('An Thuong · Da Nang');
  });

  it('a label-only place (no canonical id) is drawn but not tappable', async () => {
    mockFlags = { MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED: true };
    await render(<WatchItemOverlay item={makeItem({ id: 'item-4', place: { name: 'Kuta Beach', city: 'Denpasar', country: 'Indonesia' } })} {...PROPS} />);
    expect(screen.getByText('Kuta Beach · Denpasar')).toBeTruthy();
    expect(screen.queryByLabelText("See Kuta Beach's perspectives")).toBeNull();
  });

  it('with no place at all, the left column starts with the creator, as today', async () => {
    mockFlags = { MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED: true };
    await render(<WatchItemOverlay item={makeItem({ id: 'item-5', place: null })} {...PROPS} />);
    expect(screen.queryByTestId('watch-context-place')).toBeNull();
    expect(screen.getByText('Jane Doe')).toBeTruthy();
  });
});
