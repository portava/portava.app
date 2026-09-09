/**
 * TripMapLayersCard — §14.1's projection reaching a screen.
 *
 * The projection exists to carry what a marker list cannot: a version, a
 * generated-at, and a per-layer status. This card is where those stop being
 * fields and start being sentences, and three of them are load-bearing:
 *
 *   an UNREAD layer is named. Without that line, a map missing its saved
 *     places looks exactly like a trip with none saved.
 *   a private anchor is never shown, and neither is a COUNT of them — on a
 *     two-stop trip, "1 private location" is close to naming it.
 *   an unattributable projection (no sourceTripVersion) says so, rather than
 *     being presented as current.
 *
 * RNTL v14: always await render().
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

import { TripMapLayersCard } from '../trip/TripMapLayersCard.tsx';
import type { ProjectionRead, TripMapProjection, MapPoint } from '../../services/tripMapProjection.ts';

const TRIP_ID = 'trip-map-projection-test';

const pt = (id: string, over: Partial<MapPoint> = {}): MapPoint => ({
  id, kind: 'plan', lat: 38.7, lng: -9.1, label: id, ...over,
});

function projection(over: Partial<TripMapProjection> = {}): TripMapProjection {
  return {
    tripId: TRIP_ID,
    generatedAt: '2026-10-01T12:00:00.000Z',
    sourceTripVersion: 7,
    census: { ok: 6, unread: 0, noSource: 4, totalPoints: 0 },
    activePlanReading: 'not removed and not cancelled; TR46 — no IN_PROGRESS status exists',
    stage: { status: 'ok', items: [] },
    privateAnchors: { status: 'ok', items: [] },
    activePlans: { status: 'ok', items: [] },
    confirmedCommitments: { status: 'ok', items: [] },
    savedIdeas: { status: 'ok', items: [] },
    crewPresenceSummaries: { status: 'no_source', reason: 'no coordinate layer' },
    routeChains: { status: 'no_source', reason: 'owner-only by RLS' },
    meetupPoints: { status: 'ok', items: [] },
    liveOpportunities: { status: 'no_source', reason: 'no opportunity object' },
    safetyPoints: { status: 'no_source', reason: 'no store' },
    ...over,
  };
}

const loader = (r: ProjectionRead) => jest.fn(async () => r);
const ok = (p: TripMapProjection): ProjectionRead => ({ state: 'ok', projection: p });

describe('TripMapLayersCard', () => {
  it('counts the points it can show', async () => {
    const { findByText } = await render(
      <TripMapLayersCard
        tripId={TRIP_ID}
        load={loader(ok(projection({
          activePlans: { status: 'ok', items: [pt('a'), pt('b')] },
          stage: { status: 'ok', items: [pt('s', { kind: 'stage' })] },
        })))}
      />,
    );
    expect(await findByText(/3 things on this trip's map/)).toBeTruthy();
  });

  it('NAMES the layers that did not load — the line the whole card exists for', async () => {
    // Without it, a map missing its saved places looks exactly like a trip
    // with none saved.
    const { findByTestId, findByText } = await render(
      <TripMapLayersCard
        tripId={TRIP_ID}
        load={loader(ok(projection({
          activePlans: { status: 'ok', items: [pt('a')] },
          savedIdeas: { status: 'unread', reason: 'trip_saved_places could not be read' },
          stage: { status: 'unread', reason: 'trip_stages could not be read' },
        })))}
      />,
    );
    expect(await findByTestId('trip-map-layers-unread')).toBeTruthy();
    expect(await findByText(/stages, saved places could not be read/)).toBeTruthy();
    expect(await findByText(/showing less than this trip has/)).toBeTruthy();
  });

  it('a NO_SOURCE layer is not reported as a failure', async () => {
    // Four layers have no producer in every real response. Reporting them as
    // "did not load" would make the warning permanent and therefore ignored.
    const { queryByTestId } = await render(
      <TripMapLayersCard
        tripId={TRIP_ID}
        load={loader(ok(projection({ activePlans: { status: 'ok', items: [pt('a')] } })))}
      />,
    );
    await waitFor(() => expect(queryByTestId('trip-map-layers-loading')).toBeNull());
    expect(queryByTestId('trip-map-layers-unread')).toBeNull();
  });

  it('never shows a private anchor, nor a COUNT of them', async () => {
    // On a two-stop trip, "1 private location" is close to naming it.
    const { findByText, queryByText } = await render(
      <TripMapLayersCard
        tripId={TRIP_ID}
        load={loader(ok(projection({
          activePlans: { status: 'ok', items: [pt('a')] },
          privateAnchors: { status: 'ok', items: [pt('hotel', { kind: 'private_anchor', privateAnchor: true, label: 'Hotel Lisboa' })] },
        })))}
      />,
    );
    // One thing, not two: the anchor is excluded from the count.
    expect(await findByText(/1 thing on this trip's map/)).toBeTruthy();
    expect(queryByText(/Hotel Lisboa/)).toBeNull();
    expect(queryByText(/private location/)).toBeNull();
  });

  it('an unattributable projection says so', async () => {
    const { findByTestId, findByText } = await render(
      <TripMapLayersCard
        tripId={TRIP_ID}
        load={loader(ok(projection({
          sourceTripVersion: null,
          activePlans: { status: 'ok', items: [pt('a')] },
        })))}
      />,
    );
    expect(await findByTestId('map-layers-unattributable')).toBeTruthy();
    expect(await findByText(/couldn't confirm which version/)).toBeTruthy();
  });

  it('version 0 IS a version, and is not reported as unattributable', async () => {
    const { queryByTestId, findByText } = await render(
      <TripMapLayersCard
        tripId={TRIP_ID}
        load={loader(ok(projection({
          sourceTripVersion: 0,
          activePlans: { status: 'ok', items: [pt('a')] },
        })))}
      />,
    );
    await findByText(/1 thing on this trip's map/);
    expect(queryByTestId('map-layers-unattributable')).toBeNull();
  });

  it('an unavailable read says so', async () => {
    const { findByTestId, findByText } = await render(
      <TripMapLayersCard tripId={TRIP_ID} load={loader({ state: 'unavailable', detail: 'HTTP 503' })} />,
    );
    expect(await findByTestId('trip-map-layers-unavailable')).toBeTruthy();
    expect(await findByText(/couldn't work out what this trip has on the map/)).toBeTruthy();
  });

  it('an unexpected throw is unavailable, never off', async () => {
    const { findByTestId } = await render(
      <TripMapLayersCard tripId={TRIP_ID} load={(jest.fn(async () => { throw new Error('x'); })) as any} />,
    );
    expect(await findByTestId('trip-map-layers-unavailable')).toBeTruthy();
  });

  it('renders nothing when the projection was READ, has nothing, and nothing failed', async () => {
    const { toJSON, queryByTestId } = await render(
      <TripMapLayersCard tripId={TRIP_ID} load={loader(ok(projection()))} />,
    );
    await waitFor(() => expect(queryByTestId('trip-map-layers-loading')).toBeNull());
    expect(toJSON()).toBeNull();
  });

  it('but an EMPTY trip with a failed layer still renders, because that is not nothing', async () => {
    const { findByTestId } = await render(
      <TripMapLayersCard
        tripId={TRIP_ID}
        load={loader(ok(projection({ savedIdeas: { status: 'unread', reason: 'x' } })))}
      />,
    );
    expect(await findByTestId('trip-map-layers-unread')).toBeTruthy();
  });
});
