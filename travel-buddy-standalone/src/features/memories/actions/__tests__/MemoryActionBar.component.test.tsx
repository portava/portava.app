/**
 * MemoryActionBar — §14 Executable Memories on the Memory screen
 * (census-highlights-memories H16/H107/H108/H259).
 *
 * WHAT THIS SUITE PINS
 *   - A menu that could not be read is an error with Try again, never an empty
 *     bar; a closed or uncheckable place is SAID.
 *   - Add to trip opens the trip picker with the COMPILED current place — the
 *     payload the server resolved (a merged place's successor), not anything
 *     the screen made up.
 *   - Do this again shows the historical claim and the current reading as two
 *     separate sentences, "can't say" when there is no live reading, the free
 *     time the engine found (or why it was not checked), and a trip to pick
 *     when none goes there; its Add to a trip hands the plan's payload over.
 *   - Take me back opens maps at the compiled target; View place opens the
 *     current catalog row; a refused compile is said.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Alert, Linking } from 'react-native';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

const mockPush = jest.fn();
// NOTE: intentionally exhaustive — expo-router's real module needs a navigator.
jest.mock('expo-router', () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));

const mockPicker = jest.fn();
// NOTE: intentionally exhaustive — the real picker reads trips, AsyncStorage and
// the network; this suite asserts only what the bar hands it.
jest.mock('../../../../components/discovery/TripWishlistPicker.tsx', () => {
  const React = require('react');
  const { View, Text } = require('react-native');
  return {
    TripWishlistPicker: (props: { visible: boolean; place: { id: string; name: string } | null }) => {
      mockPicker(props);
      return props.visible && props.place
        ? <View testID="trip-picker"><Text>{`picker:${props.place.id}`}</Text></View>
        : null;
    },
  };
});

const mockGetMenu = jest.fn();
const mockDoAgain = jest.fn();
const mockAddToTrip = jest.fn();
const mockTakeMeBack = jest.fn();
const mockBringForward = jest.fn();
jest.mock('../memoryActionsApi.ts', () => ({
  ...jest.requireActual('../memoryActionsApi.ts'),
  getMemoryActions: (...a: unknown[]) => mockGetMenu(...a),
  compileDoAgain: (...a: unknown[]) => mockDoAgain(...a),
  compileAddToTrip: (...a: unknown[]) => mockAddToTrip(...a),
  compileTakeMeBack: (...a: unknown[]) => mockTakeMeBack(...a),
  compileBringForward: (...a: unknown[]) => mockBringForward(...a),
}));

import { MemoryActionBar } from '../MemoryActionBar.tsx';

const MEM = '10000000-0000-4000-8000-000000000001';
const PLACE = { id: 'place-now', name: 'New Name Cafe', category: 'food', address: '2-1 Dogenzaka', city: 'Tokyo', countryCode: 'JP', lat: 35.658, lng: 139.698, status: 'active' };
const payload = { id: 'place-now', name: 'New Name Cafe', category: 'food', type: null, address: '2-1 Dogenzaka, Tokyo', lat: 35.658, lng: 139.698 };

function d(action: string, available: boolean, reason: string | null = null, message: string | null = null, caution: string | null = null) {
  return { action, available, reason, message, caution };
}
function menu(over: Partial<{ place: unknown; actions: unknown[] }> = {}) {
  return {
    ok: true,
    menu: {
      engineVersion: 'memory-actions@1', memoryId: MEM, isOwner: true, place: PLACE,
      actions: [
        d('DO_AGAIN', true), d('TAKE_ME_BACK', true), d('ADD_TO_TRIP', true), d('SAVE_EXPERIENCE', false, 'OWN_MEMORY'),
        d('BOOK_AGAIN', false, 'NO_ELIGIBLE_PROVIDER'), d('NEW_TRIP_WITH_CREW', false, 'CONSUMER_UNAVAILABLE'),
        d('BRING_FORWARD_SAVED', true), d('USE_AS_INSPIRATION', false, 'CONSUMER_UNAVAILABLE'), d('VIEW_PLACE', true),
      ],
      ...over,
    },
  };
}
const TRIP = { id: 'trip-tokyo', title: 'Back to Tokyo', destinationCity: 'Tokyo', destinationCountry: 'Japan', startDate: '2026-11-01', endDate: '2026-11-09', status: 'upcoming' };
function plan(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    plan: {
      action: 'DO_AGAIN', place: PLACE, caution: null,
      fusion: {
        historical: { claim: 'This Memory records being at New Name Cafe on 2026-03-03.', as_of: '2026-03-03T11:00:00.000Z', establishes_current_status: false },
        current: { available: false, reason: 'No live source answered.' },
        merged: false, may_state_current_status: false, fusion_note: 'Historical only.',
      },
      tripChoice: { state: 'chosen', trip: TRIP, candidates: [TRIP] },
      freedom: { consulted: true, tripId: TRIP.id, decisionId: 'dec-1', reading: 'lower bounds', windows: [
        { id: 'w1', beginsAt: '2026-11-02T05:00:00.000Z', endsAt: '2026-11-02T08:00:00.000Z', durationMinutes: 180, confidence: 'MEDIUM', certified: false },
      ] },
      addToTrip: payload,
      navigation: { kind: 'catalog_place', placeId: 'place-now', label: 'New Name Cafe', address: '2-1 Dogenzaka', lat: 35.658, lng: 139.698, historical: false },
      ...over,
    },
  };
}

let alertSpy: jest.SpyInstance;
let linkSpy: jest.SpyInstance;
beforeEach(() => {
  for (const m of [mockPush, mockPicker, mockGetMenu, mockDoAgain, mockAddToTrip, mockTakeMeBack, mockBringForward]) m.mockReset();
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  linkSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
});
afterEach(() => { alertSpy.mockRestore(); linkSpy.mockRestore(); });

const press = async (id: string) => { await act(async () => { fireEvent.press(screen.getByTestId(id)); }); };

it('a menu that could not be read is an error with Try again — never an empty bar', async () => {
  mockGetMenu.mockResolvedValueOnce({ ok: false, kind: 'degraded_unavailable', message: 'Please try again.', reason: null });
  await render(<MemoryActionBar memoryId={MEM} />);
  expect(await screen.findByTestId('memory-actions-error')).toBeTruthy();
  expect(screen.queryByTestId('memory-action-DO_AGAIN')).toBeNull();
  mockGetMenu.mockResolvedValueOnce(menu());
  await press('memory-actions-retry');
  expect(await screen.findByTestId('memory-action-DO_AGAIN')).toBeTruthy();
  expect(mockGetMenu).toHaveBeenCalledTimes(2);
});

it('offers what the server offers and nothing it refused', async () => {
  mockGetMenu.mockResolvedValueOnce(menu());
  await render(<MemoryActionBar memoryId={MEM} />);
  for (const a of ['DO_AGAIN', 'ADD_TO_TRIP', 'TAKE_ME_BACK', 'VIEW_PLACE', 'BRING_FORWARD_SAVED']) {
    expect(await screen.findByTestId(`memory-action-${a}`)).toBeTruthy();
  }
  for (const a of ['BOOK_AGAIN', 'NEW_TRIP_WITH_CREW', 'USE_AS_INSPIRATION', 'SAVE_EXPERIENCE']) {
    expect(screen.queryByTestId(`memory-action-${a}`)).toBeNull();
  }
});

it('a closed place is said, and no venue action is offered', async () => {
  mockGetMenu.mockResolvedValueOnce(menu({
    place: null,
    actions: ['DO_AGAIN', 'TAKE_ME_BACK', 'ADD_TO_TRIP', 'VIEW_PLACE'].map((a) => d(a, false, 'PLACE_CLOSED', 'This place has closed.')),
  }));
  await render(<MemoryActionBar memoryId={MEM} />);
  expect(await screen.findByText('This place has closed.')).toBeTruthy();
  expect(screen.queryByTestId('memory-action-DO_AGAIN')).toBeNull();
  expect(screen.queryByTestId('memory-actions-retry')).toBeNull();
});

it('an uncheckable place is said with Try again', async () => {
  mockGetMenu.mockResolvedValueOnce(menu({
    place: null,
    actions: ['DO_AGAIN', 'TAKE_ME_BACK', 'ADD_TO_TRIP', 'VIEW_PLACE'].map((a) => d(a, false, 'PLACE_UNREADABLE', 'This place\'s current state could not be checked right now.')),
  }));
  await render(<MemoryActionBar memoryId={MEM} />);
  expect(await screen.findByTestId('memory-actions-note')).toBeTruthy();
  expect(screen.getByTestId('memory-actions-retry')).toBeTruthy();
});

it('Add to trip opens the trip picker with the COMPILED current place', async () => {
  mockGetMenu.mockResolvedValueOnce(menu());
  mockAddToTrip.mockResolvedValueOnce({ ok: true, addToTrip: payload, caution: null });
  await render(<MemoryActionBar memoryId={MEM} />);
  await screen.findByTestId('memory-action-ADD_TO_TRIP');
  await press('memory-action-ADD_TO_TRIP');
  expect(mockAddToTrip).toHaveBeenCalledWith(MEM);
  expect(await screen.findByText('picker:place-now')).toBeTruthy();
  const last = mockPicker.mock.calls[mockPicker.mock.calls.length - 1]![0];
  expect(last.place).toEqual(payload);
  expect(last.visible).toBe(true);
});

it('a refused compile is said, and no picker opens', async () => {
  mockGetMenu.mockResolvedValueOnce(menu());
  mockAddToTrip.mockResolvedValueOnce({ ok: false, kind: 'conflict', message: 'This place has closed.', reason: 'PLACE_CLOSED' });
  await render(<MemoryActionBar memoryId={MEM} />);
  await screen.findByTestId('memory-action-ADD_TO_TRIP');
  await press('memory-action-ADD_TO_TRIP');
  expect(alertSpy).toHaveBeenCalledWith('Could not do that', 'This place has closed.');
  expect(screen.queryByTestId('trip-picker')).toBeNull();
});

it('Do this again shows the past and the present as separate claims, the engine\'s free time, and hands its payload to the picker', async () => {
  mockGetMenu.mockResolvedValueOnce(menu());
  mockDoAgain.mockResolvedValueOnce(plan());
  await render(<MemoryActionBar memoryId={MEM} />);
  await screen.findByTestId('memory-action-DO_AGAIN');
  await press('memory-action-DO_AGAIN');
  expect(mockDoAgain).toHaveBeenCalledWith(MEM, null);
  expect(await screen.findByTestId('do-again-sheet')).toBeTruthy();
  expect(screen.getByTestId('do-again-historical').props.children).toBe('This Memory records being at New Name Cafe on 2026-03-03.');
  expect(screen.getByTestId('do-again-current').props.children).toBe('Portava can\'t say whether it is open right now.');
  expect(screen.getByText('On Back to Tokyo')).toBeTruthy();
  expect(screen.getAllByTestId('do-again-window')).toHaveLength(1);
  await press('do-again-add-to-trip');
  expect(await screen.findByText('picker:place-now')).toBeTruthy();
  expect(screen.queryByTestId('do-again-sheet')).toBeNull();
});

it('a live reading is shown as the present claim', async () => {
  mockGetMenu.mockResolvedValueOnce(menu());
  mockDoAgain.mockResolvedValueOnce(plan({
    fusion: {
      historical: { claim: 'This Memory records being at New Name Cafe on 2026-03-03.', as_of: '2026-03-03T11:00:00.000Z', establishes_current_status: false },
      current: { available: true, statement: 'New Name Cafe is open right now.' },
      merged: false, may_state_current_status: true, fusion_note: 'Two separate claims.',
    },
  }));
  await render(<MemoryActionBar memoryId={MEM} />);
  await screen.findByTestId('memory-action-DO_AGAIN');
  await press('memory-action-DO_AGAIN');
  expect((await screen.findByTestId('do-again-current')).props.children).toBe('New Name Cafe is open right now.');
});

it('when no trip goes there it asks which trip, and recompiles on the one picked', async () => {
  const OTHER = { ...TRIP, id: 'trip-paris', title: 'Paris', destinationCity: 'Paris' };
  mockGetMenu.mockResolvedValueOnce(menu());
  mockDoAgain.mockResolvedValueOnce(plan({ tripChoice: { state: 'none_matching', candidates: [OTHER] }, freedom: { consulted: false, tripId: null, info: 'No trip was chosen.' } }));
  mockDoAgain.mockResolvedValueOnce(plan({ tripChoice: { state: 'chosen', trip: OTHER, candidates: [OTHER] } }));
  await render(<MemoryActionBar memoryId={MEM} />);
  await screen.findByTestId('memory-action-DO_AGAIN');
  await press('memory-action-DO_AGAIN');
  expect(await screen.findByTestId('do-again-pick-trip')).toBeTruthy();
  await press('do-again-trip-trip-paris');
  expect(mockDoAgain).toHaveBeenLastCalledWith(MEM, 'trip-paris');
  expect(await screen.findByText('On Paris')).toBeTruthy();
});

it('free time the engine did not check is said, with the engine\'s reason', async () => {
  mockGetMenu.mockResolvedValueOnce(menu());
  mockDoAgain.mockResolvedValueOnce(plan({ freedom: { consulted: false, tripId: TRIP.id, info: 'Freedom windows are not enabled: gate off' } }));
  await render(<MemoryActionBar memoryId={MEM} />);
  await screen.findByTestId('memory-action-DO_AGAIN');
  await press('memory-action-DO_AGAIN');
  expect(await screen.findByTestId('do-again-freedom-not-consulted')).toBeTruthy();
  expect(screen.queryByTestId('do-again-window')).toBeNull();
});

it('unreadable trips are said, not shown as "no trips"', async () => {
  mockGetMenu.mockResolvedValueOnce(menu());
  mockDoAgain.mockResolvedValueOnce(plan({ tripChoice: { state: 'unreadable', candidates: [] }, freedom: { consulted: false, tripId: null, info: 'x' } }));
  await render(<MemoryActionBar memoryId={MEM} />);
  await screen.findByTestId('memory-action-DO_AGAIN');
  await press('memory-action-DO_AGAIN');
  expect(await screen.findByTestId('do-again-trips-unreadable')).toBeTruthy();
  expect(screen.queryByTestId('do-again-no-trips')).toBeNull();
});

it('Take me back opens maps at the compiled target; View place opens the current catalog row', async () => {
  mockGetMenu.mockResolvedValueOnce(menu());
  mockTakeMeBack.mockResolvedValueOnce({ ok: true, navigation: { kind: 'memory_location', placeId: null, label: 'Tokyo, Japan', address: null, lat: 35.6595, lng: 139.7005, historical: true }, caution: null });
  await render(<MemoryActionBar memoryId={MEM} />);
  await screen.findByTestId('memory-action-TAKE_ME_BACK');
  await press('memory-action-TAKE_ME_BACK');
  expect(linkSpy).toHaveBeenCalledWith('https://www.google.com/maps/dir/?api=1&destination=35.6595,139.7005');
  await press('memory-action-VIEW_PLACE');
  expect(mockPush).toHaveBeenCalledWith('/place/place-now');
});

it('Saved from that trip lists what is still waiting, says why the rest stayed behind, and adds one through the picker', async () => {
  mockGetMenu.mockResolvedValueOnce(menu());
  mockBringForward.mockResolvedValueOnce({
    ok: true,
    items: [{ savedAt: '2026-02-20T00:00:00.000Z', caution: null, addToTrip: { ...payload, id: 'tsukiji', name: 'Tsukiji Outer Market' } }],
    leftBehind: [{ placeName: 'Closed Izakaya', reason: 'PLACE_CLOSED' }],
  });
  await render(<MemoryActionBar memoryId={MEM} />);
  await screen.findByTestId('memory-action-BRING_FORWARD_SAVED');
  await press('memory-action-BRING_FORWARD_SAVED');
  expect(await screen.findByText('Tsukiji Outer Market')).toBeTruthy();
  expect(screen.getByTestId('bring-forward-left-behind')).toBeTruthy();
  expect(screen.getByText('Closed Izakaya — has closed.')).toBeTruthy();
  await press('bring-forward-add-tsukiji');
  expect(await screen.findByText('picker:tsukiji')).toBeTruthy();
});

it('an autoAction the server offers starts once, without a press (a Highlight\'s "Do this")', async () => {
  mockGetMenu.mockResolvedValueOnce(menu());
  mockDoAgain.mockResolvedValueOnce(plan());
  await render(<MemoryActionBar memoryId={MEM} autoAction="DO_AGAIN" />);
  expect(await screen.findByTestId('do-again-sheet')).toBeTruthy();
  expect(mockDoAgain).toHaveBeenCalledTimes(1);
});

it('an autoAction the server refuses does not start — the menu\'s own refusal stands', async () => {
  mockGetMenu.mockResolvedValueOnce(menu({
    place: null,
    actions: ['DO_AGAIN', 'TAKE_ME_BACK', 'ADD_TO_TRIP', 'VIEW_PLACE'].map((a) => d(a, false, 'PLACE_CLOSED', 'This place has closed.')),
  }));
  await render(<MemoryActionBar memoryId={MEM} autoAction="ADD_TO_TRIP" />);
  expect(await screen.findByText('This place has closed.')).toBeTruthy();
  expect(mockAddToTrip).not.toHaveBeenCalled();
});
