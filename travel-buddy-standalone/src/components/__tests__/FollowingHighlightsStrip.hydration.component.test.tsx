/**
 * FollowingHighlightsStrip — ring-avatar media hydration regression guard.
 *
 * resolveRingPosterUri() returns either a user's avatarUrl (profile-media,
 * private) or a highlight's mediaThumbnailUrl/mediaUrl (post-media, private).
 * Before this fix the resolved URI was bound straight to a bare React Native
 * <Image> and never reached the signed-URL hydration layer in
 * services/mediaUrl.ts.
 *
 * This test proves the ring avatar now requests hydration and renders the
 * SIGNED url the server returns, never the raw url. Run against the
 * pre-conversion component it fails on both assertions: mockHydrateMediaUrls
 * is never called, and no expo-image node exists (the old code renders a
 * plain RN <Image>, not expo-image).
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { FollowingHighlightsStrip } from '../FollowingHighlightsStrip.tsx';
import type { HighlightFeedUser } from '../../services/highlights.ts';

const RAW_URL = 'https://proj.supabase.co/storage/v1/object/public/profile-media/u1/avatar.jpg';
const SIGNED_URL = 'https://proj.supabase.co/storage/v1/object/sign/profile-media/u1/avatar.jpg?token=signed-abc';

// ── mediaUrl mock ────────────────────────────────────────────────────────────
const mockHydrateMediaUrls = jest.fn(async (urls: string[]) => {
  const result: Record<string, string | null> = {};
  for (const u of urls) result[u] = u === RAW_URL ? SIGNED_URL : u;
  return result;
});

jest.mock('../../services/mediaUrl.ts', () => {
  const ReactLib = require('react');
  return {
    PRIVATE_BUCKETS: ['post-media', 'profile-media'],
    hydrateMediaUrls: (...args: any[]) => mockHydrateMediaUrls(...args),
    useHydratedMedia: (urls: (string | null | undefined)[]) => {
      const [resolved, setResolved] = ReactLib.useState<Record<string, string | null>>({});
      const key = ReactLib.useMemo(() => {
        const unique = [...new Set(urls.filter((u: any) => !!u))].sort();
        return (unique as string[]).join('\0');
      }, [urls]);
      ReactLib.useEffect(() => {
        const unique = key ? key.split('\0') : [];
        if (!unique.length) { setResolved({}); return; }
        let cancelled = false;
        mockHydrateMediaUrls(unique).then((result: Record<string, string | null>) => {
          if (!cancelled) setResolved(result);
        });
        return () => { cancelled = true; };
      }, [key]);
      return { resolved, loading: false };
    },
  };
});

jest.mock('../../lib/batchSignMedia.ts', () => ({
  ...jest.requireActual('../../lib/batchSignMedia.ts'),
  _evictBatchSignEntry: jest.fn(),
}));

jest.mock('expo-image', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  function MockExpoImage({ onError, testID, source }: any) {
    return ReactLib.createElement(View, {
      testID: testID ?? 'mock-expo-image',
      'data-on-error': onError,
      'data-source': JSON.stringify(source ?? null),
    });
  }
  return { Image: MockExpoImage };
});

// NOTE: intentionally exhaustive — FollowingHighlightsStrip only imports the
// named `HighlightViewer` export, and we deliberately replace it with a no-op
// to avoid rendering the full overlay (which pulls in expo-av/expo-sharing),
// irrelevant to media hydration.
jest.mock('../HighlightViewer.tsx', () => ({ HighlightViewer: () => null }));

// NOTE: intentionally exhaustive — FollowingHighlightsStrip only calls the
// named `useSession` export to read the viewer's userId; no other export is
// used, so a minimal stub is safe here.
jest.mock('../../context/SessionContext.tsx', () => ({
  useSession: () => ({ userId: 'viewer-1' }),
}));

function findExpoImages(root: TestRenderer.ReactTestInstance) {
  try { return root.findAllByProps({ testID: 'mock-expo-image' }); } catch { return []; }
}

function create(el: React.ReactElement) {
  let tr!: TestRenderer.ReactTestRenderer;
  act(() => { tr = TestRenderer.create(el); });
  return tr;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function userFixture(overrides: Partial<HighlightFeedUser> = {}): HighlightFeedUser {
  return {
    userId: 'u1',
    handle: 'traveler1',
    name: 'Traveler One',
    avatarUrl: RAW_URL,
    highlights: [
      {
        id: 'h1',
        mediaType: 'image/jpeg',
        mediaUrl: 'https://proj.supabase.co/storage/v1/object/public/post-media/u1/h1.jpg',
        mediaThumbnailUrl: null,
        viewedByMe: false,
      } as any,
    ],
    ...overrides,
  } as HighlightFeedUser;
}

describe('FollowingHighlightsStrip — ring avatar media hydration', () => {
  beforeEach(() => {
    mockHydrateMediaUrls.mockClear();
  });

  it('requests the raw avatar URL through useHydratedMedia and renders the signed URL, not the raw one', async () => {
    const tr = create(
      <FollowingHighlightsStrip
        users={[userFixture()]}
        sessionViewedIds={new Set()}
        onMarkViewed={jest.fn()}
      />,
    );
    await flush();

    expect(mockHydrateMediaUrls).toHaveBeenCalledWith([RAW_URL]);

    const imgs = findExpoImages(tr.root);
    expect(imgs.length).toBeGreaterThanOrEqual(1);
    const source = JSON.parse(imgs[0].props['data-source']);
    expect(source?.uri).toBe(SIGNED_URL);
    expect(source?.uri).not.toBe(RAW_URL);
  });

  it('falls back to the initials chip (not a broken image) when the server rejects the URL', async () => {
    mockHydrateMediaUrls.mockImplementationOnce(async (urls: string[]) => {
      const result: Record<string, string | null> = {};
      for (const u of urls) result[u] = null;
      return result;
    });

    const tr = create(
      <FollowingHighlightsStrip
        users={[userFixture()]}
        sessionViewedIds={new Set()}
        onMarkViewed={jest.fn()}
      />,
    );
    await flush();

    expect(findExpoImages(tr.root).length).toBe(0);
  });
});
