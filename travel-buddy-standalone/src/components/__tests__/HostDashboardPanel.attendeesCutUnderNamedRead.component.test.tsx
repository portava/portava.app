/**
 * census-discovery §119 (DV-83 round 22, lane W11-X2; the round-21 verifier's B29, probes AN0–AN2): the host's
 * Attendees tab never states the slice of who is going as the whole list because ANOTHER read was named beside it.
 *
 * GET /events/:id marks its four-row attendee slice (`goingAttendeesTruncated`, `goingAttendeesTotal`) whenever the
 * going/maybe read answered — also when another read failed and is named beside it: the full RSVP count read
 * (`event_rsvps`, interested and can't-go) or the host's profile read (`profiles`). attendeesListCut
 * (lib/eventAttendeesUnread) returned "not a slice" as soon as either name was present, so the tab listed 4 travellers
 * with nothing saying 6 were going. It now steps aside only when the going list ITSELF could not be read
 * (`goingListUnread`: the going/maybe read failed, or nobody is listed although travellers are going and a profiles
 * read failed), and honours the route's mark otherwise.
 *
 * The bodies AU0–AU2 are the real route's (the verifier's zz-v21-eventDetailCutUnderNamedRead, registered as
 * eventDetailCutUnderNamedRead.test.ts); AU1u is AU1 as an earlier server sent it (no mark); AU3 and AU4 are the
 * route's bodies when the going travellers' profiles read, or the going/maybe read, failed.
 *
 *   AN0  CONTROL (AU0): 6 going, 4 listed, nothing named → "Showing 4 of 6 going"
 *   AN1  (AU1) the full RSVP count read failed → still "Showing 4 of 6 going" (the verifier's AN1)
 *   AN2  (AU2) the host's profile read failed → still "Showing 4 of 6 going" (the verifier's AN2)
 *   AN3  (AU1u) AU1 from an earlier server, unmarked → "Showing 4 of 6 going" (the live count says so)
 *   AN4  (AU3) the going travellers' profiles read failed → "Couldn't load attendees", never "Showing 0 of 6"
 *   AN5  (AU4) the going/maybe read failed (the cached count served) → "Couldn't load attendees", no slice said
 *   GL1  goingListUnread over every body above, and over a body whose going count is unknown
 */
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — requireActual would construct the real
// Supabase client, whose auto-refresh timer outlives the test environment.
jest.mock('../../lib/supabase', () => ({
  isSupabaseConfigured: true,
  authedClient: () => null,
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600 } } }),
      refreshSession: async () => ({ data: { session: { access_token: 'tok' } } }),
    },
  },
}));

// NOTE: intentional stubs — the other tabs' panels are not under test here.
jest.mock('../events/EventAttendancePanel.tsx', () => ({ EventAttendancePanel: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../events/EventCancelControl.tsx', () => ({ EventCancelControl: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../events/GenerateHeaderSheet.tsx', () => ({ GenerateHeaderSheet: () => null }));

import { HostDashboardPanel } from '../HostDashboardPanel.tsx';
import { getEvent } from '../../services/events.ts';
import { attendeesListCut, goingListUnread } from '../../lib/eventAttendeesUnread.ts';

const BODIES: Record<string, any> = {"AU0": {"id": "66666666-6666-4666-8666-666666666666", "hostId": "22222222-2222-4222-8222-222222222222", "title": "Rooftop quiz", "description": null, "locationName": null, "locationLat": 38.72, "locationLng": -9.14, "startsAt": "2030-01-01T00:00:00.000Z", "endsAt": null, "coverUrl": null, "coverMediaType": null, "coverSource": null, "maxAttendees": 20, "ageMin": null, "ageMax": null, "trustScoreMin": null, "verifiedOnly": false, "visibility": "public", "state": "open", "chatEnabled": false, "chatThreadId": null, "waitlistEnabled": true, "priceType": null, "priceUrl": null, "safetyNotes": null, "rsvpOptions": ["going", "maybe", "interested", "cant_go"], "goingCount": 6, "waitlistCount": 0, "category": null, "city": "Lisbon", "country": null, "showExactLocation": false, "rsvpClosed": false, "tags": [], "isHost": true, "showHeaderPublicly": false, "createdAt": "2026-09-01T00:00:00.000Z", "host": {"id": "22222222-2222-4222-8222-222222222222", "handle": "h2222", "displayName": "N22", "avatarUrl": null}, "counts": {"going": 6, "maybe": 0, "interested": 0, "cant_go": 0}, "myRsvp": null, "myJoinRequestStatus": null, "myWaitlistPosition": null, "myWaitlistOfferExpiresAt": null, "myRole": "host", "myAttendanceState": null, "goingAttendees": [{"id": "88888888-8888-4888-8888-000000000001", "handle": "h0001", "displayName": null, "avatarUrl": null}, {"id": "88888888-8888-4888-8888-000000000002", "handle": "h0002", "displayName": null, "avatarUrl": null}, {"id": "88888888-8888-4888-8888-000000000003", "handle": "h0003", "displayName": null, "avatarUrl": null}, {"id": "88888888-8888-4888-8888-000000000004", "handle": "h0004", "displayName": null, "avatarUrl": null}], "goingAttendeesTruncated": true, "goingAttendeesTotal": 6}, "AU1": {"id": "66666666-6666-4666-8666-666666666666", "hostId": "22222222-2222-4222-8222-222222222222", "title": "Rooftop quiz", "description": null, "locationName": null, "locationLat": 38.72, "locationLng": -9.14, "startsAt": "2030-01-01T00:00:00.000Z", "endsAt": null, "coverUrl": null, "coverMediaType": null, "coverSource": null, "maxAttendees": 20, "ageMin": null, "ageMax": null, "trustScoreMin": null, "verifiedOnly": false, "visibility": "public", "state": "open", "chatEnabled": false, "chatThreadId": null, "waitlistEnabled": true, "priceType": null, "priceUrl": null, "safetyNotes": null, "rsvpOptions": ["going", "maybe", "interested", "cant_go"], "goingCount": 6, "waitlistCount": 0, "category": null, "city": "Lisbon", "country": null, "showExactLocation": false, "rsvpClosed": false, "tags": [], "isHost": true, "showHeaderPublicly": false, "createdAt": "2026-09-01T00:00:00.000Z", "host": {"id": "22222222-2222-4222-8222-222222222222", "handle": "h2222", "displayName": "N22", "avatarUrl": null}, "counts": {"going": 6, "maybe": 0, "interested": null, "cant_go": null}, "failedSources": ["event_rsvps"], "myRsvp": null, "myJoinRequestStatus": null, "myWaitlistPosition": null, "myWaitlistOfferExpiresAt": null, "myRole": "host", "myAttendanceState": null, "goingAttendees": [{"id": "88888888-8888-4888-8888-000000000001", "handle": "h0001", "displayName": null, "avatarUrl": null}, {"id": "88888888-8888-4888-8888-000000000002", "handle": "h0002", "displayName": null, "avatarUrl": null}, {"id": "88888888-8888-4888-8888-000000000003", "handle": "h0003", "displayName": null, "avatarUrl": null}, {"id": "88888888-8888-4888-8888-000000000004", "handle": "h0004", "displayName": null, "avatarUrl": null}], "goingAttendeesTruncated": true, "goingAttendeesTotal": 6}, "AU2": {"id": "66666666-6666-4666-8666-666666666666", "hostId": "22222222-2222-4222-8222-222222222222", "title": "Rooftop quiz", "description": null, "locationName": null, "locationLat": 38.72, "locationLng": -9.14, "startsAt": "2030-01-01T00:00:00.000Z", "endsAt": null, "coverUrl": null, "coverMediaType": null, "coverSource": null, "maxAttendees": 20, "ageMin": null, "ageMax": null, "trustScoreMin": null, "verifiedOnly": false, "visibility": "public", "state": "open", "chatEnabled": false, "chatThreadId": null, "waitlistEnabled": true, "priceType": null, "priceUrl": null, "safetyNotes": null, "rsvpOptions": ["going", "maybe", "interested", "cant_go"], "goingCount": 6, "waitlistCount": 0, "category": null, "city": "Lisbon", "country": null, "showExactLocation": false, "rsvpClosed": false, "tags": [], "isHost": false, "showHeaderPublicly": false, "createdAt": "2026-09-01T00:00:00.000Z", "host": null, "counts": {"going": 6, "maybe": 0, "interested": 0, "cant_go": 0}, "failedSources": ["profiles"], "myRsvp": null, "myJoinRequestStatus": null, "myWaitlistPosition": null, "myWaitlistOfferExpiresAt": null, "myRole": "co_host", "myAttendanceState": null, "goingAttendees": [{"id": "88888888-8888-4888-8888-000000000001", "handle": "h0001", "displayName": null, "avatarUrl": null}, {"id": "88888888-8888-4888-8888-000000000002", "handle": "h0002", "displayName": null, "avatarUrl": null}, {"id": "88888888-8888-4888-8888-000000000003", "handle": "h0003", "displayName": null, "avatarUrl": null}, {"id": "88888888-8888-4888-8888-000000000004", "handle": "h0004", "displayName": null, "avatarUrl": null}], "goingAttendeesTruncated": true, "goingAttendeesTotal": 6}};
const { goingAttendeesTruncated: _m, goingAttendeesTotal: _t, ...au1Unmarked } = BODIES.AU1;
BODIES.AU1u = au1Unmarked;
BODIES.AU3 = { ...BODIES.AU0, goingAttendees: [], failedSources: ['profiles'] };
BODIES.AU4 = { ...au1Unmarked, goingAttendees: [], counts: { going: 6, maybe: null, interested: null, cant_go: null } };

let eventBody: any = null;
beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; });
beforeEach(() => {
  (globalThis as any).fetch = jest.fn(async (url: string) => {
    const u = new URL(url, 'http://api.test');
    const body = /^\/api\/events\/[^/]+$/.test(u.pathname) ? eventBody
      : /\/cohosts$/.test(u.pathname) ? { cohosts: [] }
      : { requests: [], waitlist: [] };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  });
});
afterEach(async () => { await act(async () => {}); });
async function load(key: string) {
  eventBody = BODIES[key];
  const res = await getEvent(eventBody.id);
  expect(res.ok).toBe(true);
  return (res as any).data;
}
async function tab(key: string) {
  const ev = await load(key);
  const ui = await render(<HostDashboardPanel event={ev} onDismiss={jest.fn()} onRefresh={jest.fn()} />);
  await act(async () => { fireEvent.press(ui.getByText('Attendees')); });
  return { ui, listed: ui.queryAllByText(/^h000[1-6]$/).length };
}

describe('census-discovery §119 (B29): the Attendees tab says a slice beside any other named read', () => {
  it('AN0 CONTROL: 6 going, 4 listed, nothing named → "Showing 4 of 6 going"', async () => {
    const { ui, listed } = await tab('AU0');
    expect(listed).toBe(4);
    expect(ui.queryByText('Showing 4 of 6 going')).not.toBeNull();
  });
  it('AN1 the full RSVP count read failed (event_rsvps named) → still "Showing 4 of 6 going"', async () => {
    const { ui, listed } = await tab('AU1');
    expect(listed).toBe(4);
    expect(ui.queryByText('Showing 4 of 6 going')).not.toBeNull();
  });
  it('AN2 the host profile read failed (profiles named) → still "Showing 4 of 6 going"', async () => {
    const { ui, listed } = await tab('AU2');
    expect(listed).toBe(4);
    expect(ui.queryByText('Showing 4 of 6 going')).not.toBeNull();
  });
  it('AN3 AU1 from an earlier server, unmarked → "Showing 4 of 6 going" (the live count says so)', async () => {
    const { ui } = await tab('AU1u');
    expect(ui.queryByText('Showing 4 of 6 going')).not.toBeNull();
  });
  it('AN4 the going travellers\' profiles read failed → "Couldn\'t load attendees", never "Showing 0 of 6"', async () => {
    const { ui, listed } = await tab('AU3');
    expect(listed).toBe(0);
    expect(ui.queryByText("Couldn't load attendees")).not.toBeNull();
    expect(ui.queryByTestId('host-attendees-cut')).toBeNull();
  });
  it('AN5 the going/maybe read failed → "Couldn\'t load attendees", no slice said', async () => {
    const { ui } = await tab('AU4');
    expect(ui.queryByText("Couldn't load attendees")).not.toBeNull();
    expect(ui.queryByTestId('host-attendees-cut')).toBeNull();
  });
  it('GL1 goingListUnread and attendeesListCut over each body', () => {
    expect(['AU0', 'AU1', 'AU2', 'AU1u', 'AU3', 'AU4'].map((k) => [k, goingListUnread(BODIES[k]), attendeesListCut(BODIES[k])])).toEqual([
      ['AU0', false, { cut: true, total: 6 }],
      ['AU1', false, { cut: true, total: 6 }],
      ['AU2', false, { cut: true, total: 6 }],
      ['AU1u', false, { cut: true, total: 6 }],
      ['AU3', true, { cut: false, total: null }],
      ['AU4', true, { cut: false, total: null }],
    ]);
    // a body whose going count is unknown, nobody listed, a profiles read failed: the list is not known to be empty
    expect(goingListUnread({ ...BODIES.AU3, counts: { going: null, maybe: 0 } })).toBe(true);
    // nobody going, the host's profile read failed: the list is whole and empty
    expect(goingListUnread({ ...BODIES.AU2, goingAttendees: [], counts: { going: 0, maybe: 0, interested: 0, cant_go: 0 }, goingAttendeesTruncated: undefined })).toBe(false);
    expect(goingListUnread(null)).toBe(false);
  });
});
