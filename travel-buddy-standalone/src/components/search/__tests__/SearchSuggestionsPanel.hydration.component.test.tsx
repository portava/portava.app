/**
 * SearchSuggestionsPanel — suggestion avatar media hydration regression guard.
 *
 * UnifiedSearchResult.avatarUrl (profile-media) and .imageUrl can both point
 * into a private bucket. Before this fix SuggestionAvatar bound whichever was
 * present straight to a bare React Native <Image> and never reached the
 * signed-URL hydration layer in services/mediaUrl.ts.
 *
 * This test proves the suggestion row now requests hydration and renders the
 * SIGNED url the server returns, never the raw url. Run against the
 * pre-conversion component it fails on both assertions: mockHydrateMediaUrls
 * is never called, and no expo-image node exists (the old code renders a
 * plain RN <Image>, not expo-image).
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { SearchSuggestionsPanel } from '../SearchSuggestionsPanel.tsx';
import type { SuggestGroup, UnifiedSearchResult } from '../../../services/discovery.ts';

const RAW_URL = 'https://proj.supabase.co/storage/v1/object/public/profile-media/u2/avatar.jpg';
const SIGNED_URL = 'https://proj.supabase.co/storage/v1/object/sign/profile-media/u2/avatar.jpg?token=signed-abc';

// ── mediaUrl mock ────────────────────────────────────────────────────────────
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

// NOTE: intentionally exhaustive — only the named `useSafeAreaInsets` export
// is reached (via PlainBottomFiller), so a minimal stub is safe; avoids
// wrapping every render in a SafeAreaProvider.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
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

function resultFixture(overrides: Partial<UnifiedSearchResult> = {}): UnifiedSearchResult {
  return {
    id: 'u2',
    type: 'person',
    title: 'Traveler Two',
    subtitle: null,
    avatarUrl: RAW_URL,
    imageUrl: null,
    fallbackInitials: 'TT',
    locationPreview: null,
    matchedReason: null,
    actionState: null,
    privacyState: null,
    accessState: null,
    destinationRoute: null,
    metadata: null,
    createdAt: null,
    startsAt: null,
    ...overrides,
  } as UnifiedSearchResult;
}

const GROUPS: SuggestGroup[] = [
  { type: 'person', label: 'People', items: [resultFixture()] } as SuggestGroup,
];

describe('SearchSuggestionsPanel — suggestion avatar media hydration', () => {
  beforeEach(() => {
    mockHydrateMediaUrls.mockClear();
  });

  it('requests the raw avatar URL through useHydratedMedia and renders the signed URL, not the raw one', async () => {
    const tr = create(
      <SearchSuggestionsPanel
        query="trav"
        groups={GROUPS}
        loading={false}
        recentSearches={[]}
        onSubmit={jest.fn()}
        onPickRecent={jest.fn()}
        onPickResult={jest.fn()}
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

  it('falls back to initials/type icon (not a broken image) when the server rejects the URL', async () => {
    mockHydrateMediaUrls.mockImplementationOnce(async (urls: string[]) => {
      const result: Record<string, string | null> = {};
      for (const u of urls) result[u] = null;
      return result;
    });

    const tr = create(
      <SearchSuggestionsPanel
        query="trav"
        groups={GROUPS}
        loading={false}
        recentSearches={[]}
        onSubmit={jest.fn()}
        onPickRecent={jest.fn()}
        onPickResult={jest.fn()}
      />,
    );
    await flush();

    expect(findExpoImages(tr.root).length).toBe(0);
  });
});
