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

import { TravelerClusterMarkers, clusterTravelers } from '../TravelerMapLayer.tsx';
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

// ── clusterTravelers — fan-out unit tests ─────────────────────────────────────

describe('clusterTravelers — fan-out at zoom ≥ 15', () => {
  /** Three travelers who all share the exact same city centroid. */
  const CENTROID_LAT = 48.8566;
  const CENTROID_LNG = 2.3522;

  const makeTraveler = (id: string): MapTraveler => ({
    id,
    handle: id,
    displayName: id,
    avatarUrl: null,
    verified: false,
    openToMeet: true,
    city: 'Paris',
    country: 'FR',
    freshness: 'live',
    precision: 'city',
    lat: CENTROID_LAT,
    lng: CENTROID_LNG,
  });

  const THREE_TRAVELERS = [
    makeTraveler('traveler-a'),
    makeTraveler('traveler-b'),
    makeTraveler('traveler-c'),
  ];

  it('returns 3 separate single-item clusters (fan-out, not one cluster) at zoom=15', () => {
    const clusters = clusterTravelers(THREE_TRAVELERS, 15);

    // All three must be fanned into individual clusters.
    expect(clusters).toHaveLength(3);
    clusters.forEach((c) => {
      expect(c.items).toHaveLength(1);
    });
  });

  it('fan positions all differ from the raw centroid', () => {
    const clusters = clusterTravelers(THREE_TRAVELERS, 15);

    clusters.forEach((c) => {
      // At least one coordinate must differ from the centroid — either lat or
      // lng (or both) is offset by the ring radius.
      const sameAsRaw = c.lat === CENTROID_LAT && c.lng === CENTROID_LNG;
      expect(sameAsRaw).toBe(false);
    });
  });

  it('fan positions are mutually distinct', () => {
    const clusters = clusterTravelers(THREE_TRAVELERS, 15);

    // No two fanned clusters share the same position.
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const same =
          clusters[i].lat === clusters[j].lat &&
          clusters[i].lng === clusters[j].lng;
        expect(same).toBe(false);
      }
    }
  });

  it('cluster keys are unique and contain "fan:" to identify fanned items', () => {
    const clusters = clusterTravelers(THREE_TRAVELERS, 15);

    const keys = clusters.map((c) => c.key);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(3);

    keys.forEach((k) => {
      expect(k).toContain('fan:');
    });
  });

  it('does NOT fan out at zoom=14 — stacked travelers merge into one cluster', () => {
    const clusters = clusterTravelers(THREE_TRAVELERS, 14);

    // Below zoom 15 the three travelers collapse into a single multi-item cluster.
    expect(clusters).toHaveLength(1);
    expect(clusters[0].items).toHaveLength(3);
  });
});

// ── TravelerClusterMarkers — fanned marker tap test ───────────────────────────

describe('TravelerClusterMarkers — tapping a fanned marker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fires onPressTraveler with the correct traveler when a fanned marker is tapped', () => {
    const CENTROID_LAT = 48.8566;
    const CENTROID_LNG = 2.3522;

    const makeTraveler = (id: string): MapTraveler => ({
      id,
      handle: id,
      displayName: id,
      avatarUrl: null,
      verified: false,
      openToMeet: true,
      city: 'Paris',
      country: 'FR',
      freshness: 'live',
      precision: 'city',
      lat: CENTROID_LAT,
      lng: CENTROID_LNG,
    });

    const travelers = [
      makeTraveler('traveler-a'),
      makeTraveler('traveler-b'),
      makeTraveler('traveler-c'),
    ];

    const onPressTraveler = jest.fn();
    const onPressCluster = jest.fn();

    let tr!: TestRenderer.ReactTestRenderer;
    act(() => {
      tr = TestRenderer.create(
        <TravelerClusterMarkers
          travelers={travelers}
          zoom={15}
          onPressTraveler={onPressTraveler}
          onPressCluster={onPressCluster}
        />,
      );
    });

    // At zoom=15 all three stacked travelers are fanned into individual
    // single-item clusters — each rendered as a TravelerAvatarMarker inside a
    // Pressable.
    //
    // TestRenderer's findAll traverses component fiber nodes AND host nodes.
    // The TravelerAvatarMarker element itself carries `onPress={onPressTraveler}`
    // as a JSX prop — calling that directly fires the mock with no traveler
    // argument (wrong).  We exclude any node whose onPress IS the mock itself
    // (those are the component fiber prop-forwarding nodes); the Pressable
    // wrapper closures are always a different reference: `() => onPress(t)`.
    const tappables = tr.root.findAll(
      (node) =>
        typeof node.props.onPress === 'function' &&
        node.props.onPress !== onPressTraveler &&
        node.props.onPress !== onPressCluster,
      { deep: true },
    );
    // There must be at least 3 tappable closures (one per fanned traveler).
    expect(tappables.length).toBeGreaterThanOrEqual(3);

    // Tap them all.  Duplicates from multi-depth traversal are expected; the
    // important assertion is which traveler payloads were fired.
    tappables.forEach((p) => {
      act(() => {
        p.props.onPress();
      });
    });

    // Every fanned traveler must have triggered onPressTraveler at least once.
    // (Duplicates from TestRenderer's multi-depth traversal are expected and
    // acceptable — the marker is reachable and passes the right payload.)
    expect(onPressTraveler).toHaveBeenCalled();

    const calledIds = onPressTraveler.mock.calls.map(
      ([t]: [MapTraveler]) => t.id,
    );
    const uniqueCalledIds = [...new Set(calledIds)];
    // All three fanned travelers must appear in the calls.
    expect(uniqueCalledIds.sort()).toEqual(['traveler-a', 'traveler-b', 'traveler-c']);

    // Cluster press handler must not have been fired.
    expect(onPressCluster).not.toHaveBeenCalled();
  });
});
