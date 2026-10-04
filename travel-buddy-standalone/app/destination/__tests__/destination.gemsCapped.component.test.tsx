/**
 * census-discovery §114 (DV-83 round 17, lane W11-X2; sweep SW1b): the destination page says a gem list the server cut.
 *
 * The page reads GET /hidden-gems for the city (10 gems) and, when every section is empty, says "No gems, events, or
 * traveler posts here yet". A cut gem read (the server's `truncated: true`; the privacy filter runs after the cut) is
 * not "no gems".
 *
 *   DG0  CONTROL: every section whole and empty → the all-empty state
 *   DG1  the gem list cut and empty → "Couldn't check every gem in Lisbon", and never the all-empty state
 *   DG2  the gem list cut with rows → the rows, and "Showing some gems"
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
jest.mock('../../../src/services/events', () => ({ listEvents: jest.fn(async () => ({ ok: true, data: { events: [] } })) }));
// NOTE: intentionally exhaustive — the real module imports Supabase.
jest.mock('../../../src/services/pulse', () => ({ getPulseData: jest.fn(async () => ({ ok: true, data: { posts: [] } })) }));
jest.mock('../../../src/services/compass', () => ({ ...jest.requireActual('../../../src/services/compass'), fetchCityConfidence: jest.fn().mockResolvedValue({ ok: false }) }));
// NOTE: intentional stub — not under test; pulls FSQ network service.
jest.mock('../../../src/components/trip/TripFsqPlacesSection', () => ({ TripFsqPlacesSection: () => null }));

import Destination from '../[slug].tsx';
import { markGemListCut } from '../../../src/services/gemListCut';

const gem = (id: string) => ({ id, name: `Gem ${id}`, neighborhood: null, imageUrl: null });

async function open() {
  await render(<Destination />);
  await waitFor(() => expect(mockListGems).toHaveBeenCalled());
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

describe('§114 SW1b: the destination page says a cut gem list', () => {
  beforeEach(() => jest.clearAllMocks());

  it('DG0 CONTROL: every section whole and empty → the all-empty state', async () => {
    mockListGems.mockResolvedValue([]);
    await open();
    expect(screen.getByText(/No gems, events, or traveler posts here yet/)).toBeTruthy();
  });

  it('DG1 the gem list cut and empty → "Couldn\'t check every gem in Lisbon", never the all-empty state', async () => {
    mockListGems.mockImplementation(async () => markGemListCut([]));
    await open();
    expect(screen.getByText("Couldn't check every gem in Lisbon")).toBeTruthy();
    expect(screen.queryByText(/No gems, events, or traveler posts here yet/)).toBeNull();
  });

  it('DG2 the gem list cut with rows → the rows, and "Showing some gems"', async () => {
    mockListGems.mockImplementation(async () => markGemListCut([gem('a')]));
    await open();
    expect(screen.getByText('Gem a')).toBeTruthy();
    expect(screen.getByText('Showing some gems')).toBeTruthy();
  });
});
