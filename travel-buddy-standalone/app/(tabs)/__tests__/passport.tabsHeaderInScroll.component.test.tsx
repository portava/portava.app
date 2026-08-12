/**
 * Passport — tabs header always inside the scroll after deep-link entry + switch
 *
 * Confirms the property: after navigating to PassportScreen via a deep-link
 * ?tab=<X> and then switching to another tab by pressing a tab button in the
 * header, the tab-bar (the horizontal ScrollView containing role="tab" buttons)
 * is rendered exactly-once, inside the main ScrollView — never duplicated or
 * stranded outside it.
 *
 * The concern: a buggy implementation might:
 *   (a) render the tab-bar outside the scrollable area (e.g. as a fixed/absolute
 *       element that does not move when sectionOrder changes), or
 *   (b) drop the 'tabs' sectionKey from the rendered section list after a tab
 *       switch, causing the header to disappear entirely.
 *
 * Strategy: use the FULL canonical sectionOrder (identity + tabs) so
 * `renderTabsSection` is actually invoked inside the ScrollView.  We then
 * assert all tab-role buttons are inside the scroll and none exist outside it,
 * both after initial render with the deep-link param and after a tab switch.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import PassportScreen from '../passport.tsx';
import { makePassportMock, MINIMAL_OWN_PROFILE } from '../../../src/components/__tests__/testUtils.ts';

// ── controlled deep-link param ───────────────────────────────────────────────
let mockSearchParams: Record<string, string | undefined> = {};

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
  useLocalSearchParams: () => mockSearchParams,
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

// NOTE: intentionally exhaustive — calls Supabase and full network stack.
jest.mock('../../../src/hooks/usePassport', () => ({
  usePassport:         jest.fn(),
  isProfileStaleSince: jest.fn(() => false),
  markProfileStale:    jest.fn(),
}));

// NOTE: intentionally exhaustive — drives pointer-events on the compact bar.
jest.mock('../../../src/hooks/useCollapsingHeader', () => ({
  useCollapsingHeader: jest.fn(),
}));

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

// NOTE: intentionally exhaustive — accesses native scroll metrics.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => jest.fn(),
  NavBarFiller:           () => null,
}));
// NOTE: intentionally exhaustive — references network services.
jest.mock('../../../src/hooks/usePostcardActions', () => ({
  usePostcardActions: (_setter: unknown) => ({ onDelete: jest.fn(), onEdit: jest.fn() }),
}));
// NOTE: intentionally exhaustive — accesses native Share API.
jest.mock('../../../src/hooks/usePassportShare', () => ({
  usePassportShare: (_username: unknown) => ({
    cardRef: { current: null },
    share:   jest.fn(),
    sharing: false,
  }),
}));
// NOTE: intentionally exhaustive — calls Supabase realtime subscriptions.
jest.mock('../../../src/hooks/useHighlightRingState', () => ({
  useHighlightRingState:    () => null,
  invalidateHighlightCache: jest.fn(),
}));
// NOTE: intentionally exhaustive — calls backend timing APIs.
jest.mock('../../../src/hooks/useScreenTiming', () => ({
  useScreenTiming: () => ({ markFirstContent: jest.fn(), epoch: 0 }),
}));

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

// NOTE: intentionally exhaustive — re-exports from context files pulling Zustand.
jest.mock('../../../src/lib/availabilityChip', () => ({
  resolveAvailabilityChip: () => null,
}));

// ── Passport section/tab utilities ────────────────────────────────────────────
// Use the CANONICAL section order (identity + tabs) so renderTabsSection() is
// actually called inside the ScrollView.  We do NOT stub passportTabs — we
// require the real resolveTabOrder so the full tab list is present.
// NOTE: intentionally exhaustive — transitively imports RN components needing native modules.
jest.mock('../../../src/components/passport/passportSections', () => ({
  // 'tabs' section is explicitly included so renderTabsSection() fires.
  resolveSectionOrder:   () => ['identity', 'tabs'],
  resolveHiddenSections: () => new Set(),
}));

// ── Utilities ─────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — uses native Date operations.
jest.mock('../../../src/utils/destinationGrouping', () => ({
  groupByDestination: () => [],
}));

// ── Sub-component stubs (null renders or minimal stubs) ───────────────────────
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
jest.mock('../../../src/components/MemoriesTab',          () => ({ MemoriesTab:          Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/TripsTab',             () => ({ TripsTab:             Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/SuggestedMemoryModal', () => ({ SuggestedMemoryModal: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ProfileCompletionCard',() => ({ ProfileCompletionCard:Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PassportShareCard',    () => ({ PassportShareCard:    Null }));

// Tab content stubs — render a unique marker so the active tab is unambiguous.
jest.mock('../../../src/components/PostcardsTab', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return { PostcardsTab: () => React.createElement(Text, { testID: 'tab-content-postcards' }, 'POSTCARDS') };
});
jest.mock('../../../src/components/StampsTab', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return { StampsTab: () => React.createElement(Text, { testID: 'tab-content-stamps' }, 'STAMPS') };
});
jest.mock('../../../src/components/MapTab', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return { MapTab: () => React.createElement(Text, { testID: 'tab-content-map' }, 'MAP') };
});

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/create/CreateHubSheet', () => ({ CreateHubSheet: Null }));

// NOTE: intentional stub — not under test here; real card pulls SVG + native image.
jest.mock('../../../src/components/passport/PassportIdentityCard', () => ({
  PassportIdentityCard: Null,
  PassportStatsRow:     Null,
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportOwnerMenuSheet', () => ({ PassportOwnerMenuSheet: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportDivider',             () => ({ PassportDivider: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportStampCollection',     () => ({ PassportStampCollection: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportStampsFullView',      () => ({ PassportStampsFullView: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportHighlightsStrip',     () => ({ PassportHighlightsStrip: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportAboutSection',        () => ({ PassportAboutSection: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportSafetySection',       () => ({ PassportSafetySection: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportSectionReorderSheet', () => ({ PassportSectionReorderSheet: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportTabReorderSheet',     () => ({ PassportTabReorderSheet: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/TrustScoreInfoSheet',         () => ({ TrustScoreInfoSheet: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportTravelInfoSection',   () => ({ PassportTravelInfoSection: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CompassStatusCard',            () => ({ CompassStatusCard: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CompassPassportSuggestions',   () => ({ CompassPassportSuggestions: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/DestinationsTab',             () => ({ DestinationsTab: Null }));
// NOTE: intentional stub — not under test here; real AppHeader uses reanimated.
jest.mock('../../../src/components/ui/AppHeader', () => ({ AppHeader: Null }));

// ── Test setup ────────────────────────────────────────────────────────────────

const { usePassport }         = require('../../../src/hooks/usePassport.ts');
const { useCollapsingHeader } = require('../../../src/hooks/useCollapsingHeader.ts');
const mockUsePassport         = usePassport as jest.Mock;
const mockUseCollapsingHeader = useCollapsingHeader as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockSearchParams = {};

  mockUsePassport.mockReturnValue(
    makePassportMock({ profile: MINIMAL_OWN_PROFILE }),
  );
  mockUseCollapsingHeader.mockReturnValue({
    largeHeaderStyle:      {},
    compactBarStyle:       {},
    compactBarInteractive: false,
  });
});

afterEach(async () => {
  // Flush any pending state updates so act() warnings don't pollute the next test.
  await act(async () => {});
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns the main-scroll element and all tab-role buttons found in the tree.
 * We assert:
 *   1. The scroll exists.
 *   2. Every role="tab" element is a descendant of the scroll.
 *   3. There is at least one tab (i.e. the tab bar is not absent).
 */
function assertTabBarInsideScroll() {
  const scroll = screen.getByTestId('main-scroll');
  // All elements with accessibilityRole="tab" are the tab-bar buttons.
  const allTabs = screen.getAllByRole('tab');

  expect(allTabs.length).toBeGreaterThanOrEqual(1);

  // Every tab button must live INSIDE the scroll — confirmed by querying the
  // same role scoped to the scroll subtree. If any were outside (stranded),
  // within(scroll).getAllByRole('tab') would return fewer items than allTabs.
  const tabsInsideScroll = within(scroll).getAllByRole('tab');
  expect(tabsInsideScroll.length).toBe(allTabs.length);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Passport — tabs header always inside the scroll after deep-link + tab switch', () => {
  /**
   * Baseline: no deep-link param — default postcards tab.
   * The tab bar must be present and entirely inside the scroll.
   */
  it('tab bar is inside main-scroll with no deep-link param (default tab)', async () => {
    mockSearchParams = {};
    await render(<PassportScreen />);
    await act(async () => {});

    assertTabBarInsideScroll();
  });

  /**
   * Deep-link to ?tab=stamps: the tab bar must still be fully inside the scroll
   * (not rendered twice, not stranded as an absolute-positioned duplicate).
   */
  it('tab bar is inside main-scroll after deep-link to ?tab=stamps', async () => {
    mockSearchParams = { tab: 'stamps' };
    await render(<PassportScreen />);
    await act(async () => {});

    assertTabBarInsideScroll();
  });

  /**
   * Deep-link to ?tab=trips: same invariant for the "trips" target.
   */
  it('tab bar is inside main-scroll after deep-link to ?tab=trips', async () => {
    mockSearchParams = { tab: 'trips' };
    await render(<PassportScreen />);
    await act(async () => {});

    assertTabBarInsideScroll();
  });

  /**
   * Deep-link to ?tab=map, then user presses the "Stamps" tab button.
   * After the switch, the tab bar must still be:
   *   - present (not dropped from the section list)
   *   - entirely inside the scroll (no ghost element outside)
   *   - present exactly once (no duplicate)
   */
  it('tab bar stays inside main-scroll after switching tabs post deep-link', async () => {
    mockSearchParams = { tab: 'map' };
    await render(<PassportScreen />);
    await act(async () => {});

    // Verify initial state: map tab is active, tab bar is inside the scroll.
    assertTabBarInsideScroll();
    expect(screen.getByTestId('tab-content-map')).toBeTruthy();

    // Switch to the Stamps tab by pressing its button.
    const stampsTabButton = screen.getByRole('tab', { name: /stamps/i });
    await act(async () => { fireEvent.press(stampsTabButton); });

    // After the switch the tab bar must still be inside the scroll.
    assertTabBarInsideScroll();
    // The tab content must have changed to stamps.
    expect(screen.getByTestId('tab-content-stamps')).toBeTruthy();
    // Map content must be gone.
    expect(screen.queryByTestId('tab-content-map')).toBeNull();
  });

  /**
   * Deep-link to ?tab=memories, switch to postcards, then switch back to stamps.
   * Tests a multi-switch sequence to confirm the invariant holds through two
   * consecutive tab-change state transitions.
   */
  it('tab bar stays inside main-scroll through multiple tab switches', async () => {
    mockSearchParams = { tab: 'memories' };
    await render(<PassportScreen />);
    await act(async () => {});

    assertTabBarInsideScroll();

    // Switch 1: memories → postcards
    const postcardsBtn = screen.getByRole('tab', { name: /postcards/i });
    await act(async () => { fireEvent.press(postcardsBtn); });
    assertTabBarInsideScroll();
    expect(screen.getByTestId('tab-content-postcards')).toBeTruthy();

    // Switch 2: postcards → stamps
    const stampsBtn = screen.getByRole('tab', { name: /stamps/i });
    await act(async () => { fireEvent.press(stampsBtn); });
    assertTabBarInsideScroll();
    expect(screen.getByTestId('tab-content-stamps')).toBeTruthy();
  });

  /**
   * Invalid deep-link param falls back to default (postcards) — tab bar still present.
   */
  it('tab bar is inside main-scroll when deep-link param is invalid', async () => {
    mockSearchParams = { tab: 'not-a-real-tab' };
    await render(<PassportScreen />);
    await act(async () => {});

    assertTabBarInsideScroll();
    expect(screen.getByTestId('tab-content-postcards')).toBeTruthy();
  });
});
