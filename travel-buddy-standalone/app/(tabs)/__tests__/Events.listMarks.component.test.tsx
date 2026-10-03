/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; sweep SW17): the events tab never says a count the server could
 * not recount as measured, nor "No events yet" over a list it could not read whole.
 *
 * The list services mark the counts a list could not recount (`goingCountUnread`, services/events.ts), and GET /events
 * adds `truncated: true` to an answer that is not whole (§115 B12). The tab drew every card's count as measured and,
 * when every section came back empty, said "No events yet" even when a list was cut or failed outright.
 *
 *   ET1  an Upcoming event marked goingCountUnread → its card says "4 going/10 (last known)"
 *   ET2  every section empty, the Upcoming list `truncated: true` → "Couldn't load every event", never "No events yet"
 *   ET3  every section empty, the Following list failed → "Couldn't load every event", never "No events yet"
 *   ET5  every section empty, a category row's list `truncated: true` → "Couldn't load every event"
 *   ET0  CONTROL: every section whole and empty → "No events yet"
 *   ET0b CONTROL: an unmarked event → "4 going/10"
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn() },
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => { const c = cb(); return typeof c === 'function' ? c : undefined; }, []);
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

// NOTE: intentional stub — location is not under test here (Near Me is never asked).
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({ locationState: { coords: null }, requestLocation: jest.fn() }),
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

const event = (over: Record<string, unknown> = {}) => ({
  id: 'ev-1', hostId: 'h1', hostName: 'Ana', hostHandle: null, hostAvatarUrl: null, title: 'Rooftop quiz',
  description: null, locationName: 'Rooftop', locationLat: null, locationLng: null, startsAt: '2099-08-01T18:00:00Z',
  endsAt: null, coverUrl: null, coverMediaType: null, maxAttendees: 10, ageMin: null, ageMax: null, trustScoreMin: null,
  verifiedOnly: false, visibility: 'public', state: 'open', chatEnabled: false, chatThreadId: null, waitlistEnabled: true,
  priceType: 'free', priceUrl: null, rsvpOptions: ['going'], goingCount: 4, waitlistCount: 0, category: null, city: 'Lisbon',
  country: null, rsvpClosed: false, showExactLocation: false, isHost: false, createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z', myRsvp: null, ...over,
});
const ok = (data: Record<string, unknown>) => Promise.resolve({ ok: true, data });

function lists(o: { main?: Record<string, unknown>; following?: any; catCut?: boolean } = {}) {
  // The Upcoming list is the one call with neither a category nor a dateTo (upcomingRange); Tomorrow, Weekend and the
  // category rows answer empty and whole.
  (svc.listEvents as jest.Mock).mockImplementation((p: { category?: string; dateTo?: string }) =>
    p.category ? ok({ events: [], ...(o.catCut ? { truncated: true } : {}) }) : ok(!p.dateTo && o.main ? o.main : { events: [] }));
  (svc.listMyEvents as jest.Mock).mockImplementation(() => ok({ events: [] }));
  (svc.listFollowingEvents as jest.Mock).mockImplementation(() => o.following ?? ok({ events: [] }));
  (svc.listCircleEvents as jest.Mock).mockImplementation(() => ok({ events: [] }));
  (svc.getSavedEvents as jest.Mock).mockImplementation(() => ok({ events: [], page: 1 }));
  (svc.getMyDrafts as jest.Mock).mockImplementation(() => ok({ drafts: [] }));
  (svc.getMyEventInvites as jest.Mock).mockImplementation(() => ok({ invites: [] }));
}

async function shown(o: Parameters<typeof lists>[0], until: RegExp) {
  lists(o);
  const r = await render(<EventsTab />);
  await waitFor(() => expect(r.queryByText(until)).not.toBeNull());
  return r;
}

describe('census-discovery §117 (SW17): the events tab reads what its lists could not read', () => {
  beforeEach(() => jest.clearAllMocks());

  it('ET1 an Upcoming event whose count was not recounted → "(last known)"', async () => {
    const r = await shown({ main: { events: [event({ goingCountUnread: true })], page: 1, limit: 10 } }, /going/);
    expect(r.getByText('4 going/10 (last known)')).toBeTruthy();
  });
  it('ET2 every section empty, Upcoming not whole → "Couldn\'t load every event"', async () => {
    const r = await shown({ main: { events: [], page: 1, limit: 10, truncated: true } }, /No events yet|Couldn't load every event/);
    expect(r.getByText("Couldn't load every event")).toBeTruthy();
    expect(r.queryByText('No events yet')).toBeNull();
  });
  it('ET3 every section empty, Following failed → "Couldn\'t load every event"', async () => {
    const r = await shown({ following: Promise.resolve({ ok: false, message: 'HTTP 503' }) }, /No events yet|Couldn't load every event/);
    expect(r.getByText("Couldn't load every event")).toBeTruthy();
    expect(r.queryByText('No events yet')).toBeNull();
  });
  it('ET5 every section empty, a category row not whole → "Couldn\'t load every event"', async () => {
    const r = await shown({ catCut: true }, /No events yet|Couldn't load every event/);
    expect(r.getByText("Couldn't load every event")).toBeTruthy();
    expect(r.queryByText('No events yet')).toBeNull();
  });
  it('ET0 CONTROL: every section whole and empty → "No events yet"', async () => {
    const r = await shown({}, /No events yet|Couldn't load every event/);
    expect(r.getByText('No events yet')).toBeTruthy();
  });
  it('ET0b CONTROL: an unmarked event → its count as measured', async () => {
    const r = await shown({ main: { events: [event()], page: 1, limit: 10 } }, /going/);
    expect(r.getByText('4 going/10')).toBeTruthy();
    expect(r.queryByText(/last known/)).toBeNull();
  });
});
