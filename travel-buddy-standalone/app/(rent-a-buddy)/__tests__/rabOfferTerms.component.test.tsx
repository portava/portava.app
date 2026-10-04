/**
 * The traveller's offers screen (app/(rent-a-buddy)/offers.tsx) — payments
 * PAY-T12, owner ruling 2026-10-04: "Don't add a deposit in the first release."
 *
 *   F1  an offer is shown with NO deposit — even one stored with a deposit
 *       before the ruling — and its cash figure is the server's;
 *   F2  a full-in-app offer says "No deposit" and names no cash;
 *   F3  accepting creates the booking through acceptOffer, and says the Buddy
 *       still has to accept it (it is not "confirmed");
 *   F4  a PERMANENT refusal from the money record (`ledger_refused`) says that
 *       trying again will not help, and that nothing was charged;
 *   F5  an OUTAGE (`ledger_unavailable`, `ledger_write_failed`) says nothing was
 *       changed or charged and that trying again is reasonable.
 *
 * The server half — the booking's price and terms from one SQL function, the
 * lost-answer repair and the Idempotency-Key — is
 * artifacts/api-server/src/test/rentABuddyGateConsolidation.test.ts.
 *
 * Run: pnpm --dir travel-buddy-standalone test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

// NOTE: intentional stub — navigation is not under test.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({ requestId: 'r1' }),
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockRequest = jest.fn();
const mockOffers = jest.fn();
const mockAccept = jest.fn();
const mockDecline = jest.fn();
// NOTE: intentional stub — the screen's network calls. The refusal copy is the shipped one.
jest.mock('../../../src/services/rentABuddy', () => ({
  ...jest.requireActual('../../../src/services/rentABuddy'),
  getRequest: (...a: unknown[]) => mockRequest(...a),
  getRequestOffers: (...a: unknown[]) => mockOffers(...a),
  acceptOffer: (...a: unknown[]) => mockAccept(...a),
  declineOffer: (...a: unknown[]) => mockDecline(...a),
}));

import Offers from '../offers';
import { LEDGER_ERROR_COPY } from '../../../src/services/rentABuddyBookingErrors';

const REQUEST = { id: 'r1', city: 'Lisbon', category: 'city', durationMinutes: 120, groupSize: 1, notes: null, status: 'open' };

function offer(id: string, over: Record<string, unknown> = {}) {
  return {
    id, requestId: 'r1', buddyProfileId: 'bp', buddyUserId: 'bu', proposedPriceUsd: 40, depositAmountUsd: 0,
    cashBalanceUsd: 0, proposedStart: null, proposedEnd: null, meetupLocation: 'Rossio', message: 'Happy to help',
    includedServices: [], addonsOffered: [], paymentMode: 'full_in_app', expiresAt: '2099-01-01T00:00:00Z', status: 'pending',
    acceptedBookingId: null, createdAt: '', buddy: { displayName: 'Ana', verified: true, averageRating: 4.9 },
    ...over,
  };
}

function alertCalls() {
  return (Alert.alert as jest.Mock).mock.calls;
}
function pressAlertButton(text: string) {
  const call = alertCalls().at(-1);
  const b = ((call?.[2] ?? []) as Array<{ text: string; onPress?: () => void }>).find((x) => x.text === text);
  if (!b) throw new Error(`no alert button "${text}"`);
  b.onPress?.();
}

beforeEach(() => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  [mockRequest, mockOffers, mockAccept, mockDecline].forEach((m) => m.mockReset());
  mockRequest.mockResolvedValue({ ok: true, data: { request: REQUEST } });
});
afterEach(() => { jest.restoreAllMocks(); });

describe('offers — no deposit is shown', () => {
  it('F1 an offer stored with a deposit before the ruling is shown with none; the cash figure is the server\'s', async () => {
    mockOffers.mockResolvedValue({ ok: true, data: { offers: [offer('o1', { paymentMode: 'deposit_plus_cash', depositAmountUsd: 12, cashBalanceUsd: 28 })] } });
    const { findByTestId, getByText, queryByText } = await render(<Offers />);
    expect(await findByTestId('offer-terms-o1', {}, { timeout: 5000 })).toBeTruthy();
    expect(getByText(/No deposit · \$28\.00 in cash at the meetup/)).toBeTruthy();
    expect(queryByText(/\$12\.00/)).toBeNull();
    expect(queryByText(/\$12\.00 deposit/)).toBeNull();
    expect(queryByText(/Full in-app/)).toBeNull();
  });

  it('F2 a full-in-app offer says "No deposit" and names no cash', async () => {
    mockOffers.mockResolvedValue({ ok: true, data: { offers: [offer('o2')] } });
    const { findByTestId, getByText, queryByText } = await render(<Offers />);
    expect(await findByTestId('offer-terms-o2', {}, { timeout: 5000 })).toBeTruthy();
    expect(getByText(/· No deposit$/)).toBeTruthy();
    expect(queryByText(/in cash at the meetup/)).toBeNull();
  });
});

describe('offers — accepting, and what a refusal says', () => {
  it('F3 Accept calls acceptOffer for that offer and says the Buddy still has to accept the booking', async () => {
    mockOffers.mockResolvedValue({ ok: true, data: { offers: [offer('o1')] } });
    mockAccept.mockResolvedValue({ ok: true, data: { bookingId: 'bk-1' } });
    const { findByText } = await render(<Offers />);
    await fireEvent.press(await findByText('Accept', {}, { timeout: 5000 }));
    await act(async () => { pressAlertButton('Accept'); });
    await waitFor(() => expect(mockAccept).toHaveBeenCalledWith('o1'));
    await waitFor(() => expect(alertCalls().at(-1)?.[0]).toBe('Booking created'));
    expect(alertCalls().at(-1)?.[1]).toBe('Your Buddy has 24 hours to accept it.');
    expect(alertCalls().map((c) => String(c[1])).join(' ')).not.toMatch(/confirmed\./);
  });

  it('F4 a permanent refusal says trying again will not help, and that nothing was charged', async () => {
    mockOffers.mockResolvedValue({ ok: true, data: { offers: [offer('o1')] } });
    mockAccept.mockResolvedValue({ ok: false, error: 'ledger_refused', status: 422 });
    const { findByText } = await render(<Offers />);
    await fireEvent.press(await findByText('Accept', {}, { timeout: 5000 }));
    await act(async () => { pressAlertButton('Accept'); });
    await waitFor(() => expect(alertCalls().at(-1)?.[0]).toBe('Error'));
    const body = String(alertCalls().at(-1)?.[1]);
    expect(body).toBe(LEDGER_ERROR_COPY.ledger_refused);
    expect(body).toMatch(/trying again won't change that/);
    expect(body).toMatch(/Nothing was changed or charged/);
    expect(body).not.toMatch(/ledger_refused/);
  });

  for (const code of ['ledger_unavailable', 'ledger_write_failed']) it(`F5 an outage (${code}) says nothing was changed or charged, in words`, async () => {
    mockOffers.mockResolvedValue({ ok: true, data: { offers: [offer('o1')] } });
    mockAccept.mockResolvedValue({ ok: false, error: code, status: 503 });
    const { findByText } = await render(<Offers />);
    await fireEvent.press(await findByText('Accept', {}, { timeout: 5000 }));
    await act(async () => { pressAlertButton('Accept'); });
    await waitFor(() => expect(alertCalls().at(-1)?.[0]).toBe('Error'));
    const body = String(alertCalls().at(-1)?.[1]);
    expect(body).toBe(LEDGER_ERROR_COPY[code]);
    expect(body).toMatch(/nothing was changed or charged/);
    expect(body).toMatch(/try again/i);
    expect(body).not.toContain(code);
  });
});
