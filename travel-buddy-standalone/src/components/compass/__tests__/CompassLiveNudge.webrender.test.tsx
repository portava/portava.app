/**
 * CompassLive on-screen nudge render — web renderer (jest-expo/web).
 *
 * The jest-expo NATIVE React 19 renderer cannot commit the setState that an
 * out-of-band event-bus dispatch triggers (known renderer wall), so the
 * native component test only asserts the wiring via mock call counts. This
 * suite runs the same component under react-native-web + real react-dom in
 * jsdom, where the commit works — proving the in-the-moment nudge card is
 * actually VISIBLE the instant the realtime event arrives, not only after
 * the refreshed context/poll.
 *
 * Runs via jest.web.config.js (see `pnpm run test:component`).
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

// Minimal focus mock — same rationale as the native component test: the real
// expo-router drags in navigation internals that crash under jest.
jest.mock('expo-router', () => {
  const ReactActual = require('react');
  return {
    useFocusEffect: (cb: () => void | (() => void)) => ReactActual.useEffect(cb, [cb]),
  };
});

const mockFetchSession = jest.fn();
const mockStart = jest.fn();
const mockStop = jest.fn();
const mockCheck = jest.fn();
jest.mock('../../../services/compass.ts', () => ({
  ...jest.requireActual('../../../services/compass.ts'),
  fetchCompassLiveSession: (...a: unknown[]) => mockFetchSession(...a),
  startCompassLive: (...a: unknown[]) => mockStart(...a),
  stopCompassLive: (...a: unknown[]) => mockStop(...a),
  checkCompassLive: (...a: unknown[]) => mockCheck(...a),
}));

import { CompassLive } from '../CompassLive.tsx';
import { emitNotificationEvent } from '../../../services/notificationEvents.ts';

const ACTIVE_SESSION = {
  id: 'ls-1',
  status: 'active',
  context: {
    city: 'Cebu City',
    tripId: 'trip-1',
    currentStop: { id: 'item-a', title: 'Basilica visit', startsAt: null },
    nextItem: { id: 'item-b', title: 'Lechon lunch', startsAt: null },
    minutesToNext: 42,
    recentEvents: [],
    updatedAt: new Date().toISOString(),
  },
  checksRun: 2,
  nudgesDelivered: 1,
  startedAt: new Date().toISOString(),
};

const NUDGE_EVENT = {
  eventType: 'compass.live.live_spontaneity',
  category: 'compass',
  title: 'Gelato around the corner',
  body: 'A beloved gelateria is 3 minutes away from your current stop.',
  actionUrl: '/trip/trip-1',
};

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  jest.clearAllMocks();
});

describe('CompassLive nudge visual commit (web renderer)', () => {
  it('shows the nudge card on screen the instant the live event arrives — not only after the refreshed context', async () => {
    mockFetchSession.mockResolvedValue({ ok: true, compassEnabled: true, active: true, session: ACTIVE_SESSION });
    // The immediate refresh check delivers NOTHING — so if the card appears,
    // it provably came from the realtime event payload itself.
    mockCheck.mockResolvedValue({ ok: true, compassEnabled: true, active: true, session: ACTIVE_SESSION, delivered: [] });

    await act(async () => { root.render(<CompassLive />); });

    // Active session resumed; no nudge yet.
    expect(container.textContent).toContain('LIVE · CEBU CITY');
    expect(container.textContent).toContain('Now: Basilica visit');
    expect(container.textContent).not.toContain(NUDGE_EVENT.title);

    await act(async () => { emitNotificationEvent(NUDGE_EVENT); });

    // The in-the-moment card is visibly rendered from the event payload.
    expect(container.textContent).toContain(NUDGE_EVENT.title);
    expect(container.textContent).toContain(NUDGE_EVENT.body);
  });

  it('never renders the same nudge twice when a later poll re-delivers it', async () => {
    mockFetchSession.mockResolvedValue({ ok: true, compassEnabled: true, active: true, session: ACTIVE_SESSION });
    mockCheck.mockResolvedValue({ ok: true, compassEnabled: true, active: true, session: ACTIVE_SESSION, delivered: [] });

    await act(async () => { root.render(<CompassLive />); });
    await act(async () => { emitNotificationEvent(NUDGE_EVENT); });
    expect(countOccurrences(container.textContent ?? '', NUDGE_EVENT.title)).toBe(1);

    // Same nudge arrives again — via the event bus AND via a poll response.
    const nudgeFromPoll = {
      type: 'live_spontaneity',
      title: NUDGE_EVENT.title,
      body: NUDGE_EVENT.body,
      actionUrl: NUDGE_EVENT.actionUrl,
    };
    mockCheck.mockResolvedValue({ ok: true, compassEnabled: true, active: true, session: ACTIVE_SESSION, delivered: [nudgeFromPoll] });
    await act(async () => { emitNotificationEvent(NUDGE_EVENT); });

    expect(countOccurrences(container.textContent ?? '', NUDGE_EVENT.title)).toBe(1);
  });

  it('ignores non-live events entirely — nothing new appears on screen', async () => {
    mockFetchSession.mockResolvedValue({ ok: true, compassEnabled: true, active: true, session: ACTIVE_SESSION });
    mockCheck.mockResolvedValue({ ok: true, compassEnabled: true, active: true, session: ACTIVE_SESSION, delivered: [] });

    await act(async () => { root.render(<CompassLive />); });
    const checksBefore = mockCheck.mock.calls.length;

    await act(async () => {
      emitNotificationEvent({ eventType: 'plans.rsvp', title: 'Someone RSVPed', body: 'x' });
    });

    expect(container.textContent).not.toContain('Someone RSVPed');
    expect(mockCheck.mock.calls.length).toBe(checksBefore);
  });
});
