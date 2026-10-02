/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; sweep SW17): the destination page never says an events list
 * GET /events could not read whole as "no events".
 *
 * GET /events adds `truncated: true` to an answer that is not whole (§115 B12): a filled rank pool, or friends-only
 * events withheld over a failed friendship read. The page read only the array, so an empty page of a cut list joined
 * the all-empty state ("No gems, events, or traveler posts here yet"). The harness is destination.gemsCapped's.
 *
 *   DE1  the events list cut and empty → "Couldn't check every event in Lisbon", never the all-empty state
 *   DE0  CONTROL: every section whole and empty → the all-empty state
 */
import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react-native';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({ slug: 'lisbon' })),
}));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
const mockListGems = jest.fn();
// NOTE: intentionally exhaustive — the real module imports Supabase.
jest.mock('../../../src/services/hiddenGems', () => ({ listGems: (...args: unknown[]) => mockListGems(...args) }));
// NOTE: intentionally exhaustive — the real module imports Supabase.
const mockListEvents = jest.fn();
jest.mock('../../../src/services/events', () => ({ listEvents: (...args: unknown[]) => mockListEvents(...args) }));
// NOTE: intentionally exhaustive — the real module imports Supabase.
jest.mock('../../../src/services/pulse', () => ({ getPulseData: jest.fn(async () => ({ ok: true, data: { posts: [] } })) }));
jest.mock('../../../src/services/compass', () => ({ ...jest.requireActual('../../../src/services/compass'), fetchCityConfidence: jest.fn().mockResolvedValue({ ok: false }) }));
// NOTE: intentional stub — not under test; pulls FSQ network service.
jest.mock('../../../src/components/trip/TripFsqPlacesSection', () => ({ TripFsqPlacesSection: () => null }));

import Destination from '../[slug].tsx';

async function open() {
  await render(<Destination />);
  await waitFor(() => expect(mockListEvents).toHaveBeenCalled());
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

describe('§117 SW17: the destination page says an events list that is not whole', () => {
  beforeEach(() => { jest.clearAllMocks(); mockListGems.mockResolvedValue([]); });

  it('DE1 the events list cut and empty → "Couldn\'t check every event in Lisbon", never the all-empty state', async () => {
    mockListEvents.mockResolvedValue({ ok: true, data: { events: [], truncated: true } });
    await open();
    expect(screen.getByText("Couldn't check every event in Lisbon")).toBeTruthy();
    expect(screen.queryByText(/No gems, events, or traveler posts here yet/)).toBeNull();
  });

  it('DE0 CONTROL: every section whole and empty → the all-empty state', async () => {
    mockListEvents.mockResolvedValue({ ok: true, data: { events: [] } });
    await open();
    expect(screen.getByText(/No gems, events, or traveler posts here yet/)).toBeTruthy();
    expect(screen.queryByText("Couldn't check every event in Lisbon")).toBeNull();
  });
});
