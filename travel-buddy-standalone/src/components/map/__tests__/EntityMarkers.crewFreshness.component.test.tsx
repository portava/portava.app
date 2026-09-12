/**
 * Trips spec §10.2 on the pin: "marker visual treatment and accessible text
 * expose freshness" (census-trips TR166).
 *
 * A friend / crew pin used to draw one ring for every position, and its
 * Pressable had no label — a screen reader read nothing, and a sighted user
 * saw a live-looking pin over a position the server had judged LAST_KNOWN.
 * The Trip Map's crew pins now carry the server's `freshnessClass` as the
 * object's `freshness` (features/map/trip/tripMapSources.composeCrewPositions),
 * and the pin says it twice: the ring (solid signal for live, dimmed and
 * dashed for stale / unknown) and the accessibility label.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { EntityMapLayers } from '../EntityMarkers.tsx';
import type { MapEntity, ToggleableEntityType } from '../../../types/mapTypes.ts';
import { point, type MapObject, type FreshnessState } from '../../../types/mapObjects.ts';

jest.mock('@maplibre/maplibre-react-native', () => {
  const RN = jest.requireActual('react-native');
  const Map = ({ children }: { children?: React.ReactNode }) => (
    <RN.View testID="map-container">{children}</RN.View>
  );
  const Camera = (_props: unknown) => <RN.View testID="map-camera" />;
  const Marker = ({ children }: { children?: React.ReactNode }) => (
    <RN.View testID="map-marker">{children}</RN.View>
  );
  return { Map, Camera, Marker };
});

jest.mock('../../CachedImage.tsx', () => {
  const RN = jest.requireActual('react-native');
  return {
    CachedImage: ({ source }: { source?: { uri?: string } }) => (
      <RN.View testID={`cached-image:${source?.uri ?? 'none'}`} />
    ),
  };
});

const LAYERS: ToggleableEntityType[] = ['buddies', 'events', 'gems', 'trips', 'friends'];
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

/** A crew pin as tripToMapObjects emits it for a permitted temporary precise position. */
function crewEntity(over: { freshness?: FreshnessState; observedAt?: string; subtitle?: string } = {}): MapEntity {
  const obj = {
    id: 'crew_member:u1',
    kind: 'crew_member',
    geometry: point(16.06, 108.21),
    title: 'Mai',
    privacyClass: 'precise_temporary',
    renderingPriority: 50,
    interaction: { actions: [] },
    payload: { tripId: 't1', sourceId: 'u1', role: 'crew' },
    ...over,
  } as unknown as MapObject;
  return { id: obj.id, type: 'friends', lat: 16.06, lng: 108.21, payload: obj };
}

function renderMarkers(entities: MapEntity[]) {
  return render(
    <EntityMapLayers
      entities={entities}
      enabledLayers={LAYERS}
      zoom={18}
      onSelectEntity={jest.fn()}
      onPressCluster={jest.fn()}
    />,
  );
}

describe('the crew pin exposes freshness visually and in accessible text (§10.2)', () => {
  it('a LIVE position: the live ring, and a label that says so', async () => {
    await renderMarkers([crewEntity({ freshness: 'live', observedAt: ago(2 * 60_000), subtitle: 'Live · 2m ago' })]);
    expect(screen.getByTestId('entity-pin-freshness-live')).toBeTruthy();
    expect(screen.getByLabelText('Mai, Live')).toBeTruthy();
    expect(screen.queryByTestId('entity-pin-freshness-stale')).toBeNull();
  });

  it('a RECENT position: the recent ring, and the age in the label', async () => {
    await renderMarkers([crewEntity({ freshness: 'recent', observedAt: ago(20 * 60_000) })]);
    expect(screen.getByTestId('entity-pin-freshness-recent')).toBeTruthy();
    expect(screen.getByLabelText('Mai, 20m ago')).toBeTruthy();
  });

  it('a stale position is drawn as what it is — the dimmed ring, "Last confirmed", never "Live"', async () => {
    await renderMarkers([crewEntity({ freshness: 'stale', observedAt: ago(3 * 3600_000) })]);
    expect(screen.getByTestId('entity-pin-freshness-stale')).toBeTruthy();
    expect(screen.queryByTestId('entity-pin-freshness-live')).toBeNull();
    const pin = screen.getByLabelText(/^Mai, Last confirmed 3h ago$/);
    expect(pin).toBeTruthy();
    expect(screen.queryByLabelText(/Live/)).toBeNull();
  });

  it('a pin with no freshness is unknown: muted, and the label admits it', async () => {
    await renderMarkers([crewEntity()]);
    expect(screen.getByTestId('entity-pin-freshness-unknown')).toBeTruthy();
    // No freshness on the object → the label is the name alone; nothing is claimed.
    expect(screen.getByLabelText('Mai')).toBeTruthy();
  });
});
