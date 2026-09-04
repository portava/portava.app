/**
 * Passport — Destinations tab badge visibility
 *
 * Verifies that the Destinations tab label hides the count badge when the
 * user has no cities yet (showing plain "DESTINATIONS") and shows the count
 * when at least one destination exists ("DESTINATIONS · 1").
 *
 * The logic under test lives in passport.tsx → renderTabsSection:
 *
 *   {key === 'destinations' && destinationCount > 0
 *     ? `${TAB_LABELS[key]} · ${destinationCount}`.toUpperCase()
 *     : TAB_LABELS[key].toUpperCase()}
 *
 * where destinationCount = groupByDestination(memories, stamps, postcards, trips).length
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import PassportScreen from '../../../app/(tabs)/passport.tsx';
import { makePassportMock, MINIMAL_OWN_PROFILE } from '../../../src/components/__tests__/testUtils.ts';

// ── expo-router — intentionally exhaustive ───────────────────────────────────
// moduleNameMapper redirects expo-router to src/__mocks__/expo-router.tsx, so
// jest.requireActual is safe here (it resolves through the mapper, not native).
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

// ── Services ──────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — all import Supabase; requireActual OOMs.
jest.mock('../../../src/services/posts', () => ({
  getPendingPosts: jest.fn().mockResolvedValue({ ok: true, data: [] }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/rentABuddy', () => ({
  getMyBuddyProfile: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/profile', () => ({
  uploadAvatar: jest.fn().mockResolvedValue({ ok: false }),
  uploadCover:  jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentional stub — not under test here.
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

// NOTE: intentionally exhaustive — initialises Zustand at module level with
// side-effects that crash the JSDOM env.
jest.mock('../../../src/context/AvailabilityStore', () => ({
  useAvailabilityStore: () => ({
    availability: { openToMeet: false, trips: [] },
    quickStatus:  null,
    refresh:      jest.fn().mockResolvedValue(undefined),
  }),
}));

// ── Lib ───────────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — re-exports from context files pulling
// Zustand/Supabase.
jest.mock('../../../src/lib/availabilityChip', () => ({
  resolveAvailabilityChip: () => ({ label: null, color: null }),
}));

// ── Passport section/tab utilities ────────────────────────────────────────────
// NOTE: intentionally exhaustive — transitively import RN components needing
// native modules.
jest.mock('../../../src/components/passport/passportSections', () => ({
  resolveSectionOrder: () => ['tabs'],
  resolveHiddenSections: () => new Set(),
}));

// Expose only the 'destinations' tab so we can assert its label in isolation.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/passportTabs', () => ({
  resolveTabOrder: () => ['destinations'],
  TAB_LABELS: { destinations: 'Destinations' },
}));

// ── Sub-component stubs (null renders) ────────────────────────────────────────
// Each component below imports native modules (SVG, maps, camera) unavailable
// in the jest-expo runner — stub as null renders to isolate badge logic.

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
jest.mock('../../../src/components/passport/PassportOwnerMenuSheet', () => ({ PassportOwnerMenuSheet: Null }));
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
jest.mock('../../../src/components/passport/PassportIdentityCard',   () => ({ PassportIdentityCard: Null, PassportStatsRow: Null }));
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
jest.mock('../../../src/components/compass/CompassStatusCard',          () => ({ CompassStatusCard:          Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CompassPassportSuggestions', () => ({ CompassPassportSuggestions: Null }));
// NOTE: intentionally exhaustive — DestinationsTab imports map/location modules.
jest.mock('../../../src/components/passport/DestinationsTab', () => ({ DestinationsTab: Null }));

// ── Typed mock ref ─────────────────────────────────────────────────────────────

const { usePassport } = require('../../../src/hooks/usePassport.ts');
const mockUsePassport = usePassport as jest.Mock;

// Stable ref — never re-create between tests to avoid the setLocalPostcards
// re-render loop triggered by a fresh [] reference on every call.
const mockLastLoadedAt: { current: number } = { current: Date.now() };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Passport — Destinations tab badge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Stamp the ref to "just loaded" so the focus-TTL guard doesn't call reload.
    mockLastLoadedAt.current = Date.now();
  });

  it('shows plain "DESTINATIONS" label when the user has no cities', async () => {
    mockUsePassport.mockReturnValue(
      makePassportMock({
        profile:      MINIMAL_OWN_PROFILE,
        memories:     [],
        stamps:       [],
        postcards:    [],
        lastLoadedAt: mockLastLoadedAt,
      }),
    );

    await render(<PassportScreen />);
    await act(async () => {});

    // Should show the plain label with no badge.
    expect(screen.getByText('DESTINATIONS')).toBeTruthy();
    // The "· 0" variant must not appear anywhere.
    expect(screen.queryByText(/DESTINATIONS\s*·/)).toBeNull();

  });

  it('shows "DESTINATIONS · 1" when the user has exactly one city', async () => {
    mockUsePassport.mockReturnValue(
      makePassportMock({
        profile:   MINIMAL_OWN_PROFILE,
        memories:  [
          {
            id:               'm-1',
            status:           'active',
            title:            'Miami trip',
            description:      null,
            country:          'US',
            city:             'Miami',
            neighborhood:     null,
            category:         'city',
            visibility:       'public',
            verificationLevel:'none',
            sourceType:       null,
            photoUrl:         null,
            mediaType:        null,
            planId:           null,
            tripId:           null,
            suggestionReason: null,
            earnedAt:         '2026-01-15T00:00:00Z',
            createdAt:        '2026-01-15T00:00:00Z',
          },
        ],
        stamps:       [],
        postcards:    [],
        lastLoadedAt: mockLastLoadedAt,
      }),
    );

    await render(<PassportScreen />);
    await act(async () => {});

    expect(screen.getByText('DESTINATIONS · 1')).toBeTruthy();

  });
});
