/**
 * PostcardList — video play badge tests
 *
 * Confirms that:
 * 1. A video postcard renders VideoThumbnail — play badge is visible.
 * 2. An image postcard renders without the play badge.
 * 3. Both cards are pressable and navigate to /post/:id.
 *
 * Run with: pnpm test:component
 *
 * ## Mock strategy
 *
 * expo-image is mocked exhaustively because it relies on native Expo modules
 * that are unavailable in the jest-expo runner.  expo-router is re-mocked
 * locally so router.push is a jest.fn() we can assert on.
 * lucide-react-native is handled by the global moduleNameMapper (renders
 * each icon as <View testID="icon-<Name>" />).
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { PostcardList } from '../PassportSections.tsx';
import type { Post } from '../../types/models.ts';

// NOTE: intentionally exhaustive — expo-router is a native package; pulling
// requireActual drags in native modules that crash the jest-expo runner.
// router.push is defined as jest.fn() inside the factory (jest.mock is hoisted
// above const declarations, so outer variables can't be captured reliably).
jest.mock('expo-router', () => ({
  router: {
    push:     jest.fn(),
    replace:  jest.fn(),
    back:     jest.fn(),
    navigate: jest.fn(),
    dismiss:  jest.fn(),
  },
  useRouter:            () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
  usePathname:          () => '/',
  useSegments:          () => [],
  useFocusEffect:       jest.fn(),
  useNavigation:        () => ({
    navigate:    jest.fn(),
    goBack:      jest.fn(),
    setOptions:  jest.fn(),
    addListener: (_e: unknown, _cb: unknown) => () => {},
  }),
  Link:     ({ children }: { children: React.ReactNode }) => children as any,
  Redirect: (_props: { href: unknown }) => null,
  Stack:    { Screen: (_props: unknown) => null },
  Tabs:     { Screen: (_props: unknown) => null },
}));

// NOTE: intentionally exhaustive — expo-image uses native ExpoView and
// ImageModule internals that crash the jest-expo runner when loaded via
// requireActual.  A lightweight stub is sufficient for these render tests.
jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    Image: ({ testID, ...rest }: { testID?: string; [k: string]: unknown }) =>
      React.createElement(View, { testID: testID ?? 'expo-image', ...rest }),
  };
});

// Retrieve router.push after the mock factory has run.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { router: mockRouter } = require('expo-router') as { router: { push: jest.Mock } };

// ── Fixture factories ─────────────────────────────────────────────────────────

const AUTHOR = {
  id:          'u1',
  handle:      'tester',
  name:        'Test User',
  displayName: 'Test User',
  avatarUrl:   null,
  isPrivate:   false,
  verified:    false,
};

const DESTINATION = {
  id:      'd1',
  city:    'Tokyo',
  country: 'Japan',
  slug:    'tokyo-japan',
};

function makePost(overrides: { id?: string; mediaKind: 'image' | 'video' }): Post {
  return {
    id:           overrides.id ?? 'post-1',
    kind:         'standard',
    category:     'tip',
    author:       AUTHOR as any,
    destination:  DESTINATION,
    media: [
      {
        id:   'm1',
        url:  'https://example.com/thumb.jpg',
        kind: overrides.mediaKind,
      },
    ],
    createdAt:    '2024-06-01T12:00:00Z',
    likeCount:    5,
    commentCount: 2,
    saveCount:    1,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockRouter.push.mockClear();
});

describe('PostcardList — video item', () => {
  it('renders the play badge (VideoThumbnail) for a video media item', async () => {
    const post = makePost({ id: 'post-video', mediaKind: 'video' });
    await render(<PostcardList posts={[post]} />);

    // VideoThumbnail exposes accessibilityLabel="Play video" on its Pressable.
    expect(screen.getByLabelText('Play video')).toBeTruthy();
  });

  it('shows the play icon inside the VideoThumbnail for a video item', async () => {
    const post = makePost({ id: 'post-video', mediaKind: 'video' });
    await render(<PostcardList posts={[post]} />);

    // The lucide mock renders Play as <View testID="icon-Play" />.
    expect(screen.getByTestId('icon-Play')).toBeTruthy();
  });

  it('navigates to /post/:id when the video card is pressed', async () => {
    const post = makePost({ id: 'post-video', mediaKind: 'video' });
    await render(<PostcardList posts={[post]} />);

    fireEvent.press(screen.getByText('5 likes · 2 comments'));
    expect(mockRouter.push).toHaveBeenCalledWith('/post/post-video');
  });
});

describe('PostcardList — image item', () => {
  it('renders no play badge for an image media item', async () => {
    const post = makePost({ id: 'post-image', mediaKind: 'image' });
    await render(<PostcardList posts={[post]} />);

    // No VideoThumbnail — play badge accessibility label must be absent.
    expect(screen.queryByLabelText('Play video')).toBeNull();
  });

  it('renders no play icon for an image media item', async () => {
    const post = makePost({ id: 'post-image', mediaKind: 'image' });
    await render(<PostcardList posts={[post]} />);

    // The lucide Play icon is only rendered by VideoThumbnail.
    expect(screen.queryByTestId('icon-Play')).toBeNull();
  });

  it('navigates to /post/:id when the image card is pressed', async () => {
    const post = makePost({ id: 'post-image', mediaKind: 'image' });
    await render(<PostcardList posts={[post]} />);

    fireEvent.press(screen.getByText('5 likes · 2 comments'));
    expect(mockRouter.push).toHaveBeenCalledWith('/post/post-image');
  });
});
