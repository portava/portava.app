/**
 * LayoverMapCard — the §13 map elements census-layover scored NOT BUILT.
 *
 * Four rows, one card, and every one of them was scored `N` with the same
 * sentence in different words:
 *
 *   L116  "Show safe/tight/blocked geography from certified envelope versions"
 *   L117  "Pins outside the certified action universe are hidden or visibly blocked"
 *   L121  "Map element Safe envelope — dynamic isochrone/polygon that contracts
 *          as conditions worsen"
 *   L122  "Map element Candidate pin — carries feasibility state from the
 *          recommendation contract"
 *   L119  "The primary route always includes the return leg and the return deadline"
 *   L126  "Map element Offline state — last-certified envelope timestamp + stale badge"
 *
 * The server has published `safeEnvelope` on `GET /overview` since census L63,
 * and `offlineBundle.certifiedAt` / `staleAfter` since the degraded-mode pass.
 * NEITHER WAS READ. The gap was never the geometry; it was that no client type
 * had a field for it, so every screen rendered correctly against a server that
 * was already sending it.
 *
 * ── WHAT IS DRIVEN, AND WHY IT IS THE COMPONENT ─────────────────────────────
 * Every case below MOUNTS `LayoverMapCard` and asserts on what a traveller can
 * see. Nothing here calls a pure helper: the contraction assertion reads the
 * rendered style of the drawn ring, and the blocked-pin assertion reads the
 * list of places the card actually handed to `DiscoveryMapView`.
 *
 * ── WHY THE RING IS A DIAGRAM AND NOT A BASEMAP OVERLAY ─────────────────────
 * `DiscoveryMapView` takes places and a camera and nothing else — it has no
 * overlay or shape prop, and it is not this lane's file. A circle absolutely
 * positioned over its viewport would be registered against a camera this card
 * does not control, i.e. a drawing that claims a scale it cannot hold. The
 * envelope is therefore drawn as its OWN to-scale diagram with a printed scale,
 * beside the map rather than on it. It is still the §13 element: the radius is
 * the server's certified one, it contracts when the window contracts, and it
 * carries the band vocabulary.
 */

import React from 'react';
import { StyleSheet } from 'react-native';
import { act, render, screen } from '@testing-library/react-native';
import { LayoverMapCard } from '../LayoverMapCard.tsx';
import type { LayoverSafeEnvelope } from '../../../services/layover.ts';

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

const AIRPORT = {
  iataCode: 'TPE',
  name: 'Taiwan Taoyuan International Airport',
  city: 'Taoyuan',
  country: 'Taiwan',
  countryCode: 'TW',
  timezone: 'Asia/Taipei',
  lat: 25.0797,
  lng: 121.2342,
  verified: false,
  id: 'airport-tpe',
};

/**
 * The server's own `safeEnvelope` shape, as `GET /overview` publishes it.
 *
 * TYPED, not `any`: `certifiedInward` and `basis` are literal types on the real
 * contract, and a fixture that widened them to `boolean`/`string` would compile
 * against a shape the server never emits — which is the whole point of the
 * test-typecheck gate.
 */
function envelope(over: Partial<LayoverSafeEnvelope> = {}): LayoverSafeEnvelope {
  return {
    centre: { lat: AIRPORT.lat, lng: AIRPORT.lng },
    radiusMetres: 40_000,
    usableMinutes: 240,
    maxOneWayMinutes: 120,
    basis: 'straight_line_lower_bound' as const,
    certifiedOutward: true as const,
    certifiedInward: false as const,
    confidence: 'LOW' as const,
    uncertaintyBudgetMinutes: 60,
    plannedMaxOneWayMinutes: 90,
    plannedRadiusMetres: 30_000,
    ...over,
  };
}

function stop(over: Partial<any> = {}) {
  return {
    id: 'stop-1', title: 'Raohe Night Market', description: null, stopOrder: 1,
    durationMin: 60, travelMin: 0, placeId: null, recommendationId: null,
    lat: 25.05, lng: 121.577, locationLabel: 'Songshan', insideAirport: false,
    source: 'user' as const,
    ...over,
  };
}

const ANCHOR = {
  hardReturnTime: '2026-09-14T09:30:00.000Z',
  minutesToHardReturn: 185,
  returnState: 'NORMAL',
  canReturn: true,
  busy: false,
  onReturnNow: jest.fn(),
};

function widthOf(el: any): number {
  const flat: any = StyleSheet.flatten(el.props.style);
  return Number(flat.width);
}

beforeEach(() => { capturedPlaces = []; });

describe('L121 / L116 — the safe envelope is drawn, and it contracts', () => {
  it('renders the certified envelope with both edges and the band vocabulary', async () => {
    await render(
      <LayoverMapCard airport={AIRPORT as any} stops={[]} airportReturn={ANCHOR} envelope={envelope()} />,
    );

    expect(screen.getByTestId('layover-map-safe-envelope')).toBeTruthy();
    // The PROVED edge — outside it nothing fits at any speed.
    expect(screen.getByTestId('layover-map-envelope-proved-label').props.children.join('')).toContain('40 km');
    // The CONTRACTED planning edge, and what it cost.
    expect(screen.getByTestId('layover-map-envelope-planned-label').props.children.join('')).toContain('30 km');
    expect(screen.getByText(/60 min .*held back/i)).toBeTruthy();
  });

  it('the drawn ring CONTRACTS when the certified window contracts', async () => {
    // `rerender` on ONE mounted card, deliberately: the same component instance
    // is handed a smaller certified envelope, which is what actually happens
    // when the screen re-polls the overview after a delay. (An earlier draft
    // used two renders with `screen.unmount()` between them and detached the
    // RNTL screen, which silently failed every LATER case in this file while
    // passing in isolation.)
    const view = await render(
      <LayoverMapCard airport={AIRPORT as any} stops={[]} airportReturn={ANCHOR} envelope={envelope()} />,
    );
    const wide = widthOf(view.getByTestId('layover-map-envelope-proved-ring'));
    const widePlanned = widthOf(view.getByTestId('layover-map-envelope-planned-ring'));

    // A delayed inbound has eaten most of the window.
    await act(async () => { view.rerender(
      <LayoverMapCard
        airport={AIRPORT as any}
        stops={[]}
        airportReturn={ANCHOR}
        envelope={envelope({
          radiusMetres: 15_000, plannedRadiusMetres: 11_000,
          usableMinutes: 100, maxOneWayMinutes: 50, plannedMaxOneWayMinutes: 37,
          uncertaintyBudgetMinutes: 25,
        })}
      />,
    ); });
    const narrow = widthOf(view.getByTestId('layover-map-envelope-proved-ring'));
    const narrowPlanned = widthOf(view.getByTestId('layover-map-envelope-planned-ring'));

    expect(narrow).toBeLessThan(wide);
    expect(narrowPlanned).toBeLessThan(widePlanned);
    // The planning edge is inside the proved edge in BOTH states — a haircut
    // that ever drew outside the proof would be drawing a bigger promise.
    expect(widePlanned).toBeLessThan(wide);
    expect(narrowPlanned).toBeLessThan(narrow);
  });

  it('an envelope too large for the box is COMPRESSED, never clamped flat', async () => {
    // The path a clamp would take. An earlier draft of the card clamped both
    // rings at the box edge, so a 40 km proved edge and a 30 km planning edge
    // came out the same size — two different distances, one drawing, with the
    // inner edge shown as far out as the outer one. A proportional compression
    // keeps the certified ratio and says so on the scale line; nothing here
    // asserts a pixel count, only that the ratio survived.
    await render(
      <LayoverMapCard
        airport={AIRPORT as any}
        stops={[]}
        airportReturn={ANCHOR}
        envelope={envelope({
          radiusMetres: 220_000, plannedRadiusMetres: 160_000,
          usableMinutes: 900, maxOneWayMinutes: 450, plannedMaxOneWayMinutes: 330,
          uncertaintyBudgetMinutes: 225,
        })}
      />,
    );
    const proved = widthOf(screen.getByTestId('layover-map-envelope-proved-ring'));
    const planned = widthOf(screen.getByTestId('layover-map-envelope-planned-ring'));
    expect(planned).toBeLessThan(proved);
    expect(screen.getByTestId('layover-map-envelope-scale').props.children.join('')).toContain('compressed to fit');
  });

  it('never claims a pin is SAFE — no band on this tree certifies a fit', async () => {
    await render(
      <LayoverMapCard airport={AIRPORT as any} stops={[]} airportReturn={ANCHOR} envelope={envelope()} />,
    );
    expect(screen.queryByText(/\bsafe to visit\b/i)).toBeNull();
    // The inward edge is uncertified and the card says so rather than implying
    // that everything inside the disc fits.
    expect(screen.getByTestId('layover-map-envelope-inward-caveat')).toBeTruthy();
  });

  it('degrades visibly when the server sent no envelope', async () => {
    await render(<LayoverMapCard airport={AIRPORT as any} stops={[]} airportReturn={ANCHOR} />);
    expect(screen.queryByTestId('layover-map-safe-envelope')).toBeNull();
    expect(screen.getByTestId('layover-map-envelope-unavailable')).toBeTruthy();
  });
});

describe('L117 / L122 / L125 — a pin carries the feasibility state it was given', () => {
  it('a BLOCKED candidate is kept off the map and explained, with no implication of fit', async () => {
    await render(
      <LayoverMapCard
        airport={AIRPORT as any}
        stops={[stop({ id: 'stop-far', title: 'Far Temple', recommendationId: 'rec-far' })]}
        airportReturn={ANCHOR}
        envelope={envelope()}
        candidateFeasibility={{
          'rec-far': {
            band: 'BLOCKED',
            certified: true,
            lowerBoundOneWayMin: 140,
            withinPlannedEdge: false,
            reason: '171.8 km from the airport — at least 280 min there and back, against 240 min of usable time',
            plannedEdgeReason: 'beyond what we would plan on LOW confidence',
            impliesFit: false,
          },
        }}
      />,
    );

    // Hidden from the map (L117's first arm) …
    expect(capturedPlaces.some((p) => p.id === 'stop-stop-far')).toBe(false);
    // … and visibly blocked with the reason (L117's second arm, L125).
    expect(screen.getByTestId('layover-map-blocked-stop-far')).toBeTruthy();
    expect(screen.getByText(/at least 280 min there and back/)).toBeTruthy();
  });

  it('a candidate beyond the PLANNING edge is flagged, not withheld', async () => {
    await render(
      <LayoverMapCard
        airport={AIRPORT as any}
        stops={[stop({ id: 'stop-annulus', title: 'Annulus Market', recommendationId: 'rec-annulus' })]}
        airportReturn={ANCHOR}
        envelope={envelope()}
        candidateFeasibility={{
          'rec-annulus': {
            band: 'UNCERTIFIED',
            certified: true,
            lowerBoundOneWayMin: 100,
            withinPlannedEdge: false,
            reason: null,
            plannedEdgeReason:
              'beyond what we would plan on LOW confidence — 60 of the 240 usable minutes are held back',
            impliesFit: false,
          },
        }}
      />,
    );

    // Still a pin on the map — a planning haircut is a flag, never a refusal.
    expect(capturedPlaces.some((p) => p.id === 'stop-stop-annulus')).toBe(true);
    expect(screen.getByTestId('layover-map-pin-band-stop-annulus')).toBeTruthy();
    expect(screen.getByText(/usable minutes are held back/)).toBeTruthy();
  });

  it('a stop nobody banded says so, instead of borrowing a band', async () => {
    await render(
      <LayoverMapCard
        airport={AIRPORT as any}
        stops={[stop({ id: 'stop-manual', title: 'A place I typed in' })]}
        airportReturn={ANCHOR}
        envelope={envelope()}
        candidateFeasibility={{}}
      />,
    );
    expect(capturedPlaces.some((p) => p.id === 'stop-stop-manual')).toBe(true);
    const band = screen.getByTestId('layover-map-pin-band-stop-manual');
    expect(band).toBeTruthy();
    expect(screen.getByText(/not been measured against your safe envelope/i)).toBeTruthy();
  });
});

describe('L119 — the primary route always includes the return leg and the deadline', () => {
  it('renders the return leg even when there is nothing else in the plan', async () => {
    await render(
      <LayoverMapCard airport={AIRPORT as any} stops={[]} airportReturn={ANCHOR} envelope={envelope()} />,
    );
    const leg = screen.getByTestId('layover-map-route-return-leg');
    expect(leg).toBeTruthy();
    expect(screen.getByTestId('layover-map-route-return-deadline')).toBeTruthy();
  });

  it('the return leg is LAST and is still there with stops before it', async () => {
    await render(
      <LayoverMapCard
        airport={AIRPORT as any}
        stops={[stop({ id: 's1', title: 'First', stopOrder: 1 }), stop({ id: 's2', title: 'Second', stopOrder: 2 })]}
        airportReturn={ANCHOR}
        envelope={envelope()}
      />,
    );
    const legs = screen.getAllByTestId(/^layover-map-route-leg-/);
    expect(legs.length).toBe(2);
    expect(screen.getByTestId('layover-map-route-return-leg')).toBeTruthy();
  });

  it('with no certified return the leg is still drawn, and says the deadline is missing', async () => {
    await render(<LayoverMapCard airport={AIRPORT as any} stops={[]} envelope={envelope()} />);
    expect(screen.getByTestId('layover-map-route-return-leg')).toBeTruthy();
    expect(screen.getByTestId('layover-map-route-return-uncertified')).toBeTruthy();
  });
});

describe('L126 — offline state shows the last-certified timestamp and a stale badge', () => {
  it('badges a bundle whose staleAfter has passed, and names when it was certified', async () => {
    const now = Date.parse('2026-09-14T06:30:00.000Z');
    await render(
      <LayoverMapCard
        airport={AIRPORT as any}
        stops={[]}
        airportReturn={ANCHOR}
        envelope={envelope()}
        offline={{ certifiedAt: '2026-09-14T05:00:00.000Z', staleAfter: '2026-09-14T05:30:00.000Z' }}
        nowMs={now}
      />,
    );
    expect(screen.getByTestId('layover-map-envelope-certified-at')).toBeTruthy();
    expect(screen.getByTestId('layover-map-envelope-stale')).toBeTruthy();
  });

  it('an UNPARSEABLE instant is treated as stale, not as fresh', async () => {
    // The fail-closed direction, and the reason this card must not carry its
    // own staleness rule. `bundleFreshness` (layoverReturnFacts.ts) mirrors the
    // server's own and answers `stale: true, known: false` for a bundle whose
    // instants do not parse; a naive `Date.parse(staleAfter) <= now` answers
    // NaN <= now === FALSE, i.e. FRESH, and shows a deadline nobody can date as
    // live truth. Two rules, and the simpler one is wrong in the dangerous
    // direction.
    await render(
      <LayoverMapCard
        airport={AIRPORT as any}
        stops={[]}
        airportReturn={ANCHOR}
        envelope={envelope()}
        offline={{ certifiedAt: 'not-an-instant', staleAfter: 'also-not-an-instant' }}
        nowMs={Date.parse('2026-09-14T06:30:00.000Z')}
      />,
    );
    expect(screen.getByTestId('layover-map-envelope-stale')).toBeTruthy();
  });

  it('a fresh bundle names the certification instant and carries no stale badge', async () => {
    const now = Date.parse('2026-09-14T05:10:00.000Z');
    await render(
      <LayoverMapCard
        airport={AIRPORT as any}
        stops={[]}
        airportReturn={ANCHOR}
        envelope={envelope()}
        offline={{ certifiedAt: '2026-09-14T05:00:00.000Z', staleAfter: '2026-09-14T05:30:00.000Z' }}
        nowMs={now}
      />,
    );
    expect(screen.getByTestId('layover-map-envelope-certified-at')).toBeTruthy();
    expect(screen.queryByTestId('layover-map-envelope-stale')).toBeNull();
  });
});
