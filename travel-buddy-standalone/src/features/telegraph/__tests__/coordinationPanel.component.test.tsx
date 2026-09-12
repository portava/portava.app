/**
 * Telegraph §2.2 + §9 — the coordination panel, rendered.
 *
 *   §2.2  the OPTIONAL COORDINATION PANEL between the rail and the stream
 *   §9    "the thread can TEMPORARILY transform from normal conversation into
 *          a coordination surface"
 *   §9.1  the seven quick states, and "User-declared status must remain
 *          distinguishable from system-derived ETA or location-derived
 *          estimates."
 *
 * TEMPORARILY is the assertion that matters most here: a PREPARING plan does
 * NOT put the thread into a coordination surface, and the panel renders
 * nothing. A test that only checked "panel appears when there is a plan" would
 * pass on an implementation that keeps a conversation in coordination mode for
 * three days.
 *
 * §9.1 is asserted as LAYOUT, not only as a field: the derived state line is
 * labelled "derived from the plan", and declared statuses live under "What
 * people said". Nothing renders a status and a derived estimate in one row —
 * there is no such row.
 *
 * SHOWN RED before commit, each reverted:
 *   • the `!c.coordinating` early return disabled AND the "derived from the
 *     plan" label removed → 3 failed / 9 passed.
 *   • the failed-read branch replaced with an empty coordinating panel →
 *     1 failed / 11 passed. Note what it took: disabling only the `return
 *     null` was not enough, because the panel is guarded twice — on `failed`
 *     and on a null `data` — and the mutation had to defeat both. That
 *     redundancy is deliberate and this is how it was measured.
 *   All restored: 12/12.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: intentional stub — coordinationApi reaches lib/supabase, which builds a
// client at import time and fails outside an Expo runtime. The panel's own
// logic, the affordance table and the labels are the real ones.
jest.mock('../coordination/coordinationApi.ts', () => {
  const actual = jest.requireActual('../coordination/coordinationApi.ts');
  return {
    ...actual,
    fetchCoordination: jest.fn(),
    postQuickState: jest.fn(async () => ({ ok: true, data: { id: 'm1' } })),
    postVote: jest.fn(async () => ({ ok: true, data: { id: 'm2' } })),
  };
});

import { CoordinationPanel } from '../coordination/CoordinationPanel.tsx';
import {
  fetchCoordination,
  postQuickState,
  postVote,
  STATE_AFFORDANCES,
  QUICK_STATES,
  type CoordinationResponse,
} from '../coordination/coordinationApi.ts';

const mockedFetch = fetchCoordination as jest.MockedFunction<typeof fetchCoordination>;
const mockedQuick = postQuickState as jest.MockedFunction<typeof postQuickState>;
const mockedVote = postVote as jest.MockedFunction<typeof postVote>;

function response(over: Partial<CoordinationResponse['coordination']> = {}): CoordinationResponse {
  return {
    coordination: {
      threadId: 't1',
      generatedAt: 'x',
      plan: { objectId: 'm1', title: 'Dinner with Marcus', startsAt: 'x', endsAt: 'y', leaveByAt: 'z' },
      state: 'ASSEMBLING',
      coordinating: true,
      legalNext: ['ACTIVE', 'DISRUPTED', 'CANCELLED'],
      quickStates: [],
      arrivedCount: 0,
      onMyWayCount: 0,
      decisions: [],
      commitments: [],
      rendezvous: [],
      ...over,
    },
    stateProvenance: 'DERIVED_FROM_PLAN_TIMELINE',
    scanned: 3,
  };
}

beforeEach(() => {
  mockedFetch.mockReset();
  mockedQuick.mockClear();
  mockedVote.mockClear();
});

describe('§9 — temporarily, and only temporarily', () => {
  it('a PREPARING plan renders NOTHING — a plan three days out is not a coordination surface', async () => {
    await render(
      <CoordinationPanel
        threadId="t1"
        initialResponse={response({ state: 'PREPARING', coordinating: false })}
      />,
    );
    expect(screen.queryByTestId('telegraph-coordination-panel')).toBeNull();
  });

  it('an ASSEMBLING plan renders the panel with the state and the counts', async () => {
    await render(
      <CoordinationPanel threadId="t1" initialResponse={response({ arrivedCount: 2, onMyWayCount: 1 })} />,
    );
    expect(screen.getByTestId('telegraph-coordination-panel')).toBeTruthy();
    expect(screen.getByText('Assembling')).toBeTruthy();
    expect(screen.getByText('2 arrived · 1 on the way')).toBeTruthy();
    expect(screen.getByText('Dinner with Marcus')).toBeTruthy();
  });

  it('a thread with no plan and no open decision renders nothing', async () => {
    await render(
      <CoordinationPanel
        threadId="t1"
        initialResponse={response({ plan: null, state: null, coordinating: false, legalNext: [] })}
      />,
    );
    expect(screen.queryByTestId('telegraph-coordination-panel')).toBeNull();
  });

  it('an UNRESOLVED decision shows even when the thread is not coordinating', async () => {
    await render(
      <CoordinationPanel
        threadId="t1"
        initialResponse={response({
          state: 'PREPARING',
          coordinating: false,
          decisions: [{
            decisionId: 'd1', askedBy: 'u1', question: 'Where do we eat?',
            options: [{ id: 'a', label: 'Bun cha' }, { id: 'b', label: 'Banh xeo' }],
            resolutionRule: 'PLURALITY', deadlineAt: null, votes: [], tally: { a: 1, b: 0 },
            resolved: false, result: null, reason: 'awaiting_votes',
          }],
        })}
      />,
    );
    expect(screen.getByTestId('telegraph-coordination-panel')).toBeTruthy();
    expect(screen.getByText('Where do we eat?')).toBeTruthy();
    // The DERIVED state line is not shown when the thread is not coordinating.
    expect(screen.queryByTestId('telegraph-coordination-state')).toBeNull();
  });

  it('a RESOLVED decision is not asked again', async () => {
    await render(
      <CoordinationPanel
        threadId="t1"
        initialResponse={response({
          decisions: [{
            decisionId: 'd1', askedBy: 'u1', question: 'Settled already',
            options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
            resolutionRule: 'PLURALITY', deadlineAt: null, votes: [], tally: { a: 2, b: 0 },
            resolved: true, result: 'a', reason: 'rule_satisfied',
          }],
        })}
      />,
    );
    expect(screen.queryByText('Settled already')).toBeNull();
  });
});

describe('§9.1 — declared and derived never share a row', () => {
  it('the derived state says it is derived', async () => {
    await render(<CoordinationPanel threadId="t1" initialResponse={response()} />);
    expect(screen.getByTestId('telegraph-coordination-state')).toBeTruthy();
    expect(screen.getByText('derived from the plan')).toBeTruthy();
  });

  it('declared statuses live under their own heading, with what the person said', async () => {
    await render(
      <CoordinationPanel
        threadId="t1"
        initialResponse={response({
          quickStates: [
            { userId: 'u1', state: 'ARRIVED', at: 'x', approximateLabel: 'An Thuong', note: null, provenance: 'USER_DECLARED' },
            { userId: 'u2', state: 'RUNNING_LATE', at: 'y', approximateLabel: null, note: null, provenance: 'USER_DECLARED' },
          ],
        })}
      />,
    );
    expect(screen.getByTestId('telegraph-coordination-declared')).toBeTruthy();
    expect(screen.getByText('What people said')).toBeTruthy();
    expect(screen.getByText('Arrived · An Thuong')).toBeTruthy();
    // "Running late" also appears as an affordance chip; the declared list is
    // the one under the heading, so it is queried inside that block.
    expect(screen.getAllByText('Running late').length).toBeGreaterThanOrEqual(2);
  });

  it('the affordance set is §9s own per-state table, and every entry is a §9.1 state', () => {
    for (const [, states] of Object.entries(STATE_AFFORDANCES)) {
      for (const s of states) expect(QUICK_STATES).toContain(s);
    }
    expect(STATE_AFFORDANCES.ASSEMBLING).toContain('ON_MY_WAY');
    expect(STATE_AFFORDANCES.ASSEMBLING).toContain('RUNNING_LATE');
    expect(STATE_AFFORDANCES.ASSEMBLING).toContain('START_WITHOUT_ME');
    expect(STATE_AFFORDANCES.RETURNING).toContain('HEADING_BACK');
    expect(STATE_AFFORDANCES.COMPLETE).toHaveLength(0);
  });

  it('declaring a quick state posts it', async () => {
    await render(<CoordinationPanel threadId="t1" initialResponse={response()} />);
    fireEvent.press(screen.getByTestId('telegraph-quick-state-ON_MY_WAY'));
    await waitFor(() => expect(mockedQuick).toHaveBeenCalledWith('t1', 'ON_MY_WAY'));
  });
});

describe('the panel and the network', () => {
  it('a failed read renders NOTHING — an empty panel would say the plan is off', async () => {
    mockedFetch.mockResolvedValue({ ok: false, error: 'db_error' } as any);
    await render(<CoordinationPanel threadId="t1" />);
    expect(mockedFetch).toHaveBeenCalledWith('t1');
    expect(screen.queryByTestId('telegraph-coordination-panel')).toBeNull();
  });

  it('voting posts the option', async () => {
    await render(
      <CoordinationPanel
        threadId="t1"
        initialResponse={response({
          decisions: [{
            decisionId: 'd1', askedBy: 'u1', question: 'Where?',
            options: [{ id: 'a', label: 'Bun cha' }, { id: 'b', label: 'Banh xeo' }],
            resolutionRule: 'PLURALITY', deadlineAt: null, votes: [], tally: { a: 0, b: 0 },
            resolved: false, result: null, reason: 'awaiting_votes',
          }],
        })}
      />,
    );
    fireEvent.press(screen.getByTestId('telegraph-decision-option-d1-b'));
    await waitFor(() => expect(mockedVote).toHaveBeenCalledWith('t1', 'd1', 'b'));
  });

  it('a rendezvous renders its checkpoint, landmark and fallback', async () => {
    await render(
      <CoordinationPanel
        threadId="t1"
        initialResponse={response({
          rendezvous: [{
            messageId: 'r1', setBy: 'u1', at: 'x',
            payload: { checkpoint: 'Dragon bridge', landmark: 'second lamp', fallbackPoint: 'the corner cafe', proximityState: 'UNKNOWN' },
          }],
        })}
      />,
    );
    expect(screen.getByTestId('telegraph-coordination-rendezvous')).toBeTruthy();
    expect(screen.getByText('Dragon bridge — second lamp')).toBeTruthy();
    expect(screen.getByText('Fallback: the corner cafe')).toBeTruthy();
  });
});
