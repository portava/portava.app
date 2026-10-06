/**
 * The crew surface and the landside gate (PR #624's verification, item 4, as
 * corrected).
 *
 * TWO THINGS, AND THEY PULL IN OPPOSITE DIRECTIONS.
 *
 * A CREW IS NOT A TRIP INTO THE CITY. A crew can meet in the terminal, and
 * starting or joining one is not leaving the airport — so a closed or
 * cautionary landside gate must not take the crew surface away. The first
 * version of this fix did exactly that (it hid "Start a crew" beside a refused
 * roster and the server refused the request); cases 4 and 6 are the regression
 * tests for it.
 *
 * A CREW DEADLINE IS NOT A CLEARANCE. The server certifies a crew's shared
 * deadline and nothing about its border: it never reads a crewmate's passport,
 * on purpose. "Everyone must be back by 14:10" must never read as "everyone may
 * go", so every crew surface says each member checks their own entry before
 * leaving the airport — and a member is told what THEIR OWN gate says, from
 * their own record only.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 *  * the deadline, or the roster, shown without the each-checks-their-own
 *    sentence (cases 1, 4, 5 — case 1 is an OLD server's payload);
 *  * a member whose own gate is closed or cautionary not told so, or told the
 *    crew is closed to them rather than the landside part (cases 2, 3);
 *  * "Start a crew" missing beside a refused roster (case 4);
 *  * a typed meeting point sent WITHOUT the creator saying where it is, or with
 *    a place pre-selected for them (cases 6, 7).
 *
 * Only `fetch` and the two auth modules beneath the real service are replaced.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { LayoverCrewSection } from '../LayoverCrewSection.tsx';

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

/** A crew the traveller is in, as a server that PREDATES `yourLandside` sends it. */
const IN_CREW_OLD_SERVER = {
  ok: true, inCrew: true,
  crew: {
    id: 'crew-1', title: 'Ramen in the old town', city: 'taoyuan', meetingPointLabel: 'Terminal 2 food court',
    status: 'open', maxMembers: 6, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    youAreOwner: true, memberCount: 2,
  },
  solution: {
    crewVersion: 'v', sharedReturnBy: new Date(Date.now() + 3_600_000).toISOString(), bindingMemberIds: [],
    bindingMemberHidden: false, feasible: true, reasons: [], split: false, members: [],
  },
  members: [], degraded: false, degradedReasons: [],
};

/** The same crew from the fixed server, for a member whose OWN gate is closed. */
const IN_CREW_OWN_GATE_CLOSED = {
  ...IN_CREW_OLD_SERVER, yourLandside: 'closed', landsideClearance: 'each_member_checks_their_own',
};

/** …and for one whose own gate is a caution: not forbidden, not confirmed. */
const IN_CREW_OWN_GATE_CAUTION = {
  ...IN_CREW_OLD_SERVER, yourLandside: 'caution', landsideClearance: 'each_member_checks_their_own',
};

/** The roster refused (#599): the traveller's own record says no landside meeting is to be OFFERED. */
const ROSTER_REFUSED = {
  ok: true, inCrew: false, city: 'Taoyuan', crews: [],
  reason: 'safety_gate_not_passed', meetWithheld: ['safety_gate_not_cleared'],
};

/** A measured empty city: nothing refused, nobody there. */
const EMPTY_CITY = { ok: true, inCrew: false, city: 'Taoyuan', crews: [] };

/** A crew on offer. */
const ONE_CREW = {
  ok: true, inCrew: false, city: 'Taoyuan',
  crews: [{
    id: 'crew-1', title: 'Ramen in the old town', meetingPointLabel: 'Terminal 2 food court',
    maxMembers: 6, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  }],
};

/** The bodies of every POST the section made, parsed. */
function postedBodies(spy: jest.SpyInstance): Array<Record<string, unknown>> {
  return spy.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body ?? '{}')));
}

afterEach(() => { jest.restoreAllMocks(); });

describe('LayoverCrewSection — a crew deadline is never a clearance to leave the airport', () => {
  it('1. the deadline is always followed by "not a clearance" — even from a server that says nothing about the gate', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, IN_CREW_OLD_SERVER));
    await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" />);
    await waitFor(() => expect(screen.getByText('Everyone must be back by')).toBeTruthy());
    expect(screen.getByTestId('layover-crew-not-a-clearance')).toBeTruthy();
    expect(screen.getAllByText(/deadline, not a clearance/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Before leaving the airport, each of you must check your own entry/).length).toBeGreaterThan(0);
    // Nothing was said about this member's own gate, so nothing is claimed about it.
    expect(screen.queryByTestId('layover-crew-own-gate-closed')).toBeNull();
    expect(screen.queryByTestId('layover-crew-own-gate-caution')).toBeNull();
  });

  it('2. a member whose OWN gate is closed still sees the crew, and is told the landside part is not open to THEM', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, IN_CREW_OWN_GATE_CLOSED));
    await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" />);
    await waitFor(() => expect(screen.getByText('Everyone must be back by')).toBeTruthy());
    // Still in the crew, still shown it.
    expect(screen.getByText('Ramen in the old town')).toBeTruthy();
    expect(screen.getByTestId('layover-crew-own-gate-closed')).toBeTruthy();
    expect(screen.getAllByText(/Your own layover does not allow leaving the airport/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/You can still meet this crew inside the airport/).length).toBeGreaterThan(0);
    expect(screen.getByTestId('layover-crew-not-a-clearance')).toBeTruthy();
  });

  it('3. a cautionary own gate is said as unconfirmed — and NOT as closed', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, IN_CREW_OWN_GATE_CAUTION));
    await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" />);
    await waitFor(() => expect(screen.getByText('Everyone must be back by')).toBeTruthy());
    expect(screen.getByTestId('layover-crew-own-gate-caution')).toBeTruthy();
    expect(screen.getAllByText(/Whether you can leave the airport is not confirmed/).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('layover-crew-own-gate-closed')).toBeNull();
    expect(screen.getByTestId('layover-crew-not-a-clearance')).toBeTruthy();
  });
});

describe('LayoverCrewSection — a closed landside gate does not take the crew surface away', () => {
  it('4. REGRESSION: a refused roster STILL offers "Start a crew" — starting a crew is not leaving the airport', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, ROSTER_REFUSED));
    await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" />);
    await waitFor(() =>
      expect(screen.getByText(/does not leave room to go and meet a crew/)).toBeTruthy(),
    );
    expect(screen.getByLabelText('Start a crew')).toBeTruthy();
    expect(screen.getByTestId('layover-crew-roster-not-a-clearance')).toBeTruthy();
  });

  it('5. the roster of crews on offer says each member checks their own entry before leaving the airport', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, ONE_CREW));
    await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" />);
    await waitFor(() => expect(screen.getByText('Ramen in the old town')).toBeTruthy());
    expect(screen.getByTestId('layover-crew-roster-not-a-clearance')).toBeTruthy();
    expect(screen.getAllByText(/Before leaving the airport, each of you must check your own entry/).length).toBeGreaterThan(0);
  });
});

describe('LayoverCrewSection — the creator says where a typed meeting point is', () => {
  it('6. a crew with NO meeting point is created with no place asked for or sent', async () => {
    const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, EMPTY_CITY));
    await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" />);
    await waitFor(() => expect(screen.getByLabelText('Start a crew')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Start a crew'));
    await fireEvent.changeText(screen.getByLabelText('Crew title'), 'Coffee at the gate');
    // Nothing typed as a meeting point: the question is not asked.
    expect(screen.queryByTestId('layover-crew-meeting-place-inside')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Create crew'));
    await waitFor(() => expect(postedBodies(spy).length).toBe(1));
    const body = postedBodies(spy)[0];
    expect(body.title).toBe('Coffee at the gate');
    expect(body.meetingPointLabel).toBeNull();
    expect('meetingPointInsideAirport' in body).toBe(false);
  });

  it('7. a typed meeting point must be PLACED: nothing is pre-selected, nothing is sent until it is, and the answer is sent as given', async () => {
    const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, EMPTY_CITY));
    await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" />);
    await waitFor(() => expect(screen.getByLabelText('Start a crew')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Start a crew'));
    await fireEvent.changeText(screen.getByLabelText('Crew title'), 'Ramen');
    await fireEvent.changeText(screen.getByLabelText('Meeting point'), 'Terminal 2 food court');

    const inside = screen.getByTestId('layover-crew-meeting-place-inside');
    const outside = screen.getByTestId('layover-crew-meeting-place-outside');
    expect(inside.props.accessibilityState.checked).toBe(false);
    expect(outside.props.accessibilityState.checked).toBe(false);

    // Not placed yet: asked, and nothing is posted.
    await fireEvent.press(screen.getByLabelText('Create crew'));
    expect(screen.getByText('Say whether that meeting point is inside the airport or in the city.')).toBeTruthy();
    expect(postedBodies(spy).length).toBe(0);

    await fireEvent.press(screen.getByTestId('layover-crew-meeting-place-inside'));
    expect(screen.getByTestId('layover-crew-meeting-place-inside').props.accessibilityState.checked).toBe(true);
    expect(screen.getByTestId('layover-crew-meeting-place-outside').props.accessibilityState.checked).toBe(false);
    await fireEvent.press(screen.getByLabelText('Create crew'));
    await waitFor(() => expect(postedBodies(spy).length).toBe(1));
    const body = postedBodies(spy)[0];
    expect(body.meetingPointLabel).toBe('Terminal 2 food court');
    expect(body.meetingPointInsideAirport).toBe(true);
  });

  it('8. "In the city" is sent as outside the airport, and the server\'s refusal is shown in its own words', async () => {
    const refusal = 'Your own layover does not allow leaving the airport right now, so you cannot set a meeting point outside it. Pick somewhere inside the airport, or leave the meeting point out.';
    const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url: any, init?: any) =>
      init?.method === 'POST'
        ? jsonResponse(409, { error: 'conflict', message: refusal, reason: 'landside_meeting_point_closed' })
        : jsonResponse(200, EMPTY_CITY));
    await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" />);
    await waitFor(() => expect(screen.getByLabelText('Start a crew')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Start a crew'));
    await fireEvent.changeText(screen.getByLabelText('Crew title'), 'Night market');
    await fireEvent.changeText(screen.getByLabelText('Meeting point'), 'Shilin night market');
    await fireEvent.press(screen.getByTestId('layover-crew-meeting-place-outside'));
    await fireEvent.press(screen.getByLabelText('Create crew'));
    await waitFor(() => expect(screen.getByText(refusal)).toBeTruthy());
    expect(postedBodies(spy)[0].meetingPointInsideAirport).toBe(false);
  });
});
