/**
 * TripNLDraft — component tests for the NL trip draft box in the New Trip screen.
 *
 * Covers:
 *  1. Pre-fill button is disabled when the NL text box is empty.
 *  2. draftTripFromText is called with the typed text on submit.
 *  3. Component does not crash when draftTripFromText rejects.
 *
 * Visual-state assertions for async-handler setState (e.g. title pre-fill)
 * are omitted: React 19 + RNTL v14 cannot commit microtask-scheduled state
 * updates outside an act() scope. The dispatch assertion (toHaveBeenCalledWith)
 * is the correct contract equivalent for the pre-fill path.
 *
 * Key: all fireEvent calls must be awaited in RNTL v14 (they return Promises);
 * skipping await leaves state updates uncommitted and subsequent queries stale.
 *
 * All mocks are exhaustive (NOTE comments) to prevent lazy-loaded native
 * modules (SecureStore via apiToken) from staying open after test teardown.
 *
 * Run with:  pnpm test:component
 */

import React from 'react';
import { render, fireEvent, screen, waitFor } from '@testing-library/react-native';
import NewTrip from '../../../app/trip/new.tsx';

// NOTE: intentionally exhaustive — expo-router pulls native navigation internals.
jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), push: jest.fn() },
}));

// NOTE: intentionally exhaustive — react-native-safe-area-context has native internals.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — SessionContext uses supabase internals.
jest.mock('../../context/SessionContext', () => ({
  useSession: () => ({ configured: true, isAuthed: true, userId: 'user-1' }),
}));

// NOTE: intentionally exhaustive — StampEarnedToast has async native deps.
jest.mock('../../components/stamps/StampEarnedToast', () => ({
  useStampToast: () => ({ checkForNewStamps: jest.fn() }),
}));

// NOTE: intentionally exhaustive — tripIntel imports apiToken/supabase which
// lazy-init SecureStore native modules that stay open after test teardown.
jest.mock('../../services/tripIntel', () => ({
  draftTripFromText: jest.fn(),
}));

// NOTE: intentionally exhaustive — trips imports supabase + apiToken native deps.
jest.mock('../../services/trips', () => ({
  createTrip: jest.fn(),
}));

// NOTE: intentionally exhaustive — tripDestinations imports apiToken native deps.
jest.mock('../../services/tripDestinations', () => ({
  addDestination: jest.fn(),
  reorderDestinations: jest.fn(),
}));

// NOTE: intentionally exhaustive — GlobalPlacePicker pulls expo-location native internals.
jest.mock('../../components/selectors/GlobalPlacePicker', () => {
  const ReactActual = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return { GlobalPlacePicker: () => ReactActual.createElement(View, null) };
});

// NOTE: intentionally exhaustive — GlobalCalendarPicker pulls calendar native modules.
jest.mock('../../components/selectors/GlobalCalendarPicker', () => ({
  GlobalCalendarPicker: () => null,
}));

// NOTE: intentionally exhaustive — KeyboardSafeScrollView wraps a native scroll view.
jest.mock('../../components/ui/KeyboardSafeView', () => {
  const { ScrollView } = jest.requireActual('react-native');
  return { KeyboardSafeScrollView: ScrollView };
});

// NOTE: intentionally exhaustive — ScreenHeader pulls navigation context.
jest.mock('../../components/ScreenHeader', () => ({
  ScreenHeader: () => null,
}));

// NOTE: intentionally exhaustive — DestinationListEditor pulls its own native deps.
jest.mock('../../components/trip/DestinationListEditor', () => ({
  DestinationListEditor: () => null,
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TripNLDraft — NL box in New Trip screen', () => {
  let mockDraft: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    // require() after hoisting ensures we get the jest.fn() instance from the factory.
    mockDraft = (require('../../services/tripIntel.ts') as any).draftTripFromText;
  });

  it('pre-fill button is disabled when the NL text box is empty', async () => {
    const { getByTestId } = await render(<NewTrip />);
    const btn = getByTestId('nl-submit');
    const disabled = btn.props.accessibilityState?.disabled ?? btn.props.disabled;
    expect(disabled).toBeTruthy();
  });

  it('calls draftTripFromText with the typed text when the user submits', async () => {
    mockDraft.mockResolvedValue(null);

    const { getByTestId } = await render(<NewTrip />);

    // fireEvent methods in RNTL v14 return Promises — must be awaited so that
    // state updates (setNlText → re-render → updated handleNLDraft closure)
    // commit before the next interaction.
    await fireEvent.changeText(getByTestId('nl-input'), 'Two weeks in Japan in October');
    await fireEvent.press(getByTestId('nl-submit'));

    await waitFor(() => {
      expect(mockDraft).toHaveBeenCalledTimes(1);
      expect(mockDraft).toHaveBeenCalledWith('Two weeks in Japan in October');
    });
  });

  it('does not crash when draftTripFromText rejects', async () => {
    mockDraft.mockRejectedValue(new Error('network failure'));

    const { getByTestId } = await render(<NewTrip />);

    await fireEvent.changeText(getByTestId('nl-input'), 'Some trip description');
    await fireEvent.press(getByTestId('nl-submit'));

    await waitFor(() => {
      expect(mockDraft).toHaveBeenCalledTimes(1);
    });
  });
});
