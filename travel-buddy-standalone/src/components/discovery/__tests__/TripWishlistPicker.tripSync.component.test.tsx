/**
 * WP-10 / TRIP-F25: "Save to trip" reaches the TRIP's shared list, and an
 * unsave the trip list refused is not shown as done (census-trips §77, WP10-D1).
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { TripWishlistPicker } from '../TripWishlistPicker.tsx';

jest.mock('../../../services/trips', () => ({
  ...jest.requireActual('../../../services/trips'),
  listMyTrips: jest.fn(),
}));
jest.mock('../../../services/discoveryBookmarks', () => ({
  ...jest.requireActual('../../../services/discoveryBookmarks'),
  toggleSave: jest.fn(),
  getSavedListIds: jest.fn(),
}));
jest.mock('../../../features/trips/savedPlaces/tripSavedPlacesSync.ts', () => ({
  ...jest.requireActual('../../../features/trips/savedPlaces/tripSavedPlacesSync.ts'),
  applyTripSaveToggle: jest.fn(),
}));

import { listMyTrips } from '../../../services/trips.ts';
import { toggleSave, getSavedListIds } from '../../../services/discoveryBookmarks.ts';
import { applyTripSaveToggle } from '../../../features/trips/savedPlaces/tripSavedPlacesSync.ts';

const mockList = listMyTrips as jest.MockedFunction<typeof listMyTrips>;
const mockToggle = toggleSave as jest.MockedFunction<typeof toggleSave>;
const mockSavedIds = getSavedListIds as jest.MockedFunction<typeof getSavedListIds>;
const mockApply = applyTripSaveToggle as jest.MockedFunction<typeof applyTripSaveToggle>;

const PLACE = { id: 'place-1', name: 'Café Nata', category: 'food', type: null, address: null, lat: null, lng: null };
const TRIP = {
  id: 'trip-a', ownerId: 'u1', title: 'Lisbon', destinationCity: 'Lisbon', destinationCountry: 'Portugal', neighborhoods: [],
  startDate: '2026-10-01', endDate: '2026-10-05', status: 'planning' as const, visibility: 'public' as const,
  travelStyle: null, openToMeet: true, coverUrl: null, progress: 0,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockList.mockResolvedValue([TRIP] as any);
});

it('saving to a trip carries the save to the trip\'s shared list', async () => {
  mockSavedIds.mockResolvedValue(new Set());
  mockToggle.mockResolvedValue({ added: true, synced: true });
  mockApply.mockResolvedValue({ state: 'synced' });
  const onSaved = jest.fn();
  const { getByText } = await render(<TripWishlistPicker place={PLACE} visible onClose={jest.fn()} onSaved={onSaved} />);
  await waitFor(() => getByText('Lisbon'));
  await fireEvent.press(getByText('Lisbon'));
  await waitFor(() => expect(mockApply).toHaveBeenCalledWith('trip-a', expect.objectContaining({ id: 'place-1' }), true));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
});

it('an unsave the trip list refused is reported as a failure and the row stays saved', async () => {
  mockSavedIds.mockResolvedValue(new Set(['trip-a']));
  mockToggle.mockResolvedValue({ added: false, synced: true });
  mockApply.mockResolvedValue({ state: 'failed', detail: 'HTTP 500' });
  const onSaveFailed = jest.fn();
  const { getByText } = await render(<TripWishlistPicker place={PLACE} visible onClose={jest.fn()} onSaveFailed={onSaveFailed} />);
  await waitFor(() => getByText('Already saved'));
  await fireEvent.press(getByText('Lisbon'));
  await waitFor(() => expect(onSaveFailed).toHaveBeenCalled());
  expect(getByText('Already saved')).toBeTruthy();
});
