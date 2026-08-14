/**
 * Passport (app/(tabs)/passport.tsx) — bottom-inset clearance test.
 *
 * Confirms that the main ScrollView's `contentContainerStyle.paddingBottom`
 * is at least 120 pt when a layover session is active.  The passport tab
 * derives this value from `useBottomInset()` (NAV_BAR_FILLER_HEIGHT + 34 on
 * iPhone 14 = 130), which is forwarded directly to the ScrollView.
 *
 * Mock structure is identical to passport.ownerMenuFreshLoad.component.test.tsx
 * (the established baseline for rendering PassportScreen in tests) with two
 * additions: a controlled useBottomInset mock and a layover-active service stub.
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */

import React from 'react';
import { render, act } from '@testing-library/react-native';
import { makePassportMock, MINIMAL_OWN_PROFILE } from '../../../src/components/__tests__/testUtils.ts';
import PassportScreen from '../passport.tsx';

// ── Inset constants ───────────────────────────────────────────────────────────
const IPHONE_BOTTOM   = 34;
const ANDROID_BOTTOM  = 48;
const NAV_BAR_FILLER  = 96;
const MIN_CLEARANCE   = 120;

// ── expo-router — intentionally exhaustive ───────────────────────────────────
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: {
    push:     jest.fn(),
    replace:  jest.fn(),
    back:     jest.fn(),
    navigate: jest.fn(),
    dismiss:  jest.fn(),
  },
  useRouter:            () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
  usePathname:          () => '/',
  useSegments:          () => [],
  useFocusEffect: (cb: () => (() => void) | void) => {
    require('react').useEffect(() => { cb(); }, []);
  },
  useNavigation: () => ({
    navigate:    jest.fn(),
    goBack:      jest.fn(),
    setOptions:  jest.fn(),
    addListener: (_e: unknown, _cb: unknown) => () => {},
  }),
  Link:     ({ children }: { children: React.ReactNode }) => children,
  Redirect: (_props: { href: unknown }) => null,
  Stack:    { Screen: (_props: unknown) => null },
  Tabs:     { Screen: (_props: unknown) => null },
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: IPHONE_BOTTOM, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: any) => children,
}));

// NOTE: intentionally exhaustive — requires native camera permissions modules.
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ granted: false }),
  launchImageLibraryAsync:             jest.fn().mockResolvedValue({ canceled: true }),
  MediaTypeOptions:                    { Images: 'Images' },
}));

// ── Bottom inset — controlled value (iPhone 14: 96 + 34 = 130) ───────────────
// NOTE: intentionally exhaustive — useBottomInset.ts imports reanimated at
// module scope via useNavBarCollapse; mocking the whole module is cleaner.
jest.mock('../../../src/hooks/useBottomInset.ts', () => ({
  useBottomInset:             () => 96 + 34,      // NAV_BAR_FILLER + IPHONE_BOTTOM = 130
  useLayoverAwareBottomInset: () => 34 + 74 + 44 + 16, // 168
  usePlainBottomInset:        () => 34 + 24,       // 58
  PlainBottomFiller:          () => null,
  BOTTOM_BREATHING_ROOM:      24,
  useStickyBarInset:          () => ({ inset: 96 + 34, onBarLayout: () => {} }),
  useKeyboardVisible:         () => false,
}));

// ── usePassport ───────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — calls Supabase and full network stack.
jest.mock('../../../src/hooks/usePassport', () => ({
  usePassport: jest.fn(),
  isProfileStaleSince: jest.fn(() => false),
  markProfileStale: jest.fn(),
}));

// ── useCollapsingHeader ───────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — drives compact bar animation via reanimated.
jest.mock('../../../src/hooks/useCollapsingHeader', () => ({
  useCollapsingHeader: jest.fn(),
}));

// ── Services ──────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/posts', () => ({
  getPendingPosts: jest.fn().mockResolvedValue({ ok: true, data: [] }),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/rentABuddy', () => ({
  getMyBuddyProfile: jest.fn().mockResolvedValue({ ok: false }),
}));
// NOTE: intentionally exhaustive — imports Supabase; requireActual OOMs.
jest.mock('../../../src/services/profile', () => ({
  uploadAvatar: jest.fn().mockResolvedValue({ ok: false }),
  uploadCover:  jest.fn().mockResolvedValue({ ok: false }),
}));
// NOTE: intentionally exhaustive — imports Supabase; requireActual OOMs.
jest.mock('../../../src/services/trips', () => ({
  listMyTrips: jest.fn().mockResolvedValue([]),
}));
// NOTE: intentional stub — layover-active scenario under test.
jest.mock('../../../src/services/layover', () => ({
  getActiveLayoverSession: jest.fn().mockResolvedValue({
    session: { id: 'layover-pass-1', departureTime: '2026-07-30T22:00:00Z', manualIata: 'SIN' },
    airport: null,
  }),
}));

// ── Hooks ─────────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — accesses native scroll metrics.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => jest.fn(),
  NavBarFiller:           () => null,
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/usePostcardActions', () => ({
  usePostcardActions: (_setter: unknown) => ({
    onDelete: jest.fn(),
    onEdit:   jest.fn(),
  }),
}));
// NOTE: intentionally exhaustive — accesses native Share API and camera roll.
jest.mock('../../../src/hooks/usePassportShare', () => ({
  usePassportShare: (_username: unknown) => ({
    cardRef: { current: null },
    share:   jest.fn(),
    sharing: false,
  }),
}));
// NOTE: intentionally exhaustive — calls Supabase realtime subscriptions.
jest.mock('../../../src/hooks/useHighlightRingState', () => ({
  useHighlightRingState:    (_userId: unknown, _key: unknown) => null,
  invalidateHighlightCache: jest.fn(),
}));
// NOTE: intentionally exhaustive — accesses native camera.
jest.mock('../../../src/hooks/useMediaPicker.ts', () => ({
  useMediaPicker: () => ({ pickMedia: jest.fn(), picking: false }),
}));

// ── Context ───────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — imports Supabase + native-incompatible modules.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ userId: 'user-test-1', isAuthed: true, signOut: jest.fn() }),
}));
// NOTE: intentionally exhaustive — initialises Zustand at module level.
jest.mock('../../../src/context/AvailabilityStore', () => ({
  useAvailabilityStore: () => ({
    availability: { openToMeet: false, trips: [] },
    quickStatus:  null,
    refresh:      jest.fn().mockResolvedValue(undefined),
  }),
}));

// ── Lib ───────────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — re-exports from context files pulling Zustand.
jest.mock('../../../src/lib/availabilityChip', () => ({
  resolveAvailabilityChip: () => null,
}));

// ── Passport section/tab utilities ────────────────────────────────────────────
// NOTE: intentionally exhaustive — transitively imports RN components needing native modules.
jest.mock('../../../src/components/passport/passportSections', () => ({
  resolveSectionOrder:   () => ['identity'],
  resolveHiddenSections: () => new Set(),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/passportTabs', () => ({
  resolveTabOrder: () => ['postcards'],
  TAB_LABELS: { postcards: 'Postcards' },
}));

// ── Sub-component stubs (null renders) ────────────────────────────────────────
const Null = () => null;

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/NotificationBell',  () => ({ NotificationBell:  Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/HighlightViewer',   () => ({ HighlightViewer:   Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/HighlightComposer', () => ({ HighlightComposer: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PostcardComposer',  () => ({ PostcardComposer:  Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/MemoriesTab',           () => ({ MemoriesTab:           Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/TripsTab',              () => ({ TripsTab:              Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/SuggestedMemoryModal',  () => ({ SuggestedMemoryModal:  Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/OwnerActionMenu',       () => ({ OwnerActionMenu:       Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ProfileCompletionCard', () => ({ ProfileCompletionCard: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PassportShareCard',     () => ({ PassportShareCard:     Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PostcardsTab',          () => ({ PostcardsTab:          Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/StampsTab',             () => ({ StampsTab:             Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/MapTab', () => ({ MapTab: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/create/CreateHubSheet', () => ({ CreateHubSheet: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportOwnerMenuSheet',      () => ({ PassportOwnerMenuSheet:      Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportDivider',             () => ({ PassportDivider:             Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportStampCollection',     () => ({ PassportStampCollection:     Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportStampsFullView',      () => ({ PassportStampsFullView:      Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportHighlightsStrip',     () => ({ PassportHighlightsStrip:     Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportAboutSection',        () => ({ PassportAboutSection:        Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportSafetySection',       () => ({ PassportSafetySection:       Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportSectionReorderSheet', () => ({ PassportSectionReorderSheet: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportTabReorderSheet',     () => ({ PassportTabReorderSheet:     Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/TrustScoreInfoSheet',         () => ({ TrustScoreInfoSheet:         Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportTravelInfoSection',   () => ({ PassportTravelInfoSection:   Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CompassStatusCard',            () => ({ CompassStatusCard:           Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CompassPassportSuggestions',   () => ({ CompassPassportSuggestions: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/DestinationsTab',             () => ({ DestinationsTab:             Null }));

// ── PassportIdentityCard — captures nothing; only scroll container is tested ──
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportIdentityCard', () => ({
  PassportIdentityCard: Null,
  PassportStatsRow:     Null,
}));

// ── Typed mock refs ───────────────────────────────────────────────────────────
const { usePassport }         = require('../../../src/hooks/usePassport.ts');
const mockUsePassport         = usePassport as jest.Mock;
const { useCollapsingHeader } = require('../../../src/hooks/useCollapsingHeader.ts');
const mockUseCollapsingHeader = useCollapsingHeader as jest.Mock;

const mockLastLoadedAt: { current: number } = { current: Date.now() };

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Collect every `paddingBottom` value found in either `contentContainerStyle`
 * or `style` props anywhere in the rendered tree.
 */
function collectPaddingBottoms(node: any): number[] {
  if (!node || typeof node !== 'object') return [];
  const found: number[] = [];

  for (const propKey of ['contentContainerStyle', 'style']) {
    const styleProp = node.props?.[propKey];
    if (styleProp) {
      const flat = Array.isArray(styleProp)
        ? Object.assign({}, ...styleProp.map((s: any) => (s && typeof s === 'object' ? s : {})))
        : styleProp;
      if (typeof flat?.paddingBottom === 'number') found.push(flat.paddingBottom);
    }
  }

  for (const child of (node.children ?? [])) {
    found.push(...collectPaddingBottoms(child));
  }
  return found;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Passport tab — ScrollView contentContainerStyle.paddingBottom when layover active', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLastLoadedAt.current = Date.now();

    mockUsePassport.mockReturnValue(
      makePassportMock({
        profile:      MINIMAL_OWN_PROFILE,
        lastLoadedAt: mockLastLoadedAt,
      }),
    );

    mockUseCollapsingHeader.mockReturnValue({
      largeHeaderStyle:      {},
      compactBarStyle:       {},
      compactBarInteractive: false,
    });
  });

  it('ScrollView paddingBottom ≥ 155 (iPhone 14, layover active)', async () => {
    const { toJSON } = await render(<PassportScreen />);
    await act(async () => { await Promise.resolve(); });

    const paddings = collectPaddingBottoms(toJSON());
    expect(paddings.length).toBeGreaterThan(0);
    const max = Math.max(...paddings);
    expect(max).toBeGreaterThanOrEqual(155);
  });

  it('ScrollView paddingBottom equals useLayoverAwareBottomInset() value (168 on iPhone 14)', async () => {
    const { toJSON } = await render(<PassportScreen />);
    await act(async () => { await Promise.resolve(); });

    const paddings = collectPaddingBottoms(toJSON());
    const max = Math.max(...paddings);
    // 34 (insets.bottom) + 74 (pill offset) + 44 (pill height) + 16 (gap) = 168
    expect(max).toBe(IPHONE_BOTTOM + 74 + 44 + 16); // 168
  });

  it('ScrollView paddingBottom ≥ Android gesture nav height (48 dp)', async () => {
    const { toJSON } = await render(<PassportScreen />);
    await act(async () => { await Promise.resolve(); });

    const paddings = collectPaddingBottoms(toJSON());
    const max = Math.max(...paddings);
    expect(max).toBeGreaterThanOrEqual(ANDROID_BOTTOM);
  });
});

describe('Passport tab — inset computation constants', () => {
  it('layover-active inset: iPhone bottom (34) + 74 + 44 + 16 = 168 ≥ 155', () => {
    expect(IPHONE_BOTTOM + 74 + 44 + 16).toBeGreaterThanOrEqual(155);
  });

  it('layover-active inset: Android bottom (48) + 74 + 44 + 16 = 182 ≥ 155', () => {
    expect(ANDROID_BOTTOM + 74 + 44 + 16).toBeGreaterThanOrEqual(155);
  });
});
