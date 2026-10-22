/**
 * GemDetailScreen — the gem's own photo is drawn by CachedImage, which signs private storage refs.
 *
 * The cover rendered the gem's own imageUrl with a plain React Native <Image> (only the category fallback used
 * CachedImage). post-media is a PRIVATE bucket and the upload returns a bare post-media/<path>: a plain <Image> cannot
 * load either form, so every uploaded gem photo showed a blank cover on its own page while the list card (CachedImage)
 * showed it. Verifier 3, 2026-10-22, once the gem create/edit schema began accepting that bare ref.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import GemDetailScreen from '../../../app/gems/[id].tsx';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  useLocalSearchParams: () => ({ id: 'freehand-gem-1' }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: ({ children }: any) => <View>{children}</View>,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

// NOTE: intentionally exhaustive — requireActual pulls native-module internals
// that are not safe under jest.
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-location', () => ({}));

jest.mock('../../hooks/useNavBarCollapse', () => ({
  ...jest.requireActual('../../hooks/useNavBarCollapse'),
  NavBarFiller: () => null,
  useNavBarScrollHandler: () => () => {},
}));

jest.mock('../../context/SessionContext', () => ({
  ...jest.requireActual('../../context/SessionContext'),
  useSession: () => ({ isAuthed: true, loading: false }),
}));

// NOTE: intentionally exhaustive stubs — importing the actual modules would
// pull heavy/native dependencies into the jest environment.
jest.mock('../RouteBuilderSheet', () => ({ RouteBuilderSheet: () => null }));
jest.mock('../discovery/TripWishlistPicker', () => ({ TripWishlistPicker: () => null }));
jest.mock('../ReviewsSection', () => ({ ReviewsSection: () => null }));
// NOTE: intentionally exhaustive stub — GemMapPreview imports MapLibre native
// modules that are unavailable in jest and would crash the suite on requireActual.
jest.mock('../discovery/GemMapPreview', () => ({ GemMapPreview: () => null }));
// NOTE: intentionally exhaustive stub — WorthItVoteRow imports animation/haptic
// native modules that are unsafe under jest.
jest.mock('../WorthItVoteRow', () => ({ WorthItVoteRow: () => null }));

// NOTE: intentionally exhaustive stub — PlaceInfoSection may pull native
// dependencies (maps, images) that are unsafe under jest.
jest.mock('../place/PlaceInfoSection', () => ({
  PlaceInfoSection: ({ description }: { description?: string | null }) => {
    const { Text } = require('react-native');
    return description ? <Text testID="place-info-description">{description}</Text> : null;
  },
}));

// NOTE: intentionally exhaustive stub — as in GemDetailFreehand; here it passes the first candidate through so the
// gem's own photo reaches the cover.
jest.mock('../../lib/visuals/resolveHeaderImage', () => ({
  resolveHeaderImage: (c: Array<{ url: string; source: string }>) => (c[0] ? { url: c[0].url, source: c[0].source } : null),
}));

// NOTE: intentionally exhaustive stub — fallbackAssets references bundled
// asset requires that are resolved by Metro, not jest, and throw on requireActual.
jest.mock('../../lib/visuals/fallbackAssets', () => ({
  fallbackUriFor: () => null,
}));

// NOTE: intentionally exhaustive stub — CachedImage imports expo-image (native). The stub keeps the uri it was given
// so the test can see which component drew the cover.
jest.mock('../../components/CachedImage', () => ({
  CachedImage: ({ source }: { source?: { uri?: string } }) => {
    const { View } = require('react-native');
    return <View testID="cached-image" {...{ uri: source?.uri }} />;
  },
}));

jest.mock('../../hooks/useBottomInset', () => ({
  ...jest.requireActual('../../hooks/useBottomInset'),
  PlainBottomFiller: () => null,
}));

// NOTE: intentionally exhaustive stub — ReasonPromptModal imports animation
// libraries that have native modules unavailable under jest.
jest.mock('../ReasonPromptModal', () => ({
  ReasonPromptModal: () => null,
}));

jest.mock('../../hooks/useHiddenGems', () => ({
  ...jest.requireActual('../../hooks/useHiddenGems'),
  useGemDetail: jest.fn(),
  useGemCheckin: () => ({ checkin: jest.fn(), loading: false, result: null }),
  useGemReport: () => ({ report: jest.fn(), loading: false, done: false }),
}));

jest.mock('../../services/hiddenGems', () => ({
  ...jest.requireActual('../../services/hiddenGems'),
  verificationBadge: () => 'Community verified',
  sensitivityLabel: () => 'Public',
  shareGemToTelegraph: jest.fn(),
}));

// NOTE: intentionally exhaustive stub — the places service may import Supabase
// client initialisation that fails under jest; only getCanonicalPlace is needed.
jest.mock('../../services/places', () => ({
  getCanonicalPlace: jest.fn(),
}));

const { useGemDetail } = require('../../hooks/useHiddenGems.ts');

/** A gem whose photo is the bare ref POST /media/upload returns. */
const gemWithUpload = {
  id: 'freehand-gem-1',
  name: 'Hidden Waterfall Trail',
  category: 'nature',
  neighborhood: 'Ubud',
  city: 'Bali',
  country: 'Indonesia',
  coordsPrecision: 'exact',
  lat: -8.5069,
  lng: 115.2625,
  sensitivityLevel: 'public',
  verificationLevel: 'community',
  vibeTags: [],
  saveCount: 7,
  description: 'A secluded waterfall only locals know about.',
  priceRange: null,
  bestTimeToGo: null,
  layoverSafe: false,
  minimumLayoverMinutes: null,
  safetyNotes: null,
  localEtiquette: null,
  imageUrl: 'post-media/u-1/1761140000000.jpg',
};


jest.setTimeout(20000);

describe('GemDetailScreen — cover photo', () => {
  beforeEach(() => {
    (useGemDetail as jest.Mock).mockReturnValue({
      gem: gemWithUpload, savedByMe: false, guideProfile: null, loading: false, error: null, refresh: jest.fn(), toggleSave: jest.fn(),
    });
  });

  it("draws the gem's uploaded photo through CachedImage, with the stored ref", async () => {
    await render(<GemDetailScreen />);
    const covers = screen.getAllByTestId('cached-image');
    expect(covers.map((n: any) => n.props.uri)).toContain('post-media/u-1/1761140000000.jpg');
  });
});
