/**
 * census-layover L166 — "Precise crew sharing: separate explicit control, off
 * by default" — on the crew card. B58 lane LAY-C1.
 *
 * The server decides (`yourShare` on GET /crew; POST/DELETE
 * …/crew/location-grant). What this proves is that the card:
 *   - renders NOTHING when the feature is off (`available: false`, the flag's
 *     FALSE seed) or the server predates the field — the control is not shown;
 *   - offers the share only on an explicit press, and nothing is sent before it;
 *   - renders the server's verdict (live, until when, why not) and derives none;
 *   - renders `yourShare: null` as UNKNOWN — never as "not sharing" — and then
 *     offers only the action that can reduce sharing (stop);
 *   - shows the server's refusal sentence when a share is refused.
 *
 * Only `fetch` and the two auth modules beneath the real service are replaced.
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';

import { LayoverCrewSection } from '../LayoverCrewSection.tsx';
import { crewLocationShareView } from '../../../services/layover.ts';
import { fmtClock } from '../layoverFormat.ts';

// NOTE: intentionally exhaustive — requireActual on lib/supabase.ts constructs a
// real Supabase client through SecureStoreAdapter, which needs native modules.
jest.mock('../../../lib/supabase.ts', () => ({
  supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: null } })) } },
  isSupabaseConfigured: true,
}));

// NOTE: intentionally exhaustive — apiToken.ts imports lib/supabase.ts at module
// scope; a requireActual spread would defeat the mock above.
jest.mock('../../../services/apiToken.ts', () => ({
  freshToken: jest.fn(async () => 'test-token'),
}));

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const UNTIL = '2026-10-14T14:40:00.000Z';

function inCrew(yourShare?: unknown, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    inCrew: true,
    crew: {
      id: 'crew-1', title: 'Ramen', city: 'taoyuan', meetingPointLabel: null, meetingPointWithheld: [],
      status: 'open', maxMembers: 6, expiresAt: '2026-10-14T18:00:00.000Z', youAreOwner: false, memberCount: 2,
    },
    solution: {
      crewVersion: 'v', sharedReturnBy: '2026-10-14T16:00:00.000Z', bindingMemberIds: [], feasible: true,
      reasons: [], split: false, members: [],
    },
    members: [{ id: 'user-a', handle: 'ann', name: 'Ann', avatarUrl: null }],
    degraded: false,
    degradedReasons: [],
    ...(yourShare === undefined ? {} : { yourShare }),
    ...extra,
  };
}

const OFF = { available: false, live: false, reason: 'feature_off', expiresAt: null };
const NEVER = { available: true, live: false, reason: 'no_live_grant:never_granted', expiresAt: null };
const LIVE = { available: true, live: true, reason: 'live_scoped_grant', expiresAt: UNTIL };

type Call = { url: string; method: string };

/** GET answers `reads` in order (last one repeats); writes answer `write`. */
function mockServer(reads: unknown[], write: { status: number; body: unknown } = { status: 200, body: {} }) {
  const calls: Call[] = [];
  let i = 0;
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    calls.push({ url, method });
    if (method === 'GET') {
      const body = reads[Math.min(i, reads.length - 1)];
      i += 1;
      return jsonResponse(200, body);
    }
    return jsonResponse(write.status, write.body);
  });
  return calls;
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');

afterEach(() => { jest.restoreAllMocks(); });

describe('crewLocationShareView — the one place the card reads `yourShare`', () => {
  it('absent / malformed / feature off are HIDDEN; null is UNKNOWN; live and off read the server', () => {
    expect(crewLocationShareView(undefined)).toEqual({ kind: 'hidden' });
    expect(crewLocationShareView(OFF as any)).toEqual({ kind: 'hidden' });
    expect(crewLocationShareView({ live: true } as any)).toEqual({ kind: 'hidden' });
    expect(crewLocationShareView(null)).toEqual({ kind: 'unknown' });
    expect(crewLocationShareView(LIVE as any)).toEqual({ kind: 'live', until: UNTIL });
    expect(crewLocationShareView(NEVER as any)).toEqual({ kind: 'off', reason: 'no_live_grant:never_granted' });
  });
});

describe('LayoverCrewSection — L166 the precise-sharing control', () => {
  it('1. OFF (the flag seed): the control is not shown at all, and nothing is sent', async () => {
    const calls = mockServer([inCrew(OFF)]);
    await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" />);
    await waitFor(() => expect(screen.getByText('Ramen')).toBeTruthy());
    expect(screen.queryByText(/precise location/i)).toBeNull();
    expect(screen.queryByTestId('layover-crew-location-share')).toBeNull();
    expect(screen.queryByTestId('layover-crew-location-stop')).toBeNull();
    expect(writes(calls)).toEqual([]);
  });

  it('2. an older server with no `yourShare`: not shown (absence is not "off" and not "on")', async () => {
    mockServer([inCrew(undefined)]);
    await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" />);
    await waitFor(() => expect(screen.getByText('Ramen')).toBeTruthy());
    expect(screen.queryByText(/precise location/i)).toBeNull();
  });

  it('3. off by default: "cannot see", the audience stated, and the share is sent ONLY on the press', async () => {
    const calls = mockServer([inCrew(NEVER), inCrew(LIVE)], { status: 200, body: inCrew(LIVE) });
    await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" />);
    await waitFor(() => expect(screen.getByText('Your crew cannot see your precise location.')).toBeTruthy());
    expect(screen.getByText(/Only crewmates you follow who follow you back can see it/)).toBeTruthy();
    expect(screen.queryByTestId('layover-crew-location-stop')).toBeNull();
    expect(writes(calls)).toEqual([]);

    await fireEvent.press(screen.getByTestId('layover-crew-location-share'));
    await waitFor(() => expect(screen.getByTestId('layover-crew-location-live')).toBeTruthy());
    expect(writes(calls)).toEqual([{ url: expect.stringMatching(/\/airport\/sessions\/sess-1\/crew\/location-grant$/), method: 'POST' }]);
  });

  it('4. live: the server\'s end time and a Stop that sends DELETE — and no second "allow"', async () => {
    const calls = mockServer([inCrew(LIVE), inCrew({ ...NEVER, reason: 'no_live_grant:user_revoked' })], { status: 200, body: {} });
    await render(<LayoverCrewSection sessionId="sess-1" timezone="UTC" />);
    await waitFor(() => expect(screen.getByTestId('layover-crew-location-live')).toBeTruthy());
    expect(screen.getByTestId('layover-crew-location-until')).toBeTruthy();
    // The server's instant, formatted by the shared formatter — no time is derived here.
    expect(screen.getByText(` until ${fmtClock(UNTIL, 'UTC')}`)).toBeTruthy();
    expect(screen.queryByTestId('layover-crew-location-share')).toBeNull();

    await fireEvent.press(screen.getByTestId('layover-crew-location-stop'));
    await waitFor(() => expect(screen.getByText('You stopped sharing your precise location with this crew.')).toBeTruthy());
    expect(writes(calls)).toEqual([{ url: expect.stringMatching(/\/crew\/location-grant$/), method: 'DELETE' }]);
  });

  it('5. `yourShare: null` is UNKNOWN — never "cannot see" — and only Stop is offered', async () => {
    mockServer([inCrew(null, { degraded: true, degradedReasons: ['location_grants_unreadable'] })]);
    await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" />);
    await waitFor(() => expect(screen.getByTestId('layover-crew-location-unknown')).toBeTruthy());
    expect(screen.getByText(/could not check whether your crew can see your precise location/)).toBeTruthy();
    expect(screen.queryByText('Your crew cannot see your precise location.')).toBeNull();
    expect(screen.queryByTestId('layover-crew-location-share')).toBeNull();
    expect(screen.getByTestId('layover-crew-location-stop')).toBeTruthy();
  });

  it('6. a refusal is shown in the server\'s words, and the card stays "cannot see"', async () => {
    mockServer([inCrew(NEVER)], { status: 409, body: { error: 'conflict', reason: 'reentry_unverifiable', message: 'Sharing your location needs airport re-entry tracking, which is not available yet. Nothing was shared.' } });
    await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" />);
    await waitFor(() => expect(screen.getByTestId('layover-crew-location-share')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('layover-crew-location-share'));
    await waitFor(() => expect(screen.getByText(/Nothing was shared/)).toBeTruthy());
    expect(screen.getByText('Your crew cannot see your precise location.')).toBeTruthy();
  });

  it('7. the server\'s reason is translated, never re-derived: paused sharing, re-entry, rejoin', async () => {
    for (const [reason, text] of [
      ['sharing_gate_closed', 'Your location sharing is paused or off in your settings.'],
      ['no_live_grant:airport_reentry', 'Your location share ended when you got back to the airport.'],
      ['granted_before_membership', 'You rejoined this crew, so an earlier share does not carry over.'],
      ['some_future_reason', 'Your crew cannot see your precise location.'],
    ] as const) {
      mockServer([inCrew({ ...NEVER, reason })]);
      const view = await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" />);
      await waitFor(() => expect(screen.getByTestId('layover-crew-location-off-reason')).toBeTruthy());
      expect(screen.getByTestId('layover-crew-location-off-reason').props.children).toBe(text);
      await view.unmount();
      jest.restoreAllMocks();
    }
  });
});
