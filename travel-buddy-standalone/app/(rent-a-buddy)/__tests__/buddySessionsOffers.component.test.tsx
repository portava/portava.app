/**
 * Buddy "My sessions" and "My offers" (testing mode, lane tm-rab; PLAT-F45,
 * PLAT-F50).
 *
 *   B1  an in-progress session offers Complete, which calls completeBooking
 *       and re-reads the list;
 *   B2  a scheduled session offers Start (startBooking);
 *   B3  a gate refusal on the list is its own state naming the gate;
 *   B4  a failed read is an error with retry — never the empty state;
 *   B5  no buddy profile is its own state, not an empty list;
 *   O1  a pending offer can be withdrawn (withdrawOffer);
 *   O2  an offer the traveller already answered (409) says so;
 *   O3  a failed offers read is an error, never "No offers yet".
 *
 * Run: pnpm --dir travel-buddy-standalone test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

// NOTE: intentional stub — navigation is not under test.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockList = jest.fn();
const mockStart = jest.fn();
const mockComplete = jest.fn();
const mockOffers = jest.fn();
const mockWithdraw = jest.fn();
jest.mock('../../../src/services/rentABuddy', () => ({
  ...jest.requireActual('../../../src/services/rentABuddy'),
  listMyBuddySessions: (...a: unknown[]) => mockList(...a),
  startBooking: (...a: unknown[]) => mockStart(...a),
  completeBooking: (...a: unknown[]) => mockComplete(...a),
  getMyOffers: (...a: unknown[]) => mockOffers(...a),
  withdrawOffer: (...a: unknown[]) => mockWithdraw(...a),
}));

import BuddySessions from '../buddy-dashboard/sessions';
import MyOffers from '../buddy-dashboard/my-offers';

function session(id: string, status: string) {
  return {
    id, buddyId: 'bp', travelerId: 't', packageId: null, tripId: null, bookingDate: '2026-10-10',
    startTime: '10:00:00', durationH: 2, groupSize: 1, city: 'Lisbon', category: 'city', notes: null,
    totalUsd: 60, status, cancelledAt: null, confirmedAt: null, completedAt: null, createdAt: '', updatedAt: '',
    routePlan: [], telegraphThreadId: null,
  };
}

function offer(id: string, status: string) {
  return {
    id, requestId: 'r', buddyProfileId: 'bp', buddyUserId: 'bu', proposedPriceUsd: 40, depositAmountUsd: 0,
    cashBalanceUsd: 0, proposedStart: null, proposedEnd: null, meetupLocation: 'Rossio', message: 'Happy to help',
    includedServices: [], addonsOffered: [], paymentMode: 'full_in_app', expiresAt: '', status,
    acceptedBookingId: status === 'accepted' ? 'bk-9' : null, createdAt: '',
  };
}

function pressAlertButton(text: string) {
  const call = (Alert.alert as jest.Mock).mock.calls.at(-1);
  const b = ((call?.[2] ?? []) as Array<{ text: string; onPress?: () => void }>).find((x) => x.text === text);
  if (!b) throw new Error(`no alert button "${text}"`);
  b.onPress?.();
}

beforeEach(() => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  [mockList, mockStart, mockComplete, mockOffers, mockWithdraw].forEach((m) => m.mockReset());
});
afterEach(() => { jest.restoreAllMocks(); });

describe('My sessions', () => {
  it('B1 in-progress → Complete calls completeBooking and re-reads', async () => {
    mockList.mockResolvedValue({ ok: true, data: [session('s1', 'in_progress')] });
    mockComplete.mockResolvedValue({ ok: true, data: { ok: true } });
    const { findByTestId, queryByTestId } = await render(<BuddySessions />);
    await fireEvent.press(await findByTestId('session-complete-s1', {}, { timeout: 5000 }));
    expect(queryByTestId('session-start-s1')).toBeNull();
    await act(async () => { pressAlertButton('Complete'); });
    await waitFor(() => expect(mockComplete).toHaveBeenCalledWith('s1'));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  it('B2 scheduled → Start calls startBooking', async () => {
    mockList.mockResolvedValue({ ok: true, data: [session('s2', 'scheduled')] });
    mockStart.mockResolvedValue({ ok: true, data: { ok: true } });
    const { findByTestId } = await render(<BuddySessions />);
    await fireEvent.press(await findByTestId('session-start-s2', {}, { timeout: 5000 }));
    await act(async () => { pressAlertButton('Start session'); });
    await waitFor(() => expect(mockStart).toHaveBeenCalledWith('s2'));
  });

  it('B3 a gate refusal is its own state', async () => {
    mockList.mockResolvedValue({ ok: false, error: 'feature_disabled', gate: 'rent_buddy_enabled' });
    const { findByTestId } = await render(<BuddySessions />);
    expect((await findByTestId('sessions-gate-gate', {}, { timeout: 5000 })).props.children).toBe('rent_buddy_enabled');
  });

  it('B4 a failed read is an error, never the empty state', async () => {
    mockList.mockResolvedValue({ ok: false, error: 'db_error' });
    const { findByText, queryByText } = await render(<BuddySessions />);
    expect(await findByText("Couldn't load your sessions", {}, { timeout: 5000 })).toBeTruthy();
    expect(queryByText('No sessions to run')).toBeNull();
  });

  it('B5 no buddy profile is its own state', async () => {
    mockList.mockResolvedValue({ ok: false, error: 'not_found' });
    const { findByText } = await render(<BuddySessions />);
    expect(await findByText("You're not a buddy yet", {}, { timeout: 5000 })).toBeTruthy();
  });

  it('a true empty says so', async () => {
    mockList.mockResolvedValue({ ok: true, data: [] });
    const { findByText } = await render(<BuddySessions />);
    expect(await findByText('No sessions to run', {}, { timeout: 5000 })).toBeTruthy();
  });
});

describe('My offers', () => {
  it('O1 a pending offer can be withdrawn', async () => {
    mockOffers.mockResolvedValue({ ok: true, data: { offers: [offer('o1', 'pending'), offer('o2', 'accepted')] } });
    mockWithdraw.mockResolvedValue({ ok: true, data: { ok: true } });
    const { findByTestId, queryByTestId } = await render(<MyOffers />);
    await fireEvent.press(await findByTestId('offer-withdraw-o1', {}, { timeout: 5000 }));
    expect(queryByTestId('offer-withdraw-o2')).toBeNull();
    await act(async () => { pressAlertButton('Withdraw'); });
    await waitFor(() => expect(mockWithdraw).toHaveBeenCalledWith('o1'));
    await waitFor(() => expect(mockOffers).toHaveBeenCalledTimes(2));
  });

  it('O2 an already-answered offer says so', async () => {
    mockOffers.mockResolvedValue({ ok: true, data: { offers: [offer('o1', 'pending')] } });
    mockWithdraw.mockResolvedValue({ ok: false, error: 'invalid_transition' });
    const { findByTestId } = await render(<MyOffers />);
    await fireEvent.press(await findByTestId('offer-withdraw-o1', {}, { timeout: 5000 }));
    await act(async () => { pressAlertButton('Withdraw'); });
    await waitFor(() => expect((Alert.alert as jest.Mock).mock.calls.map((c) => c[0])).toContain('Already answered'));
  });

  it('O3 a failed read is an error, never "No offers yet"', async () => {
    mockOffers.mockResolvedValue({ ok: false, error: 'db_error' });
    const { findByText, queryByText } = await render(<MyOffers />);
    expect(await findByText("Couldn't load your offers", {}, { timeout: 5000 })).toBeTruthy();
    expect(queryByText('No offers yet')).toBeNull();
  });
});
