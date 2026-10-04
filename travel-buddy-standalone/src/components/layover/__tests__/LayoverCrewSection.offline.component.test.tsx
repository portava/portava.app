/**
 * census-layover L154 / L294 (C2) — the crew card when the network is not
 * there, and when two reads overlap.
 *
 * `LayoverCrewSection`'s own header says why a failed read matters most here:
 * "'You are in no crew' and 'we could not read your crew' produce the same
 * screen if they are collapsed, and a traveller who believes the first walks
 * away from people who are waiting for them." It renders `null` from
 * `getLayoverCrew` as "Your crew could not be loaded." with a retry — but
 * `getLayoverCrew` had no `try`: an offline `fetch` REJECTED, `refresh()`
 * rejected inside a floated `void`, and the card sat on its spinner for as
 * long as the traveller looked at it, with an unhandled rejection behind it.
 *
 * And the card re-reads on every dashboard refresh (`refreshKey`) as well as
 * after its own actions, so two reads can be in flight at once. The one that
 * answers LAST used to win, whichever one was asked last — so a slow read
 * from before a join could put "you are in no crew" back on the screen.
 *
 * Only `fetch` and the two auth modules beneath the real service are replaced.
 */
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react-native';

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

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const OPEN_CITY = { ok: true, inCrew: false, city: 'Taoyuan', crews: [] };
const IN_CREW = {
  ok: true, inCrew: true,
  crew: {
    id: 'crew-1', title: 'Ramen in the old town', city: 'taoyuan', meetingPointLabel: 'Terminal 2 food court',
    status: 'open', maxMembers: 6, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    youAreOwner: true, memberCount: 1,
  },
  solution: {
    crewVersion: 'v', sharedReturnBy: new Date(Date.now() + 3_600_000).toISOString(), bindingMemberIds: [],
    bindingMemberHidden: false, feasible: true, reasons: [], split: false, members: [],
  },
  members: [], degraded: false, degradedReasons: [],
};

afterEach(() => { jest.restoreAllMocks(); });

describe('LayoverCrewSection — an unreachable server is a failed read, not a spinner', () => {
  it('1. an offline device gets "could not be loaded" and a retry — not an endless spinner', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network request failed'));
    await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" />);
    await waitFor(() => expect(screen.getByText('Your crew could not be loaded.')).toBeTruthy());
    expect(screen.getByLabelText('Retry loading your crew')).toBeTruthy();
  });

  it('2. an unparseable 200 is a failed read too', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); },
    } as unknown as Response);
    await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" />);
    await waitFor(() => expect(screen.getByText('Your crew could not be loaded.')).toBeTruthy());
  });

  it('3. CONTROL: a crew read renders the crew', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, IN_CREW));
    await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" />);
    await waitFor(() => expect(screen.getByText('Ramen in the old town')).toBeTruthy());
  });
});

describe('LayoverCrewSection — the newest read wins, not the slowest', () => {
  it('4. a slow read asked FIRST cannot overwrite the answer to the read asked LAST', async () => {
    const first = deferred<Response>();
    const spy = jest.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => first.promise)                               // mount read (slow)
      .mockImplementationOnce(async () => jsonResponse(200, IN_CREW));            // refresh read (fast)

    const view = await render(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" refreshKey={0} />);
    await view.rerender(<LayoverCrewSection sessionId="sess-1" timezone="Asia/Taipei" refreshKey={1} />);
    await waitFor(() => expect(screen.getByText('Ramen in the old town')).toBeTruthy());
    expect(spy).toHaveBeenCalledTimes(2);

    // The mount read finally answers, with the state from BEFORE the crew existed.
    await act(async () => { first.resolve(jsonResponse(200, OPEN_CITY)); await first.promise; });

    expect(screen.getByText('Ramen in the old town')).toBeTruthy();
    expect(screen.queryByText(/No crews here yet/)).toBeNull();
  });
});
