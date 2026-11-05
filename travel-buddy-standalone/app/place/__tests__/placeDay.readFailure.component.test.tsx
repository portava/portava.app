/**
 * /place/:id/day — a failed read is not "No Place Day yet".
 *
 * getPlaceDay and getPlaceDayFeed answer null for a failed read. The screen
 * read that as "No Place Day yet" and "Nothing shared here yet", and a recap
 * that could not be made did nothing.
 *
 * Pinned: a failed day read shows an error with Try again (which loads it); a
 * failed feed read under a real day says so; a real empty day is still the
 * empty copy; a recap that is not created says so.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

const mockPush = jest.fn();
// NOTE: intentionally exhaustive — expo-router's real module needs a navigator.
jest.mock('expo-router', () => {
  const { View: V } = jest.requireActual('react-native');
  return {
    Stack: { Screen: () => <V /> },
    router: { back: jest.fn(), push: (...a: unknown[]) => mockPush(...a) },
    useLocalSearchParams: () => ({ id: 'place-1' }),
  };
});
jest.mock('react-native-safe-area-context', () => {
  const { View: V } = jest.requireActual('react-native');
  return { ...jest.requireActual('react-native-safe-area-context'), SafeAreaView: V };
});
// NOTE: intentionally exhaustive — the real provider fetches flags on mount.
jest.mock('../../../src/context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({ isEnabled: () => true, isLivePlacesEnabled: () => true, loading: false }),
}));

const mockDay = jest.fn();
const mockFeed = jest.fn();
jest.mock('../../../src/services/places.ts', () => ({
  ...jest.requireActual('../../../src/services/places.ts'),
  getPlaceDay: (...a: unknown[]) => mockDay(...a),
  getPlaceDayFeed: (...a: unknown[]) => mockFeed(...a),
}));
const mockRecap = jest.fn();
jest.mock('../../../src/services/placeRecaps.ts', () => ({
  ...jest.requireActual('../../../src/services/placeRecaps.ts'),
  createPlaceDayRecap: (...a: unknown[]) => mockRecap(...a),
}));

import PlaceDayScreen from '../[id]/day.tsx';

const DAY = { id: 'pd-1', placeId: 'place-1', placeName: 'Plaza', localDate: '2026-11-01', timezone: 'UTC', status: 'archived' };
const NAV = { previousDate: null, nextDate: null };

let alertSpy: jest.SpyInstance;
beforeEach(() => {
  mockDay.mockReset(); mockFeed.mockReset(); mockRecap.mockReset(); mockPush.mockReset();
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => alertSpy.mockRestore());

async function mount() {
  await render(<PlaceDayScreen />);
  await act(async () => {});
}

describe('Place Day — read failures', () => {
  it('a failed day read is an error with Try again, not "No Place Day yet"', async () => {
    mockDay.mockResolvedValueOnce(null).mockResolvedValue({ day: DAY, navigation: NAV });
    mockFeed.mockResolvedValue({ items: [] });
    await mount();
    expect(screen.getByTestId('place-day-error')).toBeTruthy();
    expect(screen.queryByText('No Place Day yet')).toBeNull();
    await act(async () => { fireEvent.press(screen.getByText('Try again')); });
    expect(await screen.findByText('Nothing shared here yet')).toBeTruthy();
  });

  it('a failed feed read under a real day says so, not "Nothing shared here yet"', async () => {
    mockDay.mockResolvedValue({ day: DAY, navigation: NAV });
    mockFeed.mockResolvedValue(null);
    await mount();
    expect(screen.getByTestId('place-day-feed-error')).toBeTruthy();
    expect(screen.queryByText('Nothing shared here yet')).toBeNull();
  });

  it('control: a day that does not exist is still "No Place Day yet"', async () => {
    mockDay.mockResolvedValue({ day: null, navigation: NAV });
    await mount();
    expect(screen.getByText('No Place Day yet')).toBeTruthy();
    expect(screen.queryByTestId('place-day-error')).toBeNull();
  });

  it('a recap that is not created says so', async () => {
    mockDay.mockResolvedValue({ day: DAY, navigation: NAV });
    mockFeed.mockResolvedValue({ items: [] });
    mockRecap.mockResolvedValue(null);
    await mount();
    await act(async () => { fireEvent.press(screen.getByTestId('create-place-recap')); });
    expect(alertSpy).toHaveBeenCalledWith('Recap not created', expect.any(String));
    expect(mockPush).not.toHaveBeenCalled();
  });
});

it('Place Day photos open their originals full screen and close in place', async () => {
  mockDay.mockResolvedValue({ day: DAY, navigation: NAV });
  mockFeed.mockResolvedValue({ items: [{ id: 'p1', caption: 'Morning', mediaUrl: 'https://example.com/original.jpg', thumbnailUrl: 'https://example.com/thumb.jpg', mediaType: 'image', createdAt: '2026-11-01T10:00:00Z' }] });
  await mount(); await fireEvent.press(screen.getByLabelText('View photo full screen'));
  expect(screen.getByTestId('fullscreen-photo-canvas')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Close full-screen photo'));
  expect(screen.queryByTestId('fullscreen-photo-canvas')).toBeNull(); expect(screen.getByText('Morning')).toBeTruthy();
});
