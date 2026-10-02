/**
 * PlaceCard — an expired why-now claim becomes explicitly stale ON SCREEN, at
 * the device's clock, while the card stays mounted.
 * census-discovery DSV2-04 (the client leg), §50.
 *
 * "Expired why-now claims disappear or become explicitly stale" is a statement
 * about what a person SEES, and the failure it guards against is a card that was
 * true when it was painted and is still on screen after it stopped being true.
 * `candidateProjection.expiry.component.test.ts` pins the arithmetic; this file
 * pins that the card actually re-renders AT the horizon — nothing else has to
 * re-render it — and that a page painted late (from the device cache) is judged
 * at the time it is painted, not the time it arrived.
 *
 * Reachable from: Explore tab → `app/(tabs)/discovery.tsx` → `ForYouTab` /
 * `DiscoveryCategoryTab` → `PlaceCard` → `DiscoveryCandidateChips`.
 *
 * Run with: pnpm test:component
 *
 * RNTL v14: render() is async — always await the mount helper.
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react-native';

// ── Module mocks — the same seam as PlaceCard.candidateProjection.component.test.tsx ──

// NOTE: intentionally exhaustive — the real discovery module imports Supabase
// native internals that crash under jest-expo; only the live-status function
// is needed and we control its return value entirely.
jest.mock('../../../services/discovery', () => ({
  getPlaceLiveStatusCached: jest.fn().mockResolvedValue(null),
}));

// NOTE: intentionally exhaustive — collections imports Supabase native modules
// that are not safe under jest-expo; only the stubs are needed here.
jest.mock('../../../services/collections', () => ({
  checkSaved: jest.fn().mockResolvedValue({ saved: false }),
  saveItem:   jest.fn().mockResolvedValue(true),
  unsaveItem: jest.fn().mockResolvedValue(true),
}));

// NOTE: intentionally exhaustive — discoveryBookmarks imports AsyncStorage
// (already globally mocked) and Supabase; the Set return is all that matters.
jest.mock('../../../services/discoveryBookmarks', () => ({
  getSavedListIds: jest.fn().mockResolvedValue(new Set()),
}));

// NOTE: intentionally exhaustive — the real PlanPickerController renders the
// full picker UI tree with Reanimated/portal internals; only isAdded is needed.
jest.mock('../../PlanPickerController', () => ({
  usePlanPicker: () => ({ open: jest.fn(), isAdded: () => false }),
}));

// NOTE: intentionally exhaustive — TripWishlistPicker pulls in its own service
// chain and Modal; stubbing to null prevents a secondary dependency cascade.
jest.mock('../TripWishlistPicker', () => ({
  TripWishlistPicker: () => null,
}));

// NOTE: intentionally exhaustive — expo-image pulls in native modules that
// crash under jest-expo; the card only needs something that renders children.
jest.mock('../../ui/DisplayMediaImage.tsx', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    DisplayMediaImage: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
      React.createElement(View, { testID: testID ?? 'display-media-image' }, children ?? null),
    MediaFallback: () => null,
  };
});

// NOTE: intentionally exhaustive — the FSQ photo hook performs network lookups;
// the projection under test has nothing to do with imagery.
jest.mock('../../../hooks/useFsqPhoto.ts', () => ({ useFsqPhoto: () => null }));

import { PlaceCard } from '../PlaceCard.tsx';
import type { DiscoveryPlace } from '../../../services/discovery.ts';

const T0 = 1_750_000_000_000;

const BASE_PLACE: DiscoveryPlace = {
  id: 'node/1',
  name: 'Sirao Flower Garden',
  category: 'nature',
  type: 'Garden',
  description: 'Terraced flower rows above the city.',
  distanceKm: 3.2,
  lat: 10.4,
  lng: 123.8,
  tags: [],
  address: 'Sirao',
  website: null,
  phone: null,
  openingHours: null,
  rating: null,
  isOpenNow: null,
};

/** A served projection whose why-now is valid for `validForMs` from `receivedAtMs`. */
function placeWithWhyNow(receivedAtMs: number, validForMs: number | undefined): DiscoveryPlace {
  return {
    ...BASE_PLACE,
    candidate: {
      id: 'node/1',
      whyNow: ['crowd_busy'],
      whyForUser: [],
      rankedBy: 'none',
      confidence: 0.6,
      freshness: { state: 'fresh', ageMs: 1000, servedFrom: 'L1' },
      truthClass: 'observed',
      provenance: null,
      reasons: [],
      ...(validForMs === undefined ? {} : { whyNowValidForMs: validForMs }),
      receivedAtMs,
    },
  } as DiscoveryPlace;
}

const noop = () => {};

async function mount(place: DiscoveryPlace) {
  return render(<PlaceCard place={place} onPress={noop} onAddToPlan={noop} />);
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers({ now: T0 });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('DSV2-04 — a why-now claim expires on screen, at the device clock', () => {
  it('is current until the horizon and flips to explicitly stale AT it, with nothing else re-rendering the card', async () => {
    await mount(placeWithWhyNow(T0, 5_000));
    await flush();

    expect(screen.getByTestId('candidate-why-now')).toBeTruthy();
    expect(screen.queryByTestId('candidate-why-now-stale')).toBeNull();

    // One millisecond before the horizon: still current.
    await act(async () => { jest.advanceTimersByTime(4_999); });
    expect(screen.queryByTestId('candidate-why-now-stale')).toBeNull();

    // The horizon itself: explicitly stale, in words, claim still visible.
    await act(async () => { jest.advanceTimersByTime(1); });
    expect(screen.getByTestId('candidate-why-now-stale')).toBeTruthy();
    expect(screen.getByText(/no longer current/i)).toBeTruthy();
    expect(screen.getByText(/crowd busy/i)).toBeTruthy();
  });

  it('a page painted from the device cache after its horizon renders the claim stale IMMEDIATELY', async () => {
    // Received ten minutes ago with a five-minute window — the 4-minute device
    // cache's stale-while-revalidate repaint is exactly this case.
    await mount(placeWithWhyNow(T0 - 10 * 60_000, 5 * 60_000));
    await flush();

    expect(screen.getByTestId('candidate-why-now-stale')).toBeTruthy();
  });

  it('a claim with NO validity on the wire is not shown at all — the truth chip still is', async () => {
    await mount(placeWithWhyNow(T0, undefined));
    await flush();

    expect(screen.getByTestId('candidate-truth-class')).toBeTruthy();
    expect(screen.queryByTestId('candidate-why-now')).toBeNull();
  });
});
