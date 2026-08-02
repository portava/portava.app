/**
 * PostcardList — MediaCard rendering tests
 *
 * Confirms that:
 * 1. A video postcard renders MediaCard with a PlayCircle badge.
 * 2. An image postcard renders MediaCard without the PlayCircle badge.
 * 3. Both cards are pressable and navigate to /post/:id.
 * 4. Media URLs are passed through signed-URL hydration (SEC-02 gate).
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
 * mediaUrl is mocked to return resolved URLs synchronously so tests can
 * assert hydration without real network calls.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
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

// ── mediaUrl mock ─────────────────────────────────────────────────────────────
// Mirrors the pattern in PassportSections.component.test.tsx.
// mockHydrateMediaUrls resolves each URL to itself by default; individual
// tests can override it to assert signed-URL substitution.
const mockHydrateMediaUrls = jest.fn(async (urls: string[]) => {
  const result: Record<string, string | null> = {};
  for (const u of urls) result[u] = u;
  return result;
});

jest.mock('../../services/mediaUrl.ts', () => {
  const React = require('react');
  return {
    PRIVATE_BUCKETS: ['post-media', 'profile-media'],
    hydrateMediaUrls: (...args: any[]) => mockHydrateMediaUrls(...args),
    useHydratedMedia: (urls: (string | null | undefined)[]) => {
      const [resolved, setResolved] = React.useState<Record<string, string | null>>({});
      const [loading, setLoading]   = React.useState(false);
      const key = React.useMemo(() => {
        const unique = [...new Set(urls.filter((u: any) => !!u))].sort();
        return (unique as string[]).join('\0');
      }, [urls]);
      React.useEffect(() => {
        const unique = key ? key.split('\0') : [];
        if (!unique.length) { setResolved({}); setLoading(false); return; }
        let cancelled = false;
        setLoading(true);
        mockHydrateMediaUrls(unique).then((result: Record<string, string | null>) => {
          if (!cancelled) { setResolved(result); setLoading(false); }
        });
        return () => { cancelled = true; };
      }, [key]);
      return { resolved, loading };
    },
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

function makePost(overrides: { id?: string; mediaKind: 'image' | 'video'; mediaUrl?: string }): Post {
  return {
    id:           overrides.id ?? 'post-1',
    kind:         'standard',
    category:     'tip',
    author:       AUTHOR as any,
    destination:  DESTINATION,
    media: [
      {
        id:   'm1',
        url:  overrides.mediaUrl ?? 'https://example.com/thumb.jpg',
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
  mockHydrateMediaUrls.mockClear();
});

describe('PostcardList — video item', () => {
  it('renders the PlayCircle badge for a video media item', async () => {
    const post = makePost({ id: 'post-video', mediaKind: 'video' });
    await render(<PostcardList posts={[post]} />);

    // MediaCard renders a PlayCircle icon inside the type badge for video items.
    // The lucide mock renders PlayCircle as <View testID="icon-PlayCircle" />.
    expect(screen.getByTestId('icon-PlayCircle')).toBeTruthy();
  });

  it('renders the card with video accessibility label', async () => {
    const post = makePost({ id: 'post-video', mediaKind: 'video' });
    await render(<PostcardList posts={[post]} />);

    // MediaCard sets accessibilityLabel to "Video" when there is no title.
    expect(screen.getByLabelText('Video')).toBeTruthy();
  });

  it('navigates to /post/:id when the video card is pressed', async () => {
    const post = makePost({ id: 'post-video', mediaKind: 'video' });
    await render(<PostcardList posts={[post]} />);

    fireEvent.press(screen.getByLabelText('Video'));
    expect(mockRouter.push).toHaveBeenCalledWith('/post/post-video');
  });
});

describe('PostcardList — image item', () => {
  it('renders no PlayCircle badge for an image media item', async () => {
    const post = makePost({ id: 'post-image', mediaKind: 'image' });
    await render(<PostcardList posts={[post]} />);

    // MediaCard only shows PlayCircle in the badge for video items.
    expect(screen.queryByTestId('icon-PlayCircle')).toBeNull();
  });

  it('renders the card with image accessibility label', async () => {
    const post = makePost({ id: 'post-image', mediaKind: 'image' });
    await render(<PostcardList posts={[post]} />);

    // MediaCard sets accessibilityLabel to "Image" when there is no title.
    expect(screen.getByLabelText('Image')).toBeTruthy();
  });

  it('navigates to /post/:id when the image card is pressed', async () => {
    const post = makePost({ id: 'post-image', mediaKind: 'image' });
    await render(<PostcardList posts={[post]} />);

    fireEvent.press(screen.getByLabelText('Image'));
    expect(mockRouter.push).toHaveBeenCalledWith('/post/post-image');
  });
});

describe('PostcardList — signed-URL hydration', () => {
  it('passes media URLs through useHydratedMedia before rendering', async () => {
    const RAW_URL    = 'https://example.com/raw.jpg';
    const SIGNED_URL = 'https://example.com/signed.jpg?token=abc';

    mockHydrateMediaUrls.mockResolvedValueOnce({ [RAW_URL]: SIGNED_URL });

    const post = makePost({ id: 'post-hydrate', mediaKind: 'image', mediaUrl: RAW_URL });
    await render(<PostcardList posts={[post]} />);

    // Hydration hook must have been invoked with the raw media URL.
    await waitFor(() => {
      expect(mockHydrateMediaUrls).toHaveBeenCalledWith(
        expect.arrayContaining([RAW_URL]),
      );
    });
  });
});
