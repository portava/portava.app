/**
 * census-layover L138 — the crew card when the server REFUSES to offer a crew.
 *
 * `GET /api/airport/sessions/:id/crew` now answers `{ inCrew: false, crews: [],
 * reason: 'safety_gate_not_passed' }` when the §14.1 meet gate closes: the
 * traveller's certified record says they must not be offered a landside
 * meeting (`meetActionAvailability`, wired in
 * `services/layover/LayoverCrewVisibility.ts`).
 *
 * That answer and a genuinely empty city arrive as the same `crews: []`, and
 * the card used to have exactly one sentence for it — "No crews here yet. Start
 * one." A refusal rendered as an empty city is the fabricated zero this lane
 * keeps catching, and this one does worse than fabricate: it invites the
 * traveller to do the thing the gate has just refused.
 *
 * THIS SECTION DECIDES NOTHING ABOUT TIME. It reads the server's own `reason`
 * and branches on it; it does not compare an instant or re-derive a verdict.
 * `LayoverReturnPanel.tsx` was deleted for owning thresholds of its own.
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

/** The gate closed: no crew offered, and the server says why. */
const GATE_CLOSED = {
  ok: true, inCrew: false, city: 'Taoyuan', crews: [],
  reason: 'safety_gate_not_passed', meetWithheld: ['safety_gate_not_cleared'],
};

/** A measured empty city: the gate is open and there is simply nobody. */
const EMPTY_CITY = { ok: true, inCrew: false, city: 'Taoyuan', crews: [] };

/** The gate is open and a crew is on offer. */
const ONE_CREW = {
  ok: true, inCrew: false, city: 'Taoyuan',
  crews: [{
    id: 'crew-1', title: 'Ramen in the old town', meetingPointLabel: 'Terminal 2 food court',
    maxMembers: 6, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  }],
};

afterEach(() => { jest.restoreAllMocks(); });

describe('LayoverCrewSection — a closed meet gate is a refusal, not an empty city', () => {
  it('1. `safety_gate_not_passed` is explained, and does NOT invite starting a crew', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, GATE_CLOSED));
    await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" />);
    await waitFor(() =>
      expect(screen.getByText(/does not leave room to go and meet a crew/)).toBeTruthy(),
    );
    expect(screen.queryByText(/No crews here yet/)).toBeNull();
  });

  it('2. CONTROL: a MEASURED empty city still says so — the two zeros stay different', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, EMPTY_CITY));
    await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" />);
    await waitFor(() => expect(screen.getByText('No crews here yet. Start one.')).toBeTruthy());
    expect(screen.queryByText(/does not leave room to go and meet a crew/)).toBeNull();
  });

  it('3. CONTROL: an offered crew is still listed with its meeting point', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, ONE_CREW));
    await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" />);
    await waitFor(() => expect(screen.getByText('Ramen in the old town')).toBeTruthy());
    expect(screen.getByText('Terminal 2 food court')).toBeTruthy();
    expect(screen.queryByText(/does not leave room to go and meet a crew/)).toBeNull();
  });
});
