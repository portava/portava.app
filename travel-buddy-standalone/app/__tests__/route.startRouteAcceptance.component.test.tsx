/**
 * route.startRouteAcceptance.component.test.tsx
 *
 * THE DEFECT THIS PINS
 * --------------------
 * "Start Route" is the act that means the traveller is actually doing the route.
 * It used to be `setRouteStarted(true)` and nothing else: the canonical endpoint
 * POST /api/route-plans/:id/accept had ZERO callers, so no plan ever reached
 * status='active'. Two Map layers read only active plans — §36 traveler_flow and
 * the §10 crowd_flow accepted_plan family — so both were starved by one missing
 * client call, while the UI happily showed a started route.
 *
 * That is the shape being guarded here: CLIENT-ONLY CANONICAL STATE. The screen
 * must not present a started route unless the server actually accepted it.
 *
 * A render test, not a source assertion: the whole failure was that the visible
 * state and the server state disagreed, and only rendering shows that.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

let mockAcceptCalls = 0;
let mockAcceptShouldFail = false;

// NOTE: exhaustive by design — acceptRoutePlan is the boundary under test, so it
// must be driven per-case rather than reaching a real server.
jest.mock('../../src/services/routePlan', () => ({
  acceptRoutePlan: async (id: string) => {
    mockAcceptCalls++;
    if (mockAcceptShouldFail) throw new Error('server refused');
    return { id, status: 'active', acceptedAt: '2026-09-06T00:00:00Z', alreadyAccepted: false };
  },
  completeRoutePlan: async (id: string) => ({ id, status: 'completed', acceptedAt: null }),
  joinRoutePlan: async () => ({}),
  leaveRoutePlan: async () => ({}),
}));

// NOTE: exhaustive by design — the screen only needs a loaded plan with one stop;
// the real hook fetches over the network.
jest.mock('../../src/hooks/useRoutePlan', () => ({
  useRoutePlan: () => ({
    // The hook returns `plan`; the screen aliases it to fullPlan.
    plan: {
      // FullRoutePlan = { plan, stops, legs } — the screen reads fullPlan.plan.*
      plan: {
        id: 'plan-1', title: 'Test Route', status: 'draft', ownerUserId: 'u1',
        tripAccommodationLocation: null, endLocation: null, startLocation: null,
        routeStyle: 'custom', isApproximated: true, compassExplanation: null,
      },
      stops: [{ id: 's1', title: 'Stop One', checkpointStatus: 'pending', location: null, orderIndex: 0 }],
      legs: [],
    },
    loading: false,
    error: null,
    markArrived: jest.fn(),
    skipStop: jest.fn(),
    patchStop: jest.fn(),
    refresh: jest.fn(),
    completedCount: 0,
    totalCount: 1,
    progressFraction: 0,
    nextStop: null,
    memberProgress: null,
  }),
}));

// NOTE: exhaustive by design — map rendering needs native GL modules.
jest.mock('../../src/components/RouteMinimapView', () => ({ RouteMinimapView: () => null }));
// NOTE: exhaustive by design — modal pulls in the full map stack.
jest.mock('../../src/components/RouteFullMapModal', () => ({ RouteFullMapModal: () => null }));
// NOTE: exhaustive by design — sheet pulls in the safe-return service chain.
jest.mock('../../src/components/safeReturn/SafeReturnSetupSheet', () => ({ SafeReturnSetupSheet: () => null }));
// NOTE: exhaustive by design — network call unrelated to the acceptance boundary.
jest.mock('../../src/services/compass', () => ({ postCompassAsk: async () => ({}) }));
// NOTE: exhaustive by design — auth state is a precondition, not the subject.
jest.mock('../../src/context/SessionContext', () => ({
  useSession: () => ({ isAuthed: true, loading: false, configured: true }),
}));
// NOTE: exhaustive by design — a real provider needs device geolocation.
jest.mock('../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    locationState: { permissionStatus: 'granted', place: { city: null } },
    resolvedLocation: { place: { city: null } },
    requestLocation: async () => {},
  }),
}));
// NOTE: exhaustive by design — scroll/inset hooks need a native host view.
jest.mock('../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => ({ onScroll: () => {} }),
  navBarProgress: { value: 0 },
}));
// NOTE: exhaustive by design — same reason.
jest.mock('../../src/hooks/useBottomInset', () => ({ useStickyBarInset: () => 0 }));

jest.mock('expo-router', () => {
  const React2 = require('react');
  const { View } = require('react-native');
  const Stack: any = ({ children }: any) => React2.createElement(View, null, children);
  Stack.Screen = () => null;
  return {
    Stack,
    useLocalSearchParams: () => ({ id: 'plan-1' }),
    useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
    router: { back: jest.fn(), push: jest.fn() },
  };
});

import RouteScreen from '../route/[id].tsx';

describe('Start Route must reach the server before the UI shows a started route', () => {
  beforeEach(() => { mockAcceptCalls = 0; mockAcceptShouldFail = false; });

  it('calls the canonical acceptance endpoint when Start Route is pressed', async () => {
    await render(<RouteScreen />);
    fireEvent.press(screen.getByText('Start Route'));
    await waitFor(() => {
      expect(mockAcceptCalls).toBe(1);
    });
  });

  it('shows the started UI only after the server accepts', async () => {
    await render(<RouteScreen />);
    expect(screen.queryByText('Start Route')).not.toBeNull();
    fireEvent.press(screen.getByText('Start Route'));
    await waitFor(() => {
      // The Start button is replaced by the active action bar once accepted.
      expect(screen.queryByText('Start Route')).toBeNull();
    });
  });

  it('a REFUSED acceptance leaves the route not-started — no client-only success', async () => {
    mockAcceptShouldFail = true;
    await render(<RouteScreen />);
    fireEvent.press(screen.getByText('Start Route'));
    await waitFor(() => {
      expect(mockAcceptCalls).toBe(1);
    });
    // The whole defect in one assertion: the server refused, so the traveller
    // must still see an un-started route. Before this lane was wired the screen
    // set its local boolean unconditionally and the server was never consulted
    // at all, so this could not even fail.
    expect(screen.queryByText('Start Route')).not.toBeNull();
  });
});
