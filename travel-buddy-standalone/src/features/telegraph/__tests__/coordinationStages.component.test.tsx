/**
 * Telegraph §9's per-state cells, drawn by the coordination panel —
 * census-telegraph T6 (navigation), T106 (next step, location scope),
 * T107 (Safe Return, shared transport) and T108 (closeout).
 *
 * The server half is `artifacts/api-server/src/services/telegraph/coordinationStages.ts`
 * and its suite; this suite asserts what a person can SEE and DO with it, and
 * the refusal side of each: a control whose action cannot complete is not
 * drawn, a failed write says so, navigation declares nothing, and a closeout
 * put away stays put away.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// NOTE: intentional stub — coordinationApi reaches lib/supabase, which builds a
// client at import time and fails outside an Expo runtime. Labels, affordance
// tables and types are the real ones; only the network calls are replaced.
jest.mock('../coordination/coordinationApi.ts', () => {
  const actual = jest.requireActual('../coordination/coordinationApi.ts');
  return {
    ...actual,
    fetchCoordination: jest.fn(),
    postQuickState: jest.fn(async () => ({ ok: true, data: { id: 'q1' } })),
    postVote: jest.fn(async () => ({ ok: true, data: { id: 'v1' } })),
    proposeSharedRide: jest.fn(async () => ({ ok: true, data: { id: 'p9' } })),
    respondToAction: jest.fn(async () => ({ ok: true, data: { id: 'r9' } })),
  };
});

// NOTE: intentional stub — kindsApi reaches lib/supabase at import time.
jest.mock('../kinds/kindsApi.ts', () => ({
  sendTypedMessage: jest.fn(async () => ({ ok: true, data: { id: 'a1' } })),
}));

// NOTE: intentional stub — the handoff opens the OS maps app through Linking;
// the test asserts WHAT is handed off, which is the panel's decision.
jest.mock('../../../lib/maps.ts', () => ({ openMapsNavigation: jest.fn() }));

// NOTE: intentional stub — the real sheet reaches services/safeReturn (and
// lib/supabase) at import time. The stub renders what the panel passed it.
jest.mock('../../../components/safeReturn/SafeReturnSetupSheet.tsx', () => {
  const { View, Text } = require('react-native');
  return {
    SafeReturnSetupSheet: (p: { visible: boolean; suggestionReason?: string | null }) =>
      p.visible ? (
        <View testID="safe-return-sheet">
          <Text>{p.suggestionReason}</Text>
        </View>
      ) : null,
  };
});

import { CoordinationPanel, closeoutDismissKey, rendezvousDestination } from '../coordination/CoordinationPanel.tsx';
import {
  postQuickState,
  proposeSharedRide,
  respondToAction,
  type CoordinationResponse,
  type SharedRideView,
} from '../coordination/coordinationApi.ts';
import { openMapsNavigation } from '../../../lib/maps.ts';

const mockedPropose = proposeSharedRide as jest.MockedFunction<typeof proposeSharedRide>;
const mockedRespond = respondToAction as jest.MockedFunction<typeof respondToAction>;
const mockedMaps = openMapsNavigation as jest.MockedFunction<typeof openMapsNavigation>;
const mockedQuick = postQuickState as jest.MockedFunction<typeof postQuickState>;

const ME = 'me-1';
const FRIEND = 'friend-2';

function response(over: Partial<CoordinationResponse['coordination']> = {}): CoordinationResponse {
  return {
    coordination: {
      threadId: 't1',
      generatedAt: 'x',
      plan: { objectId: 'plan-1', title: 'Dinner with Marcus', startsAt: 'x', endsAt: 'y', leaveByAt: 'z' },
      state: 'ACTIVE',
      coordinating: true,
      legalNext: [],
      quickStates: [],
      arrivedCount: 0,
      onMyWayCount: 0,
      decisions: [],
      commitments: [],
      rendezvous: [],
      ...over,
    },
    stateProvenance: 'DERIVED_FROM_PLAN_TIMELINE',
    scanned: 1,
  };
}

function ride(over: Partial<SharedRideView> = {}): SharedRideView {
  return {
    proposalId: 'p1',
    proposedBy: FRIEND,
    proposedAt: 'x',
    title: 'Taxi back',
    detail: null,
    riders: [FRIEND],
    declined: [],
    rosterChecked: true,
    ...over,
  };
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
});

describe('T106 — Active: next step and optional location scope', () => {
  it('draws the server’s next step and labels it as a suggestion, not a declaration', async () => {
    await render(
      <CoordinationPanel
        threadId="t1"
        initialResponse={response({
          nextStep: { kind: 'OPEN_DECISION', label: 'Decide: Which bar?', at: null, sourceMessageId: 'd1', provenance: 'DERIVED_FROM_THREAD' },
        })}
      />,
    );
    expect(screen.getByTestId('telegraph-coordination-next-step')).toBeTruthy();
    expect(screen.getByText('Next: Decide: Which bar?')).toBeTruthy();
    expect(screen.getByText('suggested')).toBeTruthy();
  });

  it('an older server that sends no next step draws no next-step row', async () => {
    await render(<CoordinationPanel threadId="t1" initialResponse={response()} />);
    expect(screen.queryByTestId('telegraph-coordination-next-step')).toBeNull();
  });

  it('“Share my location” appears only where the screen can open the location sheet, and opens it', async () => {
    const onShareLocation = jest.fn();
    const { rerender } = await render(
      <CoordinationPanel threadId="t1" initialResponse={response()} onShareLocation={onShareLocation} />,
    );
    await fireEvent.press(screen.getByTestId('telegraph-coordination-share-location'));
    expect(onShareLocation).toHaveBeenCalledTimes(1);

    await rerender(<CoordinationPanel threadId="t1" initialResponse={response()} />);
    expect(screen.queryByTestId('telegraph-coordination-share-location')).toBeNull();
  });
});

describe('T6 — navigation handoff from a meeting point', () => {
  it('“Directions” hands the checkpoint and landmark to the maps app, and declares NOTHING', async () => {
    await render(
      <CoordinationPanel
        threadId="t1"
        initialResponse={response({
          rendezvous: [
            { messageId: 'r1', setBy: FRIEND, at: 'x', payload: { checkpoint: 'Station exit 4', landmark: 'Old Town' } },
          ],
        })}
      />,
    );
    await fireEvent.press(screen.getByTestId('telegraph-rendezvous-directions'));
    expect(mockedMaps).toHaveBeenCalledWith({ name: 'Station exit 4', city: 'Old Town' });
    // §9.1: starting navigation is not "on my way". Nothing is posted.
    expect(mockedQuick).not.toHaveBeenCalled();
  });

  it('a meeting point with no usable checkpoint offers no Directions', async () => {
    expect(rendezvousDestination({ checkpoint: '   ' })).toBeNull();
    expect(rendezvousDestination(null)).toBeNull();
    expect(rendezvousDestination({ checkpoint: 'Pier 2' })).toEqual({ name: 'Pier 2', city: null });
  });
});

describe('T107 — Returning: Safe Return and shared transport', () => {
  it('outside RETURNING there is no getting-back section', async () => {
    await render(<CoordinationPanel threadId="t1" initialResponse={response({ state: 'ACTIVE' })} />);
    expect(screen.queryByTestId('telegraph-coordination-returning')).toBeNull();
  });

  it('“Set up Safe Return” opens the Safe Return sheet, told where the crew is coming back from', async () => {
    await render(<CoordinationPanel threadId="t1" initialResponse={response({ state: 'RETURNING' })} />);
    expect(screen.queryByTestId('safe-return-sheet')).toBeNull();
    await fireEvent.press(screen.getByTestId('telegraph-coordination-safe-return'));
    expect(screen.getByTestId('safe-return-sheet')).toBeTruthy();
    expect(screen.getByText('Heading back from Dinner with Marcus.')).toBeTruthy();
  });

  it('“Share a ride back” posts a SPLIT_RIDE proposal', async () => {
    await render(<CoordinationPanel threadId="t1" initialResponse={response({ state: 'RETURNING' })} />);
    await fireEvent.press(screen.getByTestId('telegraph-coordination-propose-ride'));
    expect(mockedPropose).toHaveBeenCalledWith('t1', 'Share a ride back');
    expect(screen.queryByTestId('telegraph-shared-ride-error')).toBeNull();
  });

  it('a refused proposal SAYS so rather than looking as if it worked', async () => {
    mockedPropose.mockResolvedValueOnce({ ok: false, error: 'forbidden', message: 'You are blocked in this thread.' });
    await render(<CoordinationPanel threadId="t1" initialResponse={response({ state: 'RETURNING' })} />);
    await fireEvent.press(screen.getByTestId('telegraph-coordination-propose-ride'));
    expect(screen.getByTestId('telegraph-shared-ride-error')).toBeTruthy();
    expect(screen.getByText('You are blocked in this thread.')).toBeTruthy();
  });

  it('a ride the viewer is not on offers Join, which CONFIRMS', async () => {
    await render(
      <CoordinationPanel threadId="t1" viewerId={ME} initialResponse={response({ state: 'RETURNING', sharedRides: [ride()] })} />,
    );
    expect(screen.getByText('Taxi back · 1 riding')).toBeTruthy();
    expect(screen.getByText('Join')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('telegraph-shared-ride-answer-p1'));
    expect(mockedRespond).toHaveBeenCalledWith('t1', 'p1', 'CONFIRMED');
  });

  it('a ride the viewer is on offers Leave, which DECLINES', async () => {
    await render(
      <CoordinationPanel
        threadId="t1"
        viewerId={ME}
        initialResponse={response({ state: 'RETURNING', sharedRides: [ride({ riders: [FRIEND, ME] })] })}
      />,
    );
    expect(screen.getByText('Taxi back · 2 riding')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('telegraph-shared-ride-answer-p1'));
    expect(mockedRespond).toHaveBeenCalledWith('t1', 'p1', 'DECLINED');
  });

  it('the proposer gets no join/leave control on their own ride, and an unknown viewer gets none at all', async () => {
    const { rerender } = await render(
      <CoordinationPanel threadId="t1" viewerId={FRIEND} initialResponse={response({ state: 'RETURNING', sharedRides: [ride()] })} />,
    );
    expect(screen.queryByTestId('telegraph-shared-ride-answer-p1')).toBeNull();
    await rerender(
      <CoordinationPanel threadId="t1" initialResponse={response({ state: 'RETURNING', sharedRides: [ride()] })} />,
    );
    expect(screen.queryByTestId('telegraph-shared-ride-answer-p1')).toBeNull();
  });

  it('a ride whose riders could not be re-checked against the roster says so', async () => {
    await render(
      <CoordinationPanel
        threadId="t1"
        viewerId={ME}
        initialResponse={response({ state: 'RETURNING', sharedRides: [ride({ rosterChecked: false })] })}
      />,
    );
    expect(screen.getByText('Who is still in this conversation could not be checked.')).toBeTruthy();
  });
});

describe('T108 — Complete: the closeout', () => {
  const complete = (over: Partial<CoordinationResponse['coordination']> = {}) =>
    response({
      state: 'COMPLETE',
      coordinating: false,
      closeout: {
        planObjectId: 'plan-1',
        title: 'Dinner with Marcus',
        endedAt: 'x',
        offeredUntil: 'y',
        arrivedCount: 3,
        options: ['CREATE_RECAP', 'SAVE_TO_MEMORY', 'DONE'],
      },
      ...over,
    });

  it('a just-completed plan becomes a closeout card with explicit options', async () => {
    const onOpenRecap = jest.fn();
    await render(<CoordinationPanel threadId="t1" initialResponse={complete()} onOpenRecap={onOpenRecap} />);
    expect(await screen.findByTestId('telegraph-closeout')).toBeTruthy();
    expect(screen.getByText('Plan complete')).toBeTruthy();
    expect(screen.getByText('3 said they arrived')).toBeTruthy();
    expect(screen.getByTestId('telegraph-closeout-memory-hint')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('telegraph-closeout-recap'));
    expect(onOpenRecap).toHaveBeenCalledTimes(1);
  });

  it('with no way to open the recap, no recap button is drawn', async () => {
    await render(<CoordinationPanel threadId="t1" initialResponse={complete()} />);
    expect(await screen.findByTestId('telegraph-closeout')).toBeTruthy();
    expect(screen.queryByTestId('telegraph-closeout-recap')).toBeNull();
  });

  it('“Done” puts the closeout away for this plan, and it stays away', async () => {
    const { unmount } = await render(<CoordinationPanel threadId="t1" initialResponse={complete()} />);
    await fireEvent.press(await screen.findByTestId('telegraph-closeout-done'));
    expect(screen.queryByTestId('telegraph-closeout')).toBeNull();
    expect(await AsyncStorage.getItem(closeoutDismissKey('t1', 'plan-1'))).toBe('1');
    await unmount();

    await render(<CoordinationPanel threadId="t1" initialResponse={complete()} />);
    // Give the storage read its turn, then assert nothing came back.
    await screen.findByText(/./, {}, { timeout: 50 }).catch(() => null);
    expect(screen.queryByTestId('telegraph-closeout')).toBeNull();
  });

  it('a COMPLETE plan the server offers no closeout for draws nothing', async () => {
    await render(<CoordinationPanel threadId="t1" initialResponse={complete({ closeout: null })} />);
    await screen.findByText(/./, {}, { timeout: 50 }).catch(() => null);
    expect(screen.queryByTestId('telegraph-closeout')).toBeNull();
    expect(screen.queryByTestId('telegraph-coordination-panel')).toBeNull();
  });
});
