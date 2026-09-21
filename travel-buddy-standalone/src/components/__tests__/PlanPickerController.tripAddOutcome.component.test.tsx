/**
 * PlanPickerController — the `trip_add` rank outcome.
 *
 * THE DEFECT THIS IS WRITTEN AGAINST
 * ----------------------------------
 * Migration 2894 admits 'trip_add' to rank_events.outcome and
 * routes/rankEvents.ts accepts it at rung 3, but NOTHING in the client sent it:
 * the plan picker added the itinerary row and reported no outcome at all. The
 * one transition `04` §8's chain exists to measure — save → trip_add — could
 * never be observed, and every read of outcome='trip_add' returned zero rows
 * forever while looking exactly like "travellers do not add things to trips".
 *
 * What this pins:
 *   • a COMMITTED add reports trip_add for the source's id, on the surface the
 *     impression was served under
 *   • a source that arrived from no served feed hands the hook a null surface,
 *     so the real hook's gate makes every report a no-op — the controller never
 *     invents a surface
 *   • a FAILED add reports nothing (there is no commitment to record)
 *   • a DUPLICATE add reports nothing — the item was already in the trip, so the
 *     intent was recorded the first time and counting it twice would inflate the
 *     one number this outcome exists to produce
 *
 * The hook itself is mocked here: these tests assert what the controller hands
 * the hook and which report it calls, never the network. The wire body and the
 * null-surface gate are covered by hooks/__tests__/useRankOutcome.component.test.ts.
 *
 * Run with:  pnpm test:component
 */

import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

// ── react-native Proxy mock ───────────────────────────────────────────────────
// Two stubs, both about lifecycles that outlive an assertion:
//
//   Modal — the picker mounts a raw <Modal>, whose animation lifecycle leaves a
//   floating async act() scope that corrupts act depth for every later render.
//
//   Animated — a successful add calls showToast(), which starts a spring AND
//   arms a 2.5 s setTimeout that finishes the toast. That timer necessarily
//   outlives the test: it fires inside whatever suite jest runs next, by which
//   point the torn-down react-native module made `Animated` undefined and the
//   callback threw "Cannot read properties of undefined (reading 'timing')" —
//   failing an unrelated file (ReportSheet) with a stack pointing at this one.
//   Driving the animations to completion synchronously through a plain object
//   captured in this closure means the late callback can never reach a
//   torn-down module.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({ children, visible }: { children?: React.ReactNode; visible?: boolean }) =>
    visible ? R.createElement(actual.View, null, children) : null;
  const MockActivityIndicator = () => null;
  const immediate = () => ({
    start: (cb?: (r: { finished: boolean }) => void) => { if (cb) cb({ finished: true }); },
    stop:  () => {},
    reset: () => {},
  });
  const MockAnimated = Object.assign({}, actual.Animated, {
    timing: immediate,
    spring: immediate,
  });
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') return MockModal;
      if (prop === 'ActivityIndicator') return MockActivityIndicator;
      if (prop === 'Animated') return MockAnimated;
      return Reflect.get(target, prop, receiver);
    },
  });
});

const mockReportTripAdd  = jest.fn();
const mockUseRankOutcome = jest.fn(() => ({
  reportTap:     jest.fn(),
  reportSave:    jest.fn(),
  reportJoin:    jest.fn(),
  reportRsvp:    jest.fn(),
  reportTripAdd: mockReportTripAdd,
}));
// NOTE: intentionally exhaustive — the real hook posts through fetch; what the
// controller hands the hook and which report it calls is the whole subject
// here, so requireActual would replace the observation with a network call.
jest.mock('../../hooks/useRankOutcome.ts', () => ({
  useRankOutcome: (...args: unknown[]) => mockUseRankOutcome(...(args as [])),
}));

const mockAddPlaceToPlan = jest.fn(async () => ({ id: 'item-1' }));
jest.mock('../../features/trips/planning/tripPlan.ts', () => ({
  ...jest.requireActual('../../features/trips/planning/tripPlan.ts'),
  fetchPlanEditableTrips: jest.fn(async () => [
    { id: 'trip-1', title: 'Tokyo, October', destinationCity: 'Tokyo' },
  ]),
  addPlaceToPlan:  (...a: unknown[]) => mockAddPlaceToPlan(...(a as [])),
  addMeetupToPlan: jest.fn(async () => ({ id: 'item-1' })),
  createPlanItem:  jest.fn(async () => ({ id: 'item-1' })),
}));

// NOTE: intentional stub — auth state is a precondition here, not the subject.
jest.mock('../../context/SessionContext.tsx', () => ({
  useSession: () => ({ userId: 'user-1', isAuthed: true }),
}));

// NOTE: intentional stub — insets are irrelevant to outcome reporting.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// NOTE: intentional stub — the native date picker is not under test.
jest.mock('../DateTimePickerField', () => ({ DatePickerField: () => null }));
// NOTE: intentional stub — autopilot lock handling is not under test.
jest.mock('../itinerary/LockTypeSelector.tsx', () => ({ LockTypeSelector: () => null }));

import {
  PlanPickerControllerProvider,
  usePlanPicker,
  type PlanPickerSource,
} from '../PlanPickerController.tsx';

// ── Harness ───────────────────────────────────────────────────────────────────

const DISCOVERY_SOURCE: PlanPickerSource = {
  id:          'node/12345',
  type:        'place',
  title:       'Test Ramen Shop',
  category:    'food',
  rankSurface: 'discovery',
};

/** Opens the picker on mount so the test needs no press to reach step 1. */
function Opener({ source }: { source: PlanPickerSource }) {
  const { open } = usePlanPicker();
  React.useEffect(() => { open(source); }, [open, source]);
  return null;
}

/** Mount, then walk the two steps: pick the trip, confirm the add. */
async function addToTrip(source: PlanPickerSource) {
  const view = await render(
    <PlanPickerControllerProvider>
      <Opener source={source} />
    </PlanPickerControllerProvider>,
  );
  const tripRow = await view.findByText('Tokyo, October');
  fireEvent.press(tripRow);
  const confirm = await view.findByText('Add to Plan');
  fireEvent.press(confirm);
  return view;
}

/** The argument object the controller last constructed the hook with. */
function lastHookArgs(): { surface: unknown; sessionId: unknown } {
  const calls = mockUseRankOutcome.mock.calls;
  return (calls[calls.length - 1] as unknown as [{ surface: unknown; sessionId: unknown }])[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAddPlaceToPlan.mockImplementation(async () => ({ id: 'item-1' }));
});

// ── Tests ─────────────────────────────────────────────────────────────────────

it('a committed add reports trip_add for the source id, on the served surface', async () => {
  await addToTrip(DISCOVERY_SOURCE);

  await waitFor(() => expect(mockReportTripAdd).toHaveBeenCalledTimes(1));
  expect(mockReportTripAdd).toHaveBeenCalledWith('node/12345');
  expect(lastHookArgs().surface).toBe('discovery');
  // GET /discovery returns no session_id; the key must be absent, not invented.
  expect(lastHookArgs().sessionId).toBeNull();
});

it('a source with no served surface hands the hook null — the controller never invents one', async () => {
  const { rankSurface: _dropped, ...unserved } = DISCOVERY_SOURCE;
  await addToTrip(unserved as PlanPickerSource);

  await waitFor(() => expect(mockAddPlaceToPlan).toHaveBeenCalledTimes(1));
  expect(lastHookArgs().surface).toBeNull();
});

it('a failed add reports nothing — there is no commitment to record', async () => {
  mockAddPlaceToPlan.mockImplementation(async () => { throw new Error('500 server exploded'); });
  const view = await addToTrip(DISCOVERY_SOURCE);

  await view.findByText('500 server exploded');
  expect(mockReportTripAdd).not.toHaveBeenCalled();
});

it('a duplicate add reports nothing — the intent was recorded the first time', async () => {
  mockAddPlaceToPlan.mockImplementation(async () => { throw new Error('409 duplicate plan item'); });
  await addToTrip(DISCOVERY_SOURCE);

  await waitFor(() => expect(mockAddPlaceToPlan).toHaveBeenCalledTimes(1));
  expect(mockReportTripAdd).not.toHaveBeenCalled();
});
