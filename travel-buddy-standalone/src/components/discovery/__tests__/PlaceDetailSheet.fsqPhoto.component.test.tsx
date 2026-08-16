/**
 * PlaceDetailSheet — Google photo fallback rendering test
 *
 * Confirms that when `useFsqPhoto` resolves a Google photo URL (i.e. Foursquare
 * was empty but the Google Places fallback succeeded), the sheet passes that URL
 * to `DisplayMediaImage` and the category-icon fallback block is NOT rendered.
 *
 * Without this test a component that ignores the hook return value — or passes
 * it to the wrong prop — would silently show the category icon even when a real
 * photo is available.
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

// NOTE: useFsqPhoto is the core subject of this test — controlled per-test
// via mockReturnValue to simulate Foursquare-empty / Google-resolved scenarios.
const mockUseFsqPhoto = jest.fn<string | null, [string, number | null | undefined, number | null | undefined, string | null | undefined]>();
jest.mock('../../../hooks/useFsqPhoto', () => ({
  useFsqPhoto: (...args: [string, number | null | undefined, number | null | undefined, string | null | undefined]) =>
    mockUseFsqPhoto(...args),
}));

// NOTE: Capture the `uri` prop passed to DisplayMediaImage so the test can
// assert the Google URL actually reached the image component. The mock renders
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
// provider URL path.
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
// isEnabled returns false so the admin "Generate header image" button is hidden
// — it is not relevant to the photo-rendering path under test.
jest.mock('../../../context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: () => false }),
}));

// NOTE: intentionally exhaustive — SessionContext reads Supabase auth;
// role set to 'viewer' (non-admin) matches the isEnabled:false stub above.
jest.mock('../../../context/SessionContext', () => ({
  useSession: () => ({ role: 'viewer', userId: 'user-1' }),
}));

// NOTE: intentionally exhaustive — spreading requireActual pulls in native font
// loader internals that crash under jest-expo; plain value stubs suffice.

// NOTE: GenerateHeaderSheet is hidden in these tests (canGenerateHeader=false)
// but must be present to avoid a missing-module error.
jest.mock('../../events/GenerateHeaderSheet', () => ({
  GenerateHeaderSheet: () => null,
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const GOOGLE_PHOTO_URL = 'https://lh3.googleusercontent.com/places/google-test-photo.jpg';

/** Place with no pre-existing header image — forces the hook to fetch. */
const PLACE: DiscoveryPlace = {
  id:               'place-fsq-1',
  name:             'Kyoto Ramen',
  category:         'restaurant',
  type:             'ramen',
  description:      null,
  distanceKm:       null,
  lat:              35.0116,
  lng:              135.7681,
  tags:             [],
  address:          '12 Nishiki Alley, Kyoto',
  website:          null,
  phone:            null,
  openingHours:     null,
  rating:           null,
  isOpenNow:        null,
  headerImageUrl:   null,
  headerImageSource: null,
};

// ── Mount helper ──────────────────────────────────────────────────────────────

async function mountSheet() {
  return render(
    <PlaceDetailSheet
      place={PLACE}
      visible
      onClose={jest.fn()}
      onAddToPlan={jest.fn()}
    />,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PlaceDetailSheet — Google photo fallback rendering', () => {
  beforeEach(() => {
    capturedUri = undefined;
  });

  afterEach(() => jest.clearAllMocks());

  it('passes the Google photo URL to DisplayMediaImage when useFsqPhoto resolves one', async () => {
    // Simulate: Foursquare was empty, Google Places resolved a real photo.
    mockUseFsqPhoto.mockReturnValue(GOOGLE_PHOTO_URL);

    const { getByTestId } = await mountSheet();

    await waitFor(() => {
      expect(getByTestId('place-sheet-image')).toBeTruthy();
    });

    // The URL the hook returned must have reached the image component.
    expect(capturedUri).toBe(GOOGLE_PHOTO_URL);
  });

  it('does NOT render the category-icon fallback when useFsqPhoto resolves a Google URL', async () => {
    mockUseFsqPhoto.mockReturnValue(GOOGLE_PHOTO_URL);

    const { queryByTestId } = await mountSheet();

    await waitFor(() => {
      // Image container must be present.
      expect(queryByTestId('place-sheet-image')).toBeTruthy();
    });

    // Category fallback must be absent — a real photo is available.
    expect(queryByTestId('sheet-media-fallback')).toBeNull();
  });

  it('DOES render the category-icon fallback when useFsqPhoto returns null (no photo found)', async () => {
    // Baseline: confirm the fallback path works when neither FSQ nor Google resolves.
    mockUseFsqPhoto.mockReturnValue(null);

    const { getByTestId } = await mountSheet();

    await waitFor(() => {
      expect(getByTestId('sheet-media-fallback')).toBeTruthy();
    });
  });
});
