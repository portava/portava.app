/**
 * MemoriesTab — the four §15 Memories views this lane can build.
 *
 * §15 names FIVE views: Trips, Places, People, Timeline and Map. This file
 * proves FOUR of them render real, grouped content from real memory data:
 * Trips, Places, Timeline and Map. ("All" is the ungrouped grid those views are
 * views OF, not a sixth view.)
 *
 * **People is deliberately absent and this file asserts its absence**, so that
 * the gap is visible in the test output rather than silently forgotten:
 * `PassportMemory` carries no participant field, and the memory-participant
 * visibility contract belongs to the Highlights/Memories lane under
 * `artifacts/api-server/src/services/memory/`. FOUR OF FIVE DOES NOT CLOSE P77.
 *
 * Follows the MemoriesTab component-test mock discipline established by
 * MemoriesTab.timelineView.component.test.tsx: Modal becomes a synchronous
 * View, and every native/service dep the tree pulls is stubbed.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const R = require('react') as typeof import('react');
        return ({ children, visible }: { children?: React.ReactNode; visible?: boolean }) =>
          visible ? R.createElement(target.View as React.ComponentType, null, children) : null;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
});
// NOTE: intentionally exhaustive — expo-image-picker pulls native camera/permission modules unavailable in jest-expo; the picker is not exercised here.
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  launchImageLibraryAsync: jest.fn().mockResolvedValue({ canceled: true, assets: [] }),
  MediaTypeOptions: { Images: 'Images' },
}));
// NOTE: intentionally exhaustive — media.ts calls the API server + Supabase; not exercised by the view switcher under test.
jest.mock('../../services/media', () => ({ uploadMedia: jest.fn() }));
// NOTE: intentionally exhaustive — passportStamps reaches the API server + Supabase; only updatePassportMemory is touched (visibility change) and is stubbed.
jest.mock('../../services/passportStamps', () => ({
  createPassportMemory: jest.fn(),
  updatePassportMemory: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../CachedImage.tsx', () => {
  const R = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return { CachedImage: (p: Record<string, unknown>) => R.createElement(View as React.ComponentType, p) };
});
jest.mock('../ui/KeyboardSafeView', () => {
  const R = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return { KeyboardSafeView: ({ children }: { children: unknown }) => R.createElement(View, null, children) };
});
// NOTE: intentionally exhaustive — SharedVideoPlayer wraps expo-av (native AV); rendered inert here.
jest.mock('../ui/SharedVideoPlayer', () => ({ SharedVideoPlayer: () => null }));
// NOTE: intentionally exhaustive — VideoThumbnail decodes video frames via native modules; rendered inert here.
jest.mock('../ui/VideoThumbnail', () => ({ VideoThumbnail: () => null }));
// NOTE: intentionally exhaustive — MediaSourceSheet opens native camera/library pickers; rendered inert here.
jest.mock('../ui/MediaSourceSheet', () => ({ MediaSourceSheet: () => null }));
// NOTE: intentionally exhaustive — GlobalPlacePicker starts location work + safe-area reads on mount; rendered inert here.
jest.mock('../selectors/GlobalPlacePicker', () => ({ GlobalPlacePicker: () => null }));
// NOTE: intentionally exhaustive — overrides the GLOBAL maplibre stub from
// jest.config.js, which renders `Marker` as a childless <View /> and therefore
// swallows every pin. jest.config.js documents this per-file override as the
// supported way to "assert on map behaviour". Only Map/Camera/Marker are used
// by MemoriesMapView; Marker here renders its children so the pins are real
// nodes in the tree rather than an assumption.
jest.mock('@maplibre/maplibre-react-native', () => {
  const R = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return {
    Map: ({ children }: { children?: unknown }) =>
      R.createElement(View, { testID: 'maplibre-map' }, children),
    Camera: () => R.createElement(View, null),
    Marker: ({ children }: { children?: unknown }) => R.createElement(View, null, children),
  };
});

import { MemoriesTab } from '../MemoriesTab.tsx';
import type { PassportMemory } from '../../services/passportStamps.ts';
import type { TripRow } from '../../services/trips.ts';

function mem(over: Partial<PassportMemory>): PassportMemory {
  return {
    id: 'm', status: 'active', title: 'Untitled', description: null, country: null, city: null,
    neighborhood: null, category: null, visibility: 'public', verificationLevel: 'none',
    sourceType: null, photoUrl: null, mediaType: null, planId: null, tripId: null,
    suggestionReason: null, earnedAt: '2026-09-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z',
    ...over,
  } as PassportMemory;
}

function trip(over: Partial<TripRow>): TripRow {
  return {
    id: 't', ownerId: 'u', title: 'A Trip', destinationCity: 'Bangkok', destinationCountry: 'Thailand',
    neighborhoods: [], startDate: null, endDate: null, status: 'planning', visibility: 'private',
    travelStyle: null, openToMeet: false, coverUrl: null, coverMediaType: null, progress: 0,
    tripType: null, timezone: null, destinationLat: null, destinationLng: null,
    destinationPlaceId: null,
    ...over,
  } as TripRow;
}

const memories = [
  mem({ id: 'm-bkk', title: 'Sky Bar', city: 'Bangkok', country: 'Thailand', tripId: 't1', earnedAt: '2026-09-20T00:00:00Z' }),
  mem({ id: 'm-han', title: 'Beach Day', city: 'Hanoi', country: 'Vietnam', tripId: 't2', earnedAt: '2026-08-05T00:00:00Z' }),
];
const trips = [
  trip({ id: 't1', title: 'Songkran', destinationCity: 'Bangkok', destinationCountry: 'Thailand' }),
  trip({ id: 't2', title: 'Hanoi Week', destinationCity: 'Hanoi', destinationCountry: 'Vietnam' }),
];

function renderTab() {
  return render(<MemoriesTab memories={memories} onReload={jest.fn()} trips={trips} />);
}

it('offers the grid plus the four buildable §15 views, and NOT People', async () => {
  await renderTab();

  for (const mode of ['all', 'trips', 'places', 'timeline', 'map']) {
    expect(screen.getByTestId(`memories-view-${mode}`)).toBeTruthy();
  }
  // The fifth §15 view. Its absence is the requirement's remaining half and is
  // asserted so it cannot be quietly assumed built.
  expect(screen.queryByTestId('memories-view-people')).toBeNull();
});

it('Trips groups memories under their trip titles', async () => {
  await renderTab();
  fireEvent.press(screen.getByTestId('memories-view-trips'));

  expect(await screen.findByTestId('memories-view-trips-list')).toBeTruthy();
  expect(screen.getByTestId('memories-trips-header-t1')).toBeTruthy();
  expect(screen.getByTestId('memories-trips-header-t2')).toBeTruthy();
  expect(screen.getByText('Songkran')).toBeTruthy();
  expect(screen.getByText('Hanoi Week')).toBeTruthy();
  expect(screen.getByText('Sky Bar')).toBeTruthy();
  expect(screen.getByText('Beach Day')).toBeTruthy();
});

it('Places groups memories by city', async () => {
  await renderTab();
  fireEvent.press(screen.getByTestId('memories-view-places'));

  expect(await screen.findByTestId('memories-view-places-list')).toBeTruthy();
  expect(screen.getByTestId('memories-places-header-bangkok|thailand')).toBeTruthy();
  expect(screen.getByTestId('memories-places-header-hanoi|vietnam')).toBeTruthy();
  expect(screen.getByText('Bangkok')).toBeTruthy();
  expect(screen.getByText('Hanoi')).toBeTruthy();
});

it('Timeline still groups by month (unchanged by the new views)', async () => {
  await renderTab();
  fireEvent.press(screen.getByTestId('memories-view-timeline'));

  expect(await screen.findByTestId('memories-view-timeline-list')).toBeTruthy();
  expect(screen.getByText('September 2026')).toBeTruthy();
  expect(screen.getByText('August 2026')).toBeTruthy();
});

it('Map renders a real map with one pin per city', async () => {
  await renderTab();
  fireEvent.press(screen.getByTestId('memories-view-map'));

  expect(await screen.findByTestId('memories-view-map-list')).toBeTruthy();
  expect(screen.getByTestId('memories-map-view')).toBeTruthy();
  // The maplibre jest stub renders testID="maplibre-map" — so this asserts the
  // MAP ITSELF is mounted, not merely that a container div exists.
  expect(screen.getByTestId('maplibre-map')).toBeTruthy();
  expect(screen.getByTestId('memories-map-pin-bangkok|thailand')).toBeTruthy();
  expect(screen.getByTestId('memories-map-pin-hanoi|vietnam')).toBeTruthy();
});

it('Map states how many memories it cannot place instead of dropping them', async () => {
  await render(
    <MemoriesTab
      memories={[
        mem({ id: 'ok', title: 'Sky Bar', city: 'Bangkok', country: 'Thailand' }),
        mem({ id: 'nowhere', title: 'Somewhere', city: null }),
      ]}
      onReload={jest.fn()}
      trips={[]}
    />,
  );
  fireEvent.press(screen.getByTestId('memories-view-map'));

  const note = await screen.findByTestId('memories-map-unplotted');
  expect(note).toBeTruthy();
  expect(screen.getByText(/1 memory is not on the map/)).toBeTruthy();
});
