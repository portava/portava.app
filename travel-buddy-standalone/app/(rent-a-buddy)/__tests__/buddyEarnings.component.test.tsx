/**
 * The buddy's two earnings screens (payments PAY-T12; requirement rows PAY-009,
 * PAY-010, PAY-055).
 *
 * Ledger screen (buddy-dashboard/earnings-ledger):
 *   L1  a failed read is an error with retry — never a screen of zeros;
 *   L2  it no longer says "Deposit collected": it shows what was collected in
 *       the app, as the server reports it, and says nothing is collected;
 *   L3  a row with no recorded fee percentage shows NO percentage (it used to
 *       print an invented "22%");
 *   L4  a reversed booking says so instead of reading as an earning;
 *   L5  a failed "load more" has its own footer with retry — the list used to
 *       just stop, looking complete;
 *   L6  completed bookings with no earnings record are named, not hidden.
 *
 * Earnings screen (buddy-dashboard/earnings):
 *   E1  a failed bookings read is an error — it used to render "No completed
 *       bookings";
 *   E2  a failed summary read is an error too;
 *   E3  each booking's commission and net are its LEDGER ROW's, not a
 *       percentage applied on the screen (it used to be total × 0.1 / × 0.9);
 *   E4  when only the ledger read fails, the breakdown says it could not be
 *       loaded and retries — it shows no invented figures;
 *   E5  the headline figures are the server's ledger totals, and the screen
 *       links to the ledger.
 *
 * Run: pnpm --dir travel-buddy-standalone test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

// NOTE: intentional stub — expo-router is mocked so router.push can be asserted.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
}));
import { router } from 'expo-router';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockSummary = jest.fn();
const mockLedger = jest.fn();
const mockDashboard = jest.fn();
const mockBookings = jest.fn();
jest.mock('../../../src/services/rentABuddy', () => ({
  ...jest.requireActual('../../../src/services/rentABuddy'),
  getEarningsSummary: (...a: unknown[]) => mockSummary(...a),
  getEarningsLedger: (...a: unknown[]) => mockLedger(...a),
  getDashboardEarnings: (...a: unknown[]) => mockDashboard(...a),
  listMyBookings: (...a: unknown[]) => mockBookings(...a),
}));

import EarningsLedger from '../buddy-dashboard/earnings-ledger';
import BuddyEarnings from '../buddy-dashboard/earnings';

const WARNING = 'All figures are estimates. Nothing has been collected through the app: in-app payment is not live, no deposit is taken, and payouts are not connected. Cash balances are tracked, not charged.';

function summary(over: Record<string, unknown> = {}) {
  return {
    isEstimated: true,
    warning: WARNING,
    today: { bookingCount: 0, bookings: [] },
    upcoming: { bookingCount: 0, bookings: [] },
    completed: { count: 2, totalUsd: 300, unledgeredCount: 0, cashBalanceDue: 140, cashBalanceConfirmed: 0, inAppAmountCollected: 0, depositCollected: 0 },
    tips: { total: 15, count: 1 },
    buddyLevel: 'new',
    platformFeePercent: 25,
    platformFeeSource: 'fee_schedule',
    tipCommissionPercent: 0,
    estimatedPlatformFeeUsd: 75,
    estimatedBuddyEarningsUsd: 225,
    statusBreakdown: { completed: 2, disputed: 0, cancelled: 0 },
    trustScore: null, trustLevel: null, profileViews: 0, searchAppearances: 0, repeatClientCount: 0,
    cityRanking: null, averageRating: null, reviewCount: 0,
    ...over,
  };
}

function entry(bookingId: string, over: Record<string, unknown> = {}) {
  return {
    id: `led-${bookingId}`, bookingId, pricingType: 'hourly', totalBookingUsd: 200, addonsUsd: 0, tipUsd: 0,
    platformFeePercent: 25, platformFeeAmount: 50, travelerServiceFeeAmount: 0, buddyGrossAmount: 200,
    buddyNetEstimatedAmount: 150, depositAmount: 60, inAppAmountCollected: 0, cashBalanceDue: 140,
    cashBalanceConfirmed: false, isEstimated: true, reversed: false, createdAt: '2026-10-01T10:00:00Z',
    warning: 'Estimated — payout not processed',
    ...over,
  };
}

function booking(id: string, status: string, totalUsd = 200) {
  return {
    id, buddyId: 'bp', travelerId: 't', packageId: null, tripId: null, bookingDate: '2026-10-01',
    startTime: '10:00:00', durationH: 2, groupSize: 1, city: 'Lisbon', category: 'city', notes: null,
    totalUsd, status, cancelledAt: null, confirmedAt: null, completedAt: '2026-10-01T12:00:00Z',
    createdAt: '2026-09-30T00:00:00Z', updatedAt: '2026-10-01T12:00:00Z', routePlan: [], telegraphThreadId: null,
  };
}

const okLedger = (rows: unknown[], total = rows.length) => ({ ok: true, data: { ledger: rows, total } });

beforeEach(() => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  [mockSummary, mockLedger, mockDashboard, mockBookings].forEach((m) => m.mockReset());
  (router.push as jest.Mock).mockReset();
});
afterEach(() => { jest.restoreAllMocks(); });

describe('earnings ledger screen', () => {
  it('L1 a failed summary read is an error with retry — not a screen of zeros', async () => {
    mockSummary.mockResolvedValue({ ok: false, error: 'ledger_unavailable' });
    mockLedger.mockResolvedValue(okLedger([]));
    const { findByText, queryByText } = await render(<EarningsLedger />);
    expect(await findByText("Couldn't load earnings", {}, { timeout: 5000 })).toBeTruthy();
    expect(queryByText('$0.00')).toBeNull();
    expect(queryByText('No transactions yet')).toBeNull();

    mockSummary.mockResolvedValue({ ok: true, data: summary() });
    await fireEvent.press(await findByText('Try again'));
    await waitFor(() => expect(mockSummary).toHaveBeenCalledTimes(2));
    expect(await findByText('$225.00', {}, { timeout: 5000 })).toBeTruthy();
  });

  it('L1 a failed ledger read is an error too, even when the summary loaded', async () => {
    mockSummary.mockResolvedValue({ ok: true, data: summary() });
    mockLedger.mockResolvedValue({ ok: false, error: 'db_error' });
    const { findByText, queryByText } = await render(<EarningsLedger />);
    expect(await findByText("Couldn't load earnings", {}, { timeout: 5000 })).toBeTruthy();
    expect(queryByText('No transactions yet')).toBeNull();
  });

  it('L2 never says "Deposit collected"; shows what was collected in the app and that nothing is', async () => {
    mockSummary.mockResolvedValue({ ok: true, data: summary() });
    mockLedger.mockResolvedValue(okLedger([entry('bk-1')]));
    const { findByTestId, getByTestId, getByText, queryByText } = await render(<EarningsLedger />);

    expect((await findByTestId('earnings-collected-in-app', {}, { timeout: 5000 })).props.children).toBe('$0.00');
    expect(queryByText('Deposit collected')).toBeNull();
    expect(queryByText(/Deposit collected/i)).toBeNull();
    expect(getByText('Collected in app')).toBeTruthy();
    expect(getByText('In-app payment is not live and no deposit is taken.')).toBeTruthy();
    // The server's own sentence, not one the screen made up.
    expect(getByTestId('earnings-estimate-notice')).toBeTruthy();
    expect(getByText(WARNING)).toBeTruthy();
    // The commission on the next booking, with where it is configured, and no commission on tips.
    expect(getByTestId('earnings-commission-rate')).toBeTruthy();
    expect(getByText(/25% of the service price/)).toBeTruthy();
    expect(getByText(/Tips carry no commission/)).toBeTruthy();
  });

  it('L3 a row with no recorded fee percentage shows no percentage — not an invented 22%', async () => {
    mockSummary.mockResolvedValue({ ok: true, data: summary() });
    mockLedger.mockResolvedValue(okLedger([entry('bk-1', { platformFeePercent: null })]));
    const { findByTestId, getByText, queryByText } = await render(<EarningsLedger />);
    await findByTestId('ledger-row-bk-1', {}, { timeout: 5000 });
    expect(queryByText(/22%/)).toBeNull();
    expect(getByText('Gross $200.00 · Fee = $50.00')).toBeTruthy();
  });

  it('L3 a row shows the percentage and amounts the server recorded for THAT booking', async () => {
    mockSummary.mockResolvedValue({ ok: true, data: summary() });
    mockLedger.mockResolvedValue(okLedger([entry('bk-1', { tipUsd: 15, buddyNetEstimatedAmount: 165 })]));
    const { findByTestId, getByText } = await render(<EarningsLedger />);
    await findByTestId('ledger-row-bk-1', {}, { timeout: 5000 });
    expect(getByText('Gross $200.00 · Fee 25% = $50.00')).toBeTruthy();
    expect(getByText('+$165.00')).toBeTruthy();
    expect(getByText('Tip: +$15.00 (no commission)')).toBeTruthy();
    expect(getByText('Collected in app $0.00')).toBeTruthy();
    expect(getByText('Estimated — nothing collected or paid out yet')).toBeTruthy();
  });

  it('L4 a reversed booking says so, and is not presented as an earning', async () => {
    mockSummary.mockResolvedValue({ ok: true, data: summary() });
    mockLedger.mockResolvedValue(okLedger([
      entry('bk-rev', { reversed: true, totalBookingUsd: 0, platformFeeAmount: 0, buddyNetEstimatedAmount: 0, buddyGrossAmount: 0 }),
    ]));
    const { findByTestId, getByText, queryByText } = await render(<EarningsLedger />);
    await findByTestId('ledger-row-bk-rev', {}, { timeout: 5000 });
    expect(getByText(/^Reversed — this booking was cancelled/)).toBeTruthy();
    expect(queryByText('+$0.00')).toBeNull();
    expect(queryByText(/Gross \$0\.00/)).toBeNull();
  });

  it('L5 a failed "load more" shows its own footer with retry, and the retry appends the page', async () => {
    mockSummary.mockResolvedValue({ ok: true, data: summary() });
    // Page 1 of 2 loads; every later page read fails until the test says otherwise.
    mockLedger.mockResolvedValueOnce(okLedger([entry('bk-1')], 2));
    mockLedger.mockResolvedValue({ ok: false, error: 'network_error' });
    const { findByTestId, getByTestId, getByText } = await render(<EarningsLedger />);
    await findByTestId('ledger-row-bk-1', {}, { timeout: 5000 });

    await act(async () => { await fireEvent(getByTestId('earnings-ledger-list'), 'onEndReached'); });
    expect(await findByTestId('ledger-more-error', {}, { timeout: 5000 })).toBeTruthy();
    expect(getByText(/showing 1 of 2\. The list above is not complete\./)).toBeTruthy();

    mockLedger.mockResolvedValue(okLedger([entry('bk-2')], 2));
    await fireEvent.press(getByTestId('ledger-more-retry'));
    expect(await findByTestId('ledger-row-bk-2', {}, { timeout: 5000 })).toBeTruthy();
    expect(mockLedger).toHaveBeenLastCalledWith(20, 20);
  });

  it('L6 completed bookings with no earnings record are named', async () => {
    mockSummary.mockResolvedValue({ ok: true, data: summary({ completed: { ...summary().completed, unledgeredCount: 3 } }) });
    mockLedger.mockResolvedValue(okLedger([entry('bk-1')]));
    const { findByTestId, getByText } = await render(<EarningsLedger />);
    expect(await findByTestId('earnings-unledgered-notice', {}, { timeout: 5000 })).toBeTruthy();
    expect(getByText(/3 completed bookings have no earnings record and are not included/)).toBeTruthy();
  });
});

describe('earnings screen', () => {
  const DASH = { ok: true, data: { totalUsd: 300, thisMonthUsd: 200, completedBookings: 2, breakdown: [] } };

  function allOk() {
    mockDashboard.mockResolvedValue(DASH);
    mockSummary.mockResolvedValue({ ok: true, data: summary() });
    mockBookings.mockResolvedValue({ ok: true, data: { bookings: [booking('bk-1', 'completed')] } });
    mockLedger.mockResolvedValue(okLedger([entry('bk-1')]));
  }

  it('E1 a failed bookings read is an error with retry — never "No completed bookings"', async () => {
    allOk();
    mockBookings.mockResolvedValue({ ok: false, error: 'db_error' });
    const { findByText, queryByText } = await render(<BuddyEarnings />);
    expect(await findByText("Couldn't load earnings", {}, { timeout: 5000 })).toBeTruthy();
    expect(queryByText('No completed bookings')).toBeNull();
    expect(queryByText('No pending earnings')).toBeNull();

    allOk();
    await fireEvent.press(await findByText('Try again'));
    await waitFor(() => expect(mockBookings).toHaveBeenCalledTimes(2));
  });

  it('E2 a failed summary read is an error — the ledger totals are not shown as zeros', async () => {
    allOk();
    mockSummary.mockResolvedValue({ ok: false, error: 'ledger_unavailable' });
    const { findByText, queryByText } = await render(<BuddyEarnings />);
    expect(await findByText("Couldn't load earnings", {}, { timeout: 5000 })).toBeTruthy();
    expect(queryByText('$0.00')).toBeNull();
  });

  it("E3 a completed booking's commission and net are its ledger row's — not 10% / 90% of the total", async () => {
    allOk();
    const { findByTestId, findByText, getByText, queryByText } = await render(<BuddyEarnings />);
    // The date-range chips default to "This month"; show everything.
    await fireEvent.press(await findByText('All time', {}, { timeout: 5000 }));
    await findByTestId('earnings-breakdown-bk-1', {}, { timeout: 5000 });

    expect(getByText('Platform commission (25%, est.)')).toBeTruthy();
    expect(getByText('-$50.00')).toBeTruthy();
    expect(getByText('$150.00')).toBeTruthy();
    // What total × 0.1 and total × 0.9 used to print for a 200.00 booking.
    expect(queryByText('-$20.00')).toBeNull();
    expect(queryByText('$180.00')).toBeNull();
  });

  it('E4 when only the ledger read fails, the breakdown says so and retries — no figure is invented', async () => {
    allOk();
    mockLedger.mockResolvedValue({ ok: false, error: 'db_error' });
    const { findByText, findByTestId, getByText, queryByText } = await render(<BuddyEarnings />);
    await fireEvent.press(await findByText('All time', {}, { timeout: 5000 }));

    const retry = await findByTestId('earnings-breakdown-retry-bk-1', {}, { timeout: 5000 });
    expect(getByText('Commission and net could not be loaded. Tap to try again.')).toBeTruthy();
    expect(queryByText(/You keep/)).toBeNull();
    expect(queryByText('-$20.00')).toBeNull();

    mockLedger.mockResolvedValue(okLedger([entry('bk-1')]));
    await fireEvent.press(retry);
    expect(await findByText('-$50.00', {}, { timeout: 5000 })).toBeTruthy();
  });

  it('E5 the headline figures are the ledger totals, nothing is shown as collected, and the ledger is one tap away', async () => {
    allOk();
    const { findByTestId, getByText, queryByText } = await render(<BuddyEarnings />);
    const link = await findByTestId('earnings-open-ledger', {}, { timeout: 5000 });

    expect(getByText('$225.00')).toBeTruthy();                 // est. earnings, after commission
    expect(getByText('$75.00')).toBeTruthy();                  // commission
    expect(getByText('$15.00')).toBeTruthy();                  // tips
    expect(getByText('No commission on tips')).toBeTruthy();
    expect(getByText('In-app payment is not live; no deposit is taken')).toBeTruthy();
    expect(getByText(WARNING)).toBeTruthy();
    expect(queryByText(/Est\. this week/i)).toBeNull();        // was `this month ÷ 4`

    await fireEvent.press(link);
    expect(router.push).toHaveBeenCalledWith('/(rent-a-buddy)/buddy-dashboard/earnings-ledger');
  });
});
