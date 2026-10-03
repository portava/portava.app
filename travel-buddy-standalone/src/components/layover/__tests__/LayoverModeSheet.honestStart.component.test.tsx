/**
 * census-layover L294 (C2) / L267 — THE FIRST SCREEN OF THE FEATURE SAYS WHAT
 * ACTUALLY HAPPENED.
 *
 * `LayoverModeSheet` is where every layover starts, and it had three ways to
 * tell a tester something false:
 *
 *   1. Every refusal of `POST /airport/sessions` read "Could not start your
 *      layover. Please try again." — including "This layover has already
 *      departed — set a departure time in the future", which no retry fixes.
 *      The `feature_disabled` branch matched a thrown string that could never
 *      contain the server's code, so it was unreachable.
 *   2. A search that FAILED (5xx, offline, the mode switched off) rendered
 *      exactly like a search that matched nothing: an empty box.
 *   3. The autocomplete never discarded a stale answer. A slow response to
 *      "TP" landing after the fast response to "TPE" replaced the list the
 *      traveller was looking at with matches for a query they had already
 *      typed past.
 *
 * The service module is replaced here; its PARSING of the real bodies is
 * `layoverStartRead.component.test.tsx`. The pickers are replaced by buttons
 * that set fixed values, because what is under test is the sheet's handling
 * of answers, not the picker UI.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { LayoverModeSheet } from '../LayoverModeSheet.tsx';

const mockPush = jest.fn();
const mockSearch = jest.fn();
const mockCreate = jest.fn();

// NOTE: intentional stub — the sheet only needs `push`.
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }) }));

// NOTE: intentional stub — requireActual pulls native-module internals.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: any) => children,
}));

// NOTE: intentionally exhaustive — the sheet imports exactly these two calls.
jest.mock('../../../services/layover.ts', () => ({
  searchAirports: (...a: unknown[]) => mockSearch(...a),
  createLayoverSession: (...a: unknown[]) => mockCreate(...a),
}));

// NOTE: intentional stubs — a button per picker that sets a fixed value.
jest.mock('../../selectors/GlobalCalendarPicker.tsx', () => {
  const { Pressable, Text } = require('react-native');
  return {
    GlobalCalendarPicker: ({ visible, title, onConfirm }: any) => (visible
      ? <Pressable testID={`cal-${title}`} onPress={() => onConfirm('2026-10-04')}><Text>pick</Text></Pressable>
      : null),
  };
});
jest.mock('../../selectors/GlobalTimePicker.tsx', () => {
  const { Pressable, Text } = require('react-native');
  return {
    GlobalTimePicker: ({ visible, title, onChange, onClose }: any) => (visible
      ? (
        <Pressable
          testID={`time-${title}`}
          onPress={() => { onChange(title === 'Arrival time' ? '10:00' : '16:00'); onClose(); }}
        >
          <Text>pick</Text>
        </Pressable>
      )
      : null),
  };
});

const TPE = {
  id: 'ap-tpe', iataCode: 'TPE', name: 'Taiwan Taoyuan International', city: 'Taoyuan', country: 'Taiwan',
  countryCode: 'TW', timezone: 'Asia/Taipei', lat: 25.08, lng: 121.23,
  domesticBufferMin: 60, internationalBufferMin: 120, verified: false,
};
const TPA = { ...TPE, id: 'ap-tpa', iataCode: 'TPA', name: 'Tampa International', city: 'Tampa', country: 'United States', timezone: 'America/New_York' };

/**
 * A search answer in the NEW envelope that is ALSO the bare array the old
 * service returned — so the stale-answer case below fails against the old
 * sheet for the reason it names, not because the shape changed under it.
 */
function found(airports: any[], over: Record<string, unknown> = {}) {
  return Object.assign([...airports], { ok: true, airports, featureEnabled: true, degraded: false, ...over });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const INPUT = /Airport, city or IATA code/;

async function pickAirportAndTimes() {
  mockSearch.mockImplementation(async () => found([TPE]));
  await fireEvent.changeText(screen.getByPlaceholderText(INPUT), 'TPE');
  await waitFor(() => expect(screen.getByText('Taiwan Taoyuan International')).toBeTruthy());
  await fireEvent.press(screen.getByText('Taiwan Taoyuan International'));
  await fireEvent.press(screen.getAllByText('Date')[0]);
  await fireEvent.press(screen.getByTestId('cal-Arrival date'));
  await fireEvent.press(screen.getAllByText('Time')[0]);
  await fireEvent.press(screen.getByTestId('time-Arrival time'));
  await fireEvent.press(screen.getAllByText('Time')[0]);
  await fireEvent.press(screen.getByTestId('time-Departure time'));
}

async function mount() {
  return await render(<LayoverModeSheet visible onClose={() => {}} />);
}

beforeEach(() => {
  mockPush.mockReset();
  mockSearch.mockReset();
  mockCreate.mockReset();
});

describe('LayoverModeSheet — starting a layover', () => {
  it('1. a refusal shows the SERVER\'s sentence and does not navigate', async () => {
    await mount();
    await pickAirportAndTimes();
    mockCreate.mockResolvedValue({
      ok: false, code: 'invalid_payload', retryable: false,
      message: 'This layover has already departed — set a departure time in the future',
    });
    await fireEvent.press(screen.getByText('Start layover'));
    await waitFor(() =>
      expect(screen.getByText('This layover has already departed — set a departure time in the future')).toBeTruthy());
    expect(screen.queryByText(/Could not start your layover/)).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('2. feature_disabled is recognised — the branch is reachable', async () => {
    await mount();
    await pickAirportAndTimes();
    mockCreate.mockResolvedValue({
      ok: false, code: 'feature_disabled', retryable: false, message: 'Airport / Layover Mode is not yet enabled',
    });
    await fireEvent.press(screen.getByText('Start layover'));
    await waitFor(() => expect(screen.getByText(/not yet enabled/i)).toBeTruthy());
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('3. CONTROL: a created session opens its dashboard', async () => {
    await mount();
    await pickAirportAndTimes();
    mockCreate.mockResolvedValue({ ok: true, session: { id: 'sess-9' }, safeReturnSuggested: false, safeReturnReasons: [] });
    await fireEvent.press(screen.getByText('Start layover'));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/layover/sess-9'));
  });
});

describe('LayoverModeSheet — the airport search', () => {
  it('4. a FAILED search says so — it is not "no airport matches"', async () => {
    await mount();
    mockSearch.mockResolvedValue({ ok: false, message: "Airport search couldn't be reached. Check your connection and try again." });
    await fireEvent.changeText(screen.getByPlaceholderText(INPUT), 'TPE');
    await waitFor(() => expect(screen.getByTestId('layover-airport-search-failed')).toBeTruthy());
    expect(screen.queryByTestId('layover-airport-no-match')).toBeNull();
  });

  it('5. the mode switched OFF is said at the search, before anything is filled in', async () => {
    await mount();
    mockSearch.mockResolvedValue(found([], { featureEnabled: false }));
    await fireEvent.changeText(screen.getByPlaceholderText(INPUT), 'TPE');
    await waitFor(() => expect(screen.getByTestId('layover-airport-search-failed')).toBeTruthy());
    expect(screen.getByText(/not yet enabled/i)).toBeTruthy();
  });

  it('6. the other half of case 4: a MEASURED zero says no airport matches', async () => {
    await mount();
    mockSearch.mockResolvedValue(found([]));
    await fireEvent.changeText(screen.getByPlaceholderText(INPUT), 'ZZQ');
    await waitFor(() => expect(screen.getByTestId('layover-airport-no-match')).toBeTruthy());
    expect(screen.queryByTestId('layover-airport-search-failed')).toBeNull();
  });

  it('7. a slow answer to an OLDER query never replaces the answer to the current one', async () => {
    await mount();
    const slow = deferred<unknown>();
    mockSearch.mockImplementation((q: string) => (q === 'TP' ? slow.promise : Promise.resolve(found([TPE]))));

    await fireEvent.changeText(screen.getByPlaceholderText(INPUT), 'TP');
    await waitFor(() => expect(mockSearch).toHaveBeenCalledWith('TP'));
    await fireEvent.changeText(screen.getByPlaceholderText(INPUT), 'TPE');
    await waitFor(() => expect(screen.getByText('Taiwan Taoyuan International')).toBeTruthy());

    // The answer to "TP" arrives LAST.
    await act(async () => { slow.resolve(found([TPA])); await slow.promise; });

    expect(screen.queryByText('Tampa International')).toBeNull();
    expect(screen.getByText('Taiwan Taoyuan International')).toBeTruthy();
  });
});
