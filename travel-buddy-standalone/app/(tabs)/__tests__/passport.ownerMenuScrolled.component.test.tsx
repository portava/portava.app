/**
 * Passport — ⋯ menu button opens owner menu (compact-bar-visible state)
 *
 * Confirms that pressing the ⋯ button while compactBarInteractive=true
 * (scrolled — compact bar visible, pointerEvents='auto') still results in
 * PassportOwnerMenuSheet becoming visible.
 *
 * Regression guard: if the compact bar's pointerEvents is ever hardcoded to
 * 'auto' instead of being driven by compactBarInteractive, the bar
 * (position:absolute, zIndex:10) would overlay the ⋯ button when scrolled
 * and silently swallow the press.
 *
 * Sibling file passport.ownerMenuFreshLoad.component.test.tsx covers the
 * compactBarInteractive=false case in a separate renderer instance (each file
 * gets exactly one reliable press-commit slot under RNTL + React 19).
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import PassportScreen from '../../../app/(tabs)/passport.tsx';
import { makePassportMock, MINIMAL_OWN_PROFILE } from '../../../src/components/__tests__/testUtils.ts';

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
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — requires native camera permissions modules.
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ granted: false }),
  launchImageLibraryAsync:             jest.fn().mockResolvedValue({ canceled: true }),
  MediaTypeOptions:                    { Images: 'Images' },
}));

// ── usePassport ───────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — calls Supabase and full network stack.
jest.mock('../../../src/hooks/usePassport', () => ({
  usePassport: jest.fn(),
  isProfileStaleSince: jest.fn(() => false),
  markProfileStale: jest.fn(),
}));

// ── useCollapsingHeader ───────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — drives the pointerEvents on the compact bar.
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
// NOTE: intentionally exhaustive — all import Supabase; requireActual OOMs.
jest.mock('../../../src/services/profile', () => ({
  uploadAvatar: jest.fn().mockResolvedValue({ ok: false }),
  uploadCover:  jest.fn().mockResolvedValue({ ok: false }),
}));
// NOTE: intentionally exhaustive — imports Supabase; requireActual OOMs.
jest.mock('../../../src/services/trips', () => ({
  listMyTrips: jest.fn().mockResolvedValue([]),
}));

// ── Hooks ─────────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — accesses native scroll metrics.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => jest.fn(),
  NavBarFiller:           () => null,
}));
// NOTE: intentionally exhaustive — references network services.
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

// ── Context ───────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — imports Supabase + native-incompatible modules.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ userId: 'user-test-1', isAuthed: true }),
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

// ── PassportIdentityCard — partial: renders only the ⋯ button ─────────────────
// The ⋯ button lives inside PassportIdentityCard. This stub renders a pressable
// with the matching accessibilityLabel so fireEvent can locate and press it
// without pulling in the card's heavyweight SVG / native-image dependencies.
jest.mock('../../../src/components/passport/PassportIdentityCard', () => {
  const { Pressable } = require('react-native');
  const MenuButtonStub = ({ onMenuPress }: { onMenuPress?: () => void }) => (
    <Pressable
      testID="passport-menu-btn"
      accessibilityLabel="Passport menu"
      onPress={onMenuPress}
    />
  );
  return {
    PassportIdentityCard: MenuButtonStub,
    PassportStatsRow:     () => null,
  };
});

// ── PassportOwnerMenuSheet — observable: renders sentinel when visible ─────────
// Renders a View tagged "owner-menu-sheet" only when visible=true so the test
// can assert the sheet appeared without rendering the real sheet's Modal deps.
jest.mock('../../../src/components/passport/PassportOwnerMenuSheet', () => {
  const { View } = require('react-native');
  const ObservableSheet = ({ visible }: { visible: boolean }) =>
    visible ? <View testID="owner-menu-sheet" /> : null;
  return { PassportOwnerMenuSheet: ObservableSheet };
});

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportDivider',         () => ({ PassportDivider:         Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportStampCollection', () => ({ PassportStampCollection: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportStampsFullView',  () => ({ PassportStampsFullView:  Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportHighlightsStrip', () => ({ PassportHighlightsStrip: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportAboutSection',    () => ({ PassportAboutSection:    Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportSafetySection',   () => ({ PassportSafetySection:   Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportSectionReorderSheet', () => ({ PassportSectionReorderSheet: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportTabReorderSheet',     () => ({ PassportTabReorderSheet:     Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/TrustScoreInfoSheet',         () => ({ TrustScoreInfoSheet:         Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportTravelInfoSection',   () => ({ PassportTravelInfoSection:   Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CompassStatusCard',            () => ({ CompassStatusCard:            Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CompassPassportSuggestions',   () => ({ CompassPassportSuggestions:   Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/DestinationsTab', () => ({ DestinationsTab: Null }));

// ── Typed mock refs ───────────────────────────────────────────────────────────

const { usePassport } = require('../../../src/hooks/usePassport.ts');
const mockUsePassport = usePassport as jest.Mock;

const { useCollapsingHeader } = require('../../../src/hooks/useCollapsingHeader.ts');
const mockUseCollapsingHeader = useCollapsingHeader as jest.Mock;

const mockLastLoadedAt: { current: number } = { current: Date.now() };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Passport — ⋯ menu button (compact-bar-visible state)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLastLoadedAt.current = Date.now();

    mockUsePassport.mockReturnValue(
      makePassportMock({
        profile:      MINIMAL_OWN_PROFILE,
        lastLoadedAt: mockLastLoadedAt,
      }),
    );

    // Scrolled state: compact bar is fully visible.
    // pointerEvents='auto' — a regression that hardcodes this prop instead of
    // reading compactBarInteractive would cause the bar (position:absolute,
    // zIndex:10) to overlay and swallow the ⋯ press when scrolled.
    mockUseCollapsingHeader.mockReturnValue({
      largeHeaderStyle:      {},
      compactBarStyle:       {},
      compactBarInteractive: true,
    });
  });

  it('opens PassportOwnerMenuSheet when ⋯ is pressed while compact bar is visible (compactBarInteractive=true)', async () => {
    await render(<PassportScreen />);
    await act(async () => {});

    // Owner menu is not yet visible before pressing ⋯.
    expect(screen.queryByTestId('owner-menu-sheet')).toBeNull();

    // Act-wrapped press: commits the state update without a standalone
    // post-press flush (which would poison the renderer for later tests).
    await act(async () => { fireEvent.press(screen.getByTestId('passport-menu-btn')); });

    // Pressing ⋯ must make the owner menu sheet visible even while the
    // compact bar is active.
    expect(screen.getByTestId('owner-menu-sheet')).toBeTruthy();
  });
});
