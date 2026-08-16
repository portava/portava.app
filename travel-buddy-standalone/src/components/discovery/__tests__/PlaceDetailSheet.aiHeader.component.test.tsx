/**
 * PlaceDetailSheet — AI header image immediate-update test
 *
 * Confirms that when a place admin accepts a generated image via
 * GenerateHeaderSheet, the onAccepted callback fires with the new URL,
 * localAiHeaderUrl state is set, and the AI disclosure label
 * (testID="place-sheet-ai-label") becomes visible immediately — without
 * the admin needing to close and reopen the sheet.
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
import { render, fireEvent, waitFor } from '@testing-library/react-native';
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

// NOTE: useFsqPhoto makes network calls; stub to null so only localAiHeaderUrl
// influences the candidate list during the accept flow.
jest.mock('../../../hooks/useFsqPhoto', () => ({
  useFsqPhoto: jest.fn().mockReturnValue(null),
}));

// NOTE: expo-image pulls in native modules that crash under jest-expo; the
// testID prop is forwarded so assertions can locate the image wrapper.
jest.mock('../../ui/DisplayMediaImage.tsx', () => ({
  DisplayMediaImage: ({ uri, fallback, testID }: any) => {
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
// so the assertion `getByTestId('place-sheet-ai-label')` is reliable without
// pulling in lucide-react-native or native font loaders.
jest.mock('../../visuals/AiRepresentationLabel.tsx', () => ({
  AiRepresentationLabel: ({ testID }: { testID?: string }) => {
    const { View } = require('react-native');
    return <View testID={testID ?? 'ai-label'} />;
  },
}));

// NOTE: intentionally exhaustive — fallbackUriFor calls require() on bundled
// assets that are not available in jest; returning null means no
// category_fallback candidate is injected, isolating the test to the
// ai_generated path.
jest.mock('../../../lib/visuals/fallbackAssets', () => ({
  fallbackUriFor: jest.fn().mockReturnValue(null),
}));

// NOTE: intentionally exhaustive — getPlaceCategoryFallback reads a static
// mapping; a fixed stub avoids pulling in any transitively imported modules.
jest.mock('../../../utils/placeCategoryFallback', () => ({
  getPlaceCategoryFallback: jest.fn().mockReturnValue({
    emoji: '📍',
    label: 'Place',
    color: '#AAAAAA',
  }),
}));

// NOTE: intentionally exhaustive — LocationContext reads session + GPS state
// from multiple native hooks; we only need resolvedLocation here.
jest.mock('../../../context/LocationContext', () => ({
  useLocationContext: () => ({ resolvedLocation: null }),
}));

// NOTE: intentionally exhaustive — FeatureFlagsContext reads Supabase;
// isEnabled is stubbed to always return true so canGenerateHeader is true.
jest.mock('../../../context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: () => true }),
}));

// NOTE: intentionally exhaustive — SessionContext reads Supabase auth;
// role is set to 'admin' so canGenerateHeader evaluates to true.
jest.mock('../../../context/SessionContext', () => ({
  useSession: () => ({ role: 'admin', userId: 'admin-1' }),
}));

// NOTE: intentionally exhaustive — spreading requireActual pulls in native font
// loader internals that crash under jest-expo; plain value stubs suffice.

// NOTE: GenerateHeaderSheet is mocked as a thin shim that renders a single
// "Use this image" button when visible=true. Pressing it invokes onAccepted
// with a fixed test URL, mirroring how the real sheet fires onAccepted after
// the admin reviews and accepts the AI image.
jest.mock('../../events/GenerateHeaderSheet', () => ({
  GenerateHeaderSheet: ({ visible, onAccepted, onDismiss }: {
    visible: boolean;
    onAccepted: (url: string) => void;
    onDismiss: () => void;
  }) => {
    const { View, Pressable, Text } = require('react-native');
    if (!visible) return null;
    return (
      <View testID="generate-header-sheet">
        <Pressable
          testID="mock-accept-btn"
          onPress={() => {
            onAccepted('https://ai-generated.example.com/place-header-test.jpg');
            onDismiss();
          }}
        >
          <Text>Use this image</Text>
        </Pressable>
      </View>
    );
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PLACE: DiscoveryPlace = {
  id:               'place-ai-1',
  name:             'Café du Monde',
  category:         'cafe',
  type:             'café',
  description:      'A historic café.',
  distanceKm:       null,
  lat:              29.9577,
  lng:              -90.0626,
  tags:             [],
  address:          '800 Decatur St, New Orleans',
  website:          null,
  phone:            null,
  openingHours:     null,
  rating:           null,
  isOpenNow:        null,
  headerImageUrl:   null,
  headerImageSource: null,
  attribution:      null,
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

describe('PlaceDetailSheet — AI header immediate update', () => {
  afterEach(() => jest.clearAllMocks());

  it('shows the "Generate header image" button for admins with the feature flag on', async () => {
    const { getByTestId } = await mountSheet();

    await waitFor(() => {
      expect(getByTestId('place-sheet-generate-header-btn')).toBeTruthy();
    });
  });

  it('does not show the AI disclosure label before any image is accepted', async () => {
    const { queryByTestId } = await mountSheet();

    await waitFor(() => {
      expect(queryByTestId('place-sheet-ai-label')).toBeNull();
    });
  });

  it('shows the AI disclosure label immediately after onAccepted fires — no reopen needed', async () => {
    const { getByTestId, queryByTestId } = await mountSheet();

    // Confirm label absent before accepting.
    await waitFor(() => {
      expect(queryByTestId('place-sheet-ai-label')).toBeNull();
    });

    // Open the generate sheet.
    fireEvent.press(getByTestId('place-sheet-generate-header-btn'));

    // Sheet should be visible.
    await waitFor(() => {
      expect(getByTestId('generate-header-sheet')).toBeTruthy();
    });

    // Accept the image — triggers onAccepted(url) + onDismiss().
    fireEvent.press(getByTestId('mock-accept-btn'));

    // The AI disclosure label must now appear without closing and reopening.
    await waitFor(() => {
      expect(getByTestId('place-sheet-ai-label')).toBeTruthy();
    });
  });

  it('resets the AI header when a different place is shown', async () => {
    const { getByTestId, queryByTestId, rerender } = await mountSheet();

    // Accept an image on the first place.
    fireEvent.press(getByTestId('place-sheet-generate-header-btn'));
    await waitFor(() => getByTestId('generate-header-sheet'));
    fireEvent.press(getByTestId('mock-accept-btn'));
    await waitFor(() => getByTestId('place-sheet-ai-label'));

    // Switch to a different place — localAiHeaderUrl should reset.
    const OTHER_PLACE: DiscoveryPlace = { ...PLACE, id: 'place-ai-2', name: "Brennan's" };
    await rerender(
      <PlaceDetailSheet
        place={OTHER_PLACE}
        visible
        onClose={jest.fn()}
        onAddToPlan={jest.fn()}
      />,
    );

    await waitFor(() => {
      expect(queryByTestId('place-sheet-ai-label')).toBeNull();
    });
  });
});
