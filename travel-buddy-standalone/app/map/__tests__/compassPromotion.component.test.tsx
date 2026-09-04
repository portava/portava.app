/**
 * FullScreenMapScreen — the §14 Compass rung must survive §31 promotion.
 *
 * ## The defect this pins
 *
 * `compassMapModel.toMapObjects` stamps every pick with
 * `RENDERING_PRIORITY.compass_recommendation` (70). `prepareForRender` then
 * runs `promoteAll`, and `explainPriority` seeds from
 * `KIND_DEFAULT_PRIORITY[obj.kind]` — it never reads the object's own
 * `renderingPriority`. The ONLY channel that restores the rung is
 * `PromotionContext.compassRecommendationIds`, and this screen never supplied
 * it. So a pick of kind `place` was silently rewritten from 70 down to
 * `relevant_place` (40) before collision resolution, losing collisions to
 * ordinary events (60) and live zones (50) that §31 says it outranks — and
 * picks of different kinds landed on different rungs, so "these are the N
 * picks" stopped being one tier.
 *
 * `collision.test.ts` passed throughout, because it hands
 * `compassRecommendationIds` to `promotePriority` directly. That is exactly the
 * shape of a green suite over an unreached code path: the rung was proven, the
 * wiring that reaches it never existed.
 *
 * ## Why the assertion reads the promotion context
 *
 * The observable end-state (which marker a collision drops) depends on viewport
 * maths and marker geometry that would make this test about `resolveCollisions`
 * rather than about this screen. What the screen owes is the CONTEXT, so the
 * spy captures the context `prepareForRender` is actually called with. Pre-fix
 * `compassRecommendationIds` is `undefined` there.
 */
import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react-native';
import type { MapEntity } from '../../../src/types/mapTypes.ts';
import FullScreenMapScreen from '../index.tsx';

// ── expo-router ───────────────────────────────────────────────────────────────
// zoom=17 puts the render band at 'venue' so §17 does not filter a `place` out
// before it can reach prepareForRender at all.
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router:               { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), dismiss: jest.fn() },
  useRouter:            () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({ zoom: '17' }),
  usePathname:          () => '/',
  useSegments:          () => [],
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, []);
  },
  useNavigation: () => ({
    navigate:    jest.fn(),
    goBack:      jest.fn(),
    setOptions:  jest.fn(),
    addListener: (_e: unknown, _cb: unknown) => () => {},
  }),
  Link:     ({ children }: { children: React.ReactNode }) => children,
  Redirect: () => null,
  Stack:    { Screen: () => null },
  Tabs:     { Screen: () => null },
}));

// ── collision — real module, with prepareForRender under a spy ────────────────
// requireActual so promoteAll / zoomRenderBand / isKindVisibleAtBand and the new
// compassRecommendationIdsOf all keep their real behaviour; only the call is
// recorded.
jest.mock('../../../src/features/map/render/collision', () => {
  const actual = jest.requireActual('../../../src/features/map/render/collision');
  const calls: Array<{ objects: unknown[]; opts: Record<string, unknown> }> = [];
  return {
    ...actual,
    __calls: calls,
    prepareForRender: (objects: unknown[], opts: Record<string, unknown>) => {
      calls.push({ objects, opts });
      return actual.prepareForRender(objects, opts);
    },
  };
});

// ── react-native-safe-area-context ────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/passportStamps', () => ({
  getPassportMap:    jest.fn().mockResolvedValue({ ok: false }),
  _setTestAuthToken: jest.fn(),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/discovery', () => ({
  getDiscoveryPlaces: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    locationState: {
      coords:           { lat: 14.5995, lng: 120.9842 },
      place:            { city: 'Manila', country: 'Philippines' },
      permissionStatus: 'granted',
    },
    resolvedLocation: {
      place:     { city: 'Manila', country: 'Philippines' },
      coords:    { lat: 14.5995, lng: 120.9842 },
      source:    'home',
      freshness: 'live',
    },
    requireLocation: jest.fn(),
  }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/map/MapFilterSheet', () => ({
  MapFilterSheet:    () => null,
  loadEnabledLayers: jest.fn().mockResolvedValue([]),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/map/MapTopControls', () => ({
  MapTopControls: () => null,
}));

// ── AskCompassBar — exposes onResults so a Compass answer can be delivered ────
// The real bar runs a network round-trip and its own parsing; reaching
// handleCompassResults through it would test AskCompassBar, not this screen's
// wiring. The handler is captured and invoked directly instead.
jest.mock('../../../src/components/map/AskCompassBar', () => {
  const React = require('react');
  const { View } = require('react-native');
  const holder: { onResults?: (entities: unknown[], query: string) => void } = {};
  return {
    __holder: holder,
    AskCompassBar: (props: { onResults?: (entities: unknown[], query: string) => void }) => {
      holder.onResults = props.onResults;
      return <View testID="ask-compass-bar" />;
    },
  };
});

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/lib/countryCentroids', () => ({
  COUNTRY_CENTROIDS: {},
}));

// map_search_enabled gates whether AskCompassBar renders at all. Without it on,
// the screen never mounts the bar and no Compass answer can arrive.
jest.mock('../../../src/context/FeatureFlagsContext', () => ({
  ...jest.requireActual('../../../src/context/FeatureFlagsContext'),
  useFeatureFlags: () => ({
    isEnabled: (flag: string) => flag === 'map_search_enabled',
    flags: { map_search_enabled: true },
    loading: false,
    error: null,
    refresh: () => {},
  }),
}));

// NOTE: intentional stub — the real component pulls native MapLibre.
jest.mock('../../../src/components/discovery/DiscoveryMapView', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { DiscoveryMapView: () => <View testID="map-view" /> };
});

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/map/MapCarousel', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MapCarousel = React.forwardRef((_p: unknown, ref: React.Ref<unknown>) => {
    React.useImperativeHandle(ref, () => ({ scrollToIndex: jest.fn() }));
    return <View testID="map-carousel" />;
  });
  MapCarousel.displayName = 'MapCarousel';
  return { MapCarousel };
});

// NOTE: intentional stub — the Compass picks are the objects under test, so the
// default entity feed stays empty.
jest.mock('../../../src/hooks/useMapEntities', () => ({
  useMapEntities: () => ({
    entities: [], objects: [], liveEnrichment: null,
    loading: false, error: null, refresh: () => {}, source: 'legacy',
  }),
}));

// ── Shared test data ──────────────────────────────────────────────────────────

/**
 * One Compass answer. `kind` is left off the payload so toMapObjects defaults to
 * `place` — the kind whose default rung (relevant_place, 40) is BELOW the
 * Compass rung (70), which is what makes the demotion observable.
 */
const COMPASS_ENTITIES: MapEntity[] = [
  {
    id: 'place:cafe-1',
    type: 'places',
    lat: 14.5995,
    lng: 120.9842,
    payload: { title: 'Rooftop cafe' },
  } as unknown as MapEntity,
];

const COMPASS_PICK_OBJECT_ID = 'place:cafe-1';

function collisionCalls(): Array<{ objects: unknown[]; opts: Record<string, unknown> }> {
  const mod = jest.requireMock('../../../src/features/map/render/collision') as {
    __calls: Array<{ objects: unknown[]; opts: Record<string, unknown> }>;
  };
  return mod.__calls;
}

function lastPromotion(): Record<string, unknown> {
  const calls = collisionCalls();
  expect(calls.length).toBeGreaterThan(0);
  const opts = calls[calls.length - 1].opts as { promotion?: Record<string, unknown> };
  return opts.promotion ?? {};
}

/** Delivers a Compass answer exactly as AskCompassBar would. */
async function answerCompass() {
  const { __holder } = jest.requireMock('../../../src/components/map/AskCompassBar') as {
    __holder: { onResults?: (entities: unknown[], query: string) => void };
  };
  expect(typeof __holder.onResults).toBe('function');
  await act(async () => {
    __holder.onResults!(COMPASS_ENTITIES, 'rooftop cafe');
  });
}

// handleCompassResults also kicks off geocodeAndFly, which hits Nominatim. A
// test that reaches the network is a test that fails on a slow CI box for a
// reason that has nothing to do with what it asserts.
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => [],
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  collisionCalls().length = 0;
});

describe('FullScreenMapScreen — Compass picks keep the §31 Compass rung', () => {
  it('names the Compass picks in the promotion context', async () => {
    await render(<FullScreenMapScreen />);
    await waitFor(() => expect(screen.getByTestId('map-view')).toBeTruthy());

    await answerCompass();

    // Pre-fix this key was absent entirely: the screen passed only selectedId
    // and navigationTargetId, so promoteAll had no way to know a Compass pick
    // from an ordinary place.
    expect(lastPromotion().compassRecommendationIds).toContain(COMPASS_PICK_OBJECT_ID);
  });

  it('keeps the pick at compass_recommendation through prepareForRender', async () => {
    const { RENDERING_PRIORITY } = jest.requireActual('../../../src/types/mapObjects');
    const { promoteAll } = jest.requireActual('../../../src/features/map/render/collision');

    await render(<FullScreenMapScreen />);
    await waitFor(() => expect(screen.getByTestId('map-view')).toBeTruthy());

    await answerCompass();

    const call = collisionCalls()[collisionCalls().length - 1];
    const pick = (call.objects as Array<{ id: string }>).find(
      (o) => o.id === COMPASS_PICK_OBJECT_ID,
    );
    expect(pick).toBeTruthy();

    // The rung the screen's own promotion context actually produces. Pre-fix
    // this collapses to RENDERING_PRIORITY.relevant_place (40).
    const promoted = promoteAll(call.objects, call.opts.promotion) as Array<{
      id: string;
      renderingPriority: number;
    }>;
    const promotedPick = promoted.find((o) => o.id === COMPASS_PICK_OBJECT_ID);
    expect(promotedPick?.renderingPriority).toBe(RENDERING_PRIORITY.compass_recommendation);
  });
});
