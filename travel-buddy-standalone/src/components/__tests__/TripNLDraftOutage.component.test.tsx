/**
 * The New Trip screen must not tell a user their words were unusable when the
 * draft extractor never ran.
 *
 * THE SERVER HALF (routes/tripDraft.ts) now distinguishes the two:
 *
 *   provider never answered        → 503 { error: "degraded_unavailable", retryable: true }
 *   provider answered, output junk → 400 { error: "invalid_payload", message: "could_not_extract" }
 *
 * `services/tripIntel.draftTripFromText` surfaces the distinction by throwing
 * an Error whose message IS the server's `error` code. This screen is the last
 * place the distinction can be lost, and it was losing it: one `catch` set
 * `nlError` to "Could not generate a draft. Fill the form manually." for
 * everything — a verdict on the user's sentence, rendered for an outage.
 *
 * THE SCREEN IS DRIVEN, NOT A HELPER. These cases render the real
 * `app/trip/new.tsx`, type into the real NL box and press the real button, so
 * a fix that only changed a copy constant somewhere else could not pass them.
 *
 * VACUITY TRAPS AVOIDED
 * =====================
 *  1. No "some error is shown" assertion. The outage case asserts the OLD
 *     wording is ABSENT as well as that new wording is present, because a
 *     screen that shows both strings has not fixed anything.
 *  2. The unusable-text case is asserted too, in the same file. A change that
 *     relabelled every failure as an outage would be the same defect pointing
 *     the other way — it would tell a user to retry a request that will fail
 *     identically forever.
 *
 * Run with:  pnpm test:component
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
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

/** The wording that must NEVER appear for an outage. */
const VERDICT_ON_THE_USER = 'Could not generate a draft. Fill the form manually.';

describe('New Trip NL draft — an outage is not a verdict on the text', () => {
  let mockDraft: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDraft = (require('../../services/tripIntel.ts') as any).draftTripFromText;
  });

  async function submit(text: string) {
    const utils = await render(<NewTrip />);
    await fireEvent.changeText(utils.getByTestId('nl-input'), text);
    await fireEvent.press(utils.getByTestId('nl-submit'));
    await waitFor(() => { expect(mockDraft).toHaveBeenCalledTimes(1); });
    return utils;
  }

  it('a degraded_unavailable extractor is reported as unavailable, not as bad input', async () => {
    mockDraft.mockRejectedValue(new Error('degraded_unavailable'));

    const { queryByText, getByText } = await submit('Five days in Tokyo in November');

    await waitFor(() => {
      expect(queryByText(VERDICT_ON_THE_USER)).toBeNull();
    });
    // The user is told the service is the problem and that retrying is worth it.
    const shown = getByText(/unavailable|try again/i);
    expect(shown).toBeTruthy();
  });

  it('server_not_configured is treated the same way — the extractor did not run', async () => {
    mockDraft.mockRejectedValue(new Error('server_not_configured'));

    const { queryByText } = await submit('A long weekend in Lisbon');

    await waitFor(() => {
      expect(queryByText(VERDICT_ON_THE_USER)).toBeNull();
    });
  });

  it('REGRESSION GUARD: invalid_payload still reads as "we could not make a draft from this text"', async () => {
    mockDraft.mockRejectedValue(new Error('invalid_payload'));

    const { getByText } = await submit('asdfgh');

    await waitFor(() => {
      expect(getByText(VERDICT_ON_THE_USER)).toBeTruthy();
    });
  });
});
