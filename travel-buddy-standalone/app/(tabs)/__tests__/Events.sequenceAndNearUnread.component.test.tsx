/**
 * census-discovery §119 (DV-83 round 22, lane W11-X2; the round-21 verifier's survivors V28 and V29, fixtures CR1, NU1):
 * the events tab's category-row request-sequence guard and Near Me's "not whole and empty" message are pinned
 * (app/(tabs)/events.tsx). Events.nearMeRadius races only the main lists (TR1) and fails only a whole near read (NM2).
 *
 *   CR0 CONTROL / CR1 (V28): the category rows' answer for the previous filter lands after the new filter's → never drawn
 *   NU0 CONTROL: a whole, empty near answer → the prompt, nothing said unread
 *   NU1 (V29): an EMPTY near answer the server says is not whole (`truncated`) → "Couldn't load events near you"
 */
import React from 'react';
import { render, waitFor, fireEvent, act } from '@testing-library/react-native';
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn() },
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => { const c = cb(); return typeof c === 'function' ? c : undefined; }, [cb]);  // re-run when the callback changes, as on a focused screen
  },
}));

// NOTE: intentional stub — nav-bar collapse is not under test here.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  NavBarFiller: () => null,
  NAV_BAR_FILLER_HEIGHT: 96,
}));

// NOTE: intentional stub — the session is not under test here.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ isAuthed: true, configured: true, userId: 'u1' }),
}));

// NOTE: intentionally exhaustive — location is available, so Near Me can be asked; the hook is all the tab reads.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({ locationState: { coords: { lat: 38.72, lng: -9.14 } }, requestLocation: jest.fn() }),
}));

// NOTE: intentional stub — no snapshot, so the tab paints only what the lists answer.
jest.mock('../../../src/hooks/useSnapshotCache', () => ({
  useSnapshotCache: () => ({ snapshot: null, save: jest.fn(), clear: jest.fn() }),
}));

// NOTE: intentional stub — screen timing is not under test here.
jest.mock('../../../src/hooks/useScreenTiming', () => ({
  useScreenTiming: () => ({ markFirstContent: jest.fn(), epoch: 0 }),
}));

jest.mock('../../../src/services/events', () => ({
  ...jest.requireActual('../../../src/services/events'),
  listEvents: jest.fn(),
  listMyEvents: jest.fn(),
  listFollowingEvents: jest.fn(),
  listCircleEvents: jest.fn(),
  getSavedEvents: jest.fn(),
  getMyDrafts: jest.fn(),
  getMyEventInvites: jest.fn(),
}));

jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { Image: (p: { testID?: string }) => React.createElement(View, { testID: p.testID ?? 'expo-image' }) };
});

import EventsTab from '../events';
import * as svc from '../../../src/services/events';

const event = (id: string, title: string) => ({
  id, hostId: 'h1', hostName: 'Ana', hostHandle: null, hostAvatarUrl: null, title,
  description: null, locationName: 'Rooftop', locationLat: null, locationLng: null, startsAt: '2099-08-01T18:00:00Z',
  endsAt: null, coverUrl: null, coverMediaType: null, maxAttendees: 10, ageMin: null, ageMax: null, trustScoreMin: null,
  verifiedOnly: false, visibility: 'public', state: 'open', chatEnabled: false, chatThreadId: null, waitlistEnabled: true,
  priceType: 'free', priceUrl: null, rsvpOptions: ['going'], goingCount: 4, waitlistCount: 0, category: null, city: 'Lisbon',
  country: null, rsvpClosed: false, showExactLocation: false, isHost: false, createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z', myRsvp: null,
});
const ok = (data: Record<string, unknown>) => Promise.resolve({ ok: true, data });
const FAR = 'Sintra night market (20 km away)';
const NEAR = 'Alfama fado (2 km away)';
let failRadius: number | null = null;
function lists() {
  (svc.listEvents as jest.Mock).mockImplementation((p: { nearRadiusKm?: number }) => {
    if (p.nearRadiusKm == null) return ok({ events: [] });
    if (p.nearRadiusKm === failRadius) return Promise.resolve({ ok: false, message: 'HTTP 503' });
    // GET /events near: 5 km holds only NEAR; 25 km and more hold NEAR and FAR.
    return ok({ events: p.nearRadiusKm < 20 ? [event('ev-near', NEAR)] : [event('ev-near', NEAR), event('ev-far', FAR)] });
  });
  (svc.listMyEvents as jest.Mock).mockImplementation(() => ok({ events: [] }));
  (svc.listFollowingEvents as jest.Mock).mockImplementation(() => ok({ events: [] }));
  (svc.listCircleEvents as jest.Mock).mockImplementation(() => ok({ events: [] }));
  (svc.getSavedEvents as jest.Mock).mockImplementation(() => ok({ events: [], page: 1 }));
  (svc.getMyDrafts as jest.Mock).mockImplementation(() => ok({ drafts: [] }));
  (svc.getMyEventInvites as jest.Mock).mockImplementation(() => ok({ invites: [] }));
}

const OLDCAT = 'Old-filter category row';
const NEWCAT = 'Free category row';
async function catRace(stale: boolean) {
  lists();
  const held: Array<() => void> = [];
  (svc.listEvents as jest.Mock).mockImplementation((p: { limit?: number; free?: boolean }) => {
    if (p.limit === 8 && !p.free) return new Promise((res) => held.push(() => res({ ok: true, data: { events: [event('ev-oldcat', OLDCAT)] } })));
    if (p.limit === 8 && p.free) return ok({ events: [event('ev-newcat', NEWCAT)] });
    return ok({ events: [] });
  });
  const r = await render(<EventsTab />);
  await waitFor(() => expect(held.length).toBeGreaterThan(0));
  if (!stale) await act(async () => { held.forEach((f) => f()); });
  await act(async () => { fireEvent.press(r.getByLabelText('Filters')); });
  await act(async () => { fireEvent.press(r.getByText('Free')); });
  await act(async () => {}); await act(async () => {});
  if (stale) await act(async () => { held.forEach((f) => f()); });
  await act(async () => {}); await act(async () => {});
  return { newDrawn: r.queryAllByText(NEWCAT).length > 0, oldDrawn: r.queryAllByText(OLDCAT).length > 0 };
}
async function nearAnswer(body: Record<string, unknown>) {
  lists();
  (svc.listEvents as jest.Mock).mockImplementation((p: { nearRadiusKm?: number }) => (p.nearRadiusKm != null ? ok(body) : ok({ events: [] })));
  const r = await render(<EventsTab />);
  await waitFor(() => expect(r.queryByText('Find events near you')).not.toBeNull());
  await act(async () => { fireEvent.press(r.getByText('Find events near you')); });
  await act(async () => {}); await act(async () => {});
  return { unreadSaid: r.queryByTestId('near-me-unread') !== null };
}
describe('census-discovery §119 (V28, V29): the events tab', () => {
  beforeEach(() => { jest.clearAllMocks(); failRadius = null; });
  it('CR0 CONTROL: answers in order → the Free rows', async () => { expect(await catRace(false)).toEqual({ newDrawn: true, oldDrawn: false }); });
  it('CR1 the previous filter\'s category rows land last → never drawn', async () => { const s = await catRace(true); expect(s).toEqual({ newDrawn: true, oldDrawn: false }); });
  it('NU0 CONTROL: a whole, empty near answer → nothing said unread', async () => { expect(await nearAnswer({ events: [] })).toEqual({ unreadSaid: false }); });
  it('NU1 an empty near answer that is not whole → said', async () => { const s = await nearAnswer({ events: [], truncated: true }); expect(s).toEqual({ unreadSaid: true }); });
});
