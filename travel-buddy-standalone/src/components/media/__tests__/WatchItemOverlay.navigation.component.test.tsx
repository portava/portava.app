/**
 * WatchItemOverlay — navigation handler tests.
 *
 * ## What's covered
 *
 * 1. Tapping the creator display name / username navigates to the
 *    username-based profile route (/u/<username>), not /profile/<id>.
 * 2. Tapping a place chip that has a canonical place ID navigates to
 *    /place/<placeId>.
 * 3. Tapping a place chip that has NO canonical place ID does not trigger
 *    navigation (avoids /place/undefined routes).
 * 4. Tapping a linked entity chip navigates to the correct route for its kind.
 *
 * ## Why these tests exist
 *
 * Creator navigation must use the username-based route (/u/[username]) that the
 * app's profile screens accept. Place chips only navigate when a structured
 * place record is available — location-label-only items (name/city without a
 * place ID) must never produce /place/undefined.
 */

import React from 'react';
import { View } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentional exhaustive stub — expo-router's actual implementation
// relies on NavigationContainer and native navigation context unavailable in
// Jest. Spreading jest.requireActual crashes on import. Only router.push is
// needed for these navigation-handler tests.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
}));

// NOTE: intentional stub — safe-area insets are not under test; only a
// predictable zero-inset return value is needed so layout doesn't vary across
// environments.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('expo-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    LinearGradient: ({ children, ...rest }: any) => (
      <View {...rest}>{children}</View>
    ),
  };
});

// NOTE: intentional stub — useFollow's network and auth behaviour is not under
// test; only a stable non-loading state is needed so the follow button renders
// without real API calls.
jest.mock('../../../hooks/useFollow', () => ({
  useFollow: () => ({
    isFollowing: false,
    loading: false,
    toggling: false,
    followsYou: false,
    followersCount: 0,
    followingCount: 0,
    toggle: jest.fn(),
  }),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

// Import router AFTER the mock is registered so we receive the mock instance.
import { router } from 'expo-router';
import { WatchItemOverlay } from '../WatchItemOverlay.tsx';
import type { WatchItemOverlayProps } from '../WatchItemOverlay.tsx';
import type { MediaFeedItem } from '../../../types/media.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

const pushMock = router.push as jest.Mock;

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<MediaFeedItem> = {}): MediaFeedItem {
  return {
    id: 'item-1',
    videoUrl: 'https://example.com/video.mp4',
    posterUrl: null,
    duration: null,
    creator: {
      id: 'user-uuid-123',
      displayName: 'Jane Doe',
      username: 'janedoe',
      avatarUrl: null,
      isFollowing: false,
    },
    caption: 'Hello world!',
    hashtags: ['#travel'],
    place: null,
    linkedEntity: null,
    audioLabel: null,
    likeCount: 10,
    commentCount: 2,
    saveCount: 1,
    likedByMe: false,
    savedByMe: false,
    ...overrides,
  };
}

// Typed against the component's real props. Untyped, this object was missing the
// five REQUIRED stamp props (stampGroupRef, stampVisualIsStamped,
// stampVisualCount, stampButtonStyle, onStampPress) and carried three the
// component does not accept at all (isLiked, likeCount, onLike). A JSX spread
// skips excess-property checking, so neither half was ever reported.
const BASE_PROPS: Omit<WatchItemOverlayProps, 'item'> = {
  currentUserId: 'other-user',
  isSaved: false,
  onComment: jest.fn(),
  onSave: jest.fn(),
  onMore: jest.fn(),
  stampGroupRef: React.createRef<View>(),
  stampVisualIsStamped: false,
  stampVisualCount: 0,
  stampButtonStyle: undefined,
  onStampPress: jest.fn(),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  pushMock.mockClear();
});

describe('WatchItemOverlay navigation', () => {
  it('routes to /u/<username> — not /profile/<id> — when display name is tapped', async () => {
    await render(<WatchItemOverlay item={makeItem()} {...BASE_PROPS} />);

    fireEvent.press(screen.getByText('Jane Doe'));

    expect(pushMock).toHaveBeenCalledWith('/u/janedoe');
    // The internal UUID must never appear as a route segment.
    expect(pushMock).not.toHaveBeenCalledWith(expect.stringContaining('user-uuid-123'));
  });

  it('routes to /u/<username> when the @handle text is tapped', async () => {
    await render(<WatchItemOverlay item={makeItem()} {...BASE_PROPS} />);

    fireEvent.press(screen.getByText('@janedoe'));

    expect(pushMock).toHaveBeenCalledWith('/u/janedoe');
  });

  it('navigates to /place/<id> when the place chip has a canonical place ID', async () => {
    // Distinct name + city so the rendered chip text is unambiguous.
    const item = makeItem({
      place: { id: 'place-abc', name: 'Shibuya Crossing', city: 'Tokyo', country: 'Japan' },
    });
    await render(<WatchItemOverlay item={item} {...BASE_PROPS} />);

    // The chip renders as: "<name> · <city>" — find by the place name text.
    fireEvent.press(screen.getByText('Shibuya Crossing · Tokyo'));

    expect(pushMock).toHaveBeenCalledWith('/place/place-abc');
    expect(pushMock).not.toHaveBeenCalledWith(expect.stringContaining('undefined'));
  });

  it('does NOT navigate when the place chip has no canonical place ID', async () => {
    // No `id` — location-label-only item from the feed API adapter.
    const item = makeItem({ place: { name: 'Kuta Beach', city: 'Denpasar', country: 'Indonesia' } });
    await render(<WatchItemOverlay item={item} {...BASE_PROPS} />);

    // The label-only chip is rendered as a non-interactive View, so pressing
    // its text should not invoke router.push.
    const chipText = screen.queryByText('Kuta Beach · Denpasar');
    if (chipText) {
      try { fireEvent.press(chipText); } catch { /* non-interactive — expected */ }
    }
    // router.push must never fire — including with /place/undefined.
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('navigates to /event/<id> when a linked event chip is tapped', async () => {
    const item = makeItem({
      linkedEntity: { kind: 'event', id: 'evt-42', label: 'Beach Cleanup' },
    });
    await render(<WatchItemOverlay item={item} {...BASE_PROPS} />);

    fireEvent.press(screen.getByText('Beach Cleanup'));

    expect(pushMock).toHaveBeenCalledWith('/event/evt-42');
  });

  it('navigates to /trip/<id> when a linked trip chip is tapped', async () => {
    const item = makeItem({
      linkedEntity: { kind: 'trip', id: 'trip-7', label: 'Japan Highlights' },
    });
    await render(<WatchItemOverlay item={item} {...BASE_PROPS} />);

    fireEvent.press(screen.getByText('Japan Highlights'));

    expect(pushMock).toHaveBeenCalledWith('/trip/trip-7');
  });
});
