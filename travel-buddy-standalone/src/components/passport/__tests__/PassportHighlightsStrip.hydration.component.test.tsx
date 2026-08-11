/**
 * PassportHighlightsStrip — highlight bubble media hydration regression guard.
 *
 * highlight.mediaUrl / thumbnailUrl point into the `post-media` bucket, which
 * is private. Before this fix, HighlightBubble bound that URL straight to a
 * bare React Native <Image> and never called into the signed-URL hydration
 * layer (useHydratedMedia / hydrateMediaUrls in services/mediaUrl.ts) — the
 * same layer every other media surface in the app goes through.
 *
 * This test proves the bubble now requests hydration and renders the SIGNED
 * url the server returns, never the raw url it was given. Run against the
 * pre-conversion component (bare <Image>, no mediaUrl.ts import) it fails on
 * both assertions: mockHydrateMediaUrls is never called, and no expo-image
 * node exists to inspect (the old code renders a plain RN <Image>, not
 * expo-image, so `findExpoImages` comes back empty).
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { PassportHighlightsStrip } from '../PassportHighlightsStrip.tsx';

const RAW_URL = 'https://proj.supabase.co/storage/v1/object/public/post-media/u1/highlight.jpg';
const SIGNED_URL = 'https://proj.supabase.co/storage/v1/object/sign/post-media/u1/highlight.jpg?token=signed-abc';

// ── mediaUrl mock — re-implements useHydratedMedia against a controllable
// mock so the test can assert exactly which URLs were requested, without any
// real network access. ──────────────────────────────────────────────────────
const mockHydrateMediaUrls = jest.fn(async (urls: string[]) => {
  const result: Record<string, string | null> = {};
  for (const u of urls) result[u] = u === RAW_URL ? SIGNED_URL : u;
  return result;
});

jest.mock('../../../services/mediaUrl.ts', () => {
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

jest.mock('../../../lib/batchSignMedia.ts', () => ({
  ...jest.requireActual('../../../lib/batchSignMedia.ts'),
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

describe('PassportHighlightsStrip — highlight bubble media hydration', () => {
  beforeEach(() => {
    mockHydrateMediaUrls.mockClear();
  });

  it('requests the raw highlight URL through useHydratedMedia and renders the signed URL, not the raw one', async () => {
    const tr = create(
      <PassportHighlightsStrip
        highlights={[{ id: 'h1', thumbnailUrl: null, mediaUrl: RAW_URL, caption: null }]}
        hasActive
        allViewed={false}
      />,
    );
    await flush();

    // The component must have gone through the signed-URL hydration layer —
    // not passed the raw field straight through to <Image>.
    expect(mockHydrateMediaUrls).toHaveBeenCalledWith([RAW_URL]);

    const imgs = findExpoImages(tr.root);
    expect(imgs.length).toBeGreaterThanOrEqual(1);
    const source = JSON.parse(imgs[0].props['data-source']);
    expect(source?.uri).toBe(SIGNED_URL);
    expect(source?.uri).not.toBe(RAW_URL);
  });

  it('falls back to the designed placeholder (not a broken image) when the server rejects the URL', async () => {
    mockHydrateMediaUrls.mockImplementationOnce(async (urls: string[]) => {
      const result: Record<string, string | null> = {};
      for (const u of urls) result[u] = null; // unauthorized / unrecognised
      return result;
    });

    const tr = create(
      <PassportHighlightsStrip
        highlights={[{ id: 'h2', thumbnailUrl: null, mediaUrl: RAW_URL, caption: null }]}
        hasActive
        allViewed={false}
      />,
    );
    await flush();

    // No expo-image should be mounted once the server rejects the URL — the
    // designed fallback view takes over instead of a broken <Image>.
    expect(findExpoImages(tr.root).length).toBe(0);
  });
});
