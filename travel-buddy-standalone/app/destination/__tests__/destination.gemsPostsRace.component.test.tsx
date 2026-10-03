/**
 * census-discovery §119 (DV-83 round 22, lane W11-X2; the round-21 verifier's survivors V30 and V31, fixtures GS1, PS1):
 * the destination page's GEMS and POSTS sections' request-sequence guards (app/destination/[slug].tsx) are pinned.
 * Round 21's destination.staleCity races only the EVENTS section (DS1). Harness: destination.staleCity's.
 *
 *   GS0 CONTROL / GS1 (V30): gems — Lisbon's answer lands after Porto's → Lisbon's gems never drawn under Porto
 *   PS0 CONTROL / PS1 (V31): posts — Lisbon's answer (2 posts) lands after Porto's (1) → 1 tile, never Lisbon's 2
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
async function race(section: 'gems' | 'posts', order: 'inOrder' | 'stale') {
  const held: Held[] = [];
  mockListEvents.mockResolvedValue({ ok: true, data: { events: [] } });
  const post = (id: string) => ({ id, mediaUrls: [`https://img.test/${id}.jpg`], media: [] });
  if (section === 'gems') {
    mockListGems.mockImplementation((p: { city: string }) => new Promise((res) => held.push({ city: p.city, release: () => res([{ id: `g-${p.city}`, name: `${p.city} secret courtyard`, category: 'garden', city: p.city }]) })));
    mockGetPulseData.mockResolvedValue({ ok: true, data: { posts: [] } });
  } else {
    mockListGems.mockResolvedValue([]);
    mockGetPulseData.mockImplementation((p: { city: string }) => new Promise((res) => held.push({ city: p.city, release: () => res({ ok: true, data: { posts: p.city === 'Lisbon' ? [post('l1'), post('l2')] : [post('p1')] } }) })));
  }
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
  return section === 'gems'
    ? { porto: screen.queryAllByText('Porto secret courtyard').length > 0, lisbon: screen.queryAllByText('Lisbon secret courtyard').length > 0 }
    : { tiles: screen.queryAllByLabelText('Traveler post').length };
}
describe('census-discovery §119 (V30, V31): the destination page gems and posts sections draw only the city on screen', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  it('GS0 CONTROL', async () => { expect(await race('gems', 'inOrder')).toEqual({ porto: true, lisbon: false }); });
  it('GS1 Lisbon gems land after Porto\'s → never drawn under Porto', async () => { const s = await race('gems', 'stale'); expect(s).toEqual({ porto: true, lisbon: false }); });
  it('PS0 CONTROL', async () => { expect(await race('posts', 'inOrder')).toEqual({ tiles: 1 }); });
  it('PS1 Lisbon posts land after Porto\'s → never drawn under Porto', async () => { const s = await race('posts', 'stale'); expect(s).toEqual({ tiles: 1 }); });
});
