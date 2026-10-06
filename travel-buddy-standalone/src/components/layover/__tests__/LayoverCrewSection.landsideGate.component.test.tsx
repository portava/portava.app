/**
 * The crew card never reads as a clearance to leave the airport (PR #624's
 * verification, item 4).
 *
 * The server certifies a crew's shared DEADLINE and nothing about its border:
 * it never reads a crewmate's passport, on purpose. "Everyone must be back by
 * 14:10" was therefore the whole of what the card said — beside a crew one of
 * whose members had a refused border, with `landside: not_applicable`.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 *  * The deadline shown WITHOUT the sentence that says it is not a clearance.
 *    The sentence is unconditional: case 1 is an OLD server's payload, with no
 *    `yourLandside` and no `landsideClearance`, and it must still be there.
 *  * A member whose OWN gate is closed not being told so (case 2), or a member
 *    whose gate is not closed being told it is (case 1, case 3).
 *  * "Start a crew" offered beside the server's `safety_gate_not_passed`
 *    refusal (case 4). The server refuses the POST too; a button that can only
 *    fail is an invitation to the thing the gate just refused.
 *
 * Only `fetch` and the two auth modules beneath the real service are replaced.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

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

/** The roster refused: the traveller's own record says no landside meeting. */
const GATE_CLOSED = {
  ok: true, inCrew: false, city: 'Taoyuan', crews: [],
  reason: 'safety_gate_not_passed', meetWithheld: ['safety_gate_not_cleared'],
};

/** A measured empty city: nothing refused, nobody there. */
const EMPTY_CITY = { ok: true, inCrew: false, city: 'Taoyuan', crews: [] };

afterEach(() => { jest.restoreAllMocks(); });

describe('LayoverCrewSection — a crew deadline is never a clearance to leave the airport', () => {
  it('1. the deadline is always followed by "not a clearance" — even from a server that says nothing about the gate', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, IN_CREW_OLD_SERVER));
    await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" />);
    await waitFor(() => expect(screen.getByText('Everyone must be back by')).toBeTruthy());
    expect(screen.getByTestId('layover-crew-not-a-clearance')).toBeTruthy();
    expect(screen.getAllByText(/deadline, not a clearance/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/everyone checks their own/).length).toBeGreaterThan(0);
    // Nothing was said about this member's own gate, so nothing is claimed about it.
    expect(screen.queryByTestId('layover-crew-own-gate-closed')).toBeNull();
  });

  it('2. a member whose OWN gate is closed is told so, beside the crew deadline', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, IN_CREW_OWN_GATE_CLOSED));
    await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" />);
    await waitFor(() => expect(screen.getByText('Everyone must be back by')).toBeTruthy());
    expect(screen.getByTestId('layover-crew-own-gate-closed')).toBeTruthy();
    expect(screen.getAllByText(/Your own layover does not allow leaving the airport/).length).toBeGreaterThan(0);
    expect(screen.getByTestId('layover-crew-not-a-clearance')).toBeTruthy();
  });

  it('3. CONTROL: a cautionary own gate gets the unconditional sentence and NOT the closed one', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, IN_CREW_OWN_GATE_CAUTION));
    await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" />);
    await waitFor(() => expect(screen.getByText('Everyone must be back by')).toBeTruthy());
    expect(screen.getByTestId('layover-crew-not-a-clearance')).toBeTruthy();
    expect(screen.queryByTestId('layover-crew-own-gate-closed')).toBeNull();
  });

  it('4. a refused roster offers no "Start a crew" — the server refuses that request too', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, GATE_CLOSED));
    await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" />);
    await waitFor(() =>
      expect(screen.getByText(/does not leave room to go and meet a crew/)).toBeTruthy(),
    );
    expect(screen.queryByLabelText('Start a crew')).toBeNull();
  });

  it('5. CONTROL: a measured empty city still offers "Start a crew"', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, EMPTY_CITY));
    await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" />);
    await waitFor(() => expect(screen.getByText('No crews here yet. Start one.')).toBeTruthy());
    expect(screen.getByLabelText('Start a crew')).toBeTruthy();
  });
});
