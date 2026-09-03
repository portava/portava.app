/**
 * PassportSections — BuddyPreview / BuddyRow avatar fallback tests
 *
 * Covers:
 *   - BuddyPreview: broken avatar URL → onError fires → initials chip shown
 *   - BuddyPreview: null avatar URL → initials shown immediately (no image)
 *   - BuddyRow: broken avatar URL → onError fires → initials chip shown
 *   - BuddyRow: null avatar URL → initials shown immediately (no image)
 *
 * Uses react-test-renderer (not RNTL) for prop inspection and callback
 * triggering — same pattern as DisplayMediaImage.component.test.tsx.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { BuddyPreview, BuddyRow } from '../PassportSections.tsx';
import type { User } from '../../types/models.ts';

// NOTE: intentionally exhaustive — expo-router re-exports many internal hooks
// that call native modules which don't exist in the Jest environment. Spreading
// jest.requireActual would trigger those imports and crash the test suite.
// Only `router` is needed here; we stub it directly.
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
}));

// ── Stamp mock (./ui.tsx) ─────────────────────────────────────────────────────
jest.mock('../ui.tsx', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    Stamp: ({ label }: { label: string }) => React.createElement(Text, null, label),
  };
});

// ── VideoThumbnail mock ───────────────────────────────────────────────────────
jest.mock('../ui/VideoThumbnail.tsx', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    VideoThumbnail: (props: any) => React.createElement(View, props),
  };
});

// ── mediaUrl mock ─────────────────────────────────────────────────────────────
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
      const [loading, setLoading] = React.useState(false);
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

// ── batchSignMedia mock ───────────────────────────────────────────────────────
const mockEvictBatchSignEntry = jest.fn();
jest.mock('../../lib/batchSignMedia.ts', () => ({
  ...jest.requireActual('../../lib/batchSignMedia.ts'),
  _evictBatchSignEntry: (...args: any[]) => mockEvictBatchSignEntry(...args),
}));

// ── expo-image mock ───────────────────────────────────────────────────────────
jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  function MockExpoImage({ onError, onLoad, accessibilityLabel, testID, source }: any) {
    return (
      <View
        testID={testID ?? 'mock-expo-image'}
        accessibilityLabel={accessibilityLabel}
        {...{
          'data-on-error': onError,
          'data-on-load': onLoad,
          'data-source': JSON.stringify(source ?? null),
        }}
      />
    );
  }
  MockExpoImage.displayName = 'MockExpoImage';
  return { Image: MockExpoImage };
});

jest.mock('expo-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    LinearGradient: ({ children, ...rest }: any) =>
      React.createElement(View, rest, children),
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function findExpoImages(root: TestRenderer.ReactTestInstance) {
  try {
    return root.findAllByProps({ testID: 'mock-expo-image' });
  } catch {
    return [];
  }
}

function fireOnError(root: TestRenderer.ReactTestInstance, index = 0) {
  const imgs = findExpoImages(root);
  if (imgs.length === 0) throw new Error('No mock expo-image found');
  const cb = imgs[index].props['data-on-error'];
  if (typeof cb !== 'function') throw new Error('No data-on-error prop found');
  act(() => cb());
}

function create(el: React.ReactElement) {
  let tr!: TestRenderer.ReactTestRenderer;
  act(() => { tr = TestRenderer.create(el); });
  return tr;
}

function textContent(root: TestRenderer.ReactTestInstance): string[] {
  return root.findAllByType(Text as any).map((n) => n.props.children as string);
}

// Minimal User fixture.
// Returns a real `User`. It used to return a four-field object literal, so every
// call site passing the result as `User[]` was a type error nobody saw — the
// nine remaining required fields were simply absent at runtime, and any code
// path reaching for one of them would have read undefined.
function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'u1',
    handle: 'alice',
    name: 'Alice Nomad',
    avatarUrl: 'https://example.com/avatar.jpg',
    homeCity: 'Lisbon',
    homeCountry: 'Portugal',
    travelStyle: 'solo',
    interests: [],
    verified: false,
    openToMeet: true,
    isPrivate: false,
    followers: 0,
    following: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockHydrateMediaUrls.mockImplementation(async (urls: string[]) => {
    const result: Record<string, string | null> = {};
    for (const u of urls) result[u] = u;
    return result;
  });
  mockEvictBatchSignEntry.mockReset();
});

// ── BuddyPreview ──────────────────────────────────────────────────────────────

describe('BuddyPreview avatar fallback', () => {
  it('shows the expo-image while the URL is valid', () => {
    const buddies = [makeUser({ name: 'Alice Nomad', avatarUrl: 'https://example.com/ok.jpg' })];
    const tr = create(<BuddyPreview buddies={buddies} />);

    expect(findExpoImages(tr.root).length).toBeGreaterThan(0);
    // Initials not shown yet
    expect(textContent(tr.root)).not.toContain('AN');
  });

  it('shows initials after onError fires on a broken avatar URL', () => {
    const buddies = [makeUser({ name: 'Alice Nomad', avatarUrl: 'https://example.com/broken.jpg' })];
    const tr = create(<BuddyPreview buddies={buddies} />);

    // Image should be rendered initially
    expect(findExpoImages(tr.root).length).toBeGreaterThan(0);

    fireOnError(tr.root);

    // Initials chip appears after error
    expect(textContent(tr.root)).toContain('AN');
    // expo-image is unmounted
    expect(findExpoImages(tr.root).length).toBe(0);
  });

  it('shows initials immediately when avatarUrl is null', () => {
    const buddies = [makeUser({ name: 'Bob Wander', avatarUrl: null as any })];
    const tr = create(<BuddyPreview buddies={buddies} />);

    // No expo-image mounted — null URL goes straight to initials
    expect(findExpoImages(tr.root).length).toBe(0);
    expect(textContent(tr.root)).toContain('BW');
  });

  it('shows each buddy\'s correct initials after their images fail', () => {
    const buddies = [
      makeUser({ id: 'u1', name: 'Carol Drift', avatarUrl: 'https://example.com/b1.jpg' }),
      makeUser({ id: 'u2', name: 'Dana Shore', avatarUrl: 'https://example.com/b2.jpg' }),
    ];
    const tr = create(<BuddyPreview buddies={buddies} />);

    // At least one image per buddy is shown initially
    expect(findExpoImages(tr.root).length).toBeGreaterThanOrEqual(2);

    // Fire onError on the first image
    fireOnError(tr.root, 0);
    // First avatar falls back to initials
    expect(textContent(tr.root)).toContain('CD');
  });

  it('count label reflects the full list length when some buddies have null avatarUrls', () => {
    // 3 buddies: one with a valid URL, two with null — the label must say "3 buddies"
    const buddies = [
      makeUser({ id: 'u1', name: 'Alice Nomad', avatarUrl: 'https://example.com/ok.jpg' }),
      makeUser({ id: 'u2', name: 'Bob Wander', avatarUrl: null as any }),
      makeUser({ id: 'u3', name: 'Carol Drift', avatarUrl: null as any }),
    ];
    const tr = create(<BuddyPreview buddies={buddies} />);

    // React renders `{buddies.length} buddies` as array children [3, " buddies"].
    // Normalise each node's children to a flat string before asserting.
    const flatTexts = textContent(tr.root).map((c) =>
      Array.isArray(c) ? (c as unknown[]).join('') : String(c),
    );
    // The label must use the full list length (3), not just the non-null subset (1)
    expect(flatTexts).toContain('3 buddies');
  });
});

// ── BuddyRow ──────────────────────────────────────────────────────────────────

describe('BuddyRow avatar fallback', () => {
  it('shows the expo-image while the URL is valid', () => {
    const buddies = [makeUser({ name: 'Eve Trek', avatarUrl: 'https://example.com/ok.jpg' })];
    const tr = create(<BuddyRow buddies={buddies} />);

    expect(findExpoImages(tr.root).length).toBeGreaterThan(0);
    expect(textContent(tr.root)).not.toContain('ET');
  });

  it('shows initials after onError fires on a broken avatar URL', () => {
    const buddies = [makeUser({ name: 'Eve Trek', avatarUrl: 'https://example.com/broken.jpg' })];
    const tr = create(<BuddyRow buddies={buddies} />);

    expect(findExpoImages(tr.root).length).toBeGreaterThan(0);

    fireOnError(tr.root);

    // Initials chip appears
    expect(textContent(tr.root)).toContain('ET');
    expect(findExpoImages(tr.root).length).toBe(0);
  });

  it('shows initials immediately when avatarUrl is null', () => {
    const buddies = [makeUser({ name: 'Frank Way', avatarUrl: null as any })];
    const tr = create(<BuddyRow buddies={buddies} />);

    expect(findExpoImages(tr.root).length).toBe(0);
    expect(textContent(tr.root)).toContain('FW');
  });

  it('shows each buddy\'s correct initials after their images fail', () => {
    const buddies = [
      makeUser({ id: 'u1', name: 'Grace Hill', avatarUrl: 'https://example.com/r1.jpg' }),
      makeUser({ id: 'u2', name: 'Henry Vale', avatarUrl: 'https://example.com/r2.jpg' }),
    ];
    const tr = create(<BuddyRow buddies={buddies} />);

    expect(findExpoImages(tr.root).length).toBeGreaterThanOrEqual(2);

    fireOnError(tr.root, 0);
    expect(textContent(tr.root)).toContain('GH');
  });

  it('renders at most 6 avatars even when given 10 buddies', () => {
    const buddies = [
      makeUser({ id: 'u1', name: 'Alpha One', avatarUrl: null as any }),
      makeUser({ id: 'u2', name: 'Beta Two', avatarUrl: null as any }),
      makeUser({ id: 'u3', name: 'Gamma Three', avatarUrl: null as any }),
      makeUser({ id: 'u4', name: 'Delta Four', avatarUrl: null as any }),
      makeUser({ id: 'u5', name: 'Epsilon Five', avatarUrl: null as any }),
      makeUser({ id: 'u6', name: 'Zeta Six', avatarUrl: null as any }),
      makeUser({ id: 'u7', name: 'Eta Seven', avatarUrl: null as any }),
      makeUser({ id: 'u8', name: 'Theta Eight', avatarUrl: null as any }),
      makeUser({ id: 'u9', name: 'Iota Nine', avatarUrl: null as any }),
      makeUser({ id: 'u10', name: 'Kappa Ten', avatarUrl: null as any }),
    ];
    const tr = create(<BuddyRow buddies={buddies} />);

    // Each rendered buddy shows their first name as a label.
    // With null avatarUrl each buddy also shows initials, so filter to
    // just the first-name tokens (single-word strings that match our fixture names).
    const firstNames = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa'];
    const texts = textContent(tr.root);
    const renderedFirstNames = texts.filter((t) => firstNames.includes(t as string));

    // Only the first 6 should appear; buddies 7-10 must be absent.
    expect(renderedFirstNames.length).toBe(6);
    expect(renderedFirstNames).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta']);

    // The 7th+ buddy names must not appear at all.
    expect(texts).not.toContain('Eta');
    expect(texts).not.toContain('Theta');
    expect(texts).not.toContain('Iota');
    expect(texts).not.toContain('Kappa');
  });
});
