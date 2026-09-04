/**
 * DiscoveryMapView — the §25 long-press gesture reaches the screen.
 *
 * ## The defect
 *
 * `app/map/index.tsx` held `longPress` state, rendered `MapLongPressMenu` and
 * wired `onClose`/`onSelect` — and nothing anywhere could ever SET a target.
 * `setLongPress` had no producer: this component, the only thing that owns a
 * touch on the map, declared no long-press prop and passed MapLibre's
 * `onLongPress` nowhere. Seven correctly-resolved menu rows behind a gesture
 * that did not exist.
 *
 * ## What is asserted, and why it is asserted here
 *
 * The SDK event is the part that can silently be wrong. `PressEvent` carries
 * `lngLat` in MapLibre's [lng, lat] order and this codebase uses {lat, lng}
 * everywhere else, so a swap would put every press on the other side of the
 * world while every type still checked. The order, the pixel anchor, and the
 * defensive reads are therefore asserted against a synthetic native event
 * rather than through a captured-prop spy.
 *
 * Deciding WHAT was under the press is not this component's job and is not
 * tested here — that is `features/map/interaction/pressTarget.ts`, which is
 * pure and has its own suite.
 *
 * Run: pnpm test:component  (matches --testPathPattern='\.component\.test\.')
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

// ── Module mocks (declared before any import that pulls the real module) ──────

// MapLibre native modules are unavailable under jest. This stub also HOLDS the
// props the Map was given, so the long-press handler can be invoked with a
// synthetic native event — there is no other way to deliver an SDK gesture.
jest.mock('@maplibre/maplibre-react-native', () => {
  const RN = jest.requireActual('react-native');
  const holder: { onLongPress?: (e: unknown) => void } = {};
  const Map = ({ children, onLongPress }: { children?: React.ReactNode; onLongPress?: (e: unknown) => void }) => {
    holder.onLongPress = onLongPress;
    return <RN.View testID="map-container">{children}</RN.View>;
  };
  const Camera = (_props: unknown) => <RN.View testID="map-camera" />;
  const Marker = ({ children }: { children?: React.ReactNode }) => (
    <RN.View testID="map-marker">{children}</RN.View>
  );
  return { __holder: holder, Map, Camera, Marker };
});

// NOTE: intentionally exhaustive — the real hook pulls Supabase and geolocation
// native modules that are unavailable under jest; a requireActual spread would
// crash before any test runs.
jest.mock('../../../hooks/useMapTravelers', () => ({
  useMapTravelers: () => ({ travelers: [], loading: false }),
}));

// NOTE: intentionally exhaustive — TravelerClusterMarkers depends on native
// MapLibre marker internals; spreading requireActual would import native modules
// unavailable in the jest-expo runner.
jest.mock('../TravelerMapLayer', () => ({
  TravelerClusterMarkers: () => null,
}));

// NOTE: intentionally exhaustive — TravelerPreviewCard imports native
// components that are not safe under jest.
jest.mock('../TravelerPreviewCard', () => ({
  TravelerPreviewCard: () => null,
}));

// SectionErrorBoundary: transparent passthrough so a throw inside the map
// surfaces as a failure rather than an empty tree.
jest.mock('../SectionErrorBoundary', () => {
  const RN = jest.requireActual('react-native');
  return {
    SectionErrorBoundary: ({ children }: { children?: React.ReactNode }) => (
      <RN.View>{children}</RN.View>
    ),
  };
});

// NOTE: intentionally exhaustive — discoverMapFilterStorage keeps a module-level
// memory cache that mutates across tests; a full stub avoids ordering deps.
jest.mock('../discoverMapFilterStorage', () => ({
  loadMapFilter: jest.fn().mockResolvedValue('all'),
  saveMapFilter: jest.fn(),
  removeMapFilter: jest.fn(),
  getCachedFilter: jest.fn().mockReturnValue(null),
  FILTER_STORAGE_KEY: 'discovery_map_filter',
}));

// NOTE: intentionally exhaustive — CachedImage resolves signed media URLs
// through the network/media layer.
jest.mock('../../CachedImage', () => {
  const RN = jest.requireActual('react-native');
  return { CachedImage: (_props: unknown) => <RN.View testID="cached-image" /> };
});

// ── Import under test (after mocks) ──────────────────────────────────────────

import { DiscoveryMapView } from '../DiscoveryMapView';
import type { MapEntity, ToggleableEntityType } from '../../../types/mapTypes.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

const noop = () => {};

/** Đà Nẵng — the fallback coords every case below renders at. */
const AT: [number, number] = [16.047079, 108.220518];

function mapHolder() {
  return (jest.requireMock('@maplibre/maplibre-react-native') as {
    __holder: { onLongPress?: (e: unknown) => void };
  }).__holder;
}

type Press = { lat: number; lng: number; screenX: number; screenY: number };

const ALL_LAYERS: ToggleableEntityType[] = ['buddies', 'events', 'gems', 'trips', 'friends'];

function entity(id: string, type: MapEntity['type'], lat: number, lng: number): MapEntity {
  return { id, type, lat, lng, payload: {} as never };
}

/**
 * Render, then hand back a `fire` that delivers a synthetic MapLibre
 * `PressEvent`, plus the presses the component reported.
 */
async function mountWithLongPress(
  props: Partial<React.ComponentProps<typeof DiscoveryMapView>> = {},
) {
  const reported: Press[] = [];
  await render(
    <DiscoveryMapView
      places={[]}
      onSelectPlace={noop}
      fallbackLat={AT[0]}
      fallbackLng={AT[1]}
      fallbackZoom={12}
      onLongPressMap={(p) => reported.push(p)}
      {...props}
    />,
  );
  await waitFor(() => expect(mapHolder().onLongPress).toBeDefined());
  return {
    reported,
    fire: (nativeEvent: unknown) => mapHolder().onLongPress!({ nativeEvent }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DiscoveryMapView — §25 long-press', () => {
  it('reports the pressed point, converting MapLibre [lng, lat] to {lat, lng}', async () => {
    const { reported, fire } = await mountWithLongPress();
    // The SDK's own shape: lngLat is [longitude, latitude], point is [x, y].
    fire({ lngLat: [108.220518, 16.047079], point: [180, 402] });

    expect(reported).toHaveLength(1);
    // The swap is the whole point of this assertion: 108 is a longitude and 16
    // is a latitude, and reading them in the wrong order lands in Somalia.
    expect(reported[0].lat).toBeCloseTo(16.047079, 6);
    expect(reported[0].lng).toBeCloseTo(108.220518, 6);
  });

  it('reports the pixel point, so the menu can open under the finger', async () => {
    const { reported, fire } = await mountWithLongPress();
    fire({ lngLat: [108.22, 16.05], point: [180, 402] });
    expect(reported[0].screenX).toBe(180);
    expect(reported[0].screenY).toBe(402);
  });

  it('does not subscribe at all when the surface wants no long-press', async () => {
    // Every other screen that renders this map — ForYouTab, DiscoveryCategoryTab,
    // LayoverMapCard — passes no handler and must keep the plain map gesture.
    await render(
      <DiscoveryMapView
        places={[]}
        onSelectPlace={noop}
        fallbackLat={AT[0]}
        fallbackLng={AT[1]}
        fallbackZoom={12}
      />,
    );
    await waitFor(() => expect(mapHolder().onLongPress).toBeUndefined());
  });

  it('drops a half-formed event rather than reporting a press that did not happen', async () => {
    const { reported, fire } = await mountWithLongPress();
    for (const bad of [
      {},
      { lngLat: [108.22, 16.05] },
      { point: [1, 2] },
      { lngLat: 'nope', point: [1, 2] },
      { lngLat: [Number.NaN, 16.05], point: [1, 2] },
      { lngLat: [108.22, undefined], point: [1, 2] },
      null,
      undefined,
    ]) {
      fire(bad);
    }
    // A press reported with a missing coordinate would open the menu naming a
    // place the user never touched, which is worse than no menu.
    expect(reported).toHaveLength(0);
  });

  it('a long press on a PIN reports that pin, not the map', async () => {
    // A `Marker` is a native view whose children are React Native views, so the
    // Pressable inside claims the touch and MapLibre's own long-press recogniser
    // never fires. Without the marker-level gesture, §25's `save`, `Add to Trip`
    // and `report` rows — every one of which needs an object — are unreachable.
    const reported: Press[] = [];
    await render(
      <DiscoveryMapView
        places={[]}
        onSelectPlace={noop}
        fallbackLat={AT[0]}
        fallbackLng={AT[1]}
        fallbackZoom={12}
        entities={[entity('event:e1', 'events', 16.05, 108.22)]}
        enabledEntityLayers={ALL_LAYERS}
        onSelectEntity={noop}
        onLongPressMap={(p) => reported.push(p)}
      />,
    );

    const pin = await screen.findByTestId('entity-pin-event:e1');
    await fireEvent(pin, 'longPress', { nativeEvent: { pageX: 210, pageY: 512 } });

    expect(reported).toHaveLength(1);
    // The PIN's own coordinate, not the finger's: a 32 pt pin pressed at its
    // edge is still a press on that pin, and at high zoom the finger's exact
    // position can sit outside the pin's own touch radius.
    expect(reported[0].lat).toBeCloseTo(16.05, 6);
    expect(reported[0].lng).toBeCloseTo(108.22, 6);
    expect(reported[0].screenX).toBe(210);
    expect(reported[0].screenY).toBe(512);
  });

  it('a long press on a pin does not ALSO select it', async () => {
    // React Native fires onPress after onLongPress on this stack — the reason
    // the filter row in this same component already carries a didLongPress
    // guard. Without it the carousel card and §8 sheet would open behind the
    // menu that just opened over them.
    const selected: string[] = [];
    await render(
      <DiscoveryMapView
        places={[]}
        onSelectPlace={noop}
        fallbackLat={AT[0]}
        fallbackLng={AT[1]}
        fallbackZoom={12}
        entities={[entity('event:e1', 'events', 16.05, 108.22)]}
        enabledEntityLayers={ALL_LAYERS}
        onSelectEntity={(e) => selected.push(e.id)}
        onLongPressMap={noop}
      />,
    );

    const pin = await screen.findByTestId('entity-pin-event:e1');
    await fireEvent(pin, 'longPress', { nativeEvent: { pageX: 1, pageY: 1 } });
    await fireEvent.press(pin);
    expect(selected).toEqual([]);

    // ...and the NEXT tap is a real tap again, not swallowed by a stale guard.
    await fireEvent.press(pin);
    expect(selected).toEqual(['event:e1']);
  });

  it('a plain tap on a pin still selects it', async () => {
    const selected: string[] = [];
    await render(
      <DiscoveryMapView
        places={[]}
        onSelectPlace={noop}
        fallbackLat={AT[0]}
        fallbackLng={AT[1]}
        fallbackZoom={12}
        entities={[entity('gem:g1', 'gems', 16.05, 108.22)]}
        enabledEntityLayers={ALL_LAYERS}
        onSelectEntity={(e) => selected.push(e.id)}
        onLongPressMap={noop}
      />,
    );
    await fireEvent.press(await screen.findByTestId('entity-pin-gem:g1'));
    expect(selected).toEqual(['gem:g1']);
  });

  it('a long press on a legacy Discovery place pin reports that pin', async () => {
    // These pins are the OTHER place family: they come from getDiscoveryPlaces
    // and have no MapObject, so the screen resolves them to a coordinate target
    // (see pressTarget.ts). The gesture still has to reach the menu, anchored on
    // the pin — a dead pin would be the worse outcome.
    const reported: Press[] = [];
    await render(
      <DiscoveryMapView
        places={[
          {
            id: 'node/1',
            name: 'Bến Xuân Café',
            category: 'food',
            lat: 16.05,
            lng: 108.22,
          } as never,
        ]}
        onSelectPlace={noop}
        fallbackLat={AT[0]}
        fallbackLng={AT[1]}
        fallbackZoom={12}
        onLongPressMap={(p) => reported.push(p)}
      />,
    );

    const pin = await screen.findByTestId('place-pin-node/1');
    await fireEvent(pin, 'longPress', { nativeEvent: { pageX: 33, pageY: 44 } });

    expect(reported).toHaveLength(1);
    expect(reported[0].lat).toBeCloseTo(16.05, 6);
    expect(reported[0].lng).toBeCloseTo(108.22, 6);
    expect(reported[0].screenX).toBe(33);
  });

  it('a long press on a place pin does not ALSO open it', async () => {
    const opened: string[] = [];
    await render(
      <DiscoveryMapView
        places={[
          {
            id: 'node/2',
            name: 'Bạch Đằng',
            category: 'places',
            lat: 16.05,
            lng: 108.22,
          } as never,
        ]}
        onSelectPlace={(p) => opened.push(p.id)}
        fallbackLat={AT[0]}
        fallbackLng={AT[1]}
        fallbackZoom={12}
        onLongPressMap={noop}
      />,
    );

    const pin = await screen.findByTestId('place-pin-node/2');
    await fireEvent(pin, 'longPress', { nativeEvent: { pageX: 1, pageY: 1 } });
    await fireEvent.press(pin);
    expect(opened).toEqual([]);

    await fireEvent.press(pin);
    expect(opened).toEqual(['node/2']);
  });

  it('a long press on one place pin does not swallow the next tap on another', async () => {
    // The guard is keyed on the pin, not a shared boolean: one flag for every
    // pin would eat an unrelated tap on the neighbouring one.
    const opened: string[] = [];
    await render(
      <DiscoveryMapView
        places={[
          { id: 'node/3', name: 'A', category: 'food', lat: 16.05, lng: 108.22 } as never,
          { id: 'node/4', name: 'B', category: 'food', lat: 16.06, lng: 108.23 } as never,
        ]}
        onSelectPlace={(p) => opened.push(p.id)}
        fallbackLat={AT[0]}
        fallbackLng={AT[1]}
        fallbackZoom={12}
        onLongPressMap={noop}
      />,
    );

    await fireEvent(await screen.findByTestId('place-pin-node/3'), 'longPress', {
      nativeEvent: { pageX: 1, pageY: 1 },
    });
    await fireEvent.press(await screen.findByTestId('place-pin-node/4'));
    expect(opened).toEqual(['node/4']);
  });

  it('keeps the coordinate when only the pixel point is unusable', async () => {
    const { reported, fire } = await mountWithLongPress();
    fire({ lngLat: [108.22, 16.05], point: [Number.NaN, 402] });
    // The anchor merely positions the card, and the menu centres itself when it
    // cannot be placed — losing it must not cost the press.
    expect(reported).toHaveLength(1);
    expect(reported[0].lat).toBeCloseTo(16.05, 6);
    expect(reported[0].screenX).toBe(0);
  });
});
