/**
 * census-discovery §118 (DV-83 round 21, lane W11-X2; the round-20 verifier's B26, probes LR0/LR1): /events/list, a
 * client of GET /events, draws only the answer to the request it made last.
 *
 * `load` is rebuilt on every filter change and re-run by useFocusEffect, and kept no request token, so whichever answer
 * landed LAST was drawn under whichever chip was selected: a slow answer for the previous filter overwrote the answer
 * for the current one (v7's trending race class). Each load now takes a sequence number and applies its answer only if
 * no later load has started.
 *
 * useFocusEffect is modelled as expo-router runs it on a focused screen: the effect re-runs when its callback changes.
 *
 *   LR0  CONTROL: the answers land in order → "Today" shows today's answer ("No events found")
 *   LR1  the "Any time" answer lands AFTER the "Today" answer → the "Any time" rows are never drawn under "Today"
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
  useLocalSearchParams: () => ({}),
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => { const c = cb(); return typeof c === 'function' ? c : undefined; }, [cb]);  // re-run when the callback changes, as on a focused screen
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

const event = (id: string, title: string) => ({
  id, hostId: 'h1', hostName: 'Ana', hostHandle: null, hostAvatarUrl: null, title,
  description: null, locationName: 'Rooftop', locationLat: null, locationLng: null, startsAt: '2099-08-01T18:00:00Z',
  endsAt: null, coverUrl: null, coverMediaType: null, maxAttendees: 10, ageMin: null, ageMax: null, trustScoreMin: null,
  verifiedOnly: false, visibility: 'public', state: 'open', chatEnabled: false, chatThreadId: null, waitlistEnabled: true,
  priceType: 'free', priceUrl: null, rsvpOptions: ['going'], goingCount: 3, waitlistCount: 0, category: null, city: 'Lisbon',
  country: null, rsvpClosed: false, showExactLocation: false, isHost: false, createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z', myRsvp: null,
});

type Pending = { url: string; resolve: (body: unknown) => void };
async function race(order: 'inOrder' | 'stale') {
  const pending: Pending[] = [];
  (global as any).fetch = jest.fn((url: string) => new Promise((res) => pending.push({ url, resolve: (body) => res({ ok: true, status: 200, json: async () => body }) })));
  const r = await render(<EventsScreen />);
  await waitFor(() => expect(pending.length).toBe(1));            // "Any time" (no dateTo)
  await act(async () => { fireEvent.press(r.getByText('Today')); });
  await waitFor(() => expect(pending.length).toBe(2));            // "Today" (dateFrom/dateTo)
  const anyTime = pending.find((p) => !/dateTo=/.test(p.url))!;
  const today = pending.find((p) => /dateTo=/.test(p.url))!;
  const anyBody = { events: [event('ev-weekend', 'Saturday rooftop gig (not today)')], page: 1, limit: 30 };
  const todayBody = { events: [], page: 1, limit: 30 };
  if (order === 'inOrder') { await act(async () => { anyTime.resolve(anyBody); }); await act(async () => { today.resolve(todayBody); }); }
  else { await act(async () => { today.resolve(todayBody); }); await act(async () => { anyTime.resolve(anyBody); }); }
  await act(async () => {});
  return { staleRowShown: r.queryByText('Saturday rooftop gig (not today)') !== null, noEvents: r.queryByText('No events found') !== null };
}

describe('census-discovery §118 (B26): /events/list draws only the answer for the filter on screen', () => {
  afterEach(() => { delete (global as any).fetch; });
  it('LR0 CONTROL: answers in order → "Today" shows today\'s (empty) answer', async () => {
    expect(await race('inOrder')).toEqual({ staleRowShown: false, noEvents: true });
  });
  it('LR1 the previous filter\'s answer lands last → its rows must not be drawn under "Today"', async () => {
    const seen = await race('stale');
    expect(seen).toEqual({ staleRowShown: false, noEvents: true });
  });
});
