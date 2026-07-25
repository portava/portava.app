/**
 * MapEntityPreviewCard — place-type label test
 *
 * Confirms that when a place entity is shown on the map preview card the
 * rendered secondary label is the SPECIFIC type (e.g. "café", "landmark") and
 * not just the generic top-level category string ("food", "places").
 *
 * Run with: pnpm test:component
 *
 * RNTL v14: render() is async — always await.
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { MapEntityPreviewCard } from '../MapEntityPreviewCard.tsx';
import type { MapEntity } from '../../../types/mapTypes.ts';
import type { DiscoveryPlace } from '../../../services/discovery.ts';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — expo-router has native navigation state
// internals that are not safe under jest-expo; only router.push is needed.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
}));

// NOTE: intentionally exhaustive — expo-image pulls in native modules that
// crash under jest-expo; the fallback branch is all we need for image tests.
jest.mock('../../ui/DisplayMediaImage.tsx', () => ({
  DisplayMediaImage: ({ uri, fallback, children, testID }: any) => {
    const { View } = require('react-native');
    if (!uri && fallback) return <View testID={testID ?? 'dmi'}>{fallback}</View>;
    return <View testID={testID ?? 'dmi'}>{children ?? null}</View>;
  },
  MediaFallback: ({ icon }: any) => {
    const { View } = require('react-native');
    return <View testID="map-preview-fallback">{icon ?? null}</View>;
  },
  AvatarImage: ({ children }: any) => {
    const { View } = require('react-native');
    return <View>{children ?? null}</View>;
  },
}));

// NOTE: intentionally exhaustive — messaging.ts makes real fetch calls;
// only the return shape is needed for the FriendCard branch (irrelevant here).
jest.mock('../../../services/messaging.ts', () => ({
  openDirectThread: jest.fn().mockResolvedValue({ ok: true, data: { threadId: 'thread-1' } }),
}));

// NOTE: intentionally exhaustive — MapEntityActionRow imports its own
// service/hook chain; stubbing to null isolates the card-body assertions.
jest.mock('../MapEntityActionRow.tsx', () => ({
  MapEntityActionRow: () => null,
}));

// NOTE: intentionally exhaustive — spreading requireActual pulls in native font
// loader internals that crash under jest-expo; plain value stubs suffice.
jest.mock('../../../theme/tokens', () => ({
  color: {
    deep:        '#2A7F8F',
    ink:         '#1A1A2E',
    signal:      '#FF6B6B',
    mute:        '#9B9B9B',
    faint:       '#CCCCCC',
    paper:       '#FFFFFF',
    paperRaised: '#F9F9F9',
    haze:        '#E8E8E8',
    onInk:       '#FFFFFF',
    success:     '#16A34A',
  },
  space:  { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 },
  radius: { sm: 4, md: 8, lg: 12, pill: 999 },
  type:   { heading: {}, bodyStrong: {}, body: {}, small: {}, stamp: {} },
  shadow: { card: {}, float: {} },
}));

// NOTE: intentionally exhaustive — MAP_LAYER_CONFIG imports map-native
// internals; only the color + label per entity type is needed here.
jest.mock('../../../types/mapTypes', () => ({
  MAP_LAYER_CONFIG: {
    places:  { color: '#0A6EBD', label: 'Place' },
    buddies: { color: '#7C3AED', label: 'Buddy' },
    events:  { color: '#B45309', label: 'Event' },
    gems:    { color: '#2E7D5B', label: 'Gem' },
    trips:   { color: '#0891B2', label: 'Trip' },
    friends: { color: '#D4722A', label: 'Friend' },
    stamps:  { color: '#475569', label: 'Stamp' },
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makePlaceEntity(overrides: Partial<DiscoveryPlace> = {}): MapEntity<DiscoveryPlace> {
  const place: DiscoveryPlace = {
    id:           'map-place-1',
    name:         'Eiffel Tower',
    category:     'places',
    type:         'landmark',     // ← specific sub-type
    description:  null,
    distanceKm:   0.5,
    lat:          48.8584,
    lng:          2.2945,
    tags:         [],
    address:      'Champ de Mars, Paris',
    website:      null,
    phone:        null,
    openingHours: null,
    rating:       4.8,
    isOpenNow:    true,
    ...overrides,
  };

  return {
    id:          place.id,
    type:        'places',
    lat:         place.lat!,
    lng:         place.lng!,
    payload:     place,
    detailRoute: `/place/${place.id}`,
    actionCapabilities: [],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MapEntityPreviewCard — place type label', () => {
  afterEach(() => jest.clearAllMocks());

  it('shows the specific type label ("landmark") not the generic category ("places")', async () => {
    const entity = makePlaceEntity({ type: 'landmark', category: 'places' });

    const { getByTestId } = await render(
      <MapEntityPreviewCard entity={entity} onClose={jest.fn()} />,
    );

    await waitFor(() => {
      const typeEl = getByTestId('place-preview-type');
      expect(typeEl.props.children).toContain('landmark');
    });
  });

  it('falls back to the category when type is null', async () => {
    const entity = makePlaceEntity({ type: null, category: 'places' });

    const { getByTestId } = await render(
      <MapEntityPreviewCard entity={entity} onClose={jest.fn()} />,
    );

    await waitFor(() => {
      const typeEl = getByTestId('place-preview-type');
      // Category "places" shown when no specific type available
      expect(typeEl.props.children).toContain('places');
    });
  });

  it('renders the category fallback image block (not text-only)', async () => {
    const entity = makePlaceEntity({ type: 'café', category: 'food' });

    const { getByTestId } = await render(
      <MapEntityPreviewCard entity={entity} onClose={jest.fn()} />,
    );

    await waitFor(() => {
      // MediaFallback testID confirms image area is present — never text-only
      expect(getByTestId('map-preview-fallback')).toBeTruthy();
    });
  });
});
