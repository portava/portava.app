/**
 * checkout.tsx — an AGE refusal reaches the traveller as what it is
 * (census-trust §31, TV-5b).
 *
 * The class of a refusal is decided in src/services/rentABuddyBookingErrors.ts
 * and pinned there. This file pins the SCREEN half, which nothing pinned:
 *
 *   - a verified minor refused with 403 `age_requirement` sees a persistent
 *     "Age requirement" banner — before §31 every unmapped code reached the
 *     "Booking failed" alert reading "Something went wrong on our side … Please
 *     try again", which invites exactly the retry the age gate exists to stop;
 *   - a traveller with no date of birth found (403 `age_verification_required`)
 *     is given the way to add one;
 *   - CONTROL: an unreadable age check (503 `age_verification_unavailable`) is
 *     still a failure, where retrying is the honest advice.
 *
 * The classifier is the REAL one; only the screen's network calls are stubbed.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor, screen, cleanup } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// NOTE: intentional stub — expo-router is mocked so router.push can be asserted.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({ buddyId: 'buddy-77' }),
  useFocusEffect: (cb: () => unknown) => { require('react').useEffect(cb, []); },
  useRouter: () => ({ push: jest.fn() }),
}));

import { router } from 'expo-router';
const routerPush = router.push as jest.Mock;

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

// NOTE: intentional stub — the screen's three network calls. The refusal
// classifier is the shipped one, so the class under test is the real class.
jest.mock('../../../src/services/rentABuddy', () => ({
  getBuddyProfile: jest.fn(),
  getBuddyBlockedDates: jest.fn(),
  createBooking: jest.fn(),
  classifyBookingRefusal: jest.requireActual('../../../src/services/rentABuddyBookingErrors').classifyBookingRefusal,
}));

import { getBuddyProfile, getBuddyBlockedDates, createBooking } from '../../../src/services/rentABuddy';
import RentABuddyCheckout from '../checkout';

const BUDDY = {
  id: 'buddy-77', userId: 'user-77', displayName: 'Carlos', city: 'Mexico City', country: 'Mexico',
  categories: ['city'], languages: ['English'], verified: true, averageRating: 4.8, reviewCount: 18,
  hourlyRateUsd: 22, status: 'active', tagline: null, bio: null, coverPhotoUrl: null, responseTimeH: 1,
  distanceKm: null, buddyLevel: null, meetupBaseLat: null, meetupBaseLng: null,
};

async function fillAndBook() {
  await render(<RentABuddyCheckout />);
  await waitFor(() => expect(screen.getByText('Select date')).toBeTruthy());
  await fireEvent.press(screen.getByText('Select date'));
  await fireEvent.press(screen.getByTestId('pick-date'));
  await fireEvent.changeText(screen.getByPlaceholderText('e.g. Louvre main entrance, near the pyramid'), 'Zócalo, by the flagpole');
  await fireEvent.press(screen.getByText(/I confirm this booking is for cultural, social, or practical travel support only/));
  await fireEvent.press(screen.getByTestId('checkout-confirm-btn'));
  await waitFor(() => expect(createBooking).toHaveBeenCalledTimes(1));
}

beforeEach(async () => {
  // The one-time safety tutorial has already been seen on this device.
  await AsyncStorage.setItem('rab_safety_tutorial_shown', '1');
  (getBuddyProfile as jest.Mock).mockResolvedValue({
    ok: true,
    data: { buddy: BUDDY, packages: [], addons: [], availability: [], reviews: [], savedByMe: false },
  });
  (getBuddyBlockedDates as jest.Mock).mockResolvedValue({ ok: true, data: { blocked: [] } });
});

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

describe('checkout — census-trust §31 (TV-5b): age refusals are named on the screen', () => {
  it('a VERIFIED MINOR (403 age_requirement) gets a persistent age banner, not "Booking failed … try again"', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    (createBooking as jest.Mock).mockResolvedValue({ ok: false, error: 'age_requirement' });
    await fillAndBook();
    await waitFor(() => expect(screen.getByTestId('booking-ineligible-banner')).toBeTruthy());
    expect(screen.getByText('Age requirement')).toBeTruthy();
    expect(screen.getByText(/don't meet the age requirement/i)).toBeTruthy();
    expect(alert).not.toHaveBeenCalled();
    expect(screen.queryByTestId('booking-action-btn')).toBeNull();
  });

  it('no date of birth found (403 age_verification_required) is given the way to add one', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    (createBooking as jest.Mock).mockResolvedValue({ ok: false, error: 'age_verification_required' });
    await fillAndBook();
    await waitFor(() => expect(screen.getByTestId('booking-action-banner')).toBeTruthy());
    expect(screen.getByText(/couldn't find a date of birth on your profile/i)).toBeTruthy();
    expect(screen.getByText('Add my date of birth')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('booking-action-btn'));
    expect(routerPush).toHaveBeenCalledWith('/profile/edit/identity');
    expect(alert).not.toHaveBeenCalled();
  });

  it('CONTROL — an unreadable age check (503) is still a failure, where retrying is honest', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    (createBooking as jest.Mock).mockResolvedValue({ ok: false, error: 'age_verification_unavailable' });
    await fillAndBook();
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Booking failed', expect.stringMatching(/couldn't check your age/i)));
    expect(screen.queryByTestId('booking-ineligible-banner')).toBeNull();
  });
});
