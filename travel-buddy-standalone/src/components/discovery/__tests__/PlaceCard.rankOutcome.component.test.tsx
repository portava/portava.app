/**
 * PlaceCard — discovery-surface outcome reporting.
 *
 * THE DEFECT THIS IS WRITTEN AGAINST
 * ----------------------------------
 * Nothing under components/discovery/ ever reported a rank outcome: the only
 * callers were SaveButton ('pulse'), useEventRsvp ('events') and LivePulseCard
 * ('live_pulse'). Every GET /discovery serve wrote impression rows under
 * surface 'discovery' and no outcome ever closed against them, so the
 * predicted→realized loop could not close for the discovery surface at all.
 *
 * What this pins:
 *   • the hook is constructed with the surface the OWNER passed
 *     ({ surface: 'discovery' }), and with null when no surface was passed —
 *     the component never invents a surface
 *   • tap  — pressing the card (opens detail) and Directions
 *   • save — the bookmark and stamp buttons, ONLY when the API confirmed the
 *     save; unsave and a failed save report nothing
 *   • save — a trip-wishlist add via TripWishlistPicker.onSaved
 *   • Plan / Route are intent (they open pickers) and report nothing
 *
 * Run with:  pnpm test:component
 *
 * RNTL v14: render() is async — always await the mount helper.
 */

import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { PlaceCard } from '../PlaceCard.tsx';
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
// tests assert on what the component hands the hook and which report it
// calls, never on the network (useRankOutcome.component.test.ts covers that).
jest.mock('../../../hooks/useRankOutcome', () => ({
  useRankOutcome: (...args: unknown[]) => mockUseRankOutcome(...(args as [])),
}));

// NOTE: intentionally exhaustive — the real discovery module imports Supabase
// native internals that crash under jest-expo; only the live-status function is
// needed and it resolves to "no pill".
jest.mock('../../../services/discovery', () => ({
  getPlaceLiveStatusCached: jest.fn().mockResolvedValue(null),
}));

const mockSaveItem   = jest.fn(async () => true);
const mockUnsaveItem = jest.fn(async () => true);
const mockCheckSaved = jest.fn(async () => ({ saved: false }));
// NOTE: intentionally exhaustive — collections imports Supabase native modules
// that are not safe under jest-expo; the three stubs are controlled per test.
jest.mock('../../../services/collections', () => ({
  checkSaved: (...a: unknown[]) => mockCheckSaved(...(a as [])),
  saveItem:   (...a: unknown[]) => mockSaveItem(...(a as [])),
  unsaveItem: (...a: unknown[]) => mockUnsaveItem(...(a as [])),
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
// chain and Modal. This stub renders a single trigger that invokes onSaved the
// way the real picker does AFTER the API accepted the add, so the wishlist
// outcome path can be exercised without the picker's own UI.
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

// NOTE: expo-image pulls in native modules that crash under jest-expo.
// DisplayMediaImage is mocked to render its `fallback` prop when uri is null,
// which mirrors the real component's behaviour.
jest.mock('../../ui/DisplayMediaImage.tsx', () => ({
  DisplayMediaImage: ({ uri, fallback, children, testID }: any) => {
    const { View } = require('react-native');
    if (!uri && fallback) return <View testID={testID ?? 'display-media-image'}>{fallback}</View>;
    return <View testID={testID ?? 'display-media-image'}>{children ?? null}</View>;
  },
  MediaFallback: ({ label, icon }: any) => {
    const { Text: T, View } = require('react-native');
    return (
      <View testID="media-fallback">
        {icon ?? null}
        {label ? <T testID="media-fallback-label">{label}</T> : null}
      </View>
    );
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PLACE: DiscoveryPlace = {
  id:           'node/12345',
  name:         'Café du Marché',
  category:     'food',
  type:         'café',
  description:  null,
  distanceKm:   null,
  lat:          48.8566,
  lng:          2.3522,
  tags:         [],
  address:      '12 Rue de Rivoli, Paris',
  website:      null,
  phone:        null,
  openingHours: null,
  rating:       null,
  isOpenNow:    null,
};

async function mountCard(props: Partial<React.ComponentProps<typeof PlaceCard>> = {}) {
  const onPress = jest.fn();
  const onAddToPlan = jest.fn();
  // RNTL v14: render() is async.
  const utils = await render(
    <PlaceCard
      place={PLACE}
      onPress={onPress}
      onAddToPlan={onAddToPlan}
      onAddToRoute={jest.fn()}
      rankSurface="discovery"
      {...props}
    />,
  );
  // Let the mount-time effects (checkSaved, saved-count) settle.
  await waitFor(() => expect(mockCheckSaved).toHaveBeenCalled());
  return { ...utils, onPress, onAddToPlan };
}

let openURLSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockSaveItem.mockResolvedValue(true);
  mockUnsaveItem.mockResolvedValue(true);
  mockCheckSaved.mockResolvedValue({ saved: false });
  openURLSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
});

afterEach(() => openURLSpy.mockRestore());

// ── the hook receives the OWNER's surface ─────────────────────────────────────

describe('PlaceCard — rank outcome wiring', () => {
  it("constructs the hook with the surface the owner passed ('discovery')", async () => {
    await mountCard();
    expect(mockUseRankOutcome).toHaveBeenCalledWith({ surface: 'discovery' });
  });

  it('constructs the hook with surface null when no owner passed one — never invents a surface', async () => {
    await mountCard({ rankSurface: undefined });
    expect(mockUseRankOutcome).toHaveBeenCalledWith({ surface: null });
  });

  // ── tap ────────────────────────────────────────────────────────────────────

  it("pressing the card reports 'tap' for the place id AND still opens the detail", async () => {
    const { getByTestId, onPress } = await mountCard();

    fireEvent.press(getByTestId(`place-card-${PLACE.id}`));

    expect(mockReportTap).toHaveBeenCalledTimes(1);
    expect(mockReportTap).toHaveBeenCalledWith(PLACE.id);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("Directions reports 'tap' for the place id and still launches maps", async () => {
    const { getByTestId } = await mountCard();

    fireEvent.press(getByTestId(`place-card-directions-${PLACE.id}`));

    expect(mockReportTap).toHaveBeenCalledWith(PLACE.id);
    expect(openURLSpy).toHaveBeenCalledWith(expect.stringContaining('destination=48.8566,2.3522'));
  });

  // ── save ───────────────────────────────────────────────────────────────────

  it("the bookmark reports 'save' ONLY after the API confirmed the save", async () => {
    const { getByTestId } = await mountCard();

    fireEvent.press(getByTestId(`place-card-save-${PLACE.id}`));

    expect(mockReportSave).not.toHaveBeenCalled(); // not on the tap…
    await waitFor(() => expect(mockReportSave).toHaveBeenCalledWith(PLACE.id)); // …on the confirmation
    expect(mockSaveItem).toHaveBeenCalledWith('place', PLACE.id);
    expect(mockReportSave).toHaveBeenCalledTimes(1);
  });

  it("the stamp overlay reports 'save' after a confirmed save", async () => {
    const { getByTestId } = await mountCard();

    fireEvent.press(getByTestId(`place-card-stamp-${PLACE.id}`));

    await waitFor(() => expect(mockReportSave).toHaveBeenCalledWith(PLACE.id));
  });

  it('a FAILED save reports nothing — outcomes follow the API, not the tap', async () => {
    mockSaveItem.mockResolvedValue(false);
    const { getByTestId } = await mountCard();

    fireEvent.press(getByTestId(`place-card-save-${PLACE.id}`));

    await waitFor(() => expect(mockSaveItem).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(mockReportSave).not.toHaveBeenCalled();
  });

  it('UNSAVING reports nothing — a negative action is not a save outcome', async () => {
    mockCheckSaved.mockResolvedValue({ saved: true });
    const { getByTestId } = await mountCard();

    fireEvent.press(getByTestId(`place-card-save-${PLACE.id}`));

    await waitFor(() => expect(mockUnsaveItem).toHaveBeenCalledWith('place', PLACE.id));
    await new Promise((r) => setTimeout(r, 0));
    expect(mockReportSave).not.toHaveBeenCalled();
    expect(mockSaveItem).not.toHaveBeenCalled();
  });

  it("a trip-wishlist add reports 'save' via TripWishlistPicker.onSaved", async () => {
    const { getByTestId } = await mountCard();

    fireEvent.press(getByTestId('wishlist-stub-save'));

    expect(mockReportSave).toHaveBeenCalledWith(PLACE.id);
  });

  // ── intent is not an outcome ───────────────────────────────────────────────

  it('Plan reports nothing — it opens a picker in the parent, the add happens later', async () => {
    const { getByText, onAddToPlan } = await mountCard();

    fireEvent.press(getByText('Plan'));

    expect(onAddToPlan).toHaveBeenCalledTimes(1);
    expect(mockReportTap).not.toHaveBeenCalled();
    expect(mockReportSave).not.toHaveBeenCalled();
  });
});
