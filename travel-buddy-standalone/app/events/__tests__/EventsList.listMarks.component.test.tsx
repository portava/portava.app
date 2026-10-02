/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; sweep SW17): /events/list never says a count GET /events could
 * not recount as measured, nor an answer that is not whole as "No events found".
 *
 * GET /events names a live count read that failed or was cut in `failedSources` (the cached, possibly stale count is
 * served), and adds `truncated: true` to an answer that is not whole (§115 B12). No screen read either. The screen runs
 * over the REAL `listEvents` (services/events.ts), with fetch answering the bodies, so the service's marking is pinned
 * with the card's text.
 *
 *   EL1  `failedSources: ["event_rsvps", "event_waitlist"]` → "3 going/10 (last known) · 2 waiting (last known)"
 *   EL2  an empty page with `truncated: true` → "Couldn't load every event", never "No events found"
 *   EL3  a page with `truncated: true` → "More events may exist than are shown here"
 *   EL0  CONTROL: a whole answer → "3 going/10 · 2 waiting", no note
 *   EL0b CONTROL: an empty whole answer → "No events found"
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
  useLocalSearchParams: () => ({}),
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => { const c = cb(); return typeof c === 'function' ? c : undefined; }, []);
  },
}));

// NOTE: intentional stub — the session is not under test here.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ isAuthed: true, configured: true, userId: 'u1' }),
}));

// NOTE: intentionally exhaustive — apiToken exposes a single async helper; a stable token reaches fetch.
jest.mock('../../../src/services/apiToken.ts', () => ({
  freshToken: jest.fn(async () => 'tok'),
}));

jest.mock('../../../src/lib/supabase.ts', () => ({
  ...jest.requireActual('../../../src/lib/supabase.ts'),
  isSupabaseConfigured: true,
}));

// NOTE: intentional stub — the composer sheet is never opened here.
jest.mock('../../../src/components/EventComposerSheet', () => ({
  EventComposerSheet: () => null,
}));

jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { Image: (p: { testID?: string }) => React.createElement(View, { testID: p.testID ?? 'expo-image' }) };
});
jest.mock('expo-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { LinearGradient: ({ children }: { children?: React.ReactNode }) => React.createElement(View, null, children) };
});

import EventsScreen from '../list';

const event = {
  id: 'ev-1', hostId: 'h1', hostName: 'Ana', hostHandle: null, hostAvatarUrl: null, title: 'Rooftop quiz',
  description: null, locationName: 'Rooftop', locationLat: null, locationLng: null, startsAt: '2099-08-01T18:00:00Z',
  endsAt: null, coverUrl: null, coverMediaType: null, maxAttendees: 10, ageMin: null, ageMax: null, trustScoreMin: null,
  verifiedOnly: false, visibility: 'public', state: 'open', chatEnabled: false, chatThreadId: null, waitlistEnabled: true,
  priceType: 'free', priceUrl: null, rsvpOptions: ['going'], goingCount: 3, waitlistCount: 2, category: null, city: 'Lisbon',
  country: null, rsvpClosed: false, showExactLocation: false, isHost: false, createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z', myRsvp: null,
};

function answer(body: Record<string, unknown>) {
  (global as any).fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => body }));
}

async function shown(body: Record<string, unknown>) {
  answer(body);
  const r = await render(<EventsScreen />);
  await waitFor(() => expect((global as any).fetch).toHaveBeenCalled());
  await waitFor(() => expect(r.queryByText(/going|No events found|Couldn't load every event/)).not.toBeNull());
  return r;
}

describe('census-discovery §117 (SW17): /events/list reads what GET /events could not read', () => {
  afterEach(() => { delete (global as any).fetch; });

  it('EL1 failedSources names the live counts → said as last known', async () => {
    const r = await shown({ events: [event], page: 1, limit: 30, failedSources: ['event_rsvps', 'event_waitlist'] });
    expect(r.getByText('3 going/10 (last known) · 2 waiting (last known)')).toBeTruthy();
    expect(r.queryByText('3 going/10 · 2 waiting')).toBeNull();
  });
  it('EL2 an empty page that is not whole → "Couldn\'t load every event", never "No events found"', async () => {
    const r = await shown({ events: [], page: 1, limit: 30, truncated: true });
    expect(r.getByText("Couldn't load every event")).toBeTruthy();
    expect(r.queryByText('No events found')).toBeNull();
  });
  it('EL3 a page that is not whole → "More events may exist than are shown here"', async () => {
    const r = await shown({ events: [event], page: 1, limit: 30, truncated: true });
    expect(r.getByText('More events may exist than are shown here')).toBeTruthy();
  });
  it('EL0 CONTROL: a whole answer → the counts as measured, no note', async () => {
    const r = await shown({ events: [event], page: 1, limit: 30 });
    expect(r.getByText('3 going/10 · 2 waiting')).toBeTruthy();
    expect(r.queryByText(/last known/)).toBeNull();
    expect(r.queryByText('More events may exist than are shown here')).toBeNull();
  });
  it('EL0b CONTROL: an empty whole answer → "No events found"', async () => {
    const r = await shown({ events: [], page: 1, limit: 30 });
    expect(r.getByText('No events found')).toBeTruthy();
  });
});
