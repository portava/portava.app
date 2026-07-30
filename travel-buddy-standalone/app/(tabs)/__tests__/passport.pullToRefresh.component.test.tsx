/**
 * Passport screen — pull-to-refresh re-fetches data
 *
 * Confirms that triggering the ScrollView's RefreshControl.onRefresh:
 *   1. calls reload() from usePassport (re-fetches the full passport pipeline)
 *   2. calls refreshAvailability() from useAvailabilityStore (keeps chip in sync)
 *   3. sets and then clears the refreshing indicator via the lastLoadedAt sentinel
 *
 * testID "main-scroll" on the ScrollView in passport.tsx lets us reach
 * refreshControl via scroll.props.refreshControl.props.onRefresh / .refreshing.
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react-native';
import PassportScreen from '../passport.tsx';
import { makePassportMock, MINIMAL_OWN_PROFILE } from '../../../src/components/__tests__/testUtils.ts';

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

// NOTE: intentionally exhaustive — calls Supabase and the full network stack.
jest.mock('../../../src/hooks/usePassport', () => ({
  usePassport: jest.fn(),
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
  usePostcardActions: () => ({ onDelete: jest.fn(), onEdit: jest.fn() }),
}));
// NOTE: intentionally exhaustive — accesses native Share API.
jest.mock('../../../src/hooks/usePassportShare', () => ({
  usePassportShare: () => ({
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

const mockRefreshAvailability = jest.fn().mockResolvedValue(undefined);

// NOTE: intentionally exhaustive — initialises Zustand at module level.
jest.mock('../../../src/context/AvailabilityStore', () => ({
  useAvailabilityStore: () => ({
    availability: { openToMeet: false, trips: [] },
    quickStatus:  null,
    refresh:      (...args: unknown[]) => mockRefreshAvailability(...args),
  }),
}));

// NOTE: intentionally exhaustive — re-exports from context files pulling Zustand.
jest.mock('../../../src/lib/availabilityChip', () => ({
  resolveAvailabilityChip: () => null,
}));

// NOTE: intentionally exhaustive — transitively imports RN components.
jest.mock('../../../src/components/passport/passportSections', () => ({
  resolveSectionOrder:   () => ['identity'],
  resolveHiddenSections: () => new Set(),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/passportTabs', () => ({
  resolveTabOrder: () => ['postcards'],
  TAB_LABELS: { postcards: 'Postcards' },
}));

// NOTE: intentionally exhaustive — uses native Date operations.
jest.mock('../../../src/utils/destinationGrouping', () => ({
  groupByDestination: () => [],
}));

const Null = () => null;

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/NotificationBell', () => ({ NotificationBell: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/HighlightViewer', () => ({ HighlightViewer: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/HighlightComposer', () => ({ HighlightComposer: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PostcardComposer', () => ({ PostcardComposer: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/MemoriesTab', () => ({ MemoriesTab: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/TripsTab', () => ({ TripsTab: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/SuggestedMemoryModal', () => ({ SuggestedMemoryModal: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ProfileCompletionCard', () => ({ ProfileCompletionCard: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PassportShareCard', () => ({ PassportShareCard: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PostcardsTab', () => ({ PostcardsTab: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/StampsTab', () => ({ StampsTab: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/MapTab', () => ({ MapTab: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/create/CreateHubSheet', () => ({ CreateHubSheet: Null }));
// NOTE: intentional stub — not under test here; real card pulls SVG + native image.
jest.mock('../../../src/components/passport/PassportIdentityCard', () => ({ PassportIdentityCard: Null, PassportStatsRow: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportOwnerMenuSheet', () => ({ PassportOwnerMenuSheet: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportDivider', () => ({ PassportDivider: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportStampCollection', () => ({ PassportStampCollection: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportStampsFullView', () => ({ PassportStampsFullView: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportHighlightsStrip', () => ({ PassportHighlightsStrip: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportAboutSection', () => ({ PassportAboutSection: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportSafetySection', () => ({ PassportSafetySection: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportSectionReorderSheet', () => ({ PassportSectionReorderSheet: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportTabReorderSheet', () => ({ PassportTabReorderSheet: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/TrustScoreInfoSheet', () => ({ TrustScoreInfoSheet: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportTravelInfoSection', () => ({ PassportTravelInfoSection: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CompassStatusCard', () => ({ CompassStatusCard: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CompassPassportSuggestions', () => ({ CompassPassportSuggestions: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/DestinationsTab', () => ({ DestinationsTab: Null }));
// NOTE: intentional stub — not under test here; real AppHeader uses reanimated.
jest.mock('../../../src/components/ui/AppHeader', () => ({ AppHeader: Null }));

const { usePassport }         = require('../../../src/hooks/usePassport.ts');
const { useCollapsingHeader } = require('../../../src/hooks/useCollapsingHeader.ts');
const mockUsePassport         = usePassport as jest.Mock;
const mockUseCollapsingHeader = useCollapsingHeader as jest.Mock;

const mockLastLoadedAt: { current: number } = { current: 0 };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Passport screen — pull-to-refresh', () => {
  let mockReload: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRefreshAvailability.mockResolvedValue(undefined);
    mockLastLoadedAt.current = 0;

    mockReload = jest.fn();
    mockUsePassport.mockReturnValue(
      makePassportMock({
        profile:      MINIMAL_OWN_PROFILE,
        reload:       mockReload,
        lastLoadedAt: mockLastLoadedAt,
      }),
    );

    mockUseCollapsingHeader.mockReturnValue({
      largeHeaderStyle:      {},
      compactBarStyle:       {},
      compactBarInteractive: false,
    });
  });

  afterEach(async () => {
    await act(async () => {});
  });

  it('calls reload() and refreshAvailability() when RefreshControl fires', async () => {
    await render(<PassportScreen />);
    await act(async () => {});

    const scroll = await screen.findByTestId('main-scroll');
    expect(scroll.props.refreshControl.props.refreshing).toBe(false);

    const reloadBefore = mockReload.mock.calls.length;

    await act(async () => { scroll.props.refreshControl.props.onRefresh(); });

    // reload may also fire on focus-effect mount; assert it was called at least once MORE
    expect(mockReload.mock.calls.length).toBeGreaterThan(reloadBefore);
    expect(mockRefreshAvailability.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('starts the refreshing spinner when onRefresh fires', async () => {
    mockReload.mockImplementation(() => {});

    await render(<PassportScreen />);
    await act(async () => {});

    const scroll = await screen.findByTestId('main-scroll');
    await act(async () => { scroll.props.refreshControl.props.onRefresh(); });

    expect(screen.getByTestId('main-scroll').props.refreshControl.props.refreshing).toBe(true);
  });

  it('clears the refreshing spinner when lastLoadedAt is stamped after reload', async () => {
    await render(<PassportScreen />);
    await act(async () => {});

    const startTime = Date.now();
    mockReload.mockImplementation(() => {
      mockLastLoadedAt.current = startTime + 100;
    });

    const scroll = await screen.findByTestId('main-scroll');
    await act(async () => { scroll.props.refreshControl.props.onRefresh(); });

    await waitFor(
      () => {
        expect(screen.getByTestId('main-scroll').props.refreshControl.props.refreshing).toBe(false);
      },
      { timeout: 2000 },
    );
  });
});
