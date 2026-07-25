/**
 * Component tests for TravelerAvatarMarker (exercised via TravelerClusterMarkers).
 *
 * Covered:
 *  (a) When useHydratedMedia returns a signed URL the Image source uses that
 *      signed URL — confirming the private-bucket hydration path is wired up.
 *  (b) When the Image fires onError the marker falls back to the initials disc
 *      — no blank circle, no crash.
 *
 * Uses react-test-renderer for prop inspection — RNTL v14 dropped
 * UNSAFE_getAllByType.  Follows the DisplayMediaImage.component.test.tsx
 * pattern already established in this project.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { Image, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

// ── Module mocks (must appear before any import that pulls the real module) ────

// MapLibre native modules are unavailable under jest-expo; stub the whole
// package.  Marker is a transparent passthrough so children render normally.
jest.mock('@maplibre/maplibre-react-native', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    Marker: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(View, { testID: 'map-marker' }, children),
  };
});

// NOTE: intentionally exhaustive — the real useHydratedMedia pulls batchSignUrls
// which makes network calls and imports Supabase internals; we control the
// resolved map entirely here to isolate the hydration wiring.
const mockHydrateMediaUrls = jest.fn(async (urls: string[]) => {
  const r: Record<string, string | null> = {};
  for (const u of urls) r[u] = u; // default: pass-through (flag-OFF fast path)
  return r;
});

jest.mock('../../../services/mediaUrl', () => {
  const React = require('react');
  return {
    useHydratedMedia: (urls: string[]) => {
      const [resolved, setResolved] = React.useState<Record<string, string | null>>({});
      const [loading, setLoading] = React.useState(false);
      const key = React.useMemo(() => {
        const unique = [...new Set(urls.filter(Boolean))].sort();
        return unique.join('\0');
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

// NOTE: intentionally exhaustive — tokens.ts imports a font loader that is
// unavailable under jest-expo; plain value stubs cover every style reference
// used inside TravelerMapLayer.
jest.mock('../../../theme/tokens', () => ({
  color: {
    deep: '#2A7F8F',
    haze: '#E8E8E8',
  },
}));

// NOTE: intentionally exhaustive — displayIdentity imports truncateDisplayName
// from utils/identity which itself may pull platform internals; a minimal stub
// is all that is needed for these tests.
jest.mock('../../../lib/displayIdentity', () => ({
  primaryIdentityText: ({
    displayName,
    handle,
  }: {
    displayName?: string | null;
    handle?: string | null;
  }) => displayName ?? (handle ? `@${handle}` : 'Traveler'),
}));

// ── Import under test (after mocks) ──────────────────────────────────────────

import { TravelerClusterMarkers } from '../TravelerMapLayer.tsx';
import type { MapTraveler } from '../../../services/mapTravelers.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PROFILE_MEDIA_URL =
  'https://example.supabase.co/storage/v1/object/public/profile-media/user-1/avatar.jpg';

const SIGNED_URL =
  'https://example.supabase.co/storage/v1/object/sign/profile-media/user-1/avatar.jpg?token=abc123';

const BASE_TRAVELER: MapTraveler = {
  id: 'traveler-1',
  handle: 'alice',
  displayName: 'Alice Wanderer',
  avatarUrl: PROFILE_MEDIA_URL,
  verified: false,
  openToMeet: true,
  city: 'Paris',
  country: 'FR',
  freshness: 'live',
  precision: 'city',
  lat: 48.8566,
  lng: 2.3522,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Mounts TravelerClusterMarkers with a single traveler at zoom=5 (well below
 * the z≥15 fan-out threshold) so the cluster always has exactly one item,
 * which exercises the TravelerAvatarMarker branch.
 */
function create(traveler: MapTraveler) {
  let tr!: TestRenderer.ReactTestRenderer;
  act(() => {
    tr = TestRenderer.create(
      <TravelerClusterMarkers
        travelers={[traveler]}
        zoom={5}
        onPressTraveler={jest.fn()}
        onPressCluster={jest.fn()}
      />,
    );
  });
  return tr;
}

function findImages(root: TestRenderer.ReactTestInstance) {
  try {
    return root.findAllByType(Image as any);
  } catch {
    return [];
  }
}

function textContent(root: TestRenderer.ReactTestInstance): string[] {
  try {
    return root.findAllByType(Text as any).map((n) => n.props.children as string);
  } catch {
    return [];
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TravelerAvatarMarker — signed-URL hydration and fallback', () => {
  beforeEach(() => {
    // Restore default pass-through between tests.
    mockHydrateMediaUrls.mockImplementation(async (urls: string[]) => {
      const r: Record<string, string | null> = {};
      for (const u of urls) r[u] = u;
      return r;
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('(a) calls useHydratedMedia with the avatar URL when avatarUrl is present', () => {
    // Synchronous check: the hook receives the profile-media URL on first render.
    const tr = create(BASE_TRAVELER);

    // At least one Image is mounted (the avatar) — hook received the URL.
    expect(findImages(tr.root).length).toBeGreaterThan(0);

    // The image source on first render is the plain URL (before resolution
    // settles), confirming the URL was passed into the hydration layer.
    const img = findImages(tr.root)[0];
    expect(img.props.source?.uri).toBe(PROFILE_MEDIA_URL);
  });

  it('(a) updates Image source to the signed URL once useHydratedMedia resolves', async () => {
    // Arrange: hydration resolves to the signed URL.
    mockHydrateMediaUrls.mockResolvedValueOnce({ [PROFILE_MEDIA_URL]: SIGNED_URL });

    let tr!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tr = TestRenderer.create(
        <TravelerClusterMarkers
          travelers={[BASE_TRAVELER]}
          zoom={5}
          onPressTraveler={jest.fn()}
          onPressCluster={jest.fn()}
        />,
      );
      // Allow the useHydratedMedia promise to settle.
      await Promise.resolve();
    });

    // After resolution the Image source must be the signed URL.
    const images = findImages(tr.root);
    expect(images.length).toBeGreaterThan(0);
    const avatarImg = images.find((img) => img.props.source?.uri === SIGNED_URL);
    expect(avatarImg).toBeTruthy();

    // Initials disc must NOT appear (image is shown).
    const initials = textContent(tr.root).filter((t) => t === 'AW');
    expect(initials).toHaveLength(0);
  });

  it('(b) shows initials fallback when the Image fires onError', async () => {
    // Arrange: hydration resolves to the signed URL.
    mockHydrateMediaUrls.mockResolvedValueOnce({ [PROFILE_MEDIA_URL]: SIGNED_URL });

    let tr!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tr = TestRenderer.create(
        <TravelerClusterMarkers
          travelers={[BASE_TRAVELER]}
          zoom={5}
          onPressTraveler={jest.fn()}
          onPressCluster={jest.fn()}
        />,
      );
      await Promise.resolve();
    });

    // Confirm the avatar image is showing the signed URL.
    const beforeImages = findImages(tr.root);
    const avatarImg = beforeImages.find((img) => img.props.source?.uri === SIGNED_URL);
    expect(avatarImg).toBeTruthy();

    // Simulate load failure.
    act(() => {
      const onError = avatarImg!.props.onError;
      expect(typeof onError).toBe('function');
      onError();
    });

    // After failure the initials disc must appear — "AW" from "Alice Wanderer".
    expect(textContent(tr.root)).toContain('AW');

    // And the signed-URL Image must be gone.
    const afterImages = findImages(tr.root).filter(
      (img) => img.props.source?.uri === SIGNED_URL,
    );
    expect(afterImages).toHaveLength(0);
  });

  it('(b) shows initials immediately when avatarUrl is null', () => {
    // Arrange: traveler has no avatar URL at all.
    const travelerNoAvatar: MapTraveler = {
      ...BASE_TRAVELER,
      avatarUrl: null,
      displayName: 'Bob Explorer',
    };

    const tr = create(travelerNoAvatar);

    // No Image should be mounted.
    expect(findImages(tr.root)).toHaveLength(0);

    // Initials for "Bob Explorer" = "BE".
    expect(textContent(tr.root)).toContain('BE');
  });
});
