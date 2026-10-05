/**
 * checkout.tsx — the platform commission is shown BEFORE a booking is requested
 * (payments PAY-T12; owner ruling 2026-10-04: "a 10% platform commission on the
 * pre-tax service price, shown before checkout. Charge no platform commission
 * on tips. Don't add a deposit in the first release.")
 *
 *   C1  the percentage shown is the one the SERVER resolved for this buddy and
 *       category — the screen holds no rate of its own;
 *   C2  it says who bears it, and that tips and deposits are not charged;
 *   C3  a commission that cannot be loaded is an error with retry, shows no
 *       percentage, and the request CANNOT be sent until it loads;
 *   C4  the cancellation copy no longer promises a forfeited deposit.
 *
 * The server half — the quote and the ledger pricing a booking from one
 * function — is artifacts/api-server/src/test/rentBuddyLedgerPosting.test.ts.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor, screen, cleanup } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// NOTE: intentional stub — navigation is not under test.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({ buddyId: 'buddy-77' }),
  useFocusEffect: (cb: () => unknown) => { require('react').useEffect(cb, []); },
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentional stub — the sticky-bar inset is layout, not under test.
jest.mock('../../../src/hooks/useBottomInset', () => ({
  useStickyBarInset:     () => ({ inset: 100, onBarLayout: () => {} }),
  usePlainBottomInset:   () => 100,
  PlainBottomFiller:     () => null,
  BOTTOM_BREATHING_ROOM: 24,
  useKeyboardVisible:    () => false,
  useBottomInset:        () => 100,
  useLayoverAwareBottomInset: () => 100,
}));

// NOTE: intentional stub — the real picker is a full calendar modal; this one
// confirms one fixed future date, which is all the form needs to submit.
jest.mock('../../../src/components/selectors/GlobalCalendarPicker', () => ({
  GlobalCalendarPicker: ({ visible, onConfirm }: { visible: boolean; onConfirm: (v: string | null) => void }) => {
    const { createElement } = require('react');
    const { Pressable, Text } = require('react-native');
    return visible
      ? createElement(Pressable, { testID: 'pick-date', onPress: () => onConfirm('2099-06-01') }, createElement(Text, null, 'pick'))
      : null;
  },
}));

// NOTE: intentional stub — the screen's network calls. The refusal classifier
// is the shipped one.
jest.mock('../../../src/services/rentABuddy', () => ({
  getBuddyProfile: jest.fn(),
  getBuddyBlockedDates: jest.fn(),
  getCommissionQuote: jest.fn(),
  createBooking: jest.fn(),
  classifyBookingRefusal: jest.requireActual('../../../src/services/rentABuddyBookingErrors').classifyBookingRefusal,
}));

import { getBuddyProfile, getBuddyBlockedDates, getCommissionQuote, createBooking } from '../../../src/services/rentABuddy';
import RentABuddyCheckout from '../checkout';

const BUDDY = {
  id: 'buddy-77', userId: 'user-77', displayName: 'Carlos', city: 'Mexico City', country: 'Mexico',
  categories: ['city'], languages: ['English'], verified: true, averageRating: 4.8, reviewCount: 18,
  hourlyRateUsd: 22, status: 'active', tagline: null, bio: null, coverPhotoUrl: null, responseTimeH: 1,
  distanceKm: null, buddyLevel: null, meetupBaseLat: null, meetupBaseLng: null,
};

const quote = (platformFeePercent: number, feeSource = 'owner_default') => ({
  ok: true,
  data: {
    platformFeePercent, feeSource, basis: 'pre_tax_service_price', deductedFrom: 'buddy_earnings',
    tipCommissionPercent: 0, depositRequired: false, chargedInApp: false,
  },
});

/** Everything the form needs except the commission, which each test decides. */
async function fillForm() {
  await render(<RentABuddyCheckout />);
  await waitFor(() => expect(screen.getByText('Select date')).toBeTruthy());
  await fireEvent.press(screen.getByText('Select date'));
  await fireEvent.press(screen.getByTestId('pick-date'));
  await fireEvent.changeText(screen.getByPlaceholderText('e.g. Louvre main entrance, near the pyramid'), 'Zócalo, by the flagpole');
  await fireEvent.press(screen.getByText(/I confirm this booking is for cultural, social, or practical travel support only/));
}

beforeEach(async () => {
  await AsyncStorage.setItem('rab_safety_tutorial_shown', '1');
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  (getBuddyProfile as jest.Mock).mockResolvedValue({
    ok: true,
    data: { buddy: BUDDY, packages: [], addons: [], availability: [], reviews: [], savedByMe: false },
  });
  (getBuddyBlockedDates as jest.Mock).mockResolvedValue({ ok: true, data: { blocked: [] } });
  (createBooking as jest.Mock).mockResolvedValue({ ok: true, data: { booking: { id: 'bk-new' } } });
});

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

describe('checkout — the platform commission is shown before the request is sent', () => {
  it('C1 shows the percentage the server resolved, asked for THIS buddy and category', async () => {
    (getCommissionQuote as jest.Mock).mockResolvedValue(quote(10));
    await fillForm();
    const rate = await screen.findByTestId('checkout-commission-rate');
    expect(screen.getByText(/Platform commission: 10% of the service price/)).toBeTruthy();
    expect(rate).toBeTruthy();
    expect(getCommissionQuote).toHaveBeenCalledWith('buddy-77', 'city');
  });

  it('C1 the screen holds no rate of its own: a configured 25% is shown as 25%', async () => {
    (getCommissionQuote as jest.Mock).mockResolvedValue(quote(25, 'fee_schedule'));
    await fillForm();
    await screen.findByTestId('checkout-commission-rate');
    expect(screen.getByText(/Platform commission: 25% of the service price/)).toBeTruthy();
    expect(screen.queryByText(/Platform commission: 10%/)).toBeNull();
  });

  it('C2 says who bears it, and that tips and deposits are not charged', async () => {
    (getCommissionQuote as jest.Mock).mockResolvedValue(quote(10));
    await fillForm();
    await screen.findByTestId('checkout-commission-rate');
    expect(screen.getByText(/taken from your Buddy's earnings — nothing is added to the price you agree/)).toBeTruthy();
    expect(screen.getByText(/No commission on tips\. No deposit\./)).toBeTruthy();
  });

  it('C2 a request is sent once the commission has been shown', async () => {
    (getCommissionQuote as jest.Mock).mockResolvedValue(quote(10));
    await fillForm();
    await screen.findByTestId('checkout-commission-rate');
    await fireEvent.press(screen.getByTestId('checkout-confirm-btn'));
    await waitFor(() => expect(createBooking).toHaveBeenCalledTimes(1));
  });

  it('C3 a commission that cannot be loaded: an error with retry, NO percentage, and no request can be sent', async () => {
    (getCommissionQuote as jest.Mock).mockResolvedValue({ ok: false, error: 'ledger_unavailable' });
    await fillForm();
    expect(await screen.findByTestId('checkout-commission-error')).toBeTruthy();
    expect(screen.queryByTestId('checkout-commission-rate')).toBeNull();
    expect(screen.queryByText(/Platform commission: \d+%/)).toBeNull();

    const confirm = screen.getByTestId('checkout-confirm-btn');
    expect(confirm.props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(confirm);
    expect(createBooking).not.toHaveBeenCalled();

    // Retry loads it, and only then can the request go.
    (getCommissionQuote as jest.Mock).mockResolvedValue(quote(10));
    await fireEvent.press(screen.getByTestId('checkout-commission-retry'));
    await screen.findByTestId('checkout-commission-rate');
    expect(getCommissionQuote).toHaveBeenCalledTimes(2);
    await fireEvent.press(screen.getByTestId('checkout-confirm-btn'));
    await waitFor(() => expect(createBooking).toHaveBeenCalledTimes(1));
  });

  it('C4 the cancellation copy promises no forfeited deposit', async () => {
    (getCommissionQuote as jest.Mock).mockResolvedValue(quote(10));
    await fillForm();
    await fireEvent.press(screen.getByText('Cancellation policy'));
    expect(screen.getByText(/No deposit is taken and nothing is charged through the app/)).toBeTruthy();
    expect(screen.queryByText(/forfeit the deposit/)).toBeNull();
    expect(screen.queryByText(/deposit refund/)).toBeNull();
  });
});
