/**
 * PlaceDetailSheet — discovery-surface outcome reporting.
 *
 * The sheet is shared: the Discover screen and ForYouTab open it for places
 * served under rank_events surface 'discovery'; the Layover map card opens it
 * for plan stops that were never served by a ranker. The owner passes
 * `rankSurface`; the sheet must report under exactly that and stay silent
 * without it.
 *
 * What this pins:
 *   • hook constructed with { surface: 'discovery' } / { surface: null }
 *   • tap  — Directions
 *   • save — the header bookmark, ONLY when toggleSave resolved to "now saved";
 *            a toggle that resolves unsaved reports nothing
 *   • save — a trip-wishlist add via TripWishlistPicker.onSaved
 *   • Plan reports nothing (intent — opens a picker in the parent)
 *
 * ## Modal strategy
 * PlaceDetailSheet IS a Modal. The Modal Proxy replaces react-native's Modal
 * with a synchronous View so act() scopes don't overlap.
 * Must be declared before any imports that touch react-native.
 *
 * Run with: pnpm test:component
 */

// NOTE: Modal Proxy — must be hoisted above all react-native imports.
// Avoids overlapping act() from Modal animation lifecycle — see
// .agents/memory/modal-proxy-mock.md.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({ children, visible }: { children: React.ReactNode; visible: boolean }) =>
    visible ? R.createElement(actual.View, null, children) : null;
  return new Proxy(actual, {
    get(target: typeof actual, prop: string, receiver: unknown) {
      if (prop === 'Modal') return MockModal;
      return Reflect.get(target, prop, receiver);
    },
  });
});

import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { PlaceDetailSheet } from '../PlaceDetailSheet.tsx';
import type { DiscoveryPlace } from '../../../services/discovery.ts';

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockReportTap  = jest.fn();
const mockReportSave = jest.fn();
const mockUseRankOutcome = jest.fn(() => ({
  reportTap:  mockReportTap,
  reportSave: mockReportSave,
  reportJoin: jest.fn(),
  reportRsvp: jest.fn(),
}));
// NOTE: intentionally exhaustive — the real hook posts through fetch; these
// tests assert on what the sheet hands the hook and which report it calls
// (useRankOutcome.component.test.ts covers the wire).
jest.mock('../../../hooks/useRankOutcome', () => ({
  useRankOutcome: (...args: unknown[]) => mockUseRankOutcome(...(args as [])),
}));

// NOTE: intentionally exhaustive — the real discovery module imports Supabase
// native internals; both lookups resolve to "nothing".
jest.mock('../../../services/discovery', () => ({
  getPlaceLiveStatus:    jest.fn().mockResolvedValue(null),
  getWikidataEnrichment: jest.fn().mockResolvedValue(null),
}));

const mockToggleSave = jest.fn(async () => true);
// NOTE: intentionally exhaustive — collections imports Supabase native modules
// that are not safe under jest-expo; toggleSave's resolution is controlled
// per test because the outcome must follow it.
jest.mock('../../../services/collections', () => ({
  checkSaved: jest.fn().mockResolvedValue({ saved: false }),
  toggleSave: (...a: unknown[]) => mockToggleSave(...(a as [])),
}));

// NOTE: intentionally exhaustive — TripWishlistPicker has its own Modal chain.
// This stub renders one trigger that invokes onSaved the way the real picker
// does AFTER the API accepted the add.
jest.mock('../TripWishlistPicker', () => ({
  TripWishlistPicker: ({ onSaved }: { onSaved?: (trip: { id: string }) => void }) => {
    const RN = require('react-native');
    return (
      <RN.Pressable testID="wishlist-stub-save" onPress={() => onSaved?.({ id: 'trip-1' })}>
        <RN.Text>save to trip (stub)</RN.Text>
      </RN.Pressable>
    );
  },
}));

// NOTE: intentionally exhaustive — useBottomInset reads safe-area native
// modules that crash under jest-expo; a constant inset of 0 is sufficient.
jest.mock('../../../hooks/useBottomInset', () => ({
  usePlainBottomInset: () => 0,
}));

// NOTE: intentionally exhaustive — expo-image pulls in native modules that
// crash under jest-expo; the fallback branch is all we need.
jest.mock('../../ui/DisplayMediaImage.tsx', () => ({
  DisplayMediaImage: ({ uri, fallback, children, testID }: any) => {
    const { View } = require('react-native');
    if (!uri && fallback) return <View testID={testID ?? 'sheet-img'}>{fallback}</View>;
    return <View testID={testID ?? 'sheet-img'}>{children ?? null}</View>;
  },
  MediaFallback: () => {
    const { View } = require('react-native');
    return <View testID="sheet-media-fallback" />;
  },
}));

// NOTE: intentionally exhaustive — LocationContext reads session + GPS state
// from multiple native hooks; no user location is needed here.
jest.mock('../../../context/LocationContext', () => ({
  useLocationContext: () => ({
    resolvedLocation: { coords: null, source: 'none', freshness: 'unavailable', place: null },
  }),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PLACE: DiscoveryPlace = {
  id:           'db/9c1d2e3f-0000-0000-0000-000000000001',
  name:         'Test Place',
  category:     'places',
  type:         'landmark',
  description:  null,
  distanceKm:   null,
  lat:          48.8566,
  lng:          2.3522,
  tags:         [],
  address:      '1 Place du Louvre, Paris',
  website:      null,
  phone:        null,
  openingHours: null,
  rating:       null,
  isOpenNow:    null,
};

async function mountSheet(props: Partial<React.ComponentProps<typeof PlaceDetailSheet>> = {}) {
  const onAddToPlan = jest.fn();
  // RNTL v14: render() is async.
  const utils = await render(
    <PlaceDetailSheet
      place={PLACE}
      visible
      onClose={jest.fn()}
      onAddToPlan={onAddToPlan}
      rankSurface="discovery"
      {...props}
    />,
  );
  await waitFor(() => expect(utils.getByText('Test Place')).toBeTruthy());
  return { ...utils, onAddToPlan };
}

let openURLSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockToggleSave.mockResolvedValue(true);
  openURLSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
});

afterEach(() => openURLSpy.mockRestore());

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PlaceDetailSheet — rank outcome wiring', () => {
  it("constructs the hook with the owner's surface, and with null when none was passed", async () => {
    await mountSheet();
    expect(mockUseRankOutcome).toHaveBeenCalledWith({ surface: 'discovery' });

    mockUseRankOutcome.mockClear();
    await mountSheet({ rankSurface: undefined });
    expect(mockUseRankOutcome).toHaveBeenCalledWith({ surface: null });
  });

  it("Directions reports 'tap' for the place id and still launches maps", async () => {
    const { getByTestId } = await mountSheet();

    fireEvent.press(getByTestId('place-sheet-directions'));

    expect(mockReportTap).toHaveBeenCalledWith(PLACE.id);
    expect(openURLSpy).toHaveBeenCalledWith(expect.stringContaining('48.8566,2.3522'));
  });

  it("the header bookmark reports 'save' ONLY once toggleSave confirms the place is now saved", async () => {
    const { getByTestId } = await mountSheet();

    fireEvent.press(getByTestId('place-sheet-save'));

    expect(mockReportSave).not.toHaveBeenCalled(); // not on the tap…
    await waitFor(() => expect(mockReportSave).toHaveBeenCalledWith(PLACE.id)); // …on the confirmation
    expect(mockToggleSave).toHaveBeenCalledWith('place', PLACE.id, false);
  });

  it('a toggle that resolves UNSAVED reports nothing', async () => {
    mockToggleSave.mockResolvedValue(false);
    const { getByTestId } = await mountSheet();

    fireEvent.press(getByTestId('place-sheet-save'));

    await waitFor(() => expect(mockToggleSave).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(mockReportSave).not.toHaveBeenCalled();
  });

  it("a trip-wishlist add reports 'save' via TripWishlistPicker.onSaved", async () => {
    const { getByTestId } = await mountSheet();

    fireEvent.press(getByTestId('wishlist-stub-save'));

    expect(mockReportSave).toHaveBeenCalledWith(PLACE.id);
  });

  it('Plan reports nothing — intent, not an outcome', async () => {
    const { getByText, onAddToPlan } = await mountSheet();

    fireEvent.press(getByText('Plan'));

    expect(onAddToPlan).toHaveBeenCalledWith(PLACE);
    expect(mockReportTap).not.toHaveBeenCalled();
    expect(mockReportSave).not.toHaveBeenCalled();
  });
});
