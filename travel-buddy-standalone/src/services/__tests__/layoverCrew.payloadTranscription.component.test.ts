/**
 * §14.1 — THE CREW PAYLOAD THIS CLIENT ACTUALLY TRANSCRIBES.
 *
 * The crew wire grew three blocks the client had never heard of: per-branch
 * feasibility (`solution.branches`), the crew's own itinerary (`itinerary`), and
 * §14's disclosure rung per member (`locationRungs`). While `getLayoverCrew`
 * was `res.json() as CrewState`, every one of them arrived and nothing read
 * them — a cast types a field it never checks, so a screen rendering a block
 * "only when present" looks perfectly correct against a server that never sends
 * it and against one that does.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 *  1. A full payload must survive field for field. A transcription that drops
 *     `perMemberSlackMin`, `proposedBy` or `maxStopsPerBranch` passes a cast and
 *     fails here.
 *  2. ABSENT IS NOT EMPTY. A server that publishes no `itinerary` has said
 *     nothing about the crew's plan; one that publishes `stops: []` has said
 *     there are none. The two must stay distinguishable on this side of the
 *     wire, because the first must not render as "nobody has proposed a stop".
 *  3. THE EMPTY-ARRAY SPLIT MUST REACH THE SERVER. `{ assignments: [] }` is
 *     `assignCrewBranches`'s way back to unsplit, not a bad argument. A client
 *     that screens an empty list out as "nothing to send" — which a truthiness
 *     check on the body does — leaves a split crew permanently split.
 *  4. A refusal stays a refusal, carrying the route's own sentence.
 *
 * Run: pnpm test:component (Jest)
 */

// NOTE: intentionally exhaustive — requireActual on lib/supabase.ts constructs a
// real Supabase client through SecureStoreAdapter, which needs native modules.
jest.mock('../../lib/supabase.ts', () => ({
  supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: null } })) } },
  isSupabaseConfigured: true,
}));

// NOTE: intentionally exhaustive — apiToken.ts imports lib/supabase.ts at module
// scope; a requireActual spread would defeat the mock above.
jest.mock('../apiToken.ts', () => ({
  freshToken: jest.fn(async () => 'test-token'),
}));

import {
  assignCrewBranches,
  getLayoverCrew,
  grantCrewLocation,
  proposeCrewStop,
  removeCrewStop,
  revokeCrewLocation,
} from '../layover.ts';

const SESSION = 'sess-crew-1';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** A crew payload with everything `crewPayload` now publishes. */
function fullCrewBody() {
  return {
    ok: true,
    inCrew: true,
    crew: {
      id: 'crew-1',
      title: 'Ramen run',
      city: 'Tokyo',
      meetingPointLabel: 'Terminal 2 food court',
      status: 'open',
      maxMembers: 6,
      expiresAt: '2026-10-03T14:00:00.000Z',
      youAreOwner: true,
      memberCount: 2,
    },
    solution: {
      crewVersion: '2026.09.08-1',
      sharedReturnBy: '2026-10-03T13:00:00.000Z',
      bindingMemberIds: ['u-2'],
      feasible: false,
      reasons: ['plan_exceeds_usable_minutes'],
      split: true,
      members: [
        { userId: 'u-1', requiredReturnBy: '2026-10-03T14:00:00.000Z', usableMinutes: 180, returnState: 'green' },
        { userId: 'u-2', requiredReturnBy: '2026-10-03T13:00:00.000Z', usableMinutes: 60, returnState: 'amber' },
      ],
      branches: [
        {
          branchId: 'all',
          memberIds: ['u-1'],
          branchReturnBy: '2026-10-03T14:00:00.000Z',
          bindingMemberIds: ['u-1'],
          neededMinutes: 90,
          usableMinutes: 180,
          feasible: true,
          reasons: [],
          perMemberSlackMin: [{ userId: 'u-1', slackMin: 90 }],
        },
        {
          branchId: 'b',
          memberIds: ['u-2'],
          branchReturnBy: null,
          bindingMemberIds: [],
          neededMinutes: 120,
          usableMinutes: null,
          feasible: false,
          reasons: ['plan_exceeds_usable_minutes'],
          perMemberSlackMin: [{ userId: 'u-2', slackMin: -60 }],
        },
      ],
    },
    itinerary: {
      stops: [
        {
          id: 'stop-1',
          branchId: 'all',
          title: 'Ramen in the old town',
          durationMin: 60,
          travelMin: 30,
          insideAirport: false,
          locationLabel: 'Old town',
          proposedBy: 'u-1',
        },
        {
          id: 'stop-2',
          branchId: 'b',
          title: 'Observation deck',
          durationMin: 90,
          travelMin: 0,
          insideAirport: true,
          locationLabel: null,
          proposedBy: 'u-2',
        },
      ],
      maxStopsPerBranch: 12,
    },
    members: [{ id: 'u-2', handle: 'bo', name: 'Bo', avatarUrl: null }],
    locationRungs: [
      { userId: 'u-1', precision: 'precise', reason: 'self' },
      { userId: 'u-2', precision: 'meeting_point', reason: 'no_live_grant:never_granted' },
    ],
    yourShare: {
      live: true,
      reason: 'live_scoped_grant',
      expiresAt: '2026-10-03T13:30:00.000Z',
    } as { live: boolean; reason: string; expiresAt: string | null } | null,
    degraded: false,
    degradedReasons: [],
  };
}

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('getLayoverCrew — the branches and the itinerary come off the wire', () => {
  it('1. transcribes solution.branches field for field, nulls included', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, fullCrewBody()));

    const state = await getLayoverCrew(SESSION);

    expect(state).not.toBeNull();
    if (!state || !state.inCrew) throw new Error('unreachable — asserted above');
    expect(state.solution.split).toBe(true);
    expect(state.solution.branches).toHaveLength(2);

    const [first, second] = state.solution.branches!;
    expect(first.branchId).toBe('all');
    expect(first.memberIds).toEqual(['u-1']);
    expect(first.branchReturnBy).toBe('2026-10-03T14:00:00.000Z');
    expect(first.bindingMemberIds).toEqual(['u-1']);
    expect(first.neededMinutes).toBe(90);
    expect(first.usableMinutes).toBe(180);
    expect(first.feasible).toBe(true);
    expect(first.perMemberSlackMin).toEqual([{ userId: 'u-1', slackMin: 90 }]);

    // An UNCERTIFIED branch. Null must arrive as null — a client that
    // substituted the crew's shared time here would publish a later deadline
    // than the truth, the one direction a safety minimum must not move.
    expect(second.branchReturnBy).toBeNull();
    expect(second.usableMinutes).toBeNull();
    expect(second.feasible).toBe(false);
    expect(second.reasons).toEqual(['plan_exceeds_usable_minutes']);
    expect(second.perMemberSlackMin).toEqual([{ userId: 'u-2', slackMin: -60 }]);
  });

  it('2. transcribes the itinerary, its proposer attribution and the server ceiling', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, fullCrewBody()));

    const state = await getLayoverCrew(SESSION);
    if (!state || !state.inCrew) throw new Error('unreachable');

    expect(state.itinerary).toBeDefined();
    expect(state.itinerary!.maxStopsPerBranch).toBe(12);
    expect(state.itinerary!.stops).toHaveLength(2);
    expect(state.itinerary!.stops[0]).toEqual({
      id: 'stop-1',
      branchId: 'all',
      title: 'Ramen in the old town',
      durationMin: 60,
      travelMin: 30,
      insideAirport: false,
      locationLabel: 'Old town',
      proposedBy: 'u-1',
    });
    // `proposedBy` is the whole reason the itinerary is discussable. A
    // transcription that drops it passes every other assertion here.
    expect(state.itinerary!.stops[1].proposedBy).toBe('u-2');
  });

  it('3. transcribes locationRungs — a rung and a reason, and NO position', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, fullCrewBody()));

    const state = await getLayoverCrew(SESSION);
    if (!state || !state.inCrew) throw new Error('unreachable');

    expect(state.locationRungs).toEqual([
      { userId: 'u-1', precision: 'precise', reason: 'self' },
      { userId: 'u-2', precision: 'meeting_point', reason: 'no_live_grant:never_granted' },
    ]);
    // The server publishes permission, never a place. Nothing coordinate-shaped
    // may appear on a rung, now or after a careless widening of this type.
    for (const rung of state.locationRungs ?? []) {
      expect(Object.keys(rung).sort()).toEqual(['precision', 'reason', 'userId']);
    }
  });

  it('4. an ABSENT itinerary stays absent — it is not an empty plan', async () => {
    const body = fullCrewBody() as Record<string, unknown>;
    delete body.itinerary;
    delete body.locationRungs;
    delete body.yourShare;
    delete (body.solution as Record<string, unknown>).branches;
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, body));
    // The absence is announced rather than smoothed; silence it so the run is
    // readable, and assert it happened.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const state = await getLayoverCrew(SESSION);
    if (!state || !state.inCrew) throw new Error('unreachable');

    expect(state.itinerary).toBeUndefined();
    expect(state.locationRungs).toBeUndefined();
    expect(state.solution.branches).toBeUndefined();
    expect('yourShare' in state).toBe(false);
    // The fields the older payload DID carry still arrive.
    expect(state.solution.sharedReturnBy).toBe('2026-10-03T13:00:00.000Z');
    expect(state.solution.members).toHaveLength(2);
    expect(warn).toHaveBeenCalled();
  });

  it('5. an EMPTY stops array is a measured empty plan, which is not the same thing', async () => {
    const body = fullCrewBody();
    body.itinerary = { stops: [], maxStopsPerBranch: 12 };
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, body));

    const state = await getLayoverCrew(SESSION);
    if (!state || !state.inCrew) throw new Error('unreachable');

    expect(state.itinerary).toBeDefined();
    expect(state.itinerary!.stops).toEqual([]);
  });

  it('5a. yourShare arrives judged — live, with the server\'s expiry', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, fullCrewBody()));

    const state = await getLayoverCrew(SESSION);
    if (!state || !state.inCrew) throw new Error('unreachable');

    expect(state.yourShare).toEqual({
      live: true,
      reason: 'live_scoped_grant',
      expiresAt: '2026-10-03T13:30:00.000Z',
    });
  });

  it('5b. a dead share carries its terminator and NO expiry', async () => {
    const body = fullCrewBody();
    body.yourShare = { live: false, reason: 'no_live_grant:ttl_elapsed', expiresAt: null };
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, body));

    const state = await getLayoverCrew(SESSION);
    if (!state || !state.inCrew) throw new Error('unreachable');

    expect(state.yourShare).toEqual({
      live: false,
      reason: 'no_live_grant:ttl_elapsed',
      expiresAt: null,
    });
    // A past expiry on a dead grant would read as a countdown that has already
    // run out — the same number meaning the opposite thing. Nothing invents one.
    expect(state.yourShare!.expiresAt).toBeNull();
  });

  it('5c. PRESENT-AND-NULL and ABSENT are different, and neither is "not sharing"', async () => {
    // `null`: the server told us it could not tell. It always travels with the
    // degrade reason, and it must stay null rather than become `{ live: false }`.
    const unreadable = fullCrewBody();
    unreadable.yourShare = null;
    unreadable.degraded = true;
    (unreadable.degradedReasons as string[]) = ['location_grants_unreadable'];
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, unreadable));

    const read = await getLayoverCrew(SESSION);
    if (!read || !read.inCrew) throw new Error('unreachable');
    expect('yourShare' in read).toBe(true);
    expect(read.yourShare).toBeNull();
    expect(read.degradedReasons).toContain('location_grants_unreadable');

    // Absent: a server that publishes no such field. The KEY must be gone, not
    // merely hold undefined, so a screen can tell the two apart.
    const old = fullCrewBody() as Record<string, unknown>;
    delete old.yourShare;
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, old));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const legacy = await getLayoverCrew(SESSION);
    if (!legacy || !legacy.inCrew) throw new Error('unreachable');
    expect('yourShare' in legacy).toBe(false);
    // Absence is the contract mismatch and is announced; a deliberate null is not.
    expect(warn.mock.calls.flat().join(' ')).toMatch(/yourShare/);
  });

  it('6. a non-ok read is null — never "you are in no crew"', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(503, { error: 'degraded_unavailable', message: 'Your crew could not be loaded. Please try again.' }),
    );

    expect(await getLayoverCrew(SESSION)).toBeNull();
  });
});

describe('assignCrewBranches — an empty array is the way back to unsplit', () => {
  it('7. sends { assignments: [] } on the branches route as a PUT', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { ...fullCrewBody(), solution: { ...fullCrewBody().solution, split: false } }));

    const outcome = await assignCrewBranches(SESSION, []);

    expect(outcome.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.test/api/airport/sessions/${SESSION}/crew/branches`);
    expect(init.method).toBe('PUT');
    // The body must be PRESENT and must carry the empty list. A truthiness
    // check on the body — the shape the crew helper had before this — drops it
    // and leaves a split crew split forever.
    expect(init.body).toBe(JSON.stringify({ assignments: [] }));
  });

  it('8. sends a real split unchanged, one branch id per member', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, fullCrewBody()));

    await assignCrewBranches(SESSION, [
      { userId: 'u-1', branchId: 'all' },
      { userId: 'u-2', branchId: 'b' },
    ]);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      assignments: [
        { userId: 'u-1', branchId: 'all' },
        { userId: 'u-2', branchId: 'b' },
      ],
    });
  });

  it('9. a refusal carries the route\'s own sentence, not one invented here', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(400, { error: 'invalid_payload', message: 'That split names somebody who is not in your crew.' }),
    );

    const outcome = await assignCrewBranches(SESSION, [{ userId: 'nobody', branchId: 'b' }]);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.message).toBe('That split names somebody who is not in your crew.');
  });
});

describe('the itinerary and grant calls use the routes and verbs the server serves', () => {
  it('10. proposeCrewStop POSTs the stop, omitting travelMin for an airside stop', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, fullCrewBody()));

    await proposeCrewStop(SESSION, {
      title: 'Observation deck',
      durationMin: 90,
      insideAirport: true,
      branchId: 'all',
    });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.test/api/airport/sessions/${SESSION}/crew/stops`);
    expect(init.method).toBe('POST');
    const sent = JSON.parse(String(init.body));
    expect(sent).toEqual({ title: 'Observation deck', durationMin: 90, insideAirport: true, branchId: 'all' });
    // Airside: the server sets the zero because the zero is a fact there. A
    // client-sent `travelMin: 0` is a STATED zero and is a different claim.
    expect('travelMin' in sent).toBe(false);
  });

  it('11. removeCrewStop DELETEs the stop by id', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, fullCrewBody()));

    await removeCrewStop(SESSION, 'stop-1');

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.test/api/airport/sessions/${SESSION}/crew/stops/stop-1`);
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  it('12. the grant is POSTed with NO expiry — the server derives the ceiling', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, fullCrewBody()));

    await grantCrewLocation(SESSION);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.test/api/airport/sessions/${SESSION}/crew/location-grant`);
    expect(init.method).toBe('POST');
    // No duration is chosen anywhere on this client. `boundedGrantWindow` takes
    // min(crew expiry, your certified hard return) and there is no asking for
    // longer; a figure sent from here could only be the wrong one.
    expect(init.body).toBeUndefined();
  });

  it('13. the revoke DELETEs, and a failed revoke is reported rather than smoothed', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(500, {
        error: 'db_error',
        message: 'Your location share could not be stopped. It is still live — please try again.',
      }),
    );

    const outcome = await revokeCrewLocation(SESSION);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.test/api/airport/sessions/${SESSION}/crew/location-grant`);
    expect(init.method).toBe('DELETE');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    // The share is STILL LIVE. A traveller shown "sharing stopped" here has
    // been told the one thing they must not be told.
    expect(outcome.message).toMatch(/still live/i);
  });
});
