/**
 * census-discovery §118 (DV-83 round 21, lane W11-X2; the round-20 verifier's B24, probes CP0/CP1, AT0/AT1): the host's
 * Attendees tab and the co-host picker never state a slice of who is going as the whole list.
 *
 * GET /events/:id serves the first four going travellers as `goingAttendees` (the avatar strip). The Attendees tab
 * listed them as the attendees, and the co-host picker said "Everyone going is already a co-host, or nobody else is
 * going yet." when those four were co-hosts or the host. The route now marks a slice (`goingAttendeesTruncated`,
 * `goingAttendeesTotal`), and the client also compares the live `counts.going` with the travellers listed
 * (`attendeesListCut`, lib/eventAttendeesUnread), so a body from an older server is read the same way: the tab says
 * "Showing 4 of 6 going" and the picker says only some of the travellers going are listed.
 *
 * The bodies AS0 and AS1 are the round-20 route's (the verifier's, unmarked); AS1m is this round's route's body for AS1.
 *
 *   CP0  CONTROL: 4 going, all four co-hosts → "Everyone going is already a co-host…" (true)
 *   CP1  6 going (the round-20 body), the four listed are co-hosts → never "Everyone going is already a co-host…"
 *   CP2  the same over this round's marked body → never "Everyone going…", and the slice is said
 *   AT0  CONTROL: 4 going → the Attendees tab lists 4 and says nothing more
 *   AT1  6 going (the round-20 body) → the tab says it shows 4 of 6
 *   AT2  the same over this round's marked body → "Showing 4 of 6 going"
 */
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

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
// NOTE: intentional stub — not under test here.
jest.mock('../events/EventCancelControl.tsx', () => ({ EventCancelControl: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../events/GenerateHeaderSheet.tsx', () => ({ GenerateHeaderSheet: () => null }));

import { HostDashboardPanel } from '../HostDashboardPanel.tsx';
import { EventCohostsPanel } from '../events/EventCohostsPanel.tsx';
import { getEvent } from '../../services/events.ts';

const BODIES: Record<string, any> = {"AS0": {"id": "66666666-6666-4666-8666-666666666666", "hostId": "22222222-2222-4222-8222-222222222222", "title": "Rooftop quiz", "description": null, "locationName": null, "locationLat": 38.72, "locationLng": -9.14, "startsAt": "2030-01-01T00:00:00.000Z", "endsAt": null, "coverUrl": null, "coverMediaType": null, "coverSource": null, "maxAttendees": 20, "ageMin": null, "ageMax": null, "trustScoreMin": null, "verifiedOnly": false, "visibility": "public", "state": "open", "chatEnabled": false, "chatThreadId": null, "waitlistEnabled": true, "priceType": null, "priceUrl": null, "safetyNotes": null, "rsvpOptions": ["going", "maybe", "interested", "cant_go"], "goingCount": 4, "waitlistCount": 0, "category": null, "city": "Lisbon", "country": null, "showExactLocation": false, "rsvpClosed": false, "tags": [], "isHost": true, "showHeaderPublicly": false, "createdAt": "2026-09-01T00:00:00.000Z", "host": {"id": "22222222-2222-4222-8222-222222222222", "handle": "h2222", "displayName": "N22", "avatarUrl": null}, "counts": {"going": 4, "maybe": 0, "interested": 0, "cant_go": 0}, "myRsvp": null, "myJoinRequestStatus": null, "myWaitlistPosition": null, "myWaitlistOfferExpiresAt": null, "myRole": "host", "myAttendanceState": null, "goingAttendees": [{"id": "88888888-8888-4888-8888-000000000001", "handle": "h0001", "displayName": null, "avatarUrl": null}, {"id": "88888888-8888-4888-8888-000000000002", "handle": "h0002", "displayName": null, "avatarUrl": null}, {"id": "88888888-8888-4888-8888-000000000003", "handle": "h0003", "displayName": null, "avatarUrl": null}, {"id": "88888888-8888-4888-8888-000000000004", "handle": "h0004", "displayName": null, "avatarUrl": null}]}, "AS1": {"id": "66666666-6666-4666-8666-666666666666", "hostId": "22222222-2222-4222-8222-222222222222", "title": "Rooftop quiz", "description": null, "locationName": null, "locationLat": 38.72, "locationLng": -9.14, "startsAt": "2030-01-01T00:00:00.000Z", "endsAt": null, "coverUrl": null, "coverMediaType": null, "coverSource": null, "maxAttendees": 20, "ageMin": null, "ageMax": null, "trustScoreMin": null, "verifiedOnly": false, "visibility": "public", "state": "open", "chatEnabled": false, "chatThreadId": null, "waitlistEnabled": true, "priceType": null, "priceUrl": null, "safetyNotes": null, "rsvpOptions": ["going", "maybe", "interested", "cant_go"], "goingCount": 6, "waitlistCount": 0, "category": null, "city": "Lisbon", "country": null, "showExactLocation": false, "rsvpClosed": false, "tags": [], "isHost": true, "showHeaderPublicly": false, "createdAt": "2026-09-01T00:00:00.000Z", "host": {"id": "22222222-2222-4222-8222-222222222222", "handle": "h2222", "displayName": "N22", "avatarUrl": null}, "counts": {"going": 6, "maybe": 0, "interested": 0, "cant_go": 0}, "myRsvp": null, "myJoinRequestStatus": null, "myWaitlistPosition": null, "myWaitlistOfferExpiresAt": null, "myRole": "host", "myAttendanceState": null, "goingAttendees": [{"id": "88888888-8888-4888-8888-000000000001", "handle": "h0001", "displayName": null, "avatarUrl": null}, {"id": "88888888-8888-4888-8888-000000000002", "handle": "h0002", "displayName": null, "avatarUrl": null}, {"id": "88888888-8888-4888-8888-000000000003", "handle": "h0003", "displayName": null, "avatarUrl": null}, {"id": "88888888-8888-4888-8888-000000000004", "handle": "h0004", "displayName": null, "avatarUrl": null}]}};

const NOBODY = 'Everyone going is already a co-host, or nobody else is going yet.';
BODIES.AS1m = { ...BODIES.AS1, goingAttendeesTruncated: true, goingAttendeesTotal: 6 };
let eventBody: any = null;
beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; });
beforeEach(() => {
  (globalThis as any).fetch = jest.fn(async (url: string) => {
    const u = new URL(url, 'http://api.test');
    const listed = (eventBody?.goingAttendees ?? []) as Array<{ id: string; handle: string }>;
    const body = /^\/api\/events\/[^/]+$/.test(u.pathname) ? eventBody
      : /\/cohosts$/.test(u.pathname) ? { cohosts: listed.map((a) => ({ user_id: a.id, handle: a.handle, name: null, avatarUrl: null })) }
      : { requests: [], waitlist: [] };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  });
});
afterEach(async () => { await act(async () => {}); });
async function load(key: 'AS0' | 'AS1' | 'AS1m') {
  eventBody = BODIES[key];
  const res = await getEvent(eventBody.id);
  expect(res.ok).toBe(true);
  return (res as any).data;
}
async function picker(key: 'AS0' | 'AS1' | 'AS1m') {
  const ev = await load(key);
  const ui = await render(<EventCohostsPanel event={ev} />);
  await waitFor(() => expect(ui.queryByTestId('cohosts-list')).not.toBeNull());
  return ui;
}
async function attendees(key: 'AS0' | 'AS1' | 'AS1m') {
  const ev = await load(key);
  const ui = await render(<HostDashboardPanel event={ev} onDismiss={jest.fn()} onRefresh={jest.fn()} />);
  await act(async () => { fireEvent.press(ui.getByText('Attendees')); });
  return ui;
}

describe('census-discovery §118 (B24): a slice of who is going is never said as the whole list', () => {
  it('CP0 CONTROL: 4 going, all co-hosts → the picker says everyone going is a co-host', async () => {
    const ui = await picker('AS0');
    expect(ui.queryByText(NOBODY)).not.toBeNull();
    expect(ui.queryByTestId('cohosts-candidates-cut')).toBeNull();
  });
  it('CP1 6 going (round-20 body), the four listed are co-hosts → never "Everyone going is already a co-host"', async () => {
    const ui = await picker('AS1');
    expect(ui.queryByText(NOBODY)).toBeNull();
    expect(ui.queryByTestId('cohosts-candidates-cut')).not.toBeNull();
  });
  it('CP2 the marked body → never "Everyone going…", and the slice is said', async () => {
    const ui = await picker('AS1m');
    expect(ui.queryByText(NOBODY)).toBeNull();
    expect(ui.queryByTestId('cohosts-candidates-cut')).not.toBeNull();
  });
  it('AT0 CONTROL: 4 going → the tab lists 4 and says nothing more', async () => {
    const ui = await attendees('AS0');
    expect(ui.queryAllByText(/^h000[1-4]$/).length).toBe(4);
    expect(ui.queryByTestId('host-attendees-cut')).toBeNull();
  });
  it('AT1 6 going (round-20 body) → the tab says it shows 4 of 6', async () => {
    const ui = await attendees('AS1');
    expect(ui.getByTestId('host-attendees-cut').props.children).toEqual(expect.stringMatching(/4 of 6/));
  });
  it('AT2 the marked body → "Showing 4 of 6 going"', async () => {
    const ui = await attendees('AS1m');
    expect(ui.queryByText('Showing 4 of 6 going')).not.toBeNull();
  });
});
