/**
 * census-layover L134 / L135 — the crew split plan on the layover dashboard (LAYOVER 165, lane B2-CREW).
 *
 * The card renders the server's plan and its per-branch certification, proposes a split in the spec's shape (A heads
 * back at T1, everyone else until T2), shows a refused proposal's reasons, and draws NOTHING when the feature is off
 * or the traveller is in no crew. Only `fetch` and the two auth modules beneath the real service are replaced.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { LayoverCrewPlanCard } from '../LayoverCrewPlanCard.tsx';

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

const NOW = Date.UTC(2026, 9, 18, 6, 0, 0);
const iso = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

function json(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const PLAN = {
  id: 'plan-1', proposedByYou: true, createdAt: iso(0), certifiedAt: iso(0), feasible: true, reasons: [], split: true,
  branches: [
    { key: 'b1', returnBy: iso(2), stops: [], memberIds: ['me-id'], hiddenMemberCount: 0, includesYou: true, feasible: true, reasons: [], landside: 'not_applicable' },
    { key: 'rest', returnBy: iso(5), stops: [], memberIds: ['ben'], hiddenMemberCount: 1, includesYou: false, feasible: true, reasons: [], landside: 'not_applicable' },
  ],
};

type Route = (url: string, init?: RequestInit) => Response;
function serve(route: Route) {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown, init?: RequestInit) => route(String(input), init));
}

afterEach(() => { jest.restoreAllMocks(); });

describe('LayoverCrewPlanCard — L134 explicit split plans, L135 certified against every member branch', () => {
  it('1a. feature off: the card draws nothing', async () => {
    serve(() => json(200, { ok: true, available: false }));
    await render(<LayoverCrewPlanCard sessionId="s1" timezone="UTC" />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId('layover-crew-plan')).toBeNull();
  });

  it('1b. in no crew: the card draws nothing', async () => {
    serve(() => json(200, { ok: true, available: true, inCrew: false }));
    await render(<LayoverCrewPlanCard sessionId="s1" timezone="UTC" />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId('layover-crew-plan')).toBeNull();
  });

  it('2. a stored split renders BOTH branches with their T and the server\'s per-branch certification', async () => {
    serve(() => json(200, { ok: true, available: true, inCrew: true, plan: PLAN }));
    await render(<LayoverCrewPlanCard sessionId="s1" timezone="UTC" />);
    await waitFor(() => expect(screen.getByTestId('layover-crew-plan-certified')).toBeTruthy());
    expect(screen.getByTestId('layover-crew-plan-branch-b1')).toBeTruthy();
    expect(screen.getByTestId('layover-crew-plan-branch-rest')).toBeTruthy();
    expect(screen.getByText(/Heads back first — back by 08:00/)).toBeTruthy();
    expect(screen.getByText(/Everyone else — back by 11:00/)).toBeTruthy();
    expect(screen.getByText(/1 not showing a profile/)).toBeTruthy();
  });

  it('3. a stored plan the server no longer certifies is shown as NOT certified, with the failing branch\'s reason — never as fine', async () => {
    const stale = { ...PLAN, feasible: false, branches: [PLAN.branches[0], { ...PLAN.branches[1], feasible: false, reasons: ['branch_returns_after_member_deadline'] }] };
    serve(() => json(200, { ok: true, available: true, inCrew: true, plan: stale }));
    await render(<LayoverCrewPlanCard sessionId="s1" timezone="UTC" />);
    await waitFor(() => expect(screen.getByTestId('layover-crew-plan-not-certified')).toBeTruthy());
    expect(screen.getByText('This group would be back later than someone in it must be.')).toBeTruthy();
    expect(screen.queryByTestId('layover-crew-plan-branch-rest-ok')).toBeNull();
  });

  it('4. a branch whose verdict is missing is NOT certified (fail closed)', async () => {
    const odd = { ...PLAN, branches: [PLAN.branches[0], { ...PLAN.branches[1], feasible: undefined }] };
    serve(() => json(200, { ok: true, available: true, inCrew: true, plan: odd }));
    await render(<LayoverCrewPlanCard sessionId="s1" timezone="UTC" />);
    await waitFor(() => expect(screen.getByTestId('layover-crew-plan-not-certified')).toBeTruthy());
  });

  it('5. proposing sends the spec\'s shape — the chosen people back by T1, everyone else by T2 — and shows the stored plan', async () => {
    const posted: unknown[] = [];
    let stored = false;
    serve((url, init) => {
      if (url.endsWith('/crew/plan') && init?.method === 'POST') { posted.push(JSON.parse(String(init.body))); stored = true; return json(200, { ok: true, inCrew: true, available: true, plan: PLAN }); }
      if (url.endsWith('/crew/plan')) return json(200, { ok: true, available: true, inCrew: true, plan: stored ? PLAN : null });
      if (url.endsWith('/crew')) return json(200, { inCrew: true, crew: { memberCount: 3 }, solution: {}, members: [{ id: 'ben', handle: 'ben', name: 'Ben', avatarUrl: null }], degraded: false, degradedReasons: [] });
      return json(404, {});
    });
    await render(<LayoverCrewPlanCard sessionId="s1" timezone="UTC" now={() => NOW} />);
    await waitFor(() => expect(screen.getByLabelText('Propose a split')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Propose a split'));
    await waitFor(() => expect(screen.getByTestId('layover-crew-plan-composer')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Everyone else back by: 15 minutes later'));
    await fireEvent.press(screen.getByLabelText('Propose this split'));
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]).toEqual({
      branches: [{ memberIds: [], includeMe: true, returnBy: iso(1) }],
      rest: { returnBy: new Date(NOW + 2.25 * 3_600_000).toISOString() },
    });
    await waitFor(() => expect(screen.getByTestId('layover-crew-plan-certified')).toBeTruthy());
  });

  it('6. a split the server refuses is NOT saved, and its branch reasons are shown', async () => {
    serve((url, init) => {
      if (url.endsWith('/crew/plan') && init?.method === 'POST') {
        return json(409, { error: 'conflict', reason: 'crew_plan_not_certified', message: 'That split does not fit everyone’s layover. Nothing was saved.', certification: { ...PLAN, id: '', feasible: false, branches: [PLAN.branches[0], { ...PLAN.branches[1], feasible: false, reasons: ['landside_closed_for_member'] }] } });
      }
      if (url.endsWith('/crew/plan')) return json(200, { ok: true, available: true, inCrew: true, plan: null });
      if (url.endsWith('/crew')) return json(200, { inCrew: true, crew: { memberCount: 2 }, solution: {}, members: [], degraded: false, degradedReasons: [] });
      return json(404, {});
    });
    await render(<LayoverCrewPlanCard sessionId="s1" timezone="UTC" now={() => NOW} />);
    await waitFor(() => expect(screen.getByLabelText('Propose a split')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Propose a split'));
    await waitFor(() => expect(screen.getByLabelText('Propose this split')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Propose this split'));
    await waitFor(() => expect(screen.getByTestId('layover-crew-plan-refused')).toBeTruthy());
    expect(screen.getByText('This group leaves the airport, and someone in it may not.')).toBeTruthy();
    expect(screen.getByText(/Nothing was saved/)).toBeTruthy();
  });

  it('7. an unreachable server is a failed read, not "no split" — once the server has said the feature is on; before that, nothing is drawn', async () => {
    const spy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network request failed'));
    const first = await render(<LayoverCrewPlanCard sessionId="s1" timezone="UTC" />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.queryByTestId('layover-crew-plan')).toBeNull();
    expect(screen.queryByTestId('layover-crew-plan-failed')).toBeNull();
    await first.unmount();
    spy.mockReset();
    spy.mockResolvedValueOnce(json(200, { ok: true, available: true, inCrew: true, plan: null })).mockRejectedValue(new TypeError('Network request failed'));
    const view = await render(<LayoverCrewPlanCard sessionId="s1" timezone="UTC" refreshKey={0} />);
    await waitFor(() => expect(screen.getByText(/No split/)).toBeTruthy());
    await view.rerender(<LayoverCrewPlanCard sessionId="s1" timezone="UTC" refreshKey={1} />);
    await waitFor(() => expect(screen.getByTestId('layover-crew-plan-failed')).toBeTruthy());
    expect(screen.queryByText(/No split/)).toBeNull();
  });

  it('8. a 404 from a server without the route draws nothing', async () => {
    serve(() => json(404, { error: 'not_found' }));
    await render(<LayoverCrewPlanCard sessionId="s1" timezone="UTC" />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId('layover-crew-plan')).toBeNull();
    expect(screen.queryByTestId('layover-crew-plan-failed')).toBeNull();
  });
});
