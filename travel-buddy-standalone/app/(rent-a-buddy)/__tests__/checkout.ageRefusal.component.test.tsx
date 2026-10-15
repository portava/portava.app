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
import { render, fireEvent, waitFor, screen, cleanup, act } from '@testing-library/react-native';
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

jest.mock('../../../src/services/adminApi.ts', () => ({
  ...jest.requireActual('../../../src/services/adminApi.ts'),
  freshToken: jest.fn().mockResolvedValue(null),
}));

import { getBuddyProfile, getBuddyBlockedDates, createBooking, type BuddyPackage } from '../../../src/services/rentABuddy';
import RentABuddyCheckout from '../checkout';

const BUDDY = {
  id: 'buddy-77', userId: 'user-77', displayName: 'Carlos', city: 'Mexico City', country: 'Mexico',
  categories: ['city'], languages: ['English'], verified: true, averageRating: 4.8, reviewCount: 18,
  hourlyRateUsd: 22, status: 'active', tagline: null, bio: null, coverPhotoUrl: null, responseTimeH: 1,
  distanceKm: null, buddyLevel: null, meetupBaseLat: null, meetupBaseLng: null,
};

const PACKAGES: BuddyPackage[] = [
  { id: 'nightlife-package', buddyId: BUDDY.id, title: 'Nightlife walk', category: 'nightlife', priceUsd: 44, durationH: 2, maxGroup: 4, isActive: true, description: null, createdAt: '', updatedAt: '' },
  { id: 'city-package', buddyId: BUDDY.id, title: 'City walk', category: 'city', priceUsd: 66, durationH: 3, maxGroup: 4, isActive: true, description: null, createdAt: '', updatedAt: '' },
];

async function fillForm(experience?: string | RegExp) {
  await render(<RentABuddyCheckout />);
  await waitFor(() => expect(screen.getByText('Select date')).toBeTruthy());
  if (experience) await fireEvent.press(screen.getByText(experience));
  await fireEvent.press(screen.getByText('Select date'));
  await fireEvent.press(screen.getByTestId('pick-date'));
  await fireEvent.changeText(screen.getByPlaceholderText('e.g. Louvre main entrance, near the pyramid'), 'Zócalo, by the flagpole');
  await fireEvent.press(screen.getByText(/I confirm this booking is for cultural, social, or practical travel support only/));
}

async function fillAndBook(experience?: string | RegExp) {
  await fillForm(experience);
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
    expect(screen.getByTestId('checkout-confirm-btn')).toBeDisabled();
    await fireEvent.press(screen.getByTestId('checkout-confirm-btn'));
    expect(createBooking).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
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

describe('checkout — current identity refusal through the real booking client', () => {
  beforeEach(() => {
    (createBooking as jest.Mock).mockImplementation(jest.requireActual('../../../src/services/rentABuddy').createBooking);
  });

  it.each(['identity_verification_required', 'verification_required'])('%s preserves the form and offers verification without claiming a booking', async (code) => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const request = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false, status: 403,
      json: async () => ({ error: code, side: 'traveler', message: 'Please verify your identity to continue.' }),
    } as Response);
    await fillAndBook();
    await waitFor(() => expect(screen.getByTestId('booking-action-banner')).toBeTruthy());
    expect(screen.getByText('Verification needed')).toBeTruthy();
    expect(screen.getByTestId('checkout-confirm-btn')).not.toBeDisabled();
    expect(screen.getByPlaceholderText('e.g. Louvre main entrance, near the pyramid').props.value).toBe('Zócalo, by the flagpole');
    expect(screen.queryByTestId('booking-ineligible-banner')).toBeNull();
    expect(screen.queryByTestId('booking-unavailable-banner')).toBeNull();
    expect(alert).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(expect.stringMatching(/\/api\/rent-a-buddy\/bookings$/), expect.objectContaining({ method: 'POST' }));

    await fireEvent.press(screen.getByTestId('booking-action-btn'));
    expect(routerPush).toHaveBeenCalledWith('/profile/verification');
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ booking: { id: 'booking-after-verification' } }) } as Response);
    await fireEvent.press(screen.getByTestId('checkout-confirm-btn'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith({
      pathname: '/(rent-a-buddy)/booking/[id]', params: { id: 'booking-after-verification', fromCheckout: '1' },
    }));
    expect(screen.queryByTestId('booking-action-banner')).toBeNull();
    expect(request.mock.calls[1]![1]!.body).toBe(request.mock.calls[0]![1]!.body);
  });

  it.each(['age_requirement', 'verification_unavailable', 'age_verification_unavailable', 'buddy_unavailable'])('a subsequent %s replaces the earlier verification action', async (code) => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const request = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false, status: 403, json: async () => ({ error: 'verification_required' }),
    } as Response).mockResolvedValueOnce({
      ok: false, status: ['verification_unavailable', 'age_verification_unavailable'].includes(code) ? 503 : 403, json: async () => ({ error: code }),
    } as Response);
    await fillAndBook();
    await waitFor(() => expect(screen.getByTestId('booking-action-banner')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('checkout-confirm-btn'));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('booking-action-banner')).toBeNull());
    expect(screen.queryByTestId('booking-action-btn')).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
    if (code === 'age_requirement') {
      expect(screen.getByTestId('booking-ineligible-banner')).toBeTruthy();
      expect(screen.getByTestId('checkout-confirm-btn')).toBeDisabled();
      expect(alert).not.toHaveBeenCalled();
    } else if (code === 'verification_unavailable') {
      expect(screen.getByTestId('booking-unavailable-banner')).toBeTruthy();
      expect(screen.getByTestId('checkout-confirm-btn')).toBeDisabled();
      expect(alert).not.toHaveBeenCalled();
    } else {
      expect(alert).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('checkout-confirm-btn')).not.toBeDisabled();
    }
  });
});

describe('checkout — age refusals apply only to the age-relevant request context', () => {
  beforeEach(() => {
    (createBooking as jest.Mock).mockImplementation(jest.requireActual('../../../src/services/rentABuddy').createBooking);
    (getBuddyProfile as jest.Mock).mockResolvedValue({
      ok: true,
      data: { buddy: BUDDY, packages: PACKAGES, addons: [], availability: [], reviews: [], savedByMe: false },
    });
  });

  it.each([
    { selection: 'category', nightlife: 'Nightlife Guide', city: 'City Explorer', packageId: undefined },
    { selection: 'package', nightlife: /Nightlife walk/, city: /City walk/, packageId: 'city-package' },
  ])('changing $selection from nightlife to city permits a new server decision', async ({ nightlife, city, packageId }) => {
    const request = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false, status: 403, json: async () => ({ error: 'age_requirement', message: 'Nightlife bookings require you to be at least 21 years old.' }),
    } as Response).mockResolvedValueOnce({
      ok: true, status: 201, json: async () => ({ booking: { id: 'city-booking' } }),
    } as Response);
    await fillAndBook(nightlife);
    await waitFor(() => expect(screen.getByTestId('booking-ineligible-banner')).toBeTruthy());
    expect(JSON.parse(request.mock.calls[0]![1]!.body as string).category).toBe('nightlife');
    await fireEvent.press(screen.getByText(nightlife));
    await fireEvent.changeText(screen.getByPlaceholderText("Tell your Buddy what you're hoping to experience…"), 'Architecture and public squares');
    await fireEvent.changeText(screen.getByPlaceholderText('e.g. Louvre main entrance, near the pyramid'), 'Museum entrance');
    expect(screen.getByTestId('checkout-confirm-btn')).toBeDisabled();
    await fireEvent.press(screen.getByTestId('checkout-confirm-btn'));
    expect(request).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByText(city));
    expect(screen.queryByTestId('booking-ineligible-banner')).toBeNull();
    expect(screen.getByTestId('checkout-confirm-btn')).not.toBeDisabled();
    expect(request).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('checkout-confirm-btn'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith({
      pathname: '/(rent-a-buddy)/booking/[id]', params: { id: 'city-booking', fromCheckout: '1' },
    }));
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(request.mock.calls[1]![1]!.body as string)).toMatchObject({
      category: 'city', bookingDate: '2099-06-01', meetupLocation: 'Museum entrance', notes: 'Architecture and public squares',
    });
    expect(JSON.parse(request.mock.calls[1]![1]!.body as string).packageId).toBe(packageId);
  });

  it('a package change with the same category does not clear the age refusal', async () => {
    const request = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false, status: 403, json: async () => ({ error: 'age_requirement' }),
    } as Response);
    await fillAndBook('Nightlife Guide');
    await waitFor(() => expect(screen.getByTestId('booking-ineligible-banner')).toBeTruthy());
    await fireEvent.press(screen.getByText(/Nightlife walk/));
    expect(screen.getByTestId('booking-ineligible-banner')).toBeTruthy();
    expect(screen.getByTestId('checkout-confirm-btn')).toBeDisabled();
    await fireEvent.press(screen.getByTestId('checkout-confirm-btn'));
    await fireEvent.press(screen.getByText('Hourly rate ($22/hr)'));
    expect(screen.getByTestId('checkout-confirm-btn')).toBeDisabled();
    await fireEvent.press(screen.getByTestId('checkout-confirm-btn'));
    expect(request).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('changing category keeps the submitting guard and ignores a late refusal for the old category', async () => {
    let finishRequest!: (response: Response) => void;
    const request = jest.spyOn(global, 'fetch').mockImplementationOnce(() => new Promise<Response>((resolve) => { finishRequest = resolve; }))
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ booking: { id: 'city-after-pending-nightlife' } }) } as Response);
    await fillForm('Nightlife Guide');
    const pendingPress = fireEvent.press(screen.getByTestId('checkout-confirm-btn'));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await fireEvent.press(screen.getByText('City Explorer'));
    expect(screen.getByTestId('checkout-confirm-btn')).toBeDisabled();
    await fireEvent.press(screen.getByTestId('checkout-confirm-btn'));
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishRequest({ ok: false, status: 403, json: async () => ({ error: 'age_requirement' }) } as Response);
      await pendingPress;
    });
    expect(screen.queryByTestId('booking-ineligible-banner')).toBeNull();
    expect(screen.getByTestId('checkout-confirm-btn')).not.toBeDisabled();
    expect(router.replace).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('checkout-confirm-btn'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith({
      pathname: '/(rent-a-buddy)/booking/[id]', params: { id: 'city-after-pending-nightlife', fromCheckout: '1' },
    }));
    expect(JSON.parse(request.mock.calls[1]![1]!.body as string).category).toBe('city');
  });

  it('changing category does not clear an unavailable refusal', async () => {
    const request = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false, status: 503, json: async () => ({ error: 'verification_unavailable' }),
    } as Response);
    await fillAndBook('Nightlife Guide');
    await waitFor(() => expect(screen.getByTestId('booking-unavailable-banner')).toBeTruthy());
    await fireEvent.press(screen.getByText('City Explorer'));
    expect(screen.getByTestId('booking-unavailable-banner')).toBeTruthy();
    expect(screen.getByTestId('checkout-confirm-btn')).toBeDisabled();
    await fireEvent.press(screen.getByTestId('checkout-confirm-btn'));
    expect(request).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
  });
});
