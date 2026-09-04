/**
 * EntityMarkers reads the PROJECTED payload — regression guard.
 *
 * The map's PIN renderers had the same bug as its card renderers: `BuddyMarker`
 * and `FriendMarker` took `entity: MapEntity<BuddyProfile>` /
 * `MapEntity<CircleMemberLocation>` behind `as MapEntity<Dto>` casts at the
 * dispatch site, and read `entity.payload.coverPhotoUrl` / `.avatarUrl`. Since
 * the producers switched to `MapObject`, `entity.payload` is the projected
 * object and those fields live one level deeper — so both reads were always
 * `undefined` and EVERY buddy pin drew the generic glyph while EVERY circle-member
 * pin drew the fallback heart.
 *
 * It degraded silently rather than throwing, and the one existing test that
 * mounts these markers
 * (src/components/discovery/__tests__/DiscoveryMapView.entityLayers.component.test.tsx)
 * builds its entities with `payload: {} as never` and says so in a comment: it
 * covers the ICON branch only. This file covers the IMAGE branch, with entities
 * built by the real projectors — which is the only way the difference shows up.
 */

import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { EntityMapLayers } from '../EntityMarkers.tsx';
import type { MapEntity, ToggleableEntityType } from '../../../types/mapTypes.ts';
import { buddyEntity, friendEntity } from '../../../__fixtures__/mapEntities.ts';

// ── Module mocks ───────────────────────────────────────────────────────────────

// NOTE: intentional stub — @maplibre/maplibre-react-native needs a native module
// that jest-expo does not provide; requireActual crashes the suite. Mirrors the
// mock in DiscoveryMapView.entityLayers.component.test.tsx.
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

// NOTE: intentional stub — CachedImage does disk I/O and native image decoding.
// The testID carries the URI so a test can assert WHICH image was requested;
// asserting only "an image rendered" would not distinguish the fix from the bug.
jest.mock('../../CachedImage.tsx', () => {
  const RN = jest.requireActual('react-native');
  return {
    CachedImage: ({ source }: { source?: { uri?: string } }) => (
      <RN.View testID={`cached-image:${source?.uri ?? 'none'}`} />
    ),
  };
});

// ── Harness ───────────────────────────────────────────────────────────────────

const LAYERS: ToggleableEntityType[] = ['buddies', 'events', 'gems', 'trips', 'friends'];

function renderMarkers(entities: MapEntity[]) {
  return render(
    <EntityMapLayers
      entities={entities}
      enabledLayers={LAYERS}
      // High zoom so nothing clusters — clustering would replace the individual
      // markers with a count bubble and silently skip the code under test.
      zoom={18}
      onSelectEntity={jest.fn()}
      onPressCluster={jest.fn()}
    />,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EntityMarkers reads the projected payload', () => {
  it('a buddy pin renders the cover photo the projector put on the payload', async () => {
    const url = 'https://cdn.example/buddy-cover.jpg';
    await renderMarkers([buddyEntity({ coverPhotoUrl: url })]);
    // Reading entity.payload.coverPhotoUrl instead gives undefined, the ternary
    // falls through to the <Users> glyph, and this testID never exists.
    expect(screen.getByTestId(`cached-image:${url}`)).toBeTruthy();
  });

  it('a buddy pin with no cover photo falls back without rendering an image', async () => {
    await renderMarkers([buddyEntity({ coverPhotoUrl: null })]);
    expect(screen.queryByTestId('cached-image:none')).toBeNull();
    expect(screen.queryByTestId('cached-image:undefined')).toBeNull();
  });

  it('a circle-member pin renders the avatar the projector put on the payload', async () => {
    const url = 'https://cdn.example/friend-avatar.jpg';
    await renderMarkers([friendEntity({ avatarUrl: url })]);
    expect(screen.getByTestId(`cached-image:${url}`)).toBeTruthy();
  });

  it('a circle-member pin with no avatar falls back without rendering an image', async () => {
    await renderMarkers([friendEntity({ avatarUrl: null })]);
    expect(screen.queryByTestId('cached-image:none')).toBeNull();
    expect(screen.queryByTestId('cached-image:undefined')).toBeNull();
  });

  it('renders a marker for every projected kind without crashing', async () => {
    const entities = [buddyEntity(), friendEntity()];
    await renderMarkers(entities);
    expect(screen.getAllByTestId('map-marker').length).toBeGreaterThanOrEqual(entities.length);
  });
});
