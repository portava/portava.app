/**
 * HM-F15 — the trip recap, /trip/:id/recap.
 *
 * `GET /trips/:tripId/memories/recap` (§18 TripMemoryProjection) had no caller.
 * The server decides everything: accepted crew only, the trip owner's Memories
 * that THIS crew member may read, participants disclosed per §10. The screen
 * shows the rows in trip order and keeps "not on this trip" apart from "could
 * not build it".
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

const mockPush = jest.fn();
// NOTE: intentionally exhaustive — expo-router's real module needs a navigator.
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: (...a: unknown[]) => mockPush(...a) },
  useLocalSearchParams: () => ({ id: '22222222-2222-4222-8222-222222222222' }),
}));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
const mockRecap = jest.fn();
jest.mock('../../../src/services/memorySocial.ts', () => ({
  ...jest.requireActual('../../../src/services/memorySocial.ts'),
  getTripMemoryRecap: (...a: unknown[]) => mockRecap(...a),
}));

import TripRecapRoute from '../[id]/recap.tsx';

const TRIP = '22222222-2222-4222-8222-222222222222';
beforeEach(() => { mockPush.mockReset(); mockRecap.mockReset(); });

it('shows the recap rows in trip order and opens a memory', async () => {
  mockRecap.mockResolvedValue({ ok: true, rows: [
    { memory_id: 'm1', occurred_at: '2026-08-01T10:00:00Z', title: 'Arrival', location_city: 'Porto', location_country: 'Portugal', media_count: 2, people: ['a', 'b'] },
    { memory_id: 'm2', occurred_at: '2026-08-02T10:00:00Z', title: 'Douro day', location_city: null, location_country: null, media_count: 0, people: [] },
  ] });
  await render(<TripRecapRoute />);
  expect(await screen.findByText('Arrival')).toBeTruthy();
  expect(screen.getByText('Douro day')).toBeTruthy();
  expect(mockRecap).toHaveBeenCalledWith(TRIP);
  expect(screen.getByText(/with 2 people/)).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByTestId('trip-recap-row-m1')); });
  expect(mockPush).toHaveBeenCalledWith('/memory/m1');
});

it('someone not on the trip is told there is no recap for them', async () => {
  mockRecap.mockResolvedValue({ ok: false, kind: 'not_found', message: 'No recap for this trip' });
  await render(<TripRecapRoute />);
  expect(await screen.findByTestId('trip-recap-unavailable')).toBeTruthy();
  expect(screen.queryByTestId('trip-recap-retry')).toBeNull();
});

it('a recap the server could not build is an error with a retry', async () => {
  mockRecap.mockResolvedValueOnce({ ok: false, kind: 'degraded_unavailable', message: 'Could not build the trip recap. Please try again.' });
  await render(<TripRecapRoute />);
  expect(await screen.findByText('Could not build the trip recap. Please try again.')).toBeTruthy();
  mockRecap.mockResolvedValueOnce({ ok: true, rows: [] });
  await act(async () => { fireEvent.press(screen.getByTestId('trip-recap-retry')); });
  expect(await screen.findByTestId('trip-recap-empty')).toBeTruthy();
});

// PHOTOS-CLIENT (2026-10-14; found by lane NARR-PHOTOS): a recap row's `media_count` counts EVERY item of the
// Memory, photos and videos alike, and TripMemoryProjection's eight-field whitelist carries no per-kind
// count. So the row says "items", never "photos" it cannot know. Each case below that names a kind was
// "N photo(s)" on main.
describe('the recap row counts items, not photos', () => {
  const showRow = async (media_count: number | null) => {
    mockRecap.mockResolvedValue({ ok: true, rows: [{ memory_id: 'm1', occurred_at: '2026-08-01T10:00:00Z', title: 'Arrival', location_city: null, location_country: null, media_count, people: ['a'] }] });
    await render(<TripRecapRoute />);
    await screen.findByText('Arrival');
  };
  const metaText = (re: RegExp) => String([screen.getByText(re).props.children].flat().join(''));

  it('a Memory of 3 photos and 1 video (media_count 4) says "4 items", not "4 photos"', async () => {
    await showRow(4);
    expect(metaText(/· 4 items · with 1 person$/)).not.toMatch(/photo|video/);
    expect(screen.queryByText(/4 photos/)).toBeNull();
  });

  it('a Memory of 2 videos says "2 items", never "2 photos"', async () => {
    await showRow(2);
    expect(metaText(/· 2 items · with 1 person$/)).not.toMatch(/photo|video/);
  });

  it('a Memory of 3 photos also says "3 items": no kinds are sent, so none is guessed', async () => {
    await showRow(3);
    expect(metaText(/· 3 items · /)).not.toMatch(/photo/);
  });

  it('one item is "1 item"; none, or no count at all, prints no count', async () => {
    await showRow(1);
    expect(metaText(/· 1 item · /)).not.toMatch(/items|photo/);
    await showRow(0);
    expect(screen.queryByText(/\bitems?\b/)).toBeNull();
    await showRow(null);
    expect(screen.queryByText(/\bitems?\b/)).toBeNull();
  });
});
