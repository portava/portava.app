/**
 * Telegraph §2.1 — census-telegraph T8: the inbox carries shared real-world
 * context (YOUR STATUS, AVAILABLE NEARBY, NOW, UPCOMING) above the messages.
 *
 * Pinned: each band draws from what its server read returned; a failed read
 * draws NO band and no "nothing here" line; one band's outage leaves the other
 * three; the nearby band speaks only when the surface is ENABLED (the flag is
 * not an empty neighbourhood); a band item opens its conversation.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — lib/supabase builds a client at import time.
jest.mock('../../../lib/supabase.ts', () => ({ supabase: {}, isSupabaseConfigured: true }));
// NOTE: intentionally exhaustive — the reads take one function from it.
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: async () => 'tok-1' }));

import { InboxContextBands, statusLine } from '../inbox/InboxContextBands.tsx';
import {
  fetchInboxBands,
  openSessions,
  summariseNearby,
  upcomingPlans,
  type InboxBandsData,
} from '../inbox/inboxBandsApi.ts';

const NOW = Date.parse('2026-10-05T18:00:00.000Z');
const later = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

function full(over: Partial<InboxBandsData> = {}): InboxBandsData {
  return {
    status: { status: 'free_tonight', expiresAt: later(6) },
    nearby: { enabled: true, count: 3, availableNow: 2 },
    now: [{ sessionId: 's1', threadId: 'th-1', title: 'Dinner with Marcus', state: 'ACTIVE' }],
    upcoming: [{ id: 'm1', title: 'Hoi An', startsAt: later(20), chatThreadId: 'th-2' }],
    ...over,
  };
}

describe('the band parsers say null for a failed read and a value for an answer', () => {
  it('nearby: the flag answering is enabled:false, not an empty neighbourhood', () => {
    expect(summariseNearby({ enabled: false, people: [] })).toEqual({ enabled: false, count: 0, availableNow: 0 });
    expect(
      summariseNearby({ enabled: true, people: [{ availability: { state: 'available_now' } }, { availability: { state: 'unknown' } }] }),
    ).toEqual({ enabled: true, count: 2, availableNow: 1 });
    expect(summariseNearby(null)).toBeNull();
    expect(summariseNearby({ enabled: true })).toBeNull();
  });

  it('now: only OPEN sessions, and a malformed body is a failed read', () => {
    expect(
      openSessions({ sessions: [
        { sessionId: 'a', threadId: 't', title: 'Open', state: 'ACTIVE', endedAt: null, startedAt: later(-0.2) },
        { sessionId: 'b', threadId: 't', title: 'Ended', state: 'COMPLETE', endedAt: later(-1), startedAt: later(-0.5) },
      ] }, NOW),
    ).toEqual([{ sessionId: 'a', threadId: 't', title: 'Open', state: 'ACTIVE' }]);
    expect(openSessions({ nope: true })).toBeNull();
  });

  it('upcoming: future and not cancelled, soonest first', () => {
    const r = upcomingPlans({ meetups: [
      { id: 'late', title: 'Beach', startsAt: later(48), status: 'active', chatThreadId: null },
      { id: 'past', title: 'Old', startsAt: later(-2), status: 'active' },
      { id: 'off', title: 'Off', startsAt: later(5), status: 'cancelled' },
      { id: 'soon', title: 'Hoi An', startsAt: later(20), status: 'confirmed', chatThreadId: 'th-2' },
    ] }, NOW);
    expect(r?.map((m) => m.id)).toEqual(['soon', 'late']);
    expect(upcomingPlans('garbage', NOW)).toBeNull();
  });

  it('VERIFIER F5: a session opened 13 days ago that nobody ended is not NOW; a recent transition keeps one that is', () => {
    expect(openSessions({ sessions: [{ sessionId: 's', threadId: 't', title: 'Dinner', state: 'ACTIVE', endedAt: null, startedAt: later(-13 * 24) }] }, NOW)).toEqual([]);
    expect(openSessions({ sessions: [{ sessionId: 's', threadId: 't', title: 'Dinner', state: 'ACTIVE', endedAt: null, startedAt: later(-3), transitions: [{ at: later(-0.25) }] }] }, NOW)?.length).toBe(1);
    expect(openSessions({ sessions: [{ sessionId: 's', threadId: 't', title: 'Dinner', state: 'ACTIVE', endedAt: null }] }, NOW)).toEqual([]);
  });

  it('VERIFIER F5: UPCOMING excludes a plan the viewer DECLINED', () => {
    expect(upcomingPlans({ meetups: [{ id: 'm1', title: 'Beach', startsAt: later(5), status: 'active', chatThreadId: 't', myRsvp: 'declined' }] }, NOW)).toEqual([]);
    expect(upcomingPlans({ meetups: [{ id: 'm2', title: 'Beach', startsAt: later(5), status: 'active', chatThreadId: 't', myRsvp: 'going' }] }, NOW)?.length).toBe(1);
  });

  it('a status line is said only for a live status', () => {
    expect(statusLine({ status: 'free_tonight', expiresAt: later(6) }, NOW)).toMatch(/^Free tonight · until \d{1,2}:\d{2}$/);
    expect(statusLine({ status: 'free_tonight', expiresAt: later(-1) }, NOW)).toBeNull();
    expect(statusLine({ status: 'invented', expiresAt: later(1) }, NOW)).toBeNull();
    expect(statusLine({ status: null, expiresAt: null }, NOW)).toBeNull();
    expect(statusLine(null, NOW)).toBeNull();
  });
});

describe('VERIFIER F5: the inbox stays mounted, so its clock must not freeze', () => {
  it('YOUR STATUS is gone after it expires, on the next render', async () => {
    const realNow = Date.now;
    let clock = NOW;
    Date.now = () => clock;
    try {
      const data = { status: { status: 'free_now', expiresAt: later(0.5) }, nearby: null, now: null, upcoming: null };
      const { rerender } = await render(<InboxContextBands initialData={data} />);
      expect(screen.queryByTestId('telegraph-band-status')).toBeTruthy();
      clock = NOW + 2 * 3_600_000;
      await rerender(<InboxContextBands initialData={data} />);
      expect(screen.queryByTestId('telegraph-band-status')).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});

describe('the bands, drawn', () => {
  it('all four, in §2.1’s order, above the messages', async () => {
    await render(<InboxContextBands initialData={full()} nowMs={NOW} />);
    const order = screen.queryAllByTestId(/^telegraph-band-(status|nearby|now|upcoming)$/).map((n) => String(n.props.testID));
    expect(order).toEqual(['telegraph-band-status', 'telegraph-band-nearby', 'telegraph-band-now', 'telegraph-band-upcoming']);
    expect(screen.getByText('3 people from your circles and trips · 2 free now')).toBeTruthy();
    expect(screen.getByText('Dinner with Marcus · active')).toBeTruthy();
    expect(screen.getByText('Hoi An · in 20 h')).toBeTruthy();
  });

  it('nearby switched off by its flag draws NO band — and says nothing about who is around', async () => {
    await render(<InboxContextBands initialData={full({ nearby: { enabled: false, count: 0, availableNow: 0 } })} nowMs={NOW} />);
    expect(screen.queryByTestId('telegraph-band-nearby')).toBeNull();
    expect(screen.queryByText(/nobody|no one/i)).toBeNull();
  });

  it('every read failed: only the person\'s own status speaks, and it says it could not be loaded — no "no plans"', async () => {
    await render(<InboxContextBands initialData={{ status: null, nearby: null, now: null, upcoming: null }} nowMs={NOW} />);
    expect(screen.getByTestId('telegraph-band-status-failed')).toBeTruthy();
    expect(screen.getByText("Couldn't load your status")).toBeTruthy();
    expect(screen.queryByTestId('telegraph-band-nearby')).toBeNull();
    expect(screen.queryByTestId('telegraph-band-now')).toBeNull();
    expect(screen.queryByTestId('telegraph-band-upcoming')).toBeNull();
  });

  it('a status read that failed says so even beside other bands', async () => {
    await render(<InboxContextBands initialData={full({ status: null })} nowMs={NOW} />);
    expect(screen.getByTestId('telegraph-band-status-failed')).toBeTruthy();
    expect(screen.getByTestId('telegraph-band-now')).toBeTruthy();
  });

  it('no status SET (a real answer) draws no status band and no failure', async () => {
    await render(<InboxContextBands initialData={full({ status: { status: null, expiresAt: null } })} nowMs={NOW} />);
    expect(screen.queryByTestId('telegraph-band-status')).toBeNull();
    expect(screen.queryByTestId('telegraph-band-status-failed')).toBeNull();
    expect(screen.getByTestId('telegraph-band-now')).toBeTruthy();
  });

  it('a NOW or UPCOMING item opens its conversation; a plan with no conversation opens nothing', async () => {
    const onOpenThread = jest.fn();
    await render(
      <InboxContextBands
        initialData={full({ upcoming: [
          { id: 'm1', title: 'Hoi An', startsAt: later(20), chatThreadId: 'th-2' },
          { id: 'm2', title: 'Beach', startsAt: later(30), chatThreadId: null },
        ] })}
        nowMs={NOW}
        onOpenThread={onOpenThread}
      />,
    );
    await fireEvent.press(screen.getByTestId('telegraph-band-now-s1'));
    await fireEvent.press(screen.getByTestId('telegraph-band-upcoming-m1'));
    await fireEvent.press(screen.getByTestId('telegraph-band-upcoming-m2'));
    expect(onOpenThread.mock.calls).toEqual([['th-1'], ['th-2']]);
  });
});

describe('the four reads are independent', () => {
  const realFetch = global.fetch;
  afterAll(() => { global.fetch = realFetch; });

  it('one endpoint failing leaves its band null and the other three answered', async () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
    global.fetch = jest.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      const body = u.includes('/me/quick-availability')
        ? { status: 'free_now', expiresAt: later(1) }
        : u.includes('/nearby/reachable')
          ? { enabled: false, people: [] }
          : u.includes('/me/coordination-sessions')
            ? { sessions: [] } // a well-formed body on a 503: the STATUS must decide, not the shape
            : { meetups: [{ id: 'm1', title: 'Hoi An', startsAt: later(3), status: 'active', chatThreadId: 'th-2' }] };
      const failed = u.includes('/me/coordination-sessions');
      return { ok: !failed, status: failed ? 503 : 200, json: async () => body } as Response;
    }) as typeof fetch;
    const d = await fetchInboxBands(NOW);
    expect(d.now).toBeNull();
    expect(d.status).toEqual({ status: 'free_now', expiresAt: later(1) });
    expect(d.nearby).toEqual({ enabled: false, count: 0, availableNow: 0 });
    expect(d.upcoming?.map((m) => m.id)).toEqual(['m1']);
  });
});

describe('the status read: a 503 is a failure, a 200 with no status is an answer', () => {
  const realFetch = global.fetch;
  afterAll(() => { global.fetch = realFetch; });
  const respond = (status: number, body: unknown) => {
    global.fetch = jest.fn(async (url: RequestInfo | URL) => {
      const own = String(url).includes('/me/quick-availability');
      return { ok: own ? status < 400 : false, status: own ? status : 503, json: async () => (own ? body : null) } as Response;
    }) as typeof fetch;
  };

  it('503 from /me/quick-availability → status null (failed), and the band says so', async () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
    respond(503, { error: 'degraded_unavailable' });
    const d = await fetchInboxBands(NOW);
    expect(d.status).toBeNull();
  });

  it('200 { status: null } → an answer: no status set', async () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
    respond(200, { status: null, expiresAt: null });
    const d = await fetchInboxBands(NOW);
    expect(d.status).toEqual({ status: null, expiresAt: null });
  });
});

describe('the inbox mounts the bands', () => {
  // Source-level: TelegraphInboxScreen pulls in the whole messaging stack.
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const inbox: string = readFileSync(join(__dirname, '../../../components/TelegraphInboxScreen.tsx'), 'utf8');

  it('above the search and the conversation list, opening threads by id', () => {
    const line = inbox.split('\n').find((l) => l.includes('<InboxContextBands ')) ?? '';
    expect(line).toContain('onOpenThread={(threadId) => router.push(`/messages/${threadId}`)}');
    expect(inbox.indexOf('<InboxContextBands ')).toBeLessThan(inbox.indexOf('style={s.searchWrap}'));
  });
});
