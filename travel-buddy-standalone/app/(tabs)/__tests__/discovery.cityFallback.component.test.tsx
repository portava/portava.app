/**
 * DiscoveryHub — what city the screen claims you are in.
 *
 * ## The defect
 *
 * `destination` and `debouncedDestination` were both seeded with
 * `locationState.place.city ?? 'Paris'`. The fallback applied to the city NAME
 * only: `destinationLat`/`destinationLng` immediately below resolve from
 * `locationState.coords` and fall back to null, never to Paris coordinates.
 *
 * So when GPS produced a fix whose reverse geocode returned no city name —
 * a real state the location layer models deliberately (buildGpsState discards
 * the previous place wholesale, activeLocation.state.ts:48, and :52 carries the
 * user message "We found your location, but couldn't name the city yet") — the
 * screen fetched content for the user's real coordinates and labelled it
 * "Paris". The owner saw exactly that while sitting in Asia.
 *
 * ## What these assertions hold
 *
 * The invariant the bug violated: **the city name and the coordinates come from
 * the same source, or neither is shown.** That is why every test below reads
 * the name and the coordinates together rather than checking the name alone —
 * a name-only assertion is what the original code would have passed.
 *
 * Assertions read the rendered tree. `destination` reaching ForYouTab and
 * DestinationBar is the whole observable behaviour; the state variable holding
 * a different value would change nothing on screen and is not what was wrong.
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import DiscoveryHub from '../discovery.tsx';

/** Every (destination, lat, lng) triple the tab has been rendered with. */
const tabProps: Array<{ destination?: string; lat?: number | null; lng?: number | null }> = [];

// ── expo-router ───────────────────────────────────────────────────────────────
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), dismiss: jest.fn() },
  useRouter:            () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
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
    navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn(),
    addListener: (_e: unknown, _cb: unknown) => () => {},
  }),
  Link:     ({ children }: { children: React.ReactNode }) => children,
  Redirect: () => null,
  Stack:    { Screen: () => null },
  Tabs:     { Screen: () => null },
}));

// ── react-native-safe-area-context ────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── Services ──────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/hashtag', () => ({
  getTrendingHashtags: jest.fn().mockResolvedValue({ ok: true, data: { trending: [] } }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/discovery', () => ({
  getDiscoveryCategoryCounts:      jest.fn().mockResolvedValue({}),
  getDiscoveryCategoryCountsBatch: jest.fn().mockResolvedValue({}),
}));

// NOTE: intentional stub — the trip-destination upgrade at discovery.tsx:527 is
// a SEPARATE fallback path; an empty list keeps it out of these assertions.
jest.mock('../../../src/services/trips', () => ({
  listMyTrips: jest.fn().mockResolvedValue([]),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/rentABuddy', () => ({
  getAvailableNow: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/featured', () => ({
  getFeaturedHub: jest.fn().mockResolvedValue({ ok: false }),
}));

// ── Hooks ─────────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  navBarProgress:         { value: 0 },
  NAV_BAR_FILLER_HEIGHT:  96,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useBottomInset', () => ({
  usePlainBottomInset: () => 130,
  PlainBottomFiller: () => null,
  BOTTOM_BREATHING_ROOM: 24,
  useStickyBarInset: () => ({ inset: 130, onBarLayout: () => {} }),
  useKeyboardVisible: () => false,
  useBottomInset: () => 130,
  useLayoverAwareBottomInset: () => 130,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useFollowingHighlights', () => ({
  useFollowingHighlights: () => ({
    users: [], sessionViewedIds: new Set<string>(), markSessionViewed: jest.fn(),
  }),
}));

// ── useRecentPlaces — the last-known-city source under test ──────────────────
// Mutable so each test controls what the user's last known city is. The real
// hook fetches /api/me/recent-places, so the network is not what is being
// exercised here — which recent place the screen picks, and whether it takes
// that place's coordinates with it, is.
let mockRecents: any[] = [];
// NOTE: intentionally exhaustive — the whole hook is replaced so `recents` can
// be driven per test. A requireActual spread would restore the real hook's
// mount fetch to /api/me/recent-places and make the fallback depend on network
// timing rather than on the value under test.
jest.mock('../../../src/hooks/useRecentPlaces', () => ({
  useRecentPlaces: () => ({
    recents: mockRecents, loading: false, saveRecent: jest.fn(), reload: jest.fn(),
  }),
}));

// ── Contexts ──────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ userId: 'user-test-1', isAuthed: true }),
}));

let mockLocationState: {
  place: { city: string | null; country: string | null };
  coords: { lat: number; lng: number } | null;
} = { place: { city: null, country: null }, coords: null };

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    setSessionLocation: jest.fn(),
    clearSessionLocation: jest.fn(),
    locationState: mockLocationState,
    resolvedLocation: {
      place:  mockLocationState.place,
      coords: mockLocationState.coords,
      source: 'gps_fresh',
      freshness: 'live',
    },
    showCityPicker: false,
    openCityPicker: jest.fn(),
    closeCityPicker: jest.fn(),
    setManualCity: jest.fn().mockResolvedValue(undefined),
    isLoading: false,
  }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PlanPickerController', () => ({
  usePlanPicker: () => ({ open: jest.fn() }),
}));

// ── Heavy sub-components ──────────────────────────────────────────────────────
const Null = () => null;

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/LayoverModeSheet', () => ({ LayoverModeSheet: Null }));
// NOTE: intentional stub — must stay exhaustive; the screen imports FilterStrip
// + SORT_LABELS from this module too (missing exports crash the filters panel).
jest.mock('../../../src/components/discovery/DiscoveryCategoryTab', () => ({
  DiscoveryCategoryTab: Null, FilterStrip: Null, SORT_LABELS: {},
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/PlaceDetailSheet', () => ({ PlaceDetailSheet: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CompassBuddyRow', () => ({ CompassBuddyRow: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ManualCityPicker', () => ({ ManualCityPicker: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/FollowingHighlightsStrip', () => ({ FollowingHighlightsStrip: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/RouteBuilderSheet', () => ({ RouteBuilderSheet: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/SubmitPlaceSheet', () => ({ SubmitPlaceSheet: Null }));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/SectionErrorBoundary', () => ({
  SectionErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

// ── Capture stubs: these render what the screen computed ─────────────────────
// Not spies. Each writes the value it received into the tree, so the assertions
// below read rendered output. The real DestinationBar pulls GlobalPlacePicker
// (and MapLibre through it), which is why it is stubbed rather than rendered.
jest.mock('../../../src/components/discovery/DestinationBar', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    DestinationBar: ({ destination }: { destination: string }) => (
      <Text testID="dest-bar">{destination === '' ? '(empty)' : destination}</Text>
    ),
  };
});

jest.mock('../../../src/components/discovery/ForYouTab', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    ForYouTab: (props: { destination?: string; lat?: number | null; lng?: number | null }) => {
      tabProps.push({ destination: props.destination, lat: props.lat, lng: props.lng });
      return (
        <Text testID="tab-coords">{`${props.destination ?? ''}|${props.lat ?? 'null'}|${props.lng ?? 'null'}`}</Text>
      );
    },
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function place(id: string, city: string | null, lat: number | null, lng: number | null) {
  return {
    id, type: 'city', name: city ?? id, displayName: city ?? id,
    country: null, countryCode: null, region: null, city, district: null,
    lat, lng, timezone: null, source: 'manual',
  };
}

/** What DestinationBar was last given. */
const shownCity = () => screen.getByTestId('dest-bar').props.children as string;
/** The last (destination, lat, lng) triple the tab received. */
const lastTriple = () => tabProps[tabProps.length - 1];

async function renderHub() {
  const view = await render(<DiscoveryHub />);
  await act(async () => {});
  return view;
}

beforeEach(() => {
  jest.clearAllMocks();
  tabProps.length = 0;
  mockRecents = [];
  mockLocationState = { place: { city: null, country: null }, coords: null };
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DiscoveryHub — no city is ever invented', () => {
  it('shows no city when nothing is known', async () => {
    // Pre-fix this rendered "Paris" with null coordinates.
    await renderHub();

    expect(shownCity()).toBe('(empty)');
    expect(lastTriple().destination).toBe('');
  });

  it('never falls back to Paris when GPS has coords but no city name', async () => {
    // The owner's exact sighting: a working fix in Asia whose reverse geocode
    // returned no city. Content was locally correct; the label said Paris.
    mockLocationState = {
      place: { city: null, country: 'Philippines' },
      coords: { lat: 14.5995, lng: 120.9842 },
    };

    await renderHub();

    expect(shownCity()).not.toBe('Paris');
    expect(shownCity()).toBe('(empty)');
  });

  it('never requests category counts for a city it invented', async () => {
    // `debouncedDestination` carried the same `?? 'Paris'` seed and is the value
    // the quota-limited counts request is built from. Unlike `destination` it
    // never reaches the tree, so its only observable effect is this outbound
    // call — which is why this one assertion reads a service mock rather than
    // rendered output. Pre-fix, mounting in Asia spent a Foursquare-backed
    // request on Paris.
    const { getDiscoveryCategoryCounts } = require('../../../src/services/discovery');
    mockLocationState = {
      place: { city: null, country: 'Philippines' },
      coords: { lat: 14.5995, lng: 120.9842 },
    };

    await renderHub();

    for (const call of (getDiscoveryCategoryCounts as jest.Mock).mock.calls) {
      expect(call[0]).not.toBe('Paris');
    }
  });

  it('uses the known city, with the coordinates that go with it', async () => {
    mockLocationState = {
      place: { city: 'Manila', country: 'Philippines' },
      coords: { lat: 14.5995, lng: 120.9842 },
    };

    await renderHub();

    expect(shownCity()).toBe('Manila');
    const { lat, lng } = lastTriple();
    expect(lat).toBeCloseTo(14.5995, 4);
    expect(lng).toBeCloseTo(120.9842, 4);
  });
});

describe('DiscoveryHub — the fallback is the last known city', () => {
  it('falls back to the most recent place that has a city', async () => {
    mockRecents = [place('r1', 'Cebu City', 10.316, 123.891)];

    await renderHub();

    expect(shownCity()).toBe('Cebu City');
  });

  it('brings that place own coordinates with the name', async () => {
    // The invariant the original bug broke. A name-only assertion here would
    // pass against a version that took the name from a recent place and left
    // the coordinates null — which is the same class of defect as 'Paris'.
    mockRecents = [place('r1', 'Cebu City', 10.316, 123.891)];

    await renderHub();

    const { destination, lat, lng } = lastTriple();
    expect(destination).toBe('Cebu City');
    expect(lat).toBeCloseTo(10.316, 3);
    expect(lng).toBeCloseTo(123.891, 3);
  });

  it('skips recent entries that carry no city name', async () => {
    // A recent place can be a venue or a region with a null city; falling back
    // to one would put an empty label back on screen while claiming success.
    mockRecents = [
      place('r0', null, 1.1, 2.2),
      place('r1', 'Bangkok', 13.756, 100.502),
    ];

    await renderHub();

    expect(shownCity()).toBe('Bangkok');
    const { lat } = lastTriple();
    expect(lat).toBeCloseTo(13.756, 3);
  });

  it('prefers a known city over the last known one', async () => {
    // The fallback must never outrank a real answer.
    mockLocationState = {
      place: { city: 'Manila', country: 'Philippines' },
      coords: { lat: 14.5995, lng: 120.9842 },
    };
    mockRecents = [place('r1', 'Cebu City', 10.316, 123.891)];

    await renderHub();

    expect(shownCity()).toBe('Manila');
    const { lat } = lastTriple();
    expect(lat).toBeCloseTo(14.5995, 4);
  });

  it('stays empty when there is no last known city either', async () => {
    // The directive's floor: with nothing to fall back to, prompt rather than
    // name any city at all.
    mockRecents = [place('r0', null, 1.1, 2.2)];

    await renderHub();

    expect(shownCity()).toBe('(empty)');
    expect(lastTriple().destination).toBe('');
  });
});
