/**
 * LayoverMapCard — the airport element, and stop-pin taps.
 *
 * ── CENSUS L123: *"Map element Airport — always visible; return CTA anchor"* ─
 * Two defects, both closed, and THIS FILE PINNED THE SECOND ONE AS CORRECT
 * until now. The case below titled "passes the airport pin place to
 * PlaceDetailSheet when the airport is tapped" asserted, in the requirement's
 * own words, that the airport is NOT a return CTA anchor: it opened the generic
 * place sheet — the one that offers "add to plan" — for the airport the
 * traveller has to get back to. It is rewritten rather than deleted, and the
 * fact that it used to pass is recorded here rather than quietly dropped.
 *
 * The first defect had no test at all: the whole card `return null`-ed when the
 * airport had no coordinates or coordinates of exactly (0,0), which is what
 * `buildFallbackProfile` writes for every airport missing from
 * `airport_profiles`. "Always visible" was false for an entire class of
 * airports and nothing here noticed.
 *
 * ── MUTATIONS RUN, each against PRODUCTION code, reverted and `cmp`-verified ─
 * Measured over the whole layover client suite (6 files, 51 cases, 51 green
 * unmutated), because these components only matter mounted:
 *   1. `if (!hasAirportCoords) return null` restored ............... 7 failed
 *   2. the airport tap falling back to `PlaceDetailSheet` .......... 1 failed
 *   3. an ended layover offered a dead return button ............... 1 failed
 *   4. the footer never switching its primary CTA (L42) ............ 3 failed
 *   5. the map card mounted but handed no return facts ............. 1 failed
 *   6. the shared double-press ref guard removed ................... 3 failed
 *   7. the anchor's minutes invented instead of the server's ....... 1 failed
 *
 * Confirms that tapping a stop pin in the layover map card opens
 * PlaceDetailSheet with the tapped place — onSelectPlace is no longer a no-op.
 *
 * Mock strategy:
 * - DiscoveryMapView is replaced with a stub that captures onSelectPlace.
 * - PlaceDetailSheet is replaced with a stub that renders a testID indicator
 *   when visible=true, so the test can assert the sheet opened.
 *
 * NOTE: PlaceDetailSheet is mocked with its .tsx extension because
 * LayoverMapCard.tsx imports it as '../discovery/PlaceDetailSheet.tsx'
 * (explicit extension), so the jest module key must match.
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { LayoverMapCard } from '../LayoverMapCard.tsx';

// ── react-native-safe-area-context ─────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── expo-router ────────────────────────────────────────────────────────────────
// NOTE: intentional stub — LayoverMapCard only needs router; all nav calls are
// irrelevant here, so a full requireActual spread would pull in native modules.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  usePathname: () => '/',
  useSegments: () => [],
  Link: ({ children }: { children: React.ReactNode }) => children,
  Redirect: () => null,
}));

// ── DiscoveryMapView — captures onSelectPlace prop ─────────────────────────────
// NOTE: intentional stub — MapLibre native modules are unavailable under Jest.
let capturedOnSelectPlace: ((place: any) => void) | null = null;

jest.mock('../../discovery/DiscoveryMapView', () => {
  const { View } = require('react-native');
  return {
    DiscoveryMapView: (props: any) => {
      capturedOnSelectPlace = props.onSelectPlace;
      return <View testID="layover-map-view" />;
    },
  };
});

// ── PlaceDetailSheet — visible indicator stub ──────────────────────────────────
// NOTE: must mock with .tsx extension to match the source import path:
// `import { PlaceDetailSheet } from '../discovery/PlaceDetailSheet.tsx'`
// NOTE: intentional stub — avoids pulling in services/collections/discovery.
jest.mock('../../discovery/PlaceDetailSheet.tsx', () => {
  const { View, Text } = require('react-native');
  return {
    PlaceDetailSheet: ({ visible, place }: { visible: boolean; place: any }) =>
      visible && place ? (
        <View testID="place-detail-sheet">
          <Text testID="place-detail-name">{place.name}</Text>
        </View>
      ) : null,
  };
});

// ── Test fixture ───────────────────────────────────────────────────────────────

const AIRPORT = {
  iataCode: 'BKK',
  name: 'Suvarnabhumi Airport',
  city: 'Bangkok',
  country: 'TH',
  lat: 13.6811,
  lng: 100.7476,
  timezone: 'Asia/Bangkok',
};

// DiscoveryPlace that DiscoveryMapView calls onSelectPlace with on pin tap.
const TEST_STOP_PLACE = {
  id: 'stop-101',
  name: 'Chatuchak Market',
  category: 'activity',
  lat: 13.7999,
  lng: 100.5500,
  type: null,
  description: null,
  distanceKm: null,
  tags: [],
  address: '587/10 Kamphaeng Phet 2 Rd',
  website: null,
  phone: null,
  openingHours: null,
  rating: null,
  isOpenNow: null,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LayoverMapCard — stop pin tap opens PlaceDetailSheet', () => {
  beforeEach(() => {
    capturedOnSelectPlace = null;
  });

  it('renders the map and passes a real onSelectPlace handler to DiscoveryMapView', async () => {
    await render(<LayoverMapCard airport={AIRPORT as any} stops={[]} />);

    // DiscoveryMapView must be mounted.
    expect(screen.getByTestId('layover-map-view')).toBeTruthy();

    // The captured callback must be a real function, not the old no-op () => {}.
    expect(capturedOnSelectPlace).not.toBeNull();
    expect(typeof capturedOnSelectPlace).toBe('function');
  });

  it('opens PlaceDetailSheet when onSelectPlace is called with a stop place', async () => {
    await render(<LayoverMapCard airport={AIRPORT as any} stops={[]} />);

    // Ensure the component mounted and the callback was captured.
    await screen.findByTestId('layover-map-view');
    expect(capturedOnSelectPlace).not.toBeNull();

    // Sheet is initially closed.
    expect(screen.queryByTestId('place-detail-sheet')).toBeNull();

    // Simulate a stop pin tap. await act(async) ensures React 19 flushes the
    // setSelectedPlace + setPlaceSheetVisible state updates before assertions.
    await act(async () => {
      capturedOnSelectPlace!(TEST_STOP_PLACE);
    });

    // PlaceDetailSheet must now be visible with the tapped place's name.
    await waitFor(() => {
      expect(screen.getByTestId('place-detail-sheet')).toBeTruthy();
    });
    expect(screen.getByText('Chatuchak Market')).toBeTruthy();
  });

  it('the AIRPORT pin does NOT open the generic place sheet — it opens the return sheet', async () => {
    // THE REWRITTEN CASE. Its previous form asserted the opposite and passed,
    // which is how L123's second half survived a test file named after it.
    const airportPlace = {
      id: 'airport-BKK',
      name: 'BKK — Suvarnabhumi Airport',
      category: 'transport',
      lat: 13.6811,
      lng: 100.7476,
      type: null,
      description: null,
      distanceKm: null,
      tags: [],
      address: 'Bangkok',
      website: null,
      phone: null,
      openingHours: null,
      rating: null,
      isOpenNow: null,
    };

    await render(<LayoverMapCard airport={AIRPORT as any} stops={[]} airportReturn={anchor()} />);

    await screen.findByTestId('layover-map-view');
    expect(capturedOnSelectPlace).not.toBeNull();

    await act(async () => {
      capturedOnSelectPlace!(airportPlace);
    });

    await waitFor(() => {
      expect(screen.getByTestId('layover-map-airport-sheet')).toBeTruthy();
    });
    expect(screen.queryByTestId('place-detail-sheet')).toBeNull();
    expect(screen.getByTestId('layover-map-airport-return-btn')).toBeTruthy();
  });
});

// ── L123, first half: ALWAYS VISIBLE ────────────────────────────────────────

const NO_COORDS = {
  iataCode: 'ZZZ',
  name: 'ZZZ Airport',
  city: 'Unknown',
  country: 'Unknown',
  lat: 0,
  lng: 0,
  timezone: 'UTC',
};

function anchor(over: Partial<Record<string, unknown>> = {}) {
  return {
    hardReturnTime: '2026-09-08T13:40:00.000Z',
    minutesToHardReturn: 95,
    returnState: 'RETURN_SOON',
    canReturn: true,
    busy: false,
    onReturnNow: jest.fn(),
    ...over,
  } as any;
}

describe('LayoverMapCard — the airport element is always visible', () => {
  it('a buildFallbackProfile airport at (0,0) still gets a card, an airport and an explanation', async () => {
    // THE DEFECT: this rendered NOTHING. Production holds 3,206 airport rows
    // and every session that misses them runs on buildFallbackProfile, whose
    // lat/lng default to 0 — so "always visible" was false for all of them.
    await render(<LayoverMapCard airport={NO_COORDS as any} stops={[]} airportReturn={anchor()} />);

    expect(screen.getByTestId('layover-map-card')).toBeTruthy();
    expect(screen.getByTestId('layover-map-airport')).toBeTruthy();
    expect(screen.getByTestId('layover-map-no-coordinates')).toBeTruthy();
    // Degraded VISIBLY: there is no map, and the card says why rather than
    // leaving a hole where a map would be.
    expect(screen.queryByTestId('layover-map-view')).toBeNull();
  });

  it('a null-coordinate airport is the same case, not a crash', async () => {
    const nulled = { ...NO_COORDS, lat: null, lng: null };
    await render(<LayoverMapCard airport={nulled as any} stops={[]} airportReturn={anchor()} />);
    expect(screen.getByTestId('layover-map-airport')).toBeTruthy();
    expect(screen.getByTestId('layover-map-no-coordinates')).toBeTruthy();
  });

  it('the airport element carries the certified deadline even with no map to put it on', async () => {
    await render(<LayoverMapCard airport={NO_COORDS as any} stops={[]} airportReturn={anchor()} />);
    expect(screen.getByTestId('layover-map-airport-deadline')).toBeTruthy();
  });
});

// ── L123, second half: RETURN CTA ANCHOR ────────────────────────────────────

describe('LayoverMapCard — the airport element anchors the return CTA', () => {
  it('tapping the airport ROW opens the return sheet and fires the screen\'s one abort', async () => {
    const onReturnNow = jest.fn();
    await render(
      <LayoverMapCard airport={NO_COORDS as any} stops={[]} airportReturn={anchor({ onReturnNow })} />,
    );

    fireEvent.press(screen.getByTestId('layover-map-airport'));
    await waitFor(() => expect(screen.getByTestId('layover-map-airport-sheet')).toBeTruthy());
    expect(screen.getByTestId('layover-map-airport-sheet-time')).toBeTruthy();

    fireEvent.press(screen.getByTestId('layover-map-airport-return-btn'));
    expect(onReturnNow).toHaveBeenCalledTimes(1);
  });

  it('while the abort is in flight the control is disabled, so two taps are one POST', async () => {
    const onReturnNow = jest.fn();
    await render(
      <LayoverMapCard
        airport={NO_COORDS as any}
        stops={[]}
        airportReturn={anchor({ onReturnNow, busy: true })}
      />,
    );
    fireEvent.press(screen.getByTestId('layover-map-airport'));
    await waitFor(() => expect(screen.getByTestId('layover-map-airport-sheet')).toBeTruthy());
    fireEvent.press(screen.getByTestId('layover-map-airport-return-btn'));
    expect(onReturnNow).not.toHaveBeenCalled();
  });

  it('an ENDED layover offers no return control, and says so instead of a dead button', async () => {
    await render(
      <LayoverMapCard
        airport={NO_COORDS as any}
        stops={[]}
        airportReturn={anchor({ canReturn: false })}
      />,
    );
    fireEvent.press(screen.getByTestId('layover-map-airport'));
    await waitFor(() => expect(screen.getByTestId('layover-map-airport-sheet')).toBeTruthy());
    expect(screen.queryByTestId('layover-map-airport-return-btn')).toBeNull();
    expect(screen.getByTestId('layover-map-airport-inactive')).toBeTruthy();
  });

  it('with no certified return the sheet says so rather than inventing a deadline', async () => {
    await render(<LayoverMapCard airport={NO_COORDS as any} stops={[]} />);
    fireEvent.press(screen.getByTestId('layover-map-airport'));
    await waitFor(() => expect(screen.getByTestId('layover-map-airport-sheet')).toBeTruthy());
    expect(screen.getByTestId('layover-map-airport-no-deadline')).toBeTruthy();
    expect(screen.queryByTestId('layover-map-airport-deadline')).toBeNull();
  });
});
