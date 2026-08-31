/**
 * FullScreenMapScreen — passport error-card state-machine tests.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
 *
 * ## What's covered
 *
 * 1. While getPassportMap is in-flight, the loading card ("Loading your
 *    stamps…") is visible and the error card is absent.
 *
 * 2. When getPassportMap rejects, the error card ("Couldn't load your stamps")
 *    is visible and the loading card is absent.
 *
 * 3. Pressing "Tap to retry" re-triggers the fetch; when the second call
 *    resolves with ok:true + markers the error card disappears and a stamp
 *    entity card for the returned country is rendered.
 *
 * ## Mock strategy
 *
 * MapCarousel is replaced with a lightweight stand-in that mirrors the real
 * component's passportLoading / passportError / onPassportRetry branching
 * exactly — this avoids react-native-reanimated's native modules while still
 * exercising the state machine inside FullScreenMapScreen.
 *
 * All other heavy native dependencies (MapLibre, AskCompassBar, MapTopControls,
 * DiscoveryMapView) are stubbed to null so only the passport flow is tested.
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import FullScreenMapScreen from '../index.tsx';

// ── expo-router ────────────────────────────────────────────────────────────────
// The moduleNameMapper wires expo-router to the shared stub; override only the
// parts this test needs (useLocalSearchParams returning mode=passport).
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), dismiss: jest.fn() },
  useRouter:            () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({ mode: 'passport' }),
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

// ── react-native-safe-area-context ─────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── passportStamps service ─────────────────────────────────────────────────────
// getPassportMap is the seam under test; everything else is a no-op.
import { getPassportMap } from '../../../src/services/passportStamps.ts';

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/passportStamps', () => ({
  getPassportMap: jest.fn(),
  _setTestAuthToken: jest.fn(),
}));

const mockGetPassportMap = getPassportMap as jest.Mock;

// ── discovery service ──────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/discovery', () => ({
  getDiscoveryPlaces: jest.fn().mockResolvedValue({ ok: false }),
}));

// ── LocationContext ────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    setSessionLocation: jest.fn(),
    clearSessionLocation: jest.fn(),
    locationState: {
      coords: { lat: 14.5995, lng: 120.9842 },
      place:  { city: 'Manila', country: 'Philippines' },
      permissionStatus: 'granted',
    },
    // resolvedLocation — required by FullScreenMapScreen after location unification.
    resolvedLocation: {
      place:  { city: 'Manila', country: 'Philippines' },
      coords: { lat: 14.5995, lng: 120.9842 },
      source: 'home',
      freshness: 'live',
    },
    requireLocation: jest.fn(),
  }),
}));

// ── useMapEntities ─────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — the real hook calls Supabase real-time
// subscriptions that are unavailable under Jest.
jest.mock('../../../src/hooks/useMapEntities', () => ({
  useMapEntities: () => ({ entities: [], objects: [], liveEnrichment: null, loading: false, error: null, refresh: () => {}, source: 'legacy' }),
}));

// ── MapFilterSheet / loadEnabledLayers ─────────────────────────────────────────
// NOTE: intentionally exhaustive — the real sheet pulls AsyncStorage.
jest.mock('../../../src/components/map/MapFilterSheet', () => ({
  MapFilterSheet:   () => null,
  loadEnabledLayers: jest.fn().mockResolvedValue([]),
}));

// ── DiscoveryMapView (native MapLibre) ─────────────────────────────────────────
// NOTE: intentionally exhaustive — MapLibre native modules are not available
// under Jest; stub with a plain View so the map container renders without crashing.
jest.mock('../../../src/components/discovery/DiscoveryMapView', () => {
  const { View } = require('react-native');
  return {
    DiscoveryMapView: () => <View testID="map-view" />,
  };
});

// ── MapTopControls ─────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — uses native geolocation and camera internals.
jest.mock('../../../src/components/map/MapTopControls', () => ({
  MapTopControls: () => null,
}));

// ── AskCompassBar ──────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — depends on AI completion and native keyboard.
jest.mock('../../../src/components/map/AskCompassBar', () => ({
  AskCompassBar: () => null,
}));

// ── COUNTRY_CENTROIDS ──────────────────────────────────────────────────────────
// Provide a known entry for the test marker's country so buildPassportEntities
// can produce a stamp entity from the success response.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/lib/countryCentroids', () => ({
  COUNTRY_CENTROIDS: {
    Philippines: [12.8797, 121.774],
  },
}));

// ── MapCarousel — lightweight stand-in ────────────────────────────────────────
// Mirrors the real component's passportLoading / passportError / onPassportRetry
// branching without react-native-reanimated or native FlatList internals.
jest.mock('../../../src/components/map/MapCarousel', () => {
  const React = require('react');
  const { View, Text, Pressable } = require('react-native');

  const MapCarousel = React.forwardRef(
    (
      {
        entities,
        passportLoading,
        passportError,
        onPassportRetry,
      }: {
        entities: { id: string }[];
        passportLoading?: boolean;
        passportError?: string | null;
        onPassportRetry?: () => void;
      },
      _ref: unknown,
    ) => {
      if (entities.length === 0) {
        if (passportLoading) {
          return (
            <View testID="passport-loading-card">
              <Text>Loading your stamps…</Text>
            </View>
          );
        }
        if (passportError) {
          return (
            <View testID="passport-error-card">
              <Text>Couldn't load your stamps</Text>
              {onPassportRetry && (
                <Pressable
                  onPress={onPassportRetry}
                  accessibilityLabel="Retry loading passport stamps"
                  testID="retry-btn"
                >
                  <Text>Tap to retry</Text>
                </Pressable>
              )}
            </View>
          );
        }
      }
      // Entities present — render minimal stamp cards so the retry-success
      // assertion can detect them.
      return (
        <View testID="passport-carousel">
          {entities.map((e: { id: string }) => (
            <Text key={e.id} testID={`stamp-entity-${e.id}`}>
              {e.id}
            </Text>
          ))}
        </View>
      );
    },
  );
  MapCarousel.displayName = 'MapCarousel';
  return { MapCarousel };
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FullScreenMapScreen — passport error-card state machine', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows the loading card while the passport fetch is in-flight', async () => {
    // Never-resolving promise — fetch stays pending for the duration of the test.
    mockGetPassportMap.mockReturnValue(new Promise(() => {}));

    const view = await render(<FullScreenMapScreen />);

    // The loading card is intentionally deferred behind a 150 ms timer (see
    // app/map/index.tsx) to avoid a one-frame flicker when stamps resolve fast.
    // Fake timers corrupt the renderer in this suite (RENDERER RULE 2), so we
    // sleep past the REAL timer inside act() to let setPassportLoading(true)
    // commit.  The fetch promise never resolves, so the loading state persists.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150 + 400));
    });

    // Loading card must be visible once the deferred loading state commits.
    expect(view.getByText('Loading your stamps…')).toBeTruthy();

    // Error card must not be shown while still loading.
    expect(view.queryByText("Couldn't load your stamps")).toBeNull();

  });

  it('shows the error card when getPassportMap rejects', async () => {
    mockGetPassportMap.mockRejectedValue(new Error('Network timeout'));

    await render(<FullScreenMapScreen />);

    // Wait for the rejection to propagate through the useEffect.
    await waitFor(() => {
      expect(screen.getByText("Couldn't load your stamps")).toBeTruthy();
    });

    // Loading card must be gone once the error is set.
    expect(screen.queryByText('Loading your stamps…')).toBeNull();

  });

  it('shows the error card when getPassportMap returns ok:false', async () => {
    mockGetPassportMap.mockResolvedValue({ ok: false, message: 'Service unavailable' });

    await render(<FullScreenMapScreen />);

    await waitFor(() => {
      expect(screen.getByText("Couldn't load your stamps")).toBeTruthy();
    });

    expect(screen.queryByText('Loading your stamps…')).toBeNull();

  });

  it('clears the error card and renders stamp entities after a successful retry', async () => {
    // First call: simulate a network failure.
    mockGetPassportMap.mockRejectedValueOnce(new Error('Network timeout'));

    // Second call (retry): resolve with a Philippines marker.
    mockGetPassportMap.mockResolvedValueOnce({
      ok: true,
      data: {
        markers: [
          {
            country: 'Philippines',
            city: 'Manila',
            neighborhood: null,
            stampCount: 3,
            verificationLevel: 'verified',
            displayLabel: 'Philippines',
          },
        ],
        countries: ['Philippines'],
        cities: ['Manila'],
      },
    });

    await render(<FullScreenMapScreen />);

    // Wait for the initial failure to surface.
    await waitFor(() => {
      expect(screen.getByText("Couldn't load your stamps")).toBeTruthy();
    });

    // Press the retry button.
    fireEvent.press(screen.getByTestId('retry-btn'));

    // After retry resolves, the error card must be gone and the stamp entity
    // for Philippines must appear (id = "stamp:Philippines").
    await waitFor(() => {
      expect(screen.queryByText("Couldn't load your stamps")).toBeNull();
      expect(screen.getByTestId('stamp-entity-stamp:Philippines')).toBeTruthy();
    });

    // getPassportMap must have been called exactly twice (initial + retry).
    expect(mockGetPassportMap).toHaveBeenCalledTimes(2);

  });
});
