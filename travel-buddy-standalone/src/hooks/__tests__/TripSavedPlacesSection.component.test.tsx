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
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { TripSavedPlacesSection } from '../../components/TripPage.tsx';
import { useTripSavedPlaces } from '../useTripSavedPlaces.ts';
import type { BookmarkedPlace } from '../../services/discoveryBookmarks.ts';

// ── Module mocks ─────────────────────────────────────────────────────────────
// Mock useTripSavedPlaces so we control returned state without async effects.
// discoveryBookmarks is also mocked so the real hook can be used in the
// integrated describe block below without touching real AsyncStorage.
// AsyncStorage is mapped to the official jest mock globally via
// moduleNameMapper in jest.config.js — no per-file mock needed.
jest.mock('../../services/discoveryBookmarks.ts', () => ({
  ...jest.requireActual('../../services/discoveryBookmarks.ts'),
  listSaved: jest.fn(),
  toggleSave: jest.fn(),
  clearAllSaved: jest.fn(),
  removeSavedFromList: jest.fn(),
}));
// NOTE: intentionally exhaustive — requireActual would pull the module's
// native/supabase dependency chain under jest.
jest.mock('../useTripSavedPlaces.ts', () => ({
  useTripSavedPlaces: jest.fn(),
}));

// Prevent expo-router from loading its native runtime.
// useFocusEffect is also mocked: the real hook requires a navigation context,
// but in tests we only need mount-time semantics.  We use React.useEffect so
// the callback runs after render (deferred), avoiding "too many re-renders".
jest.mock('expo-router', () => {
  const React = require('react');
  return {
    router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
    useFocusEffect: jest.fn((cb: () => void) => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      React.useEffect(() => { cb(); }, []);
    }),
  };
});

// The remaining mocks prevent native-module imports inside TripPage.tsx's
// other exported functions from blowing up when jest loads the module.
// NOTE: intentionally an exhaustive stub — requiring the actual component module
// would execute its heavy/native dependency imports under jest.
jest.mock('../../components/AttachController.tsx', () => ({
  useAttach: () => ({ open: jest.fn() }),
}));
jest.mock('../../context/AttachmentStore.tsx', () => ({
  ...jest.requireActual('../../context/AttachmentStore.tsx'),
  useAttachments: () => ({ listAttachmentsByTarget: jest.fn().mockReturnValue([]) }),
}));
// NOTE: intentionally an exhaustive stub — requiring the actual component module
// would execute its heavy/native dependency imports under jest.
jest.mock('../../components/HighlightRing.tsx', () => ({
  HighlightRing: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
// NOTE: intentionally an exhaustive stub — requiring the actual component module
// would execute its heavy/native dependency imports under jest.
jest.mock('../../components/HighlightViewer.tsx', () => ({
  HighlightViewer: () => null,
}));
// NOTE: intentionally exhaustive — requireActual would pull the module's
// native/supabase dependency chain under jest.
jest.mock('../useHighlightRingState.ts', () => ({
  useHighlightRingState: () => ({ allViewed: true }),
}));
// NOTE: intentionally an exhaustive stub — requiring the actual component module
// would execute its heavy/native dependency imports under jest.
jest.mock('../../components/PassportStampCard.tsx', () => ({
  PassportStampCard: () => null,
}));
// NOTE: intentionally an exhaustive stub — requiring the actual component module
// would execute its heavy/native dependency imports under jest.
jest.mock('../../components/primitives.tsx', () => ({
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
  const remove = jest.fn().mockResolvedValue(undefined);
  mockUseTripSavedPlaces.mockReturnValue({
    places: [makePlace('p1'), makePlace('p2')],
    loading: false,
    toggle,
    clearAll,
    remove,
    refresh: jest.fn(),
    ...overrides,
  });
  return { clearAll, toggle, remove };
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

// ── Tests: individual place remove (X button) ─────────────────────────────────

describe('TripSavedPlacesSection — X button (individual place remove)', () => {
  it('calls remove with the correct place when the X button is pressed', async () => {
    const { remove } = setupHook();
    const { getByTestId } = await render(<TripSavedPlacesSection tripId="trip-1" />);

    await fireEvent.press(getByTestId('saved-place-remove-p1'));

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
  });

  it('does NOT show an Alert when remove resolves (success path)', async () => {
    setupHook();
    const { getByTestId } = await render(<TripSavedPlacesSection tripId="trip-1" />);

    await fireEvent.press(getByTestId('saved-place-remove-p1'));

    // Flush the resolved promise's microtask queue
    await new Promise<void>((resolve) => {
      Promise.resolve().then(() => Promise.resolve().then(resolve));
    });

    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('shows an error Alert when remove rejects (storage failure)', async () => {
    const remove = jest.fn().mockRejectedValue(new Error('remove_failed'));
    setupHook({ remove });

    const { getByTestId } = await render(<TripSavedPlacesSection tripId="trip-1" />);
    await fireEvent.press(getByTestId('saved-place-remove-p1'));

    // Let the .catch() handler run
    await new Promise<void>((resolve) => {
      Promise.resolve().then(() => Promise.resolve().then(resolve));
    });

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0][0]).toBe('Something went wrong');
  });

  it('calls remove with p2 when the X button for p2 is pressed', async () => {
    const { remove } = setupHook();
    const { getByTestId } = await render(<TripSavedPlacesSection tripId="trip-1" />);

    await fireEvent.press(getByTestId('saved-place-remove-p2'));

    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'p2' }));
  });
});

// ── Integrated test: real hook + mocked storage ───────────────────────────────
//
// These tests do NOT mock useTripSavedPlaces. They swap in the real hook
// implementation and mock only the underlying discoveryBookmarks storage layer.
// This validates the full flow: optimistic remove → storage reject → rollback
// → item reappears in UI → error Alert shown — all in one connected path.

describe('TripSavedPlacesSection — integrated remove flow (real hook + mocked storage)', () => {
  type DiscoveryMocks = { listSaved: jest.Mock; toggleSave: jest.Mock; clearAllSaved: jest.Mock };

  beforeEach(() => {
    // Outer beforeEach already cleared mocks. Now set up integration-specific state.
    const dm = jest.requireMock('../../services/discoveryBookmarks.ts') as DiscoveryMocks;
    dm.listSaved.mockResolvedValue([makePlace('p1'), makePlace('p2')]);
    dm.clearAllSaved.mockResolvedValue(undefined);

    // Override the module-level hook mock with the real implementation so the
    // component exercises the actual optimistic-remove + rollback logic.
    const { useTripSavedPlaces: realHook } = jest.requireActual('../useTripSavedPlaces.ts') as typeof import('../useTripSavedPlaces.ts');
    mockUseTripSavedPlaces.mockImplementation(realHook);
  });

  it('restores the item and shows an error Alert when storage rejects (end-to-end rollback)', async () => {
    const dm = jest.requireMock('../../services/discoveryBookmarks.ts') as DiscoveryMocks;
    dm.removeSavedFromList.mockRejectedValue(new Error('disk full'));

    const { getByTestId } = await render(<TripSavedPlacesSection tripId="trip-1" />);

    // Wait for the initial load to complete — both X buttons must be present
    await waitFor(() => {
      expect(getByTestId('saved-place-remove-p1')).toBeTruthy();
      expect(getByTestId('saved-place-remove-p2')).toBeTruthy();
    });

    // Press X on p1 — triggers optimistic remove, then toggleSave rejects
    await fireEvent.press(getByTestId('saved-place-remove-p1'));

    // Rollback must restore p1 and the component must show the error Alert
    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledTimes(1);
    });
    expect(alertSpy.mock.calls[0][0]).toBe('Something went wrong');

    // p1 must be visible again (rollback landed)
    await waitFor(() => expect(getByTestId('saved-place-remove-p1')).toBeTruthy());
  });

  it('removes the item permanently when storage succeeds (no Alert)', async () => {
    const dm = jest.requireMock('../../services/discoveryBookmarks.ts') as DiscoveryMocks;
    dm.removeSavedFromList.mockResolvedValue(undefined);

    const { getByTestId, queryByTestId } = await render(<TripSavedPlacesSection tripId="trip-1" />);

    await waitFor(() => expect(getByTestId('saved-place-remove-p1')).toBeTruthy());

    await fireEvent.press(getByTestId('saved-place-remove-p1'));

    // Success: no error Alert
    await new Promise<void>((res) => { Promise.resolve().then(() => Promise.resolve().then(res)); });
    expect(alertSpy).not.toHaveBeenCalled();

    // p1 must be gone from the list
    await waitFor(() => expect(queryByTestId('saved-place-remove-p1')).toBeNull());
  });
});
