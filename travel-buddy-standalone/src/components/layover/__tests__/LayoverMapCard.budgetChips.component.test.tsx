/**
 * LayoverMapCard — spec §13's time-budget chips (census-layover L118):
 * "Changing time-budget chips triggers simulation/replanning, not local visual
 * filtering alone."
 *
 * Mounts the card and asserts on what a traveller sees. A chip press must reach
 * the SERVER (`simulateMapBudget`), and the map must then draw the server's
 * answer AS SENT — including where a local filter by the budget would have
 * decided differently, which is how these tests tell a server simulation from a
 * client-side filter. While the answer is in flight, after a refusal and after
 * a failure, the certified bands stay on the map; nothing is filtered locally.
 */
import React from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import { LayoverMapCard } from '../LayoverMapCard.tsx';
import { useMapBudgetSimulation } from '../LayoverMapBudgetChips.tsx';
import type { LayoverSafeEnvelope, MapBudgetChips, MapBudgetSimulationRead } from '../../../services/layover.ts';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// NOTE: intentional stub — LayoverMapCard touches no navigation at all; a
// requireActual spread here pulls expo-router's native linking internals into a
// suite that only renders one card.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  usePathname: () => '/',
  useSegments: () => [],
  Link: ({ children }: { children: React.ReactNode }) => children,
  Redirect: () => null,
}));

// NOTE: intentional stub — MapLibre native modules are unavailable under Jest.
// It captures `places` so the test can assert WHICH pins reached the map.
let capturedPlaces: any[] = [];
jest.mock('../../discovery/DiscoveryMapView', () => {
  const { View } = require('react-native');
  return {
    DiscoveryMapView: (props: any) => {
      capturedPlaces = props.places;
      return <View testID="layover-map-view" />;
    },
  };
});

// NOTE: intentional stub — avoids pulling in services/collections/discovery.
jest.mock('../../discovery/PlaceDetailSheet.tsx', () => {
  const { View } = require('react-native');
  return { PlaceDetailSheet: () => <View /> };
});

// NOTE: intentionally exhaustive — the card's only RUNTIME import from the
// layover service is the simulate call; every other import of it is `import type`.
const mockSimulate = jest.fn();
jest.mock('../../../services/layover.ts', () => ({
  simulateMapBudget: (...a: unknown[]) => mockSimulate(...a),
}));

const AIRPORT = {
  iataCode: 'TPE', name: 'Taiwan Taoyuan International Airport', city: 'Taoyuan', country: 'Taiwan',
  countryCode: 'TW', timezone: 'Asia/Taipei', lat: 25.0797, lng: 121.2342, verified: false, id: 'airport-tpe',
};

function envelope(): LayoverSafeEnvelope {
  return {
    centre: { lat: AIRPORT.lat, lng: AIRPORT.lng }, radiusMetres: 40_000, usableMinutes: 300, maxOneWayMinutes: 150,
    basis: 'straight_line_lower_bound' as const, certifiedOutward: true as const, certifiedInward: false as const,
    confidence: 'LOW' as const, uncertaintyBudgetMinutes: 60, plannedMaxOneWayMinutes: 120, plannedRadiusMetres: 30_000,
  };
}

function band(b: 'SAFE' | 'TIGHT' | 'BLOCKED' | null, reason: string, neededMin: number, usableMinutes: number) {
  return { band: b, reason, neededMin, usableMinutes, spareMin: usableMinutes - neededMin };
}

function stop(over: Partial<any> = {}) {
  return {
    id: 'stop-1', title: 'Raohe Night Market', description: null, stopOrder: 1,
    durationMin: 60, travelMin: 30, placeId: null, recommendationId: null,
    lat: 25.05, lng: 121.577, locationLabel: 'Songshan', insideAirport: false, source: 'user' as const,
    ...over,
  };
}

/** The overview's stops: both SAFE at the certified 300 minutes. */
const CERTIFIED = [
  stop({ id: 'a', title: 'Old town', durationMin: 60, travelMin: 30, mapBand: band('SAFE', 'Fits with 180 min to spare, using the travel time you entered — not a measured route.', 120, 300) }),
  stop({ id: 'b', title: 'Tea house', durationMin: 140, travelMin: 30, lat: 25.06, lng: 121.5, mapBand: band('SAFE', 'Fits with 100 min to spare, using the travel time you entered — not a measured route.', 200, 300) }),
];

const CHIPS: MapBudgetChips = { available: true, withheld: null, certifiedUsableMinutes: 300, budgets: [90, 120, 180, 240] };

/**
 * The SERVER's answer for 120 minutes, deliberately one a budget filter could
 * not produce: stop `a` (needs 120) comes back BLOCKED, and stop `b` (needs 200,
 * far more than 120) comes back TIGHT. A client filtering by `neededMin <= 120`
 * would keep `a` and drop `b`; the map must show exactly the opposite.
 */
function simulated120(): MapBudgetSimulationRead {
  return {
    ok: true, budgetMinutes: 120, certifiedUsableMinutes: 300,
    statement: 'If you had only 2 h out of the airport: each band below is read against 120 usable minutes instead of your certified 300. Your return time does not change, and nothing was saved.',
    stops: [
      { ...CERTIFIED[0], mapBand: band('BLOCKED', 'SERVER SAYS BLOCKED UNDER 120', 120, 120) },
      { ...CERTIFIED[1], mapBand: band('TIGHT', 'SERVER SAYS TIGHT UNDER 120', 200, 120) },
    ] as any,
    planFit: { usableMinutes: 120 } as any,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function mount(over: Partial<React.ComponentProps<typeof LayoverMapCard>> = {}) {
  return render(
    <LayoverMapCard
      airport={AIRPORT as any}
      stops={CERTIFIED as any}
      envelope={envelope()}
      envelopeGate={{ status: 'open' } as any}
      budgetChips={CHIPS}
      sessionId="session-1"
      {...over}
    />,
  );
}

beforeEach(() => { capturedPlaces = []; mockSimulate.mockReset(); });

describe('L118 — the chips are the server\'s', () => {
  it('renders exactly the budgets the server offers, plus the certified "All"', async () => {
    await mount();
    expect(screen.getByTestId('layover-map-budget-chips')).toBeTruthy();
    for (const b of CHIPS.budgets) expect(screen.getByTestId(`layover-map-budget-chip-${b}`)).toBeTruthy();
    expect(screen.queryByTestId('layover-map-budget-chip-300')).toBeNull();
    expect(screen.getByTestId('layover-map-budget-chip-all')).toBeTruthy();
    expect(screen.getByText('All 5h')).toBeTruthy();
  });

  it('no chips when the server offers none, when it withholds them, or without a session', async () => {
    await mount({ budgetChips: null });
    expect(screen.queryByTestId('layover-map-budget-chips')).toBeNull();
    await mount({ budgetChips: { ...CHIPS, available: false, withheld: 'landside_closed', budgets: [] } });
    expect(screen.queryByTestId('layover-map-budget-chips')).toBeNull();
    await mount({ sessionId: null });
    expect(screen.queryByTestId('layover-map-budget-chips')).toBeNull();
  });
});

describe('L118 — a chip press is a server simulation, never a local filter', () => {
  it('asks the server, and draws its answer as sent — even where a budget filter would have decided the opposite', async () => {
    mockSimulate.mockResolvedValue(simulated120());
    await mount();
    expect(screen.getByTestId('layover-map-band-SAFE-a')).toBeTruthy();
    await act(async () => { await fireEvent.press(screen.getByTestId('layover-map-budget-chip-120')); });
    expect(mockSimulate).toHaveBeenCalledTimes(1);
    expect(mockSimulate).toHaveBeenCalledWith('session-1', 120);
    // `a` fits 120 by its own minutes, and the server blocked it: it is off the map and listed.
    expect(screen.getByTestId('layover-map-blocked-a')).toBeTruthy();
    expect(screen.getByText('SERVER SAYS BLOCKED UNDER 120')).toBeTruthy();
    expect(capturedPlaces.map((p) => p.id)).not.toContain('stop-a');
    // `b` needs 200 > 120, and the server kept it (TIGHT): it stays on the map.
    expect(screen.getByTestId('layover-map-band-TIGHT-b')).toBeTruthy();
    expect(capturedPlaces.map((p) => p.id)).toContain('stop-b');
    expect(screen.getByTestId('layover-map-budget-statement').props.children).toMatch(/If you had only 2 h/);
    expect(screen.getByTestId('layover-map-route-leg-a').props.children).toEqual(expect.arrayContaining([' — blocked, not on the map']));
  });

  it('while the answer is in flight the certified bands stay: nothing is pre-filtered on the device', async () => {
    const d = deferred<MapBudgetSimulationRead>();
    mockSimulate.mockReturnValue(d.promise);
    await mount();
    await act(async () => { await fireEvent.press(screen.getByTestId('layover-map-budget-chip-90')); });
    expect(mockSimulate).toHaveBeenCalledWith('session-1', 90);
    expect(screen.getByTestId('layover-map-band-SAFE-a')).toBeTruthy();
    expect(screen.getByTestId('layover-map-band-SAFE-b')).toBeTruthy();
    expect(capturedPlaces.map((p) => p.id)).toEqual(expect.arrayContaining(['stop-a', 'stop-b']));
    expect(screen.queryByTestId('layover-map-budget-statement')).toBeNull();
    await act(async () => { d.resolve(simulated120()); });
  });

  it('a refusal keeps the certified bands and says why, in the server\'s words', async () => {
    mockSimulate.mockResolvedValue({ ok: false, reason: 'refused', message: 'Your certified usable time is 110 minutes. A time budget can only narrow it, never widen it.' });
    await mount();
    await act(async () => { await fireEvent.press(screen.getByTestId('layover-map-budget-chip-120')); });
    expect(mockSimulate).toHaveBeenCalledWith('session-1', 120);
    expect(screen.getByTestId('layover-map-budget-error').props.children).toMatch(/can only narrow it/);
    expect(screen.getByTestId('layover-map-band-SAFE-a')).toBeTruthy();
    expect(screen.getByTestId('layover-map-band-SAFE-b')).toBeTruthy();
    expect(capturedPlaces.map((p) => p.id)).toEqual(expect.arrayContaining(['stop-a', 'stop-b']));
  });

  it('offline: the certified bands stay, and the card says so', async () => {
    mockSimulate.mockResolvedValue({ ok: false, reason: 'unreachable', message: 'Could not reach Portava to simulate that budget, so your certified time is shown.' });
    await mount();
    await act(async () => { await fireEvent.press(screen.getByTestId('layover-map-budget-chip-180')); });
    expect(screen.getByTestId('layover-map-budget-error').props.children).toMatch(/certified time is shown/);
    expect(screen.getByTestId('layover-map-band-SAFE-a')).toBeTruthy();
  });

  it('"All" returns to the certified bands without another call', async () => {
    mockSimulate.mockResolvedValue(simulated120());
    await mount();
    await act(async () => { await fireEvent.press(screen.getByTestId('layover-map-budget-chip-120')); });
    expect(screen.getByTestId('layover-map-blocked-a')).toBeTruthy();
    await act(async () => { await fireEvent.press(screen.getByTestId('layover-map-budget-chip-all')); });
    expect(mockSimulate).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('layover-map-band-SAFE-a')).toBeTruthy();
    expect(screen.queryByTestId('layover-map-budget-statement')).toBeNull();
  });

  it('the latest press wins: an earlier answer arriving late is dropped', async () => {
    const first = deferred<MapBudgetSimulationRead>();
    const second = deferred<MapBudgetSimulationRead>();
    mockSimulate.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await mount();
    await act(async () => { await fireEvent.press(screen.getByTestId('layover-map-budget-chip-90')); });
    await act(async () => { await fireEvent.press(screen.getByTestId('layover-map-budget-chip-120')); });
    await act(async () => { second.resolve(simulated120()); });
    await act(async () => {
      first.resolve({ ...simulated120(), budgetMinutes: 90, statement: 'STALE 90', stops: [{ ...CERTIFIED[0], mapBand: band('TIGHT', 'STALE', 120, 90) }, CERTIFIED[1]] as any });
    });
    expect(screen.getByText('SERVER SAYS BLOCKED UNDER 120')).toBeTruthy();
    expect(screen.queryByText('STALE 90')).toBeNull();
  });

  it('a changed plan under an active chip is simulated AGAIN on the server, not patched locally', async () => {
    mockSimulate.mockResolvedValue(simulated120());
    const view = await mount();
    await act(async () => { await fireEvent.press(screen.getByTestId('layover-map-budget-chip-120')); });
    expect(mockSimulate).toHaveBeenCalledTimes(1);
    const added = [...CERTIFIED, stop({ id: 'c', title: 'Temple', durationMin: 30, travelMin: 10 })];
    await act(async () => {
      view.rerender(
        <LayoverMapCard airport={AIRPORT as any} stops={added as any} envelope={envelope()} envelopeGate={{ status: 'open' } as any} budgetChips={CHIPS} sessionId="session-1" />,
      );
    });
    expect(mockSimulate).toHaveBeenCalledTimes(2);
    expect(mockSimulate).toHaveBeenLastCalledWith('session-1', 120);
  });

  it('a budget the server stops offering clears the chip back to the certified bands', async () => {
    mockSimulate.mockResolvedValue(simulated120());
    const view = await mount();
    await act(async () => { await fireEvent.press(screen.getByTestId('layover-map-budget-chip-120')); });
    expect(screen.getByTestId('layover-map-blocked-a')).toBeTruthy();
    await act(async () => {
      view.rerender(
        <LayoverMapCard airport={AIRPORT as any} stops={CERTIFIED as any} envelope={envelope()} envelopeGate={{ status: 'open' } as any} budgetChips={{ ...CHIPS, certifiedUsableMinutes: 110, budgets: [90] }} sessionId="session-1" />,
      );
    });
    expect(screen.getByTestId('layover-map-band-SAFE-a')).toBeTruthy();
    expect(screen.queryByTestId('layover-map-budget-statement')).toBeNull();
    expect(mockSimulate).toHaveBeenCalledTimes(1);
  });
});

describe('L118 — the hook only ever simulates a budget the server offered', () => {
  it('a budget the server did not offer is never sent (it clears instead)', async () => {
    const { result } = await renderHook(() => useMapBudgetSimulation('session-1', CHIPS, CERTIFIED as any));
    await act(async () => { result.current.choose(300); });
    await act(async () => { result.current.choose(60); });
    expect(mockSimulate).not.toHaveBeenCalled();
    expect(result.current.activeBudget).toBeNull();
    expect(result.current.stops).toBeNull();
    // CONTROL: an offered one is sent.
    mockSimulate.mockResolvedValue(simulated120());
    await act(async () => { result.current.choose(120); });
    expect(mockSimulate).toHaveBeenCalledWith('session-1', 120);
  });
});

describe('L118 — the act queue is drained (RNTL v14 presses are async)', () => {
  it('PROBE: a render after every press above still commits', async () => {
    const { View } = require('react-native');
    await render(<View testID="probe" />);
    expect(screen.getByTestId('probe')).toBeTruthy();
  });
});
