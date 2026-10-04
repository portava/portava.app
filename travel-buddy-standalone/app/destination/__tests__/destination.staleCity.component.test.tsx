/**
 * census-discovery §118 (DV-83 round 21, lane W11-X2; sweep SW23, B26's class): the destination page draws only the
 * answers for the city on screen.
 *
 * Each section's load is rebuilt when the city changes and kept no request token, so a slow answer for the previous
 * city that landed after the new city's was drawn under the new city's name (events, gems and posts alike). Each section
 * now applies an answer only if no later load of that section has started. The harness is destination.eventsNotWhole's.
 *
 *   DS0  CONTROL: Lisbon's answers land, then the page moves to Porto and Porto's land → Porto's rows
 *   DS1  the page moves to Porto and Lisbon's answers land LAST → Lisbon's rows are never drawn under Porto
 */
import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react-native';

let mockSlug = 'lisbon';
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({ slug: mockSlug })),
}));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
const mockListGems = jest.fn();
// NOTE: intentionally exhaustive — the real module imports Supabase.
jest.mock('../../../src/services/hiddenGems', () => ({ listGems: (...args: unknown[]) => mockListGems(...args) }));
// NOTE: intentionally exhaustive — the real module imports Supabase.
const mockListEvents = jest.fn();
jest.mock('../../../src/services/events', () => ({ listEvents: (...args: unknown[]) => mockListEvents(...args) }));
// NOTE: intentionally exhaustive — the real module imports Supabase.
const mockGetPulseData = jest.fn();
jest.mock('../../../src/services/pulse', () => ({ getPulseData: (...args: unknown[]) => mockGetPulseData(...args) }));
jest.mock('../../../src/services/compass', () => ({ ...jest.requireActual('../../../src/services/compass'), fetchCityConfidence: jest.fn().mockResolvedValue({ ok: false }) }));
// NOTE: intentional stub — not under test; pulls FSQ network service.
jest.mock('../../../src/components/trip/TripFsqPlacesSection', () => ({ TripFsqPlacesSection: () => null }));

import Destination from '../[slug].tsx';

const event = (id: string, title: string, city: string) => ({
  id, hostId: 'h1', hostName: 'Ana', hostHandle: null, hostAvatarUrl: null, title, description: null, locationName: 'Rooftop',
  locationLat: null, locationLng: null, startsAt: '2099-08-01T18:00:00Z', endsAt: null, coverUrl: null, coverMediaType: null,
  maxAttendees: 10, ageMin: null, ageMax: null, trustScoreMin: null, verifiedOnly: false, visibility: 'public', state: 'open',
  chatEnabled: false, chatThreadId: null, waitlistEnabled: true, priceType: 'free', priceUrl: null, rsvpOptions: ['going'],
  goingCount: 3, waitlistCount: 0, category: null, city, country: null, rsvpClosed: false, showExactLocation: false, isHost: false,
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', myRsvp: null,
});
type Held = { city: string; release: () => void };
async function race(order: 'inOrder' | 'stale') {
  const held: Held[] = [];
  mockListEvents.mockImplementation((p: { city: string }) => new Promise((res) => held.push({ city: p.city, release: () => res({ ok: true, data: { events: [event(`ev-${p.city}`, `${p.city} night market`, p.city)] } }) })));
  mockListGems.mockResolvedValue([]);
  mockGetPulseData.mockResolvedValue({ ok: true, data: { posts: [] } });
  mockSlug = 'lisbon';
  const ui = await render(<Destination />);
  await waitFor(() => expect(held.length).toBe(1));
  if (order === 'inOrder') await act(async () => { held[0]!.release(); });
  mockSlug = 'porto';
  await act(async () => { ui.rerender(<Destination />); });
  await waitFor(() => expect(held.some((h) => h.city === 'Porto')).toBe(true));
  await act(async () => { held.find((h) => h.city === 'Porto')!.release(); });
  if (order === 'stale') await act(async () => { held.find((h) => h.city === 'Lisbon')!.release(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return { porto: screen.queryAllByText('Porto night market').length > 0, lisbon: screen.queryAllByText('Lisbon night market').length > 0 };
}

describe('§118 SW23: the destination page draws only the city on screen', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  it('DS0 CONTROL: the answers land in order → Porto\'s rows', async () => {
    expect(await race('inOrder')).toEqual({ porto: true, lisbon: false });
  });
  it('DS1 Lisbon\'s answer lands after Porto\'s → Lisbon\'s rows are never drawn under Porto', async () => {
    expect(await race('stale')).toEqual({ porto: true, lisbon: false });
  });
});
