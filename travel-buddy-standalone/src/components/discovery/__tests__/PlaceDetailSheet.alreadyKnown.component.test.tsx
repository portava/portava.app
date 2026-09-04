/**
 * PlaceDetailSheet — "Already know it" action.
 *
 * The action records an already_known memory-feedback signal for the shown
 * place (POST /discovery/already-known → §7 New-to-Me suppression) AND fires the
 * discovery rank outcome so the interaction closes the impression→outcome loop
 * on the surface the place was served from.
 *
 * What this pins:
 *   • the action is shown only when a served rank context exists (rankSurface
 *     set) — it is hidden on the Layover card (rankSurface undefined)
 *   • pressing it calls recordAlreadyKnown(place.id) AND reports 'tap' for the
 *     place id (the discovery outcome)
 *   • it is idempotent in the UI: a second press does not re-fire either call
 *
 * Run with: pnpm test:component
 */

// NOTE: Modal Proxy — must be hoisted above all react-native imports. Avoids
// overlapping act() from the Modal animation lifecycle.
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
// NOTE: intentionally exhaustive — the real hook posts through fetch; this test
// asserts what the sheet hands the hook and which report it fires.
jest.mock('../../../hooks/useRankOutcome', () => ({
  useRankOutcome: (...args: unknown[]) => mockUseRankOutcome(...(args as [])),
}));

const mockRecordAlreadyKnown = jest.fn(async () => ({ ok: true as const }));
// NOTE: intentionally exhaustive — the real discovery module imports Supabase
// native internals; only these three functions are reached by the sheet, and
// recordAlreadyKnown's result is controlled here.
jest.mock('../../../services/discovery', () => ({
  getPlaceLiveStatus:    jest.fn().mockResolvedValue(null),
  getWikidataEnrichment: jest.fn().mockResolvedValue(null),
  recordAlreadyKnown:    (...a: unknown[]) => mockRecordAlreadyKnown(...(a as [])),
}));

const mockToggleSave = jest.fn(async () => true);
// NOTE: intentionally exhaustive — collections imports Supabase native modules
// unsafe under jest-expo.
jest.mock('../../../services/collections', () => ({
  checkSaved: jest.fn().mockResolvedValue({ saved: false }),
  toggleSave: (...a: unknown[]) => mockToggleSave(...(a as [])),
}));

// NOTE: intentionally exhaustive — TripWishlistPicker has its own Modal chain.
jest.mock('../TripWishlistPicker', () => ({
  TripWishlistPicker: () => null,
}));

// NOTE: intentionally exhaustive — useBottomInset reads safe-area native modules.
jest.mock('../../../hooks/useBottomInset', () => ({
  usePlainBottomInset: () => 0,
}));

// NOTE: intentionally exhaustive — expo-image pulls native modules; the fallback
// branch is all we need.
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

// NOTE: intentionally exhaustive — LocationContext reads session + GPS state.
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
  const utils = await render(
    <PlaceDetailSheet
      place={PLACE}
      visible
      onClose={jest.fn()}
      onAddToPlan={jest.fn()}
      rankSurface="discovery"
      {...props}
    />,
  );
  await waitFor(() => expect(utils.getByText('Test Place')).toBeTruthy());
  return utils;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordAlreadyKnown.mockResolvedValue({ ok: true as const });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PlaceDetailSheet — "Already know it"', () => {
  it('records already_known AND reports the discovery tap outcome on press', async () => {
    const { getByTestId } = await mountSheet();

    fireEvent.press(getByTestId('place-sheet-already-known'));

    expect(mockRecordAlreadyKnown).toHaveBeenCalledWith(PLACE.id);
    expect(mockReportTap).toHaveBeenCalledWith(PLACE.id);
  });

  it('is idempotent in the UI — a second press re-fires nothing', async () => {
    const { getByTestId } = await mountSheet();

    fireEvent.press(getByTestId('place-sheet-already-known'));
    await waitFor(() => expect(mockRecordAlreadyKnown).toHaveBeenCalledTimes(1));
    fireEvent.press(getByTestId('place-sheet-already-known'));

    expect(mockRecordAlreadyKnown).toHaveBeenCalledTimes(1);
    expect(mockReportTap).toHaveBeenCalledTimes(1);
  });

  it('is hidden when no served rank context was passed (Layover card)', async () => {
    const { queryByTestId } = await mountSheet({ rankSurface: undefined });
    expect(queryByTestId('place-sheet-already-known')).toBeNull();
    expect(mockUseRankOutcome).toHaveBeenCalledWith({ surface: null });
  });
});
