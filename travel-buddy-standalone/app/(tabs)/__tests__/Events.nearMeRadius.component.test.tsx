/**
 * census-discovery §118 (DV-83 round 21, lane W11-X2; the round-20 verifier's B27, probes NM0–NM2; B28's client half; and
 * the tab's own load, which had B26's shape): the events tab draws only the answer to what is on screen, and says a list
 * it could not read.
 *
 * A radius chip ran `setRadiusKm(r.km); handleNearMeRequest()`, and handleNearMeRequest read `radiusKm` from the render
 * that made it, so the "5 km" chip asked for and drew the 25 km answer; a near read that failed (`if (res.ok)` only)
 * left the previous radius's rows drawn under the new chip, unsaid. The chip now passes its radius; a failed near read
 * clears the rows and says so; a near answer for a radius no longer selected is never drawn. The tab's own load kept no
 * request token either (a slow answer for the previous filter overwrote the current one). And with some lists drawn, a
 * list that failed (/following, /me … now answer 503 over a read they could not make, B28) left its section absent with
 * nothing said; the tab now says some lists could not be loaded.
 *
 *   NM0  CONTROL (the verifier's): "Find events near you" asks 25 km and draws its rows
 *   NM1  (the verifier's) tap "5 km" → the read asks 5 km; the 20 km event is not drawn under "5 km"
 *   NM2  (the verifier's) tap "100 km" and that read FAILS → the 25 km rows are not left drawn, and the failure is said
 *   NM3  tap "5 km" then "100 km"; the 5 km answer lands last → the 100 km answer stays drawn
 *   TR0  CONTROL: a category chip's answer lands → its rows are drawn
 *   TR1  the previous filter's answer lands after the chip's → the previous rows are never drawn under the chip
 *   LU0  CONTROL: every list answers → no "some lists" note
 *   LU1  the Following list FAILS while other lists are drawn → the tab says some lists could not be loaded
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

// Location is available, so Near Me can be asked.
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
const nearCalls = () => (svc.listEvents as jest.Mock).mock.calls.map((c) => c[0]).filter((p) => p.nearRadiusKm != null).map((p) => p.nearRadiusKm);
async function nearMe() {
  lists();
  const r = await render(<EventsTab />);
  await waitFor(() => expect(r.queryByText('Find events near you')).not.toBeNull());
  await act(async () => { fireEvent.press(r.getByText('Find events near you')); });
  await waitFor(() => expect(r.queryByText(FAR)).not.toBeNull());
  await act(async () => { fireEvent.press(r.getByLabelText('Filters')); });  // the radius chips sit in the Filters panel
  return r;
}

describe('census-discovery §118 (B27): the events tab Near Me read over the radius chips', () => {
  beforeEach(() => { jest.clearAllMocks(); failRadius = null; });
  it('NM0 CONTROL: "Find events near you" asks 25 km and draws its rows', async () => {
    const r = await nearMe();
    expect(nearCalls()).toEqual([25]);
    expect(r.queryByText(NEAR)).not.toBeNull();
    expect(r.queryByTestId('near-me-unread')).toBeNull();
  });
  it('NM1 tap "5 km" → the read asks 5 km; the 20 km event is not drawn under "5 km"', async () => {
    const r = await nearMe();
    await act(async () => { fireEvent.press(r.getByText('5 km')); });
    await act(async () => {});
    expect({ radiiAsked: nearCalls(), farShownUnder5km: r.queryByText(FAR) !== null }).toEqual({ radiiAsked: [25, 5], farShownUnder5km: false });
  });
  it('NM2 tap "100 km", that read FAILS → the 25 km rows are not left drawn, and the failure is said', async () => {
    failRadius = 100;
    const r = await nearMe();
    await act(async () => { fireEvent.press(r.getByText('100 km')); });
    await act(async () => {});
    expect({ radiiAsked: nearCalls(), oldRowsShown: r.queryByText(FAR) !== null, said: r.queryByTestId('near-me-unread') !== null }).toEqual({ radiiAsked: [25, 100], oldRowsShown: false, said: true });
  });
  it('NM3 tap "5 km" then "100 km"; the 5 km answer lands last → the 100 km answer stays drawn', async () => {
    const r = await nearMe();
    const held: Array<() => void> = [];
    (svc.listEvents as jest.Mock).mockImplementation((p: { nearRadiusKm?: number }) => {
      if (p.nearRadiusKm === 5) return new Promise((res) => held.push(() => res({ ok: true, data: { events: [event('ev-near', NEAR)] } })));
      if (p.nearRadiusKm === 100) return ok({ events: [event('ev-near', NEAR), event('ev-far', FAR)] });
      return ok({ events: [] });
    });
    await act(async () => { fireEvent.press(r.getByText('5 km')); });
    await act(async () => { fireEvent.press(r.getByText('100 km')); });
    await act(async () => {});
    await act(async () => { held.forEach((f) => f()); });
    await act(async () => {});
    expect(r.queryByText(FAR)).not.toBeNull();
  });
});

describe('census-discovery §118 (B26 shape, B28 client): the events tab\'s own lists', () => {
  beforeEach(() => { jest.clearAllMocks(); failRadius = null; });
  const ROCK = 'Rock night (Music)';
  const OLD = 'Any-category picnic (not Music)';
  async function chipRace(order: 'inOrder' | 'stale') {
    lists();
    const held: Array<{ cat?: string; release: () => void }> = [];
    (svc.listEvents as jest.Mock).mockImplementation((p: { category?: string; limit?: number; nearRadiusKm?: number }) => {
      if (p.limit !== 10) return ok({ events: [] });  // the category rows and near reads are not under test here
      return new Promise((res) => held.push({ cat: p.category, release: () => res({ ok: true, data: { events: [p.category === 'Music' ? event('ev-rock', ROCK) : event('ev-old', OLD)] } }) }));
    });
    const r = await render(<EventsTab />);
    await waitFor(() => expect(held.length).toBeGreaterThan(0));
    await act(async () => { fireEvent.press(r.getByLabelText('Filters')); });
    await act(async () => { fireEvent.press(r.getByText('Music')); });
    await waitFor(() => expect(held.some((h) => h.cat === 'Music')).toBe(true));
    const first = held.filter((h) => h.cat !== 'Music'); const music = held.filter((h) => h.cat === 'Music');
    if (order === 'inOrder') { await act(async () => { first.forEach((h) => h.release()); }); await act(async () => { music.forEach((h) => h.release()); }); }
    else { await act(async () => { music.forEach((h) => h.release()); }); await act(async () => { first.forEach((h) => h.release()); }); }
    await act(async () => {});
    return { rock: r.queryAllByText(ROCK).length > 0, old: r.queryAllByText(OLD).length > 0 };
  }
  it('TR0 CONTROL: the chip\'s answer lands last → its rows are drawn', async () => {
    expect(await chipRace('inOrder')).toEqual({ rock: true, old: false });
  });
  it('TR1 the previous filter\'s answer lands after the chip\'s → the previous rows are never drawn under the chip', async () => {
    expect(await chipRace('stale')).toEqual({ rock: true, old: false });
  });
  it('LU0 CONTROL: every list answers → no "some lists" note', async () => {
    lists();
    (svc.listEvents as jest.Mock).mockImplementation((p: { limit?: number }) => ok({ events: p.limit === 10 ? [event('ev-a', 'Harbour swim')] : [] }));
    const r = await render(<EventsTab />);
    await waitFor(() => expect(r.queryAllByText('Harbour swim').length).toBeGreaterThan(0));
    expect(r.queryByTestId('events-lists-unread')).toBeNull();
  });
  it('LU1 the Following list FAILS while other lists are drawn → the tab says some lists could not be loaded', async () => {
    lists();
    (svc.listEvents as jest.Mock).mockImplementation((p: { limit?: number }) => ok({ events: p.limit === 10 ? [event('ev-a', 'Harbour swim')] : [] }));
    (svc.listFollowingEvents as jest.Mock).mockImplementation(() => Promise.resolve({ ok: false, message: 'HTTP 503' }));
    const r = await render(<EventsTab />);
    await waitFor(() => expect(r.queryAllByText('Harbour swim').length).toBeGreaterThan(0));
    expect(r.queryByTestId('events-lists-unread')).not.toBeNull();
  });
});
