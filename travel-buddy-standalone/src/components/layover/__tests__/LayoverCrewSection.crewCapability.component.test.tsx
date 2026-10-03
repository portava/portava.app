/**
 * §14 / §14.1 — WHAT THE CREW SECTION TELLS A TRAVELLER ABOUT SHARING AND SPLITS.
 *
 * ── THE LOAD-BEARING CASE IS THE DEGRADED ONE ────────────────────────────────
 * Every member reads at the `meeting_point` rung in TWO completely different
 * situations: nobody has shared their location, and the grant table could not be
 * read. The server keeps them apart by reporting `location_grants_unreadable`
 * beside the rungs (`crewPayload`: *"a feature that silently degrades to
 * 'nobody is sharing' looks completely correct while telling the traveller who
 * tapped 'share my location' nothing at all"*).
 *
 * A section that renders the rung list under that reason reports the first fact
 * when the server stated the second, and the traveller acts on it — they stop
 * waiting for a crewmate they believe is not sharing, or they tap share again
 * over a grant that is already live. So case 1 asserts the sentence AND the
 * absence of the rung list; case 2 is its paired positive, so a fix that simply
 * stops rendering rungs altogether fails.
 *
 * ── THE OTHER CASES ──────────────────────────────────────────────────────────
 *  3. The split's per-branch verdict reaches the screen: which group, who is on
 *     it, and which member is short. The roll-up alone said `feasible: false`
 *     with no way to see where.
 *  4. The empty-array request is actually issuable — "go together again" calls
 *     `assignCrewBranches` with `[]`, the server's way back to unsplit.
 *  5. An absent itinerary renders NOTHING rather than "nobody has proposed a
 *     stop yet", because a server that did not publish the block has not said
 *     there are no stops.
 *  6. NO COORDINATE. The rungs are permissions; the payload carries no position
 *     and this section must not imply one.
 *
 * Run: pnpm test:component (Jest)
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

import { LayoverCrewSection } from '../LayoverCrewSection.tsx';
import { fmtClock } from '../layoverFormat.ts';
import {
  assignCrewBranches,
  getLayoverCrew,
  type CrewState,
} from '../../../services/layover.ts';

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

const SESSION = 'sess-crew-ui';

const CREW: CrewState & { inCrew: true } = {
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
      { userId: 'u-1', requiredReturnBy: '2026-10-03T14:00:00.000Z', usableMinutes: 180, returnState: null },
      { userId: 'u-2', requiredReturnBy: '2026-10-03T13:00:00.000Z', usableMinutes: 60, returnState: null },
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
        branchReturnBy: '2026-10-03T13:00:00.000Z',
        bindingMemberIds: ['u-2'],
        neededMinutes: 120,
        usableMinutes: 60,
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
    ],
    maxStopsPerBranch: 12,
  },
  members: [{ id: 'u-2', handle: 'bo', name: 'Bo', avatarUrl: null }],
  locationRungs: [
    { userId: 'u-1', precision: 'precise', reason: 'self' },
    { userId: 'u-2', precision: 'meeting_point', reason: 'no_live_grant:never_granted' },
  ],
  yourShare: { live: false, reason: 'no_live_grant:never_granted', expiresAt: null },
  degraded: false,
  degradedReasons: [],
};

function crewState(overrides: Partial<CrewState & { inCrew: true }> = {}): CrewState {
  return { ...CREW, ...overrides } as CrewState;
}

async function renderSection(state: CrewState) {
  (getLayoverCrew as jest.Mock).mockResolvedValue(state);
  const view = render(<LayoverCrewSection sessionId={SESSION} timezone="Asia/Tokyo" />);
  await waitFor(() => expect(screen.getByText('Ramen run')).toBeTruthy());
  return view;
}

// The service's own wire behaviour is covered against a real fetch in
// src/services/__tests__/layoverCrew.payloadTranscription.component.test.ts.
// NOTE: intentionally exhaustive — a requireActual spread would evaluate
// layover.ts, which imports lib/supabase.ts at module scope and builds a client
// through SecureStoreAdapter. Only the crew surface this section calls is here.
jest.mock('../../../services/layover.ts', () => ({
  getLayoverCrew: jest.fn(),
  createLayoverCrew: jest.fn(),
  joinLayoverCrew: jest.fn(),
  leaveLayoverCrew: jest.fn(),
  proposeCrewStop: jest.fn(),
  removeCrewStop: jest.fn(),
  assignCrewBranches: jest.fn(),
  grantCrewLocation: jest.fn(),
  revokeCrewLocation: jest.fn(),
  CREW_LOCATION_GRANTS_UNREADABLE: 'location_grants_unreadable',
}));

afterEach(() => {
  jest.clearAllMocks();
});

describe('LayoverCrewSection — "could not be read" is never "not sharing"', () => {
  it('1. an unreadable grant table says so, and the rung list is NOT shown as the answer', async () => {
    await renderSection(crewState({
      // The server always sends these three together: it could not read the
      // grants, so it can neither rung anybody nor judge your own share.
      yourShare: null,
      degraded: true,
      degradedReasons: ['location_grants_unreadable'],
    }));

    const notice = screen.getByTestId('crew-location-grants-unreadable');
    expect(notice).toBeTruthy();
    // The sentence must say the state could not be READ. (The viewer's own
    // share is unknown for the same reason, so two lines say it.)
    expect(screen.getAllByText(/could not be read/i).length).toBeGreaterThan(0);
    // And it must not be mistakable for the other fact.
    expect(screen.getByText(/not the same as nobody sharing/i)).toBeTruthy();

    // THE RUNGS ARE SUPPRESSED. Published under this reason, every member reads
    // at `meeting_point` — the same rung an entirely unshared crew sits at — so
    // rendering them here states a fact the server explicitly declined to state.
    expect(screen.queryByTestId('crew-rung-u-2')).toBeNull();
    expect(screen.queryByTestId('crew-rung-u-1')).toBeNull();
  });

  it('2. with the grants readable, the rungs ARE shown — the paired positive', async () => {
    await renderSection(crewState());

    expect(screen.queryByTestId('crew-location-grants-unreadable')).toBeNull();
    expect(screen.getByTestId('crew-rung-u-1')).toBeTruthy();
    expect(screen.getByTestId('crew-rung-u-2')).toBeTruthy();
    // A rung in a traveller's words, and `self` named as "You" (the split
    // editor's roster names the viewer too, hence getAllByText).
    expect(screen.getAllByText('You').length).toBeGreaterThan(0);
    expect(screen.getByText('The meeting point only')).toBeTruthy();
    // THE VIEWER'S OWN ROW IS `precise`/`self` whether or not they have shared
    // anything, so it must not be rendered as a live grant of their own. The
    // toggle below reads `yourShare`; this row only says whose position it is.
    expect(screen.getByText(/Your own position/i)).toBeTruthy();
    expect(screen.queryByText('Sharing their precise location with the crew')).toBeNull();
  });

  it('3. a degrade for a DIFFERENT reason leaves the rungs alone', async () => {
    // `member_cards_unreadable` says nothing about grants. Treating any degrade
    // as an unreadable grant table would hide a sharing state the server did
    // publish — the same confusion in the opposite direction.
    await renderSection(crewState({ degraded: true, degradedReasons: ['member_cards_unreadable'] }));

    expect(screen.queryByTestId('crew-location-grants-unreadable')).toBeNull();
    expect(screen.getByTestId('crew-rung-u-2')).toBeTruthy();
  });
});

describe('LayoverCrewSection — your own share is ONE control with THREE states', () => {
  it('4a. live: offers only "Stop sharing", and shows the SERVER\'s expiry', async () => {
    await renderSection(crewState({
      yourShare: { live: true, reason: 'live_scoped_grant', expiresAt: '2026-10-03T13:30:00.000Z' },
    }));

    expect(screen.getByTestId('crew-your-share-live')).toBeTruthy();
    expect(screen.getByLabelText('Stop sharing my location with this crew')).toBeTruthy();
    // ONE control. The share action must not also be offered while it is live.
    expect(screen.queryByLabelText('Share my location with this crew')).toBeNull();
    // The instant the server published, formatted in the session's zone. A
    // countdown computed here would be a second opinion on a privacy boundary
    // whose ceiling is min(the crew's life, this traveller's certified return).
    // Formatted through the section's own helper in the session's zone, so this
    // asserts the instant the server sent and not a hard-coded locale string.
    const until = fmtClock('2026-10-03T13:30:00.000Z', 'Asia/Tokyo');
    expect(screen.getByText(`You are sharing with this crew until ${until}.`)).toBeTruthy();
  });

  it('4b. not live: offers only "Share my location", naming an actionable terminator', async () => {
    await renderSection(crewState({
      yourShare: { live: false, reason: 'no_live_grant:ttl_elapsed', expiresAt: null },
    }));

    expect(screen.getByTestId('crew-your-share-off')).toBeTruthy();
    expect(screen.getByLabelText('Share my location with this crew')).toBeTruthy();
    expect(screen.queryByLabelText('Stop sharing my location with this crew')).toBeNull();
    expect(screen.getByText('Your last share ran out on its own.')).toBeTruthy();
    // No expiry is rendered for a dead share — a past instant reads as a
    // countdown that has already run out, the same number meaning the opposite.
    expect(screen.queryByText(/until /)).toBeNull();
  });

  it('4c. never_granted is the default state and gets no sentence of its own', async () => {
    await renderSection(crewState());

    expect(screen.getByLabelText('Share my location with this crew')).toBeTruthy();
    // And an unknown terminator is NOT given invented copy.
    expect(screen.queryByText(/ran out on its own|You stopped sharing/)).toBeNull();
  });

  it('4d. UNKNOWN (null) renders as unknown and offers NEITHER action', async () => {
    await renderSection(crewState({
      yourShare: null,
      degraded: true,
      degradedReasons: ['location_grants_unreadable'],
    }));

    expect(screen.getByTestId('crew-your-share-unknown')).toBeTruthy();
    expect(screen.getByText(/cannot tell whether you are sharing/i)).toBeTruthy();
    expect(screen.getAllByText(/could not be read/i).length).toBeGreaterThan(0);
    // NEITHER affordance. A "Share my location" button over an unknown state is
    // this screen answering "no" on the server's behalf — the same class of lie
    // as "nobody is sharing", just about the viewer.
    expect(screen.queryByLabelText('Share my location with this crew')).toBeNull();
    expect(screen.queryByLabelText('Stop sharing my location with this crew')).toBeNull();
    // What it offers instead is a re-read, which claims nothing.
    expect(screen.getByLabelText('Check your location sharing again')).toBeTruthy();
  });

  it('4e. UNKNOWN (field absent) is also unknown, never "not sharing"', async () => {
    const state = crewState();
    // A server that publishes no `yourShare` at all. Distinct from null — it
    // never said it could not tell — and it must land in the same place.
    delete (state as { yourShare?: unknown }).yourShare;
    await renderSection(state);

    expect(screen.getByTestId('crew-your-share-unknown')).toBeTruthy();
    expect(screen.queryByTestId('crew-your-share-off')).toBeNull();
    expect(screen.queryByLabelText('Share my location with this crew')).toBeNull();
    expect(screen.queryByLabelText('Stop sharing my location with this crew')).toBeNull();
    // This one was not a read failure, so it must not claim one.
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });
});

describe('LayoverCrewSection — the split, per branch', () => {
  it('4. each branch carries its own verdict, its people, and who is short', async () => {
    await renderSection(crewState());

    expect(screen.getByTestId('crew-branch-all')).toBeTruthy();
    expect(screen.getByTestId('crew-branch-b')).toBeTruthy();
    // The feasible branch says so; the infeasible one names the shortfall and
    // the member it belongs to, which the plan-level roll-up could not.
    expect(screen.getByTestId('crew-branch-all-fits')).toBeTruthy();
    expect(screen.queryByTestId('crew-branch-b-fits')).toBeNull();
    expect(screen.getByText(/Bo is 60 minutes short/i)).toBeTruthy();
  });

  it('5. "go together again" asks for the EMPTY assignment list', async () => {
    (assignCrewBranches as jest.Mock).mockResolvedValue({
      ok: true,
      state: crewState({ solution: { ...CREW.solution, split: false } }),
    });
    await renderSection(crewState());

    fireEvent.press(screen.getByLabelText('Put the crew back together'));

    await waitFor(() => expect(assignCrewBranches as jest.Mock).toHaveBeenCalledTimes(1));
    // `[]` is the server's way back to unsplit. A UI that treated an empty list
    // as "nothing to send" would leave the crew split with no way out.
    expect(assignCrewBranches as jest.Mock).toHaveBeenCalledWith(SESSION, []);
  });

  it('6. an unsplit crew is offered the split editor and no un-split button', async () => {
    await renderSection(crewState({
      solution: {
        ...CREW.solution,
        split: false,
        branches: [{ ...CREW.solution.branches![0], memberIds: ['u-1', 'u-2'] }],
      },
    }));

    expect(screen.getByLabelText('Split the crew into groups')).toBeTruthy();
    expect(screen.queryByLabelText('Put the crew back together')).toBeNull();
  });
});

describe('LayoverCrewSection — the itinerary, and the absence of one', () => {
  it('7. the crew\'s stops are shown with their proposer and no position', async () => {
    const { toJSON } = await renderSection(crewState());

    expect(screen.getByTestId('crew-itinerary')).toBeTruthy();
    expect(screen.getByTestId('crew-stop-stop-1')).toBeTruthy();
    expect(screen.getByText('Ramen in the old town')).toBeTruthy();
    // The label the proposer typed is a place NAME, which is all the crew
    // tables hold. Nothing coordinate-shaped may reach the screen.
    expect(screen.getByText('Old town')).toBeTruthy();
    expect(screen.getByText('Proposed by You')).toBeTruthy();
    expect(JSON.stringify(toJSON())).not.toMatch(/\b\d{1,3}\.\d{4,}\b/);
  });

  it('8. an ABSENT itinerary renders nothing — not "nobody has proposed a stop yet"', async () => {
    const state = crewState();
    delete (state as { itinerary?: unknown }).itinerary;
    await renderSection(state);

    expect(screen.queryByTestId('crew-itinerary')).toBeNull();
    expect(screen.queryByTestId('crew-itinerary-empty')).toBeNull();
    expect(screen.queryByLabelText('Propose a stop for the crew')).toBeNull();
  });

  it('9. an EMPTY stop list is a measured empty plan and says so', async () => {
    await renderSection(crewState({ itinerary: { stops: [], maxStopsPerBranch: 12 } }));

    expect(screen.getByTestId('crew-itinerary-empty')).toBeTruthy();
    expect(screen.getByLabelText('Propose a stop for the crew')).toBeTruthy();
  });
});
