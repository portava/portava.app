/**
 * census-discovery §119 (DV-83 round 22, lane W11-X2; the round-21 verifier's B30, probes FF0–FF2): the events tab
 * never leaves a section's PREVIOUS rows drawn when that section's read for the filter now on screen fails.
 *
 * load() set each section only `if (xRes.ok)`, so when the read for a new chip failed, the previous chip's rows stayed
 * drawn under it; the only text was the generic "Some event lists couldn't be loaded", which does not say the rows are
 * another filter's. Round 21 fixed exactly this for Near Me (B27 NM2). Now a section whose read failed is cleared, and
 * the failure is said (the error state when nothing else is drawn, the lists-unread note beside what is).
 *
 *   FF0 CONTROL: "All" answers OLD; tap "Music", Music answers ROCK → ROCK drawn, OLD gone
 *   FF1 "All" answers OLD; tap "Music", every Music list read FAILS → OLD is not drawn under "Music"; the failure is said
 *   FF2 "All" answers OLD in This Weekend; tap "Music", Upcoming answers ROCK, This Weekend FAILS → OLD is not drawn;
 *       ROCK is, beside the lists-unread note
 *   FF3 (sweep) Following answers a hosted event; the next load's Following read FAILS → it is not drawn as the
 *       current list; the lists-unread note says a list failed
 *   FF4 Upcoming alone answers OLD under "All" (Tomorrow and This Weekend are empty, so nothing dedups it away); tap
 *       "Music", the Upcoming read FAILS → OLD is not drawn; the failure is said
 *   FF5 (sweep) FF3 for Circles
 *   FF6 (sweep) the invites read answers 2 pending; the next load's FAILS → never "You have 2 pending event invites"
 *       from the earlier read; the failure is said
 *   FF7 (sweep) the saved read answers a saved event; the next load's FAILS → the Saved section is not drawn from the
 *       earlier read; the failure is said
 *   FF8 (sweep) the drafts read answers a draft; the next load's FAILS → "Your drafts" is not drawn from the earlier
 *       read; the failure is said
 *   FF9 (sweep) events are drawn under the new chip and only the invites read FAILS → the lists-unread note says a list
 *       failed beside what is drawn
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

const ROCK = 'Rock night (Music)';
const OLD = 'Any-category picnic (not Music)';
const FOLLOWED = 'A followed host\'s supper club';
const CIRCLED = 'A circle\'s harbour swim';
const SAVED = 'A saved lantern walk';
const DRAFT = 'My half-planned picnic';
async function filterFails(mode: 'ok' | 'allFail' | 'weekendFail') {
  lists();
  (svc.listEvents as jest.Mock).mockImplementation((p: { category?: string; limit?: number; startsAfter?: string; startsBefore?: string; nearRadiusKm?: number }) => {
    if (p.limit !== 10) return ok({ events: [] });
    if (p.category !== 'Music') return ok({ events: [event('ev-old', OLD)] });
    if (mode === 'allFail') return Promise.resolve({ ok: false, message: 'HTTP 503' });
    return ok({ events: [event('ev-rock', ROCK)] });
  });
  const r = await render(<EventsTab />);
  await waitFor(() => expect(r.queryAllByText(OLD).length).toBeGreaterThan(0));
  if (mode === 'weekendFail') {
    const base = (svc.listEvents as jest.Mock).getMockImplementation()!;
    let n = 0;
    (svc.listEvents as jest.Mock).mockImplementation((p: any) => {
      if (p.limit === 10 && p.category === 'Music') { n++; if (n === 3) return Promise.resolve({ ok: false, message: 'HTTP 503' }); return ok({ events: n === 1 ? [event('ev-rock', ROCK)] : [] }); }
      return base(p);
    });
  }
  await act(async () => { fireEvent.press(r.getByLabelText('Filters')); });
  await act(async () => { fireEvent.press(r.getByText('Music')); });
  await act(async () => {}); await act(async () => {});
  const musicCalls = (svc.listEvents as jest.Mock).mock.calls.map((c) => c[0]).filter((p: any) => p.category === 'Music' && p.limit === 10).length;
  return { musicCalls, rock: r.queryAllByText(ROCK).length > 0, oldStillDrawn: r.queryAllByText(OLD).length > 0, note: r.queryByTestId('events-lists-unread') !== null, failedSaid: r.queryAllByText(/Failed to load events|couldn't be loaded|Couldn't load every event/).length > 0 };
}
describe('census-discovery §119 (B30): a failed read for the chip on screen never leaves the previous chip\'s rows drawn', () => {
  beforeEach(() => { jest.clearAllMocks(); failRadius = null; });
  it('FF0 CONTROL: Music answers → ROCK drawn, OLD gone', async () => {
    const seen = await filterFails('ok');
    expect({ rock: seen.rock, old: seen.oldStillDrawn }).toEqual({ rock: true, old: false });
  });
  it('FF1 every Music read FAILS → the previous filter\'s rows must not stay drawn under "Music"', async () => {
    const seen = await filterFails('allFail');
    expect(seen.oldStillDrawn).toBe(false);
    expect(seen.failedSaid).toBe(true);
  });
  it('FF2 This Weekend FAILS under "Music" → the previous filter\'s weekend rows must not stay drawn', async () => {
    const seen = await filterFails('weekendFail');
    expect({ old: seen.oldStillDrawn, rock: seen.rock, note: seen.note }).toEqual({ old: false, rock: true, note: true });
  });
  it('FF3 (sweep) the next load\'s Following read FAILS → the earlier Following rows are not drawn; the failure is said', async () => {
    lists();
    (svc.listEvents as jest.Mock).mockImplementation((p: { category?: string; limit?: number }) => (p.limit === 10 && p.category !== 'Music' ? ok({ events: [event('ev-old', OLD)] }) : ok({ events: [] })));
    (svc.listFollowingEvents as jest.Mock).mockImplementation(() => ok({ events: [event('ev-fol', FOLLOWED)] }));
    const r = await render(<EventsTab />);
    await waitFor(() => expect(r.queryAllByText(FOLLOWED).length).toBeGreaterThan(0));
    (svc.listFollowingEvents as jest.Mock).mockImplementation(() => Promise.resolve({ ok: false, message: 'HTTP 503' }));
    await act(async () => { fireEvent.press(r.getByLabelText('Filters')); });
    await act(async () => { fireEvent.press(r.getByText('Music')); });
    await act(async () => {}); await act(async () => {});
    expect((svc.listFollowingEvents as jest.Mock).mock.calls.length).toBeGreaterThan(1);
    expect({ followedDrawn: r.queryAllByText(FOLLOWED).length > 0, note: r.queryAllByText(/Failed to load events|couldn't be loaded|Couldn't load every event/).length > 0 }).toEqual({ followedDrawn: false, note: true });
  });
  it('FF4 Upcoming alone answers OLD; under "Music" the Upcoming read FAILS → OLD is not drawn; the failure is said', async () => {
    lists();
    const upcoming = (p: { dateTo?: string; limit?: number }) => p.limit === 10 && p.dateTo === undefined;
    (svc.listEvents as jest.Mock).mockImplementation((p: any) => (upcoming(p) && p.category !== 'Music' ? ok({ events: [event('ev-old', OLD)] }) : ok({ events: [] })));
    const r = await render(<EventsTab />);
    await waitFor(() => expect(r.queryAllByText(OLD).length).toBeGreaterThan(0));
    (svc.listEvents as jest.Mock).mockImplementation((p: any) => (upcoming(p) ? Promise.resolve({ ok: false, message: 'HTTP 503' }) : ok({ events: [] })));
    await act(async () => { fireEvent.press(r.getByLabelText('Filters')); });
    await act(async () => { fireEvent.press(r.getByText('Music')); });
    await act(async () => {}); await act(async () => {});
    expect({ oldDrawn: r.queryAllByText(OLD).length > 0, said: r.queryAllByText(/Failed to load events|couldn't be loaded|Couldn't load every event/).length > 0 }).toEqual({ oldDrawn: false, said: true });
  });
  it('FF5 (sweep) the next load\'s Circles read FAILS → the earlier Circles rows are not drawn; the failure is said', async () => {
    lists();
    (svc.listEvents as jest.Mock).mockImplementation((p: { category?: string; limit?: number }) => (p.limit === 10 && p.category !== 'Music' ? ok({ events: [event('ev-old', OLD)] }) : ok({ events: [] })));
    (svc.listCircleEvents as jest.Mock).mockImplementation(() => ok({ events: [event('ev-cir', CIRCLED)] }));
    const r = await render(<EventsTab />);
    await waitFor(() => expect(r.queryAllByText(CIRCLED).length).toBeGreaterThan(0));
    (svc.listCircleEvents as jest.Mock).mockImplementation(() => Promise.resolve({ ok: false, message: 'HTTP 503' }));
    await act(async () => { fireEvent.press(r.getByLabelText('Filters')); });
    await act(async () => { fireEvent.press(r.getByText('Music')); });
    await act(async () => {}); await act(async () => {});
    expect((svc.listCircleEvents as jest.Mock).mock.calls.length).toBeGreaterThan(1);
    expect({ circledDrawn: r.queryAllByText(CIRCLED).length > 0, note: r.queryAllByText(/Failed to load events|couldn't be loaded|Couldn't load every event/).length > 0 }).toEqual({ circledDrawn: false, note: true });
  });
  async function refetchFails(arm: (mode: 'ok' | 'fail') => void, seen: (r: any) => boolean) {
    lists();
    (svc.listEvents as jest.Mock).mockImplementation((p: { category?: string; limit?: number }) => (p.limit === 10 && p.category !== 'Music' ? ok({ events: [event('ev-old', OLD)] }) : ok({ events: [] })));
    arm('ok');
    const r = await render(<EventsTab />);
    await waitFor(() => expect(seen(r)).toBe(true));
    arm('fail');
    await act(async () => { fireEvent.press(r.getByLabelText('Filters')); });
    await act(async () => { fireEvent.press(r.getByText('Music')); });
    await act(async () => {}); await act(async () => {});
    return { stillDrawn: seen(r), said: r.queryAllByText(/Failed to load events|couldn't be loaded|Couldn't load every event/).length > 0 };
  }
  const FAIL = () => Promise.resolve({ ok: false, message: 'HTTP 503' });
  it('FF6 (sweep) the invites read FAILS on the next load → never the earlier "2 pending event invites"; said', async () => {
    const inv = (id: string) => ({ id, eventId: 'ev-x', status: 'pending', invitedAt: '2026-09-01T00:00:00Z' });
    const seen = await refetchFails((m) => (svc.getMyEventInvites as jest.Mock).mockImplementation(() => (m === 'ok' ? ok({ invites: [inv('i1'), inv('i2')] }) : FAIL())), (r) => r.queryByText('You have 2 pending event invites') !== null);
    expect(seen).toEqual({ stillDrawn: false, said: true });
  });
  it('FF7 (sweep) the saved read FAILS on the next load → the earlier Saved rows are not drawn; said', async () => {
    const seen = await refetchFails((m) => (svc.getSavedEvents as jest.Mock).mockImplementation(() => (m === 'ok' ? ok({ events: [event('ev-sav', SAVED)], page: 1 }) : FAIL())), (r) => r.queryAllByText(SAVED).length > 0);
    expect(seen).toEqual({ stillDrawn: false, said: true });
  });
  it('FF8 (sweep) the drafts read FAILS on the next load → the earlier "Your drafts" is not drawn; said', async () => {
    const seen = await refetchFails((m) => (svc.getMyDrafts as jest.Mock).mockImplementation(() => (m === 'ok' ? ok({ drafts: [{ id: 'd1', title: DRAFT, updatedAt: '2026-09-01T00:00:00Z' }] }) : FAIL())), (r) => r.queryAllByText(DRAFT).length > 0);
    expect(seen).toEqual({ stillDrawn: false, said: true });
  });
  it('FF9 (sweep) events drawn, only the invites read FAILS on the next load → the lists-unread note says so', async () => {
    lists();
    (svc.listEvents as jest.Mock).mockImplementation((p: { limit?: number }) => (p.limit === 10 ? ok({ events: [event('ev-old', OLD)] }) : ok({ events: [] })));
    const r = await render(<EventsTab />);
    await waitFor(() => expect(r.queryAllByText(OLD).length).toBeGreaterThan(0));
    (svc.getMyEventInvites as jest.Mock).mockImplementation(() => FAIL());
    await act(async () => { fireEvent.press(r.getByLabelText('Filters')); });
    await act(async () => { fireEvent.press(r.getByText('Music')); });
    await act(async () => {}); await act(async () => {});
    expect({ drawn: r.queryAllByText(OLD).length > 0, note: r.queryByTestId('events-lists-unread') !== null }).toEqual({ drawn: true, note: true });
  });
});
