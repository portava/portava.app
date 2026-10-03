/**
 * Passport screen — the owner's Travel Highlights strip is told when the
 * owner's own Highlights could not be read (lane highlights, 2026-10-03).
 *
 * `useHighlightRingState` reports a failed read as `unreadable`; the screen
 * used to drop that and hand the strip `[]`, which drew "Share travel moments
 * as highlights" over Highlights the owner had posted. This pins the WIRING:
 * the strip receives `unreadable`, and its retry asks the hook again
 * (a non-zero refreshKey busts the hook's cache).
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, act } from '@testing-library/react-native';
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
  isProfileStaleSince: jest.fn(() => false),
  markProfileStale: jest.fn(),
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
const mockRingState = jest.fn();
jest.mock('../../../src/hooks/useHighlightRingState', () => ({
  useHighlightRingState:    (...a: unknown[]) => mockRingState(...a),
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
  resolveSectionOrder:   () => ['identity', 'highlights'],
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
const mockStripProps = jest.fn();
jest.mock('../../../src/components/passport/PassportHighlightsStrip', () => ({
  PassportHighlightsStrip: (p: Record<string, unknown>) => { mockStripProps(p); return null; },
}));
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

describe('Passport screen — own Highlights unreadable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRefreshAvailability.mockResolvedValue(undefined);
    mockUsePassport.mockReturnValue(makePassportMock({ profile: MINIMAL_OWN_PROFILE, reload: jest.fn(), lastLoadedAt: mockLastLoadedAt }));
    mockUseCollapsingHeader.mockReturnValue({ largeHeaderStyle: {}, compactBarStyle: {}, compactBarInteractive: false });
  });
  afterEach(async () => { await act(async () => {}); });

  it('hands the strip `unreadable`, and its retry asks the ring hook again', async () => {
    mockRingState.mockReturnValue({ hasActive: false, allViewed: false, highlights: [], unreadable: true });
    await render(<PassportScreen />);
    await act(async () => {});
    const last = mockStripProps.mock.calls[mockStripProps.mock.calls.length - 1]?.[0] as any;
    expect(last).toBeTruthy();
    expect(last.unreadable).toBe(true);
    expect(typeof last.onRetry).toBe('function');
    const keysBefore = mockRingState.mock.calls.map((c) => c[1]);
    expect(Math.max(...keysBefore)).toBe(0);
    await act(async () => { last.onRetry(); });
    const keysAfter = mockRingState.mock.calls.map((c) => c[1]);
    expect(Math.max(...keysAfter)).toBe(1);
  });

  it('a readable empty read is not unreadable', async () => {
    mockRingState.mockReturnValue({ hasActive: false, allViewed: false, highlights: [], unreadable: false });
    await render(<PassportScreen />);
    await act(async () => {});
    const last = mockStripProps.mock.calls[mockStripProps.mock.calls.length - 1]?.[0] as any;
    expect(last.unreadable).toBe(false);
  });
});
