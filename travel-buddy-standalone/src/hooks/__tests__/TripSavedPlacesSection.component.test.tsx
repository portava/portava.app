/**
 * TripSavedPlacesSection.component.test.tsx
 *
 * Confirms the Alert confirmation gate in TripSavedPlacesSection.handleClearAll:
 *   1. Alert.alert fires with the correct title when "Clear all" is pressed
 *   2. Alert has Cancel + destructive Clear all buttons
 *   3. clearAll is NOT called before the user confirms
 *   4. clearAll is called only after the user taps the destructive button
 *   5. An error Alert appears when clearAll rejects after confirmation
 *
 * All assertions are bound to the production handleClearAll in TripPage.tsx.
 */

import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';
import { TripSavedPlacesSection } from '../../components/TripPage';
import { useTripSavedPlaces } from '../useTripSavedPlaces';
import type { BookmarkedPlace } from '../../services/discoveryBookmarks';

// ── Module mocks ─────────────────────────────────────────────────────────────
// Mock useTripSavedPlaces so we control returned state without async effects.
jest.mock('../useTripSavedPlaces', () => ({
  useTripSavedPlaces: jest.fn(),
}));

// Prevent expo-router from loading its native runtime.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

// The remaining mocks prevent native-module imports inside TripPage.tsx's
// other exported functions from blowing up when jest loads the module.
jest.mock('../../components/AttachController', () => ({
  useAttach: () => ({ open: jest.fn() }),
}));
jest.mock('../../context/AttachmentStore', () => ({
  useAttachments: () => ({ listAttachmentsByTarget: jest.fn().mockReturnValue([]) }),
}));
jest.mock('../../components/HighlightRing', () => ({
  HighlightRing: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('../../components/HighlightViewer', () => ({
  HighlightViewer: () => null,
}));
jest.mock('../useHighlightRingState', () => ({
  useHighlightRingState: () => ({ allViewed: true }),
}));
jest.mock('../../components/PassportStampCard', () => ({
  PassportStampCard: () => null,
}));
jest.mock('../../components/primitives', () => ({
  TravelSectionHeader: ({ title }: { title: string }) => <>{title}</>,
  TravelEmptyState: () => null,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────
const mockUseTripSavedPlaces = useTripSavedPlaces as jest.MockedFunction<typeof useTripSavedPlaces>;

function makePlace(id: string): BookmarkedPlace {
  return { id, name: `Place ${id}`, category: 'food', savedAt: 1000, address: null, type: null };
}

function setupHook(overrides: Partial<ReturnType<typeof useTripSavedPlaces>> = {}) {
  const clearAll = jest.fn().mockResolvedValue(undefined);
  const toggle = jest.fn().mockResolvedValue(true);
  mockUseTripSavedPlaces.mockReturnValue({
    places: [makePlace('p1'), makePlace('p2')],
    loading: false,
    toggle,
    clearAll,
    ...overrides,
  });
  return { clearAll, toggle };
}

// ── Alert spy ─────────────────────────────────────────────────────────────────
let alertSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  alertSpy = jest.spyOn(Alert, 'alert');
});
afterEach(() => {
  alertSpy.mockRestore();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TripSavedPlacesSection — handleClearAll Alert gate', () => {
  it('shows Alert.alert with the correct title when "Clear all" is pressed', async () => {
    setupHook();
    const { getByText } = await render(<TripSavedPlacesSection tripId="trip-1" />);

    await fireEvent.press(getByText('Clear all'));

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0][0]).toBe('Clear all saved places?');
  });

  it('Alert has a Cancel button and a destructive Clear all button', async () => {
    setupHook();
    const { getByText } = await render(<TripSavedPlacesSection tripId="trip-1" />);

    await fireEvent.press(getByText('Clear all'));

    const [, , buttons] = alertSpy.mock.calls[0] as [string, string, Array<{ text: string; style?: string }>];
    expect(buttons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
        expect.objectContaining({ text: 'Clear all', style: 'destructive' }),
      ]),
    );
  });

  it('does NOT call clearAll before the user confirms', async () => {
    const { clearAll } = setupHook();
    const { getByText } = await render(<TripSavedPlacesSection tripId="trip-1" />);

    await fireEvent.press(getByText('Clear all'));

    // Alert opened but user hasn't tapped a button yet
    expect(clearAll).not.toHaveBeenCalled();
  });

  it('calls clearAll only when the user taps the destructive confirmation button', async () => {
    const { clearAll } = setupHook();
    const { getByText } = await render(<TripSavedPlacesSection tripId="trip-1" />);

    await fireEvent.press(getByText('Clear all'));

    const [, , buttons] = alertSpy.mock.calls[0] as [
      string,
      string,
      Array<{ text: string; style?: string; onPress?: () => void }>,
    ];
    const destructiveBtn = buttons.find((b) => b.style === 'destructive');
    expect(destructiveBtn).toBeDefined();
    expect(clearAll).not.toHaveBeenCalled();

    destructiveBtn!.onPress?.();

    expect(clearAll).toHaveBeenCalledTimes(1);
  });

  it('shows an error Alert when clearAll rejects after the user confirms', async () => {
    const { clearAll } = setupHook();
    clearAll.mockRejectedValue(new Error('storage error'));

    const { getByText } = await render(<TripSavedPlacesSection tripId="trip-1" />);
    await fireEvent.press(getByText('Clear all'));

    const [, , buttons] = alertSpy.mock.calls[0] as [
      string,
      string,
      Array<{ text: string; style?: string; onPress?: () => void }>,
    ];
    const destructiveBtn = buttons.find((b) => b.style === 'destructive');

    // Invoke onPress and let the rejection's .catch() callback run
    await new Promise<void>((resolve) => {
      destructiveBtn!.onPress?.();
      // Two microtask ticks: one for the rejected Promise, one for the .catch() handler
      Promise.resolve().then(() => Promise.resolve().then(resolve));
    });

    expect(alertSpy).toHaveBeenCalledTimes(2);
    expect(alertSpy.mock.calls[1][0]).toBe('Something went wrong');
  });
});
