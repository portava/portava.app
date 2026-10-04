/**
 * Create trip (app/trip/new.tsx) — a multi-city trip whose stops did not all
 * save is not reported as either a clean success or a failure (census-trips §79).
 *
 * Before: after POST /trips succeeded, each stop went to addDestination and a
 * `null` (the request was refused or failed) was ignored, so the traveller
 * landed on a trip missing stops with no word about it. A stop request that
 * THREW fell into the create handler's catch and printed "Network request
 * failed" under the form — for a trip that already existed — inviting a second
 * "Create trip" tap and a duplicate trip.
 *
 * Now: the trip is opened, and the stops that did not save are named.
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, screen, act } from '@testing-library/react-native';
import NewTrip from '../../../app/trip/new.tsx';

// NOTE: intentionally exhaustive — expo-router pulls native navigation internals.
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  router: { replace: (...a: unknown[]) => mockReplace(...a), push: jest.fn() },
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
const mockCreateTrip = jest.fn();
jest.mock('../../services/trips', () => ({
  createTrip: (...a: unknown[]) => mockCreateTrip(...a),
}));

// NOTE: intentionally exhaustive — tripDestinations imports apiToken native deps.
const mockAddDestination = jest.fn();
jest.mock('../../services/tripDestinations', () => ({
  addDestination: (...a: unknown[]) => mockAddDestination(...a),
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


async function createMultiCity() {
  const draft = (require('../../services/tripIntel.ts') as any).draftTripFromText as jest.Mock;
  draft.mockResolvedValue({ draft: { title: 'Japan', destinations: [{ city: 'Tokyo', country: 'Japan' }, { city: 'Kyoto', country: 'Japan' }, { city: 'Osaka', country: 'Japan' }] } });
  await render(<NewTrip />);
  await act(async () => { await fireEvent.changeText(screen.getByTestId('nl-input'), 'Tokyo, Kyoto and Osaka'); });
  await act(async () => { await fireEvent.press(screen.getByTestId('nl-submit')); });
  await act(async () => { await fireEvent.press(screen.getByText('Create trip')); });
  await act(async () => {});
}

describe('Create trip — stops that did not save', () => {
  let alertSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateTrip.mockResolvedValue({ id: 'trip-new' });
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });
  afterEach(() => alertSpy.mockRestore());

  it('control: every stop saves — the trip opens and nothing is said', async () => {
    mockAddDestination.mockResolvedValue({ id: 'd' });
    await createMultiCity();
    expect(mockCreateTrip).toHaveBeenCalledTimes(1);
    expect(mockAddDestination).toHaveBeenCalledTimes(3);
    expect(mockReplace).toHaveBeenCalledWith('/trip/trip-new');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('a refused stop is named, and the created trip still opens', async () => {
    mockAddDestination.mockResolvedValueOnce({ id: 'd1' }).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'd3' });
    await createMultiCity();
    expect(mockReplace).toHaveBeenCalledWith('/trip/trip-new');
    expect(alertSpy).toHaveBeenCalledTimes(1);
    const [title, body] = alertSpy.mock.calls[0];
    expect(title).toMatch(/not saved/i);
    expect(body).toContain('Kyoto');
    expect(body).not.toContain('Tokyo');
    expect(body).not.toContain('Osaka');
  });

  it('a stop request that throws does not report the CREATED trip as failed, and does not stop the later stops', async () => {
    mockAddDestination.mockResolvedValueOnce({ id: 'd1' }).mockRejectedValueOnce(new Error('Network request failed')).mockResolvedValueOnce({ id: 'd3' });
    await createMultiCity();
    expect(mockAddDestination).toHaveBeenCalledTimes(3);
    expect(mockReplace).toHaveBeenCalledWith('/trip/trip-new');
    expect(screen.queryByText('Network request failed')).toBeNull();
    expect(alertSpy.mock.calls[0][1]).toContain('Kyoto');
    expect(mockCreateTrip).toHaveBeenCalledTimes(1);
  });
});
