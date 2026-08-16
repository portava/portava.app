/**
 * PlaceDetailSheet — OSM image fallback rendering test
 *
 * Confirms that when `headerImageUrl` is null and `useFsqPhoto` returns null,
 * PlaceDetailSheet uses `osmImageUrl` as the header image source — not
 * silently falling through to the category-icon fallback.
 *
 * Task 3684 added osmImageUrl as the lowest-priority header image candidate.
 * This test ensures the wiring is correct: the URL actually reaches
 * DisplayMediaImage rather than being dropped by the resolver.
 *
 * ## Modal strategy
 * PlaceDetailSheet IS a Modal. The Modal Proxy replaces react-native's Modal
 * with a synchronous View so act() scopes don't overlap.
 * Must be declared before any imports that touch react-native.
 *
 * Run with: pnpm test:component
 */

// NOTE: Modal Proxy — must be hoisted above all react-native imports.
// Avoids overlapping act() from Modal animation lifecycle — see
// .agents/memory/modal-proxy-mock.md.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({ children, visible }: { children: React.ReactNode; visible: boolean }) =>
    visible ? R.createElement(actual.View, null, children) : null;
  return new Proxy(actual, {
    get(target: typeof actual, prop: string, receiver: unknown) {
      if (prop === 'Modal') return MockModal;
      return Reflect.get(target, prop, receiver);
    },
  });
});

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { PlaceDetailSheet } from '../PlaceDetailSheet.tsx';
import type { DiscoveryPlace } from '../../../services/discovery.ts';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — the real discovery module imports Supabase
// native internals; only getPlaceLiveStatus is needed and its return value is
// controlled entirely by this stub.
jest.mock('../../../services/discovery', () => ({
  getPlaceLiveStatus: jest.fn().mockResolvedValue(null),
  getWikidataEnrichment: jest.fn().mockResolvedValue(null),
}));

// NOTE: intentionally exhaustive — collections imports Supabase native modules
// that are not safe under jest-expo; only the stubs are needed.
jest.mock('../../../services/collections', () => ({
  checkSaved: jest.fn().mockResolvedValue({ saved: false }),
  toggleSave:  jest.fn().mockResolvedValue(false),
}));

// NOTE: TripWishlistPicker has its own Modal chain; null prevents a secondary
// act() scope from leaking into this test.
jest.mock('../TripWishlistPicker', () => ({
  TripWishlistPicker: () => null,
}));

// NOTE: intentionally exhaustive — useBottomInset reads safe-area native
// modules that crash under jest-expo; a constant inset of 0 is sufficient.
jest.mock('../../../hooks/useBottomInset', () => ({
  usePlainBottomInset: () => 0,
}));

// NOTE: useFsqPhoto is controlled per-test to simulate the scenario where
// neither Foursquare nor Google Places finds a photo, so osmImageUrl is the
// only real candidate.
const mockUseFsqPhoto = jest.fn<string | null, [string, number | null | undefined, number | null | undefined, string | null | undefined]>();
jest.mock('../../../hooks/useFsqPhoto', () => ({
  useFsqPhoto: (...args: [string, number | null | undefined, number | null | undefined, string | null | undefined]) =>
    mockUseFsqPhoto(...args),
}));

// NOTE: Capture the `uri` prop passed to DisplayMediaImage so the test can
// assert the OSM URL actually reached the image component. The mock renders
// the fallback only when uri is falsy — matching real component behavior.
let capturedUri: string | null | undefined;
jest.mock('../../ui/DisplayMediaImage.tsx', () => ({
  DisplayMediaImage: ({ uri, fallback, testID }: any) => {
    capturedUri = uri;
    const { View } = require('react-native');
    if (!uri && fallback) return <View testID={testID ?? 'sheet-img'}>{fallback}</View>;
    return <View testID={testID ?? 'sheet-img'} />;
  },
  MediaFallback: () => {
    const { View } = require('react-native');
    return <View testID="sheet-media-fallback" />;
  },
}));

// NOTE: AiRepresentationLabel forwards the testID prop; stub to a plain View
// so the assertion is reliable without pulling in lucide-react-native.
jest.mock('../../visuals/AiRepresentationLabel.tsx', () => ({
  AiRepresentationLabel: ({ testID }: { testID?: string }) => {
    const { View } = require('react-native');
    return <View testID={testID ?? 'ai-label'} />;
  },
}));

// NOTE: ImageSourceBadge reads accuracy-pipeline fields; stub so it never
// renders in these tests (sourceLabel will be null for the fixture place).
jest.mock('../../visuals/ImageSourceBadge.tsx', () => ({
  ImageSourceBadge: () => null,
}));

// NOTE: intentionally exhaustive — fallbackUriFor calls require() on bundled
// assets that are not available in jest; returning null means no
// category_fallback candidate is injected, isolating the test to the
// osmImageUrl path.
jest.mock('../../../lib/visuals/fallbackAssets', () => ({
  fallbackUriFor: jest.fn().mockReturnValue(null),
}));

// NOTE: intentionally exhaustive — getPlaceCategoryFallback reads a static
// mapping; a fixed stub avoids pulling in transitively imported modules.
jest.mock('../../../utils/placeCategoryFallback', () => ({
  getPlaceCategoryFallback: jest.fn().mockReturnValue({
    emoji: '📍',
    label: 'Place',
    color: '#AAAAAA',
  }),
}));

// NOTE: intentionally exhaustive — LocationContext reads session + GPS state
// from multiple native hooks; resolvedLocation null is sufficient here.
jest.mock('../../../context/LocationContext', () => ({
  useLocationContext: () => ({ resolvedLocation: null }),
}));

// NOTE: intentionally exhaustive — FeatureFlagsContext reads Supabase;
// isEnabled returns false so the admin "Generate header image" button is
// hidden — it is not relevant to the OSM photo-rendering path under test.
jest.mock('../../../context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: () => false }),
}));

// NOTE: intentionally exhaustive — SessionContext reads Supabase auth;
// role set to 'viewer' (non-admin) matches the isEnabled:false stub above.
jest.mock('../../../context/SessionContext', () => ({
  useSession: () => ({ role: 'viewer', userId: 'user-1' }),
}));

// NOTE: GenerateHeaderSheet is hidden in these tests (canGenerateHeader=false)
// but must be present to avoid a missing-module error.
jest.mock('../../events/GenerateHeaderSheet', () => ({
  GenerateHeaderSheet: () => null,
}));

// ── Constants ─────────────────────────────────────────────────────────────────

const OSM_IMAGE_URL = 'https://upload.wikimedia.org/wikipedia/commons/osm-test-image.jpg';

// ── Fixture ───────────────────────────────────────────────────────────────────

/** Place with no headerImageUrl so osmImageUrl is the only real candidate. */
const PLACE: DiscoveryPlace = {
  id:                'place-osm-sheet-1',
  name:              'Rizal Park',
  category:          'places',
  type:              'park',
  description:       null,
  distanceKm:        null,
  lat:               14.5832,
  lng:               120.9794,
  tags:              [],
  address:           'Roxas Boulevard, Manila',
  website:           null,
  phone:             null,
  openingHours:      null,
  rating:            null,
  isOpenNow:         null,
  headerImageUrl:    null,
  headerImageSource: null,
};

// ── Mount helper ──────────────────────────────────────────────────────────────

async function mountSheet(overrides: Partial<DiscoveryPlace> = {}) {
  return render(
    <PlaceDetailSheet
      place={{ ...PLACE, ...overrides }}
      visible
      onClose={jest.fn()}
      onAddToPlan={jest.fn()}
    />,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PlaceDetailSheet — OSM image fallback', () => {
  beforeEach(() => {
    capturedUri = undefined;
  });

  afterEach(() => jest.clearAllMocks());

  it('passes osmImageUrl to DisplayMediaImage when headerImageUrl and FSQ are both null', async () => {
    // useFsqPhoto returns null — no Foursquare or Google photo available.
    mockUseFsqPhoto.mockReturnValue(null);

    const { getByTestId } = await mountSheet({ osmImageUrl: OSM_IMAGE_URL });

    await waitFor(() => {
      expect(getByTestId('place-sheet-image')).toBeTruthy();
    });

    // The OSM image URL must have reached the image component.
    expect(capturedUri).toBe(OSM_IMAGE_URL);
  });

  it('does NOT render the category-icon fallback when osmImageUrl is the only real candidate', async () => {
    mockUseFsqPhoto.mockReturnValue(null);

    const { queryByTestId } = await mountSheet({ osmImageUrl: OSM_IMAGE_URL });

    await waitFor(() => {
      expect(queryByTestId('place-sheet-image')).toBeTruthy();
    });

    // Category fallback must be absent — an OSM photo is available.
    expect(queryByTestId('sheet-media-fallback')).toBeNull();
  });

  it('DOES render the category-icon fallback when osmImageUrl is also null', async () => {
    // Baseline: confirm the fallback path works when no candidate at all exists.
    mockUseFsqPhoto.mockReturnValue(null);

    const { getByTestId } = await mountSheet({ osmImageUrl: null });

    await waitFor(() => {
      expect(getByTestId('sheet-media-fallback')).toBeTruthy();
    });
  });

  it('prefers a FSQ photo over osmImageUrl when both are present', async () => {
    // useFsqPhoto resolved a real photo — it must win over osmImageUrl.
    const FSQ_URL = 'https://fastly.4sqi.net/img/general/original/venue-photo.jpg';
    mockUseFsqPhoto.mockReturnValue(FSQ_URL);

    await mountSheet({ osmImageUrl: OSM_IMAGE_URL });

    await waitFor(() => {
      expect(capturedUri).toBe(FSQ_URL);
    });

    expect(capturedUri).not.toBe(OSM_IMAGE_URL);
  });

  it('prefers headerImageUrl over osmImageUrl when headerImageUrl is set', async () => {
    const HEADER_URL = 'https://images.example.com/official-photo.jpg';
    mockUseFsqPhoto.mockReturnValue(null);

    await mountSheet({
      headerImageUrl:    HEADER_URL,
      headerImageSource: 'provider',
      osmImageUrl:       OSM_IMAGE_URL,
    });

    await waitFor(() => {
      expect(capturedUri).toBe(HEADER_URL);
    });

    expect(capturedUri).not.toBe(OSM_IMAGE_URL);
  });
});
