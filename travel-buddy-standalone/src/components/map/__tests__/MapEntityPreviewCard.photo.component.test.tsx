/**
 * MapEntityPreviewCard — Google photo resolution test
 *
 * Confirms that when `useFsqPhoto` resolves a real photo URL the URL actually
 * reaches `DisplayMediaImage` and the category-icon fallback is NOT rendered.
 * A component that ignored the hook return value would silently show the
 * category icon on map popups even when a real photo is available.
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

// ── Constants ─────────────────────────────────────────────────────────────────

const GOOGLE_PHOTO_URL =
  'https://lh3.googleusercontent.com/places/photo-ABCtest123';

// Collect every uri prop received by DisplayMediaImage across renders so the
// assertion does not depend on render timing subtleties.
const capturedUris: Array<string | null> = [];

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — expo-router pulls in native navigation
// state that is unsafe under jest-expo.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
}));

// NOTE: intentionally exhaustive — expo-image pulls in native modules that
// crash under jest-expo; the factory captures `uri` so the assertion can
// confirm the resolved URL flows through, while the fallback branch preserves
// map-preview-fallback queryability for the no-photo case.
jest.mock('../../ui/DisplayMediaImage.tsx', () => ({
  DisplayMediaImage: ({ uri, fallback, testID }: any) => {
    const { View } = require('react-native');
    capturedUris.push(uri ?? null);
    if (!uri && fallback) return <View testID={testID ?? 'dmi'}>{fallback}</View>;
    return <View testID={testID ?? 'dmi'} />;
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

// NOTE: messaging.ts makes real fetch calls; stub to isolate the card test.
jest.mock('../../../services/messaging.ts', () => ({
  openDirectThread: jest.fn().mockResolvedValue({ ok: true, data: { threadId: 't1' } }),
}));

// NOTE: MapEntityActionRow imports its own service/hook chain — stub to null
// so it doesn't pull in untested dependencies.
jest.mock('../MapEntityActionRow.tsx', () => ({
  MapEntityActionRow: () => null,
}));

// NOTE: theme/tokens spreads native font-loader internals that crash under
// jest-expo; plain value stubs are sufficient.
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

// NOTE: MAP_LAYER_CONFIG imports map-native internals; only color + label
// per entity type is needed here.
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

// NOTE: intentionally exhaustive — this is the hook under test; returning a
// fixed Google URL isolates the card rendering from the real FSQ/Google fetch
// chain without needing network access.
jest.mock('../../../hooks/useFsqPhoto.ts', () => ({
  useFsqPhoto: jest.fn().mockReturnValue(GOOGLE_PHOTO_URL),
}));

// NOTE: intentionally exhaustive — resolveHeaderImage pulls in native image
// scoring internals; the stub passes the first candidate's URL through so the
// resolved URL flows into DisplayMediaImage for assertion.
jest.mock('../../../lib/visuals/resolveHeaderImage.ts', () => ({
  resolveHeaderImage: jest.fn((candidates: any[]) => {
    if (!candidates || candidates.length === 0) return null;
    const first = candidates[0];
    return {
      url:               first.url,
      source:            first.source ?? 'provider',
      isRepresentation:  false,
      imageSourceType:   first.imageSourceType ?? null,
      disclaimerRequired: false,
      disclaimerText:    null,
    };
  }),
}));

// NOTE: intentionally exhaustive — fallbackAssets reads bundled asset files
// that are unavailable under jest-expo; returning null is correct here because
// the test exercises the photo-resolved code path, not the fallback path.
jest.mock('../../../lib/visuals/fallbackAssets.ts', () => ({
  fallbackUriFor: jest.fn().mockReturnValue(null),
}));

// NOTE: intentionally exhaustive — usePlaceImage computes accessibility and
// disclaimer metadata from the resolved URL; forwarding url directly lets the
// component proceed to render DisplayMediaImage without crashing.
jest.mock('../../../hooks/usePlaceImage.ts', () => ({
  usePlaceImage: jest.fn(({ url }: any) => ({
    url:               url ?? null,
    accessibilityLabel: 'Test place photo',
    sourceLabel:       null,
    disclaimerRequired: false,
    disclaimerText:    null,
  })),
}));

// NOTE: intentionally exhaustive — placeCategoryFallback reads a large
// category-to-emoji mapping; only the emoji/color/label shape is needed for
// the card fallback branch in this test.
jest.mock('../../../utils/placeCategoryFallback.ts', () => ({
  getPlaceCategoryFallback: jest.fn().mockReturnValue({
    emoji: '📍',
    color: '#0A6EBD',
    label: 'Place',
  }),
}));

// NOTE: intentionally exhaustive — AiRepresentationLabel imports styled
// native components that crash under jest-expo; returning null is safe because
// the photo-resolved path never shows the AI label.
jest.mock('../../visuals/AiRepresentationLabel.tsx', () => ({
  AiRepresentationLabel: () => null,
}));

// NOTE: intentionally exhaustive — ImageSourceBadge renders a pressable sheet
// with native internals; the test only exercises photo rendering, not badge UI.
jest.mock('../../visuals/ImageSourceBadge.tsx', () => ({
  ImageSourceBadge: () => null,
}));

// NOTE: intentionally exhaustive — deferredNavigate uses a timer + router
// that are unsafe under jest-expo; the CTA press is not exercised in this test.
jest.mock('../../../lib/deferredNavigate.ts', () => ({
  closeThenNavigate: jest.fn(),
}));

// ── Fixture ───────────────────────────────────────────────────────────────────

function makePlaceEntity(
  overrides: Partial<DiscoveryPlace> = {},
): MapEntity<DiscoveryPlace> {
  const place: DiscoveryPlace = {
    id:           'place-photo-test',
    name:         'Blue Bottle Coffee',
    category:     'food',
    type:         'café',
    description:  null,
    distanceKm:   0.3,
    lat:          37.7749,
    lng:          -122.4194,
    tags:         [],
    address:      '300 Webster St, San Francisco',
    website:      null,
    phone:        null,
    openingHours: null,
    rating:       4.5,
    isOpenNow:    true,
    ...overrides,
  };
  return {
    id:                 place.id,
    type:               'places',
    lat:                place.lat!,
    lng:                place.lng!,
    payload:            place,
    detailRoute:        `/place/${place.id}`,
    actionCapabilities: [],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MapEntityPreviewCard — Google photo resolution', () => {
  beforeEach(() => {
    capturedUris.length = 0;
  });
  afterEach(() => jest.clearAllMocks());

  it('passes the resolved Google photo URL to DisplayMediaImage', async () => {
    const entity = makePlaceEntity();

    await render(<MapEntityPreviewCard entity={entity} onClose={jest.fn()} />);

    await waitFor(() => {
      expect(capturedUris).toContain(GOOGLE_PHOTO_URL);
    });
  });

  it('does not render the category-icon fallback when a photo URL is resolved', async () => {
    const entity = makePlaceEntity();

    const { queryByTestId } = await render(
      <MapEntityPreviewCard entity={entity} onClose={jest.fn()} />,
    );

    await waitFor(() => {
      // The fallback View (map-preview-fallback) must be absent when a real
      // photo URL is in play — the category emoji must not be shown.
      expect(queryByTestId('map-preview-fallback')).toBeNull();
    });
  });

  it('renders the category-icon fallback when useFsqPhoto returns null', async () => {
    // Reconfigure the hook mock to return null for this case only.
    const { useFsqPhoto } = require('../../../hooks/useFsqPhoto.ts') as {
      useFsqPhoto: jest.Mock;
    };
    useFsqPhoto.mockReturnValueOnce(null);

    const entity = makePlaceEntity();

    const { getByTestId } = await render(
      <MapEntityPreviewCard entity={entity} onClose={jest.fn()} />,
    );

    await waitFor(() => {
      // When no photo is available the fallback emoji block must appear.
      expect(getByTestId('map-preview-fallback')).toBeTruthy();
    });
  });
});
