/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; the round-19 verifier's B19, probes HA0/HA1): the host's
 * Attendees tab never says "No attendees yet" over a read that failed.
 *
 * GET /events/:id names a failed going/maybe read (`event_rsvps`) or a failed profiles read (`profiles`) in
 * `failedSources`, beside an empty `goingAttendees`. EventDetail had no such field and the tab rendered the empty list as
 * "No attendees yet". The bodies are the real route's (the verifier's DA0/DA1 dumps); HA2's is DA1's with the profiles
 * read named instead, as GET /events/:id now serves it (eventDetailAttendeesUnread DA3).
 *
 * Driven through the REAL events service (getEvent → GET /api/events/:id → normalizeEventDetail) and the real
 * HostDashboardPanel; only `fetch` is faked, plus the session.
 *
 *   HA0  CONTROL: the healthy body → the two going travellers are listed
 *   HA1  the going/maybe read failed → "Couldn't load attendees", never "No attendees yet"
 *   HA2  the going travellers' profiles read failed → the same
 *   HA3  CONTROL: a healthy body with nobody going → "No attendees yet"
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
jest.mock('../events/EventCohostsPanel.tsx', () => ({ EventCohostsPanel: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../events/EventCancelControl.tsx', () => ({ EventCancelControl: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../events/GenerateHeaderSheet.tsx', () => ({ GenerateHeaderSheet: () => null }));

import { HostDashboardPanel } from '../HostDashboardPanel.tsx';
import { getEvent } from '../../services/events.ts';

const BODIES: Record<string, any> = {"DA0": {"id": "66666666-6666-4666-8666-666666666666", "hostId": "22222222-2222-4222-8222-222222222222", "title": "Rooftop quiz", "description": null, "locationName": null, "locationLat": null, "locationLng": null, "startsAt": "2030-01-01T00:00:00.000Z", "endsAt": null, "coverUrl": null, "coverMediaType": null, "coverSource": null, "maxAttendees": 10, "ageMin": null, "ageMax": null, "trustScoreMin": null, "verifiedOnly": false, "visibility": "public", "state": "open", "chatEnabled": false, "chatThreadId": null, "waitlistEnabled": true, "priceType": null, "priceUrl": null, "safetyNotes": null, "rsvpOptions": ["going", "maybe", "interested", "cant_go"], "goingCount": 7, "waitlistCount": 0, "category": null, "city": "Lisbon", "country": null, "showExactLocation": false, "rsvpClosed": false, "tags": [], "isHost": true, "showHeaderPublicly": false, "createdAt": "2026-09-01T00:00:00.000Z", "host": {"id": "22222222-2222-4222-8222-222222222222", "handle": "h2222", "displayName": "N", "avatarUrl": null}, "counts": {"going": 2, "maybe": 0, "interested": 0, "cant_go": 0}, "myRsvp": null, "myJoinRequestStatus": null, "myWaitlistPosition": null, "myWaitlistOfferExpiresAt": null, "myRole": "host", "myAttendanceState": null, "goingAttendees": [{"id": "33333333-3333-4333-8333-333333333333", "handle": "h3333", "displayName": null, "avatarUrl": null}, {"id": "44444444-4444-4444-8444-444444444444", "handle": "h4444", "displayName": null, "avatarUrl": null}]}, "DA1": {"id": "66666666-6666-4666-8666-666666666666", "hostId": "22222222-2222-4222-8222-222222222222", "title": "Rooftop quiz", "description": null, "locationName": null, "locationLat": null, "locationLng": null, "startsAt": "2030-01-01T00:00:00.000Z", "endsAt": null, "coverUrl": null, "coverMediaType": null, "coverSource": null, "maxAttendees": 10, "ageMin": null, "ageMax": null, "trustScoreMin": null, "verifiedOnly": false, "visibility": "public", "state": "open", "chatEnabled": false, "chatThreadId": null, "waitlistEnabled": true, "priceType": null, "priceUrl": null, "safetyNotes": null, "rsvpOptions": ["going", "maybe", "interested", "cant_go"], "goingCount": 7, "waitlistCount": 0, "category": null, "city": "Lisbon", "country": null, "showExactLocation": false, "rsvpClosed": false, "tags": [], "isHost": true, "showHeaderPublicly": false, "createdAt": "2026-09-01T00:00:00.000Z", "host": {"id": "22222222-2222-4222-8222-222222222222", "handle": "h2222", "displayName": "N", "avatarUrl": null}, "counts": {"going": 7, "maybe": null, "interested": 0, "cant_go": 0}, "failedSources": ["event_rsvps"], "myRsvp": null, "myJoinRequestStatus": null, "myWaitlistPosition": null, "myWaitlistOfferExpiresAt": null, "myRole": "host", "myAttendanceState": null, "goingAttendees": []}};
let eventBody: any = null;
beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; });
beforeEach(() => {
  (globalThis as any).fetch = jest.fn(async (url: string) => {
    const u = new URL(url, 'http://api.test');
    const body = /^\/api\/events\/[^/]+$/.test(u.pathname) ? eventBody : { requests: [], waitlist: [] };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  });
});
afterEach(async () => { await act(async () => {}); });

BODIES.HA2 = { ...BODIES.DA1, counts: { going: 2, maybe: 0, interested: 0, cant_go: 0 }, failedSources: ['profiles'] };
BODIES.HA3 = { ...BODIES.DA0, counts: { going: 0, maybe: 0, interested: 0, cant_go: 0 }, goingAttendees: [] };

async function attendeesTab(key: 'DA0' | 'DA1' | 'HA2' | 'HA3') {
  eventBody = BODIES[key];
  const res = await getEvent(eventBody.id);
  expect({ ok: res.ok, msg: (res as any).message ?? null }).toEqual({ ok: true, msg: null });
  const ev = res.ok ? res.data! : null;
  const ui = await render(<HostDashboardPanel event={ev as any} onDismiss={jest.fn()} onRefresh={jest.fn()} />);
  await act(async () => { fireEvent.press(ui.getByText('Attendees')); });
  const said = ui.queryByText('No attendees yet') !== null;
  const unread = ui.queryByText("Couldn't load attendees") !== null;
  return { ui, said, unread, seen: JSON.stringify({ body: key, counts: (ev as any)?.counts, goingAttendees: (ev as any)?.goingAttendees?.length, failedSourcesOnClient: (ev as any)?.failedSources ?? null, noAttendeesYet: said }) };
}

describe('census-discovery §117 (B19): the host Attendees tab over a failed read', () => {
  it('HA0 CONTROL: the healthy body lists the going travellers', async () => {
    const r = await attendeesTab('DA0');
    expect({ said: r.said, unread: r.unread, listed: r.ui.queryByText('@h3333') !== null || r.ui.queryByText('h3333') !== null, seen: r.seen }).toEqual({ said: false, unread: false, listed: true, seen: expect.any(String) });
  });
  it('HA1 the going/maybe read failed → "Couldn\'t load attendees", never "No attendees yet"', async () => {
    const r = await attendeesTab('DA1');
    expect({ said: r.said, unread: r.unread, seen: r.seen }).toEqual({ said: false, unread: true, seen: expect.any(String) });
  });
  it('HA2 the going travellers\' profiles read failed → "Couldn\'t load attendees"', async () => {
    const r = await attendeesTab('HA2');
    expect({ said: r.said, unread: r.unread, seen: r.seen }).toEqual({ said: false, unread: true, seen: expect.any(String) });
  });
  it('HA3 CONTROL: nobody going, every read answered → "No attendees yet"', async () => {
    const r = await attendeesTab('HA3');
    expect({ said: r.said, unread: r.unread, seen: r.seen }).toEqual({ said: true, unread: false, seen: expect.any(String) });
  });
});
