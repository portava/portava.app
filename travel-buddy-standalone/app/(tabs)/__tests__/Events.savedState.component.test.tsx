/**
 * census-discovery §122 (DV-83 round 23, lane W11-X2; §119.16 B35, survivor X19): the events tab's bookmarks are each
 * list's own measured `isSaved`, never page 1 of a saved read, and never a saved read that failed.
 *
 * The tab drew every bookmark from `savedIds`: page 1 of GET /events/saved (20 saves), kept over a failed read
 * (D-W11X2-176: "the saved bookmarks keep their last answer") — on a first load there is no last answer, and a 21st save
 * was "not saved". Every list the tab reads now serves `isSaved` measured from the store the bookmark writes, or refuses
 * (api-server eventsListsSavedState). The tab draws that, keeps only the viewer's own taps beside it (reverted when the
 * write fails), draws a card with no measured state as unknown ("Couldn't check if saved", not a toggle), and says a
 * failed saved read ("Couldn't load your saved events").
 *
 *   BK0 CONTROL: the list serves isSaved true → "Unsave event"
 *   BK1 first load, the saved read FAILS, the list serves isSaved true → "Unsave event", and the failure is said
 *   BK2 the saved read answers page 1 (20 other saves); the list serves ev-old isSaved true → "Unsave event"
 *   BK3 CONTROL: the list serves isSaved false → "Save event"
 *   BK4 a card with no measured saved state → "Couldn't check if saved"; a tap saves nothing
 *   BK5 a tap on "Save event" → "Unsave event" and saveEvent asked; the write FAILS → back to "Save event"
 *   BK6 a tap on "Unsave event"; the write FAILS → still saved, in the Saved section too
 *   SV9 (the round-22 verifier's fixture for X19) events drawn, only the saved read FAILS → the lists-unread note
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
  saveEvent: jest.fn(),
  unsaveEvent: jest.fn(),
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
const FAIL = () => Promise.resolve({ ok: false, message: 'HTTP 503' });
const OLD = 'A saved lantern walk';
function base(saved: 'ok' | 'fail' | 'page1', isSaved: boolean | 'none' = true) {
  (svc.listEvents as jest.Mock).mockImplementation((p: { limit?: number; dateTo?: string }) => (p.limit === 10 && p.dateTo === undefined ? ok({ events: [{ ...event('ev-old', OLD), ...(isSaved === 'none' ? {} : { isSaved }) }] }) : ok({ events: [] })));
  (svc.listMyEvents as jest.Mock).mockImplementation(() => ok({ events: [] }));
  (svc.listFollowingEvents as jest.Mock).mockImplementation(() => ok({ events: [] }));
  (svc.listCircleEvents as jest.Mock).mockImplementation(() => ok({ events: [] }));
  (svc.getSavedEvents as jest.Mock).mockImplementation(() => (saved === 'ok' ? ok({ events: [{ ...event('ev-old', OLD), isSaved: true }], page: 1 }) : saved === 'page1' ? ok({ events: Array.from({ length: 20 }, (_, i) => ({ ...event(`sv-${i}`, `Saved ${i}`), isSaved: true })), page: 1, limit: 20 }) : FAIL()));
  (svc.getMyDrafts as jest.Mock).mockImplementation(() => ok({ drafts: [] }));
  (svc.getMyEventInvites as jest.Mock).mockImplementation(() => ok({ invites: [] }));
}
async function seen(saved: 'ok' | 'fail' | 'page1', isSaved: boolean | 'none' = true) {
  base(saved, isSaved);
  const r = await render(<EventsTab />);
  await waitFor(() => expect(r.queryAllByText(OLD).length).toBeGreaterThan(0));
  await act(async () => {}); await act(async () => {});
  return r;
}
// The Upcoming card for ev-old (the Saved section may draw it too when the saved read answers it).
const upcomingLabel = (r: Awaited<ReturnType<typeof seen>>) => ({
  save: r.queryAllByLabelText('Save event').length, unsave: r.queryAllByLabelText('Unsave event').length, unknown: r.queryAllByLabelText("Couldn't check if saved").length,
});

describe('census-discovery §122 (B35): the events tab bookmarks are the lists\' measured isSaved', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  it('BK0 CONTROL: isSaved true → "Unsave event"', async () => {
    const r = await seen('ok');
    expect(upcomingLabel(r)).toEqual({ save: 0, unsave: 2, unknown: 0 });
  });
  it('BK1 the saved read FAILS → the list\'s isSaved drawn, and the failure said', async () => {
    const r = await seen('fail');
    expect(upcomingLabel(r)).toEqual({ save: 0, unsave: 1, unknown: 0 });
    expect(r.queryByText("Couldn't load your saved events.")).not.toBeNull();
  });
  it('BK2 the saved read answers page 1 of other saves; ev-old served isSaved true → "Unsave event"', async () => {
    const r = await seen('page1');
    expect(r.queryAllByText(OLD).length).toBe(1);
    expect(upcomingLabel(r).save).toBe(0);
    expect(r.queryByText("Couldn't load your saved events.")).toBeNull();
  });
  it('BK3 CONTROL: isSaved false → "Save event"', async () => {
    const r = await seen('page1', false);
    expect(upcomingLabel(r).save).toBe(1);
  });
  it('BK4 no measured saved state → "Couldn\'t check if saved"; a tap saves nothing', async () => {
    const r = await seen('page1', 'none');
    expect(upcomingLabel(r).save).toBe(0);
    expect(upcomingLabel(r).unknown).toBe(1);
    await act(async () => { fireEvent.press(r.getByLabelText("Couldn't check if saved")); });
    expect(svc.saveEvent).not.toHaveBeenCalled();
    expect(svc.unsaveEvent).not.toHaveBeenCalled();
  });
  it('BK5 a tap saves; the write FAILS → back to "Save event"', async () => {
    let fail: (v: unknown) => void = () => {};
    (svc.saveEvent as jest.Mock).mockImplementation(() => new Promise((res) => { fail = res; }));
    const r = await seen('page1', false);
    await act(async () => { fireEvent.press(r.getByLabelText('Save event')); });
    expect(svc.saveEvent).toHaveBeenCalledWith('ev-old');
    expect(upcomingLabel(r).save).toBe(0);
    await act(async () => { fail({ ok: false, message: 'HTTP 503' }); });
    expect(upcomingLabel(r).save).toBe(1);
  });
  it('SV9 events drawn, only the saved read FAILS → the lists-unread note', async () => {
    const r = await seen('fail');
    expect(r.queryByTestId('events-lists-unread')).not.toBeNull();
  });
  it('BK6 a tap unsaves; the write FAILS → still saved, in the Saved section too', async () => {
    let fail: (v: unknown) => void = () => {};
    (svc.unsaveEvent as jest.Mock).mockImplementation(() => new Promise((res) => { fail = res; }));
    const r = await seen('ok');
    expect(upcomingLabel(r).unsave).toBe(2);
    await act(async () => { fireEvent.press(r.getAllByLabelText('Unsave event')[0]); });
    expect(svc.unsaveEvent).toHaveBeenCalledWith('ev-old');
    await act(async () => { fail({ ok: false, message: 'HTTP 503' }); });
    expect(upcomingLabel(r)).toEqual({ save: 0, unsave: 2, unknown: 0 });
  });
});
