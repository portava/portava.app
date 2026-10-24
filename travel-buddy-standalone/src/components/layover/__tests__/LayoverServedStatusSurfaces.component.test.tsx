/**
 * census-layover §83 — the flag-versus-app audit of 2026-10-23: with `layover_recommendation_status_enabled` ON in
 * production, the server keeps BLOCKED / STALE / EXPIRED / SUPERSEDED cards and serves them with `available: false`.
 * The recommendations list honoured that on batch 1 (LayoverRecsSection.servedStatus); two more surfaces read the same
 * cards and did not:
 *
 *   - the map (via the screen's `candidateFeasibility` lookup): a plan stop added before its card stopped being
 *     available was still drawn as a pin with no reason;
 *   - "Check an experience from here": an unavailable card was still offered as a choice to check.
 *
 * Each case mounts the real component with the wire shape the server sends.
 */
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react-native';
import { LayoverMapCard } from '../LayoverMapCard.tsx';
import { LayoverCurrentPositionCard } from '../LayoverCurrentPositionCard.tsx';
import type { LayoverRecommendation } from '../../../services/layover.ts';
import { candidateFeasibilityByRecId } from '../layoverServedContract.ts';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));
// NOTE: intentional stub — LayoverMapCard touches no navigation; requireActual pulls expo-router's native linking in.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  usePathname: () => '/',
  useSegments: () => [],
  Link: ({ children }: { children: React.ReactNode }) => children,
  Redirect: () => null,
}));
// NOTE: intentional stub — MapLibre native modules are unavailable under Jest; it captures which pins reached the map.
let capturedPlaces: any[] = [];
jest.mock('../../discovery/DiscoveryMapView', () => {
  const { View } = require('react-native');
  return { DiscoveryMapView: (props: any) => { capturedPlaces = props.places; return <View testID="layover-map-view" />; } };
});
// NOTE: intentional stub — avoids pulling in services/collections/discovery.
jest.mock('../../discovery/PlaceDetailSheet.tsx', () => {
  const { View } = require('react-native');
  return { PlaceDetailSheet: () => <View /> };
});
// NOTE: intentional stub — native SecureStore auth is unavailable in the test host; nothing here sends a request.
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: jest.fn(async () => 'owner-token') }));

afterEach(cleanup);

const AIRPORT = { iataCode: 'SIN', name: 'Singapore Changi Airport', city: 'Singapore', country: 'Singapore', countryCode: 'SG', timezone: 'Asia/Singapore', lat: 1.3644, lng: 103.9915, verified: true, id: 'airport-sin' };
const ANCHOR = { hardReturnTime: '2026-10-23T09:30:00.000Z', minutesToHardReturn: 185, returnState: 'NORMAL', canReturn: true, busy: false, onReturnNow: jest.fn() };
const STALE = 'This idea was worked out on an older plan. Refresh to see it again.';

function rec(over: Partial<LayoverRecommendation>): LayoverRecommendation {
  return { id: 'rec-garden', snapshotId: 'snap-1', title: 'Gardens by the Bay', insideAirport: false, routing: { state: 'FEASIBLE' }, ...over } as LayoverRecommendation;
}
function stop(over: Partial<any> = {}) {
  return { id: 'stop-garden', title: 'Gardens by the Bay', description: null, stopOrder: 1, durationMin: 60, travelMin: 0, placeId: null, recommendationId: 'rec-garden', lat: 1.2816, lng: 103.8636, locationLabel: 'Marina Bay', insideAirport: false, source: 'recommendation' as const, ...over };
}

describe('the map honours a card served unavailable', () => {
  it('candidateFeasibilityByRecId: available === false is a BLOCKED, uncertified entry carrying the server sentence; others pass through', () => {
    const feasible = { band: 'UNCERTIFIED' as const, certified: false, lowerBoundOneWayMin: 20, withinPlannedEdge: null, reason: null, plannedEdgeReason: null, impliesFit: false };
    const out = candidateFeasibilityByRecId([
      rec({ id: 'gone', available: false, status: 'STALE', statusExplanation: STALE, feasibility: feasible }),
      rec({ id: 'kept', available: true, feasibility: feasible }),
      rec({ id: 'older-server', feasibility: feasible }),
      rec({ id: 'unmeasured' }),
      rec({ id: undefined as any, available: false }),
    ]);
    expect(out['gone']).toEqual({ band: 'BLOCKED', certified: false, lowerBoundOneWayMin: 20, withinPlannedEdge: null, reason: STALE, plannedEdgeReason: null, impliesFit: false });
    expect(out['kept']).toBe(feasible);
    expect(out['older-server']).toBe(feasible);
    expect('unmeasured' in out).toBe(false);
    expect(Object.keys(out).sort()).toEqual(['gone', 'kept', 'older-server']);
    expect(candidateFeasibilityByRecId([rec({ id: 'x', available: false })])['x']!.reason).toBe('This idea is not available right now.');
  });

  it('a plan stop whose card is now unavailable is kept off the map and listed with the server reason', async () => {
    await render(<LayoverMapCard airport={AIRPORT as any} stops={[stop()]} airportReturn={ANCHOR} candidateFeasibility={candidateFeasibilityByRecId([rec({ available: false, status: 'STALE', statusExplanation: STALE })])} />);
    expect(capturedPlaces.some((p) => p.id === 'stop-stop-garden')).toBe(false);
    expect(screen.getByTestId('layover-map-blocked-stop-garden')).toBeTruthy();
    expect(screen.getByText(STALE)).toBeTruthy();
  });

  it('control: the same stop with its card available is drawn', async () => {
    await render(<LayoverMapCard airport={AIRPORT as any} stops={[stop()]} airportReturn={ANCHOR} candidateFeasibility={candidateFeasibilityByRecId([rec({ available: true, status: 'AVAILABLE' })])} />);
    expect(capturedPlaces.some((p) => p.id === 'stop-stop-garden')).toBe(true);
    expect(screen.queryByTestId('layover-map-blocked-stop-garden')).toBeNull();
  });
});

describe('"Check an experience from here" never offers a card served unavailable', () => {
  it('an unavailable card is not a choice; with no other choice the card does not render', async () => {
    await render(<LayoverCurrentPositionCard sessionId="session" recs={[rec({ available: false, status: 'EXPIRED', statusExplanation: 'This idea has expired.' })]} timezone="UTC" enabled />);
    expect(screen.queryByTestId('layover-current-position')).toBeNull();
  });

  it('beside an available card, only the available one is offered', async () => {
    await render(<LayoverCurrentPositionCard sessionId="session" recs={[rec({ id: 'rec-gone', title: 'Old idea', available: false, status: 'SUPERSEDED' }), rec({ id: 'rec-ok', title: 'Merlion Park', available: true, status: 'AVAILABLE' })]} timezone="UTC" enabled />);
    expect(screen.getByTestId('layover-current-position')).toBeTruthy();
    expect(screen.getByText('Merlion Park')).toBeTruthy();
    expect(screen.queryByText('Old idea')).toBeNull();
  });

  it('control: an older server (no status fields) keeps the card offered exactly as before', async () => {
    await render(<LayoverCurrentPositionCard sessionId="session" recs={[rec({ title: 'Merlion Park' })]} timezone="UTC" enabled />);
    expect(screen.getByText('Merlion Park')).toBeTruthy();
  });
});
