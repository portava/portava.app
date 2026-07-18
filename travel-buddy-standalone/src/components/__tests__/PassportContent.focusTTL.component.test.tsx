/**
 * PassportContent — focus-driven reload TTL guard
 *
 * Confirms that the useFocusEffect inside PassportContent only calls
 * reload() when passport data is stale (older than FEED_FOCUS_TTL_MS).
 * Within the TTL window the reload is suppressed; once it expires the
 * next focus triggers exactly one reload.
 *
 * Also confirms that the two lightweight calls — getPendingPosts and
 * getMyBuddyProfile — fire unconditionally on every focus, regardless
 * of TTL state.
 *
 * Run with: pnpm test:component
 *
 * ## Mock strategy
 *
 * expo-router is overridden locally (not via the file-level stub) so the
 * test can capture and re-fire the useFocusEffect callback at will.
 * All heavy sub-components are stubbed as null renders so no native-module
 * side-effects occur.  usePassport is mocked to return a pre-loaded profile
 * and a jest spy for reload().
 */

import React from 'react';
import { act, render } from '@testing-library/react-native';
import PassportScreen from '../../../app/(tabs)/passport.tsx';
import { FEED_FOCUS_TTL_MS } from '../../hooks/usePosts.ts';

// ── Controlled useFocusEffect ─────────────────────────────────────────────────
// Capture the callback so tests can re-trigger focus manually.

let capturedFocusCallback: (() => void) | null = null;

// NOTE: intentionally exhaustive — expo-router is a native package; pulling
// requireActual would drag in native modules that crash the jest-expo runner.
// The custom useFocusEffect stores the callback so tests can re-fire it.
jest.mock('expo-router', () => {
  const React = require('react');
  return {
    router: {
      push:     jest.fn(),
      replace:  jest.fn(),
      back:     jest.fn(),
      navigate: jest.fn(),
      dismiss:  jest.fn(),
    },
    useRouter:             () => ({ push: jest.fn(), back: jest.fn() }),
    useLocalSearchParams:  () => ({}),
    usePathname:           () => '/',
    useSegments:           () => [],
    useFocusEffect: (cb: () => (() => void) | void) => {
      // Fire once on mount (mirrors the file-level stub) and capture for
      // re-triggering in later test steps.
      React.useEffect(() => {
        capturedFocusCallback = () => { cb(); };
        cb();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
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
  };
});

// NOTE: intentionally exhaustive — react-native-safe-area-context pulls native
// UIManager internals that are not safe under jest-expo.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — expo-image-picker requires native camera
// permissions modules that are unavailable in the jest-expo runner.
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ granted: false }),
  launchImageLibraryAsync:             jest.fn().mockResolvedValue({ canceled: true }),
  MediaTypeOptions:                    { Images: 'Images' },
}));

// ── usePassport — pre-loaded, no loading spinner ──────────────────────────────

const mockReload = jest.fn();

const MOCK_PROFILE = {
  id:                    'user-test-1',
  username:              'testuser',
  handle:                'testuser',
  name:                  'Test User',
  displayName:           'Test User',
  bio:                   null,
  avatarUrl:             null,
  homeCity:              null,
  homeCountry:           null,
  currentCity:           null,
  travelStyle:           null,
  interests:             [],
  verified:              false,
  verificationStatus:    'unverified' as const,
  verifiedAt:            null,
  openToMeet:            false,
  isPrivate:             false,
  passportVisibility:    'public' as const,
  coverPhotoUrl:         null,
  usernameUpdatedAt:     null,
  createdAt:             '2024-01-01T00:00:00Z',
  spokenLanguages:       [],
  defaultLanguage:       null,
  travelStyles:          [],
  travelPace:            null,
  budgetStyle:           null,
  travelGroupStyle:      [],
  lookingFor:            [],
  comfortLevel:          null,
  availabilityTags:      [],
  planningStyle:         null,
  publicSocialLinks:     {},
  preferredLanguage:     null,
  dateOfBirth:           null,
  dobVerified:           false,
  trustScore:            null,
  trustLabel:            null,
  verificationLevel:     'none' as const,
  idVerifiedAt:          null,
  selfieVerifiedAt:      null,
  homeCountryVerifiedAt: null,
  safetyFlagsCount:      0,
  followersCount:        0,
  followingCount:        0,
  tripCount:             0,
  hostVerifiedAt:        null,
  buddyVerifiedAt:       null,
  passportSectionOrder:  null,
  passportTabOrder:      null,
};

// NOTE: intentionally exhaustive — usePassport calls Supabase and the full
// network stack; pulling requireActual would trigger live network requests.
jest.mock('../../hooks/usePassport', () => ({
  usePassport: jest.fn(),
}));

// ── Services ──────────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — services/posts imports Supabase and the API
// token stack, pulling in a module graph that causes OOM under jest-expo when
// loaded via requireActual.  Only getPendingPosts is used by passport.tsx.
jest.mock('../../services/posts', () => ({
  getPendingPosts: jest.fn(),
}));

// NOTE: intentionally exhaustive — services/rentABuddy imports Supabase;
// requireActual would cause OOM.  Only getMyBuddyProfile is used by passport.tsx.
jest.mock('../../services/rentABuddy', () => ({
  getMyBuddyProfile: jest.fn(),
}));

// NOTE: intentionally exhaustive — services/profile imports Supabase;
// requireActual would cause OOM.  Only uploadAvatar/uploadCover are used.
jest.mock('../../services/profile', () => ({
  uploadAvatar: jest.fn().mockResolvedValue({ ok: false }),
  uploadCover:  jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentionally exhaustive — services/trips imports Supabase;
// requireActual would cause OOM.  Only listMyTrips is used by passport.tsx.
jest.mock('../../services/trips', () => ({
  listMyTrips: jest.fn().mockResolvedValue([]),
}));

// ── Hooks ─────────────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — useNavBarCollapse accesses native scroll
// metrics that are unavailable in the jest-expo runner.
jest.mock('../../hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => jest.fn(),
  NavBarFiller:           () => null,
}));

// NOTE: intentionally exhaustive — usePostcardActions references network
// services; pulling requireActual would cause live API calls in tests.
jest.mock('../../hooks/usePostcardActions', () => ({
  usePostcardActions: (_setter: unknown) => ({
    onDelete: jest.fn(),
    onEdit:   jest.fn(),
  }),
}));

// NOTE: intentionally exhaustive — usePassportShare accesses the native Share
// API and camera roll, which crash the jest-expo runner.
jest.mock('../../hooks/usePassportShare', () => ({
  usePassportShare: (_username: unknown) => ({
    cardRef: { current: null },
    share:   jest.fn(),
    sharing: false,
  }),
}));

// NOTE: intentionally exhaustive — useHighlightRingState calls Supabase
// realtime subscriptions unavailable in the test environment.
jest.mock('../../hooks/useHighlightRingState', () => ({
  useHighlightRingState:    (_userId: unknown, _key: unknown) => null,
  invalidateHighlightCache: jest.fn(),
}));

// ── Context ───────────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — SessionContext imports Supabase, auth
// services, and circle/cache services that pull in native-incompatible modules
// under jest-expo.  Only useSession is consumed by passport.tsx.
jest.mock('../../context/SessionContext', () => ({
  useSession: () => ({ userId: 'user-test-1', isAuthed: true }),
}));

// NOTE: intentionally exhaustive — the real AvailabilityStore initializes a
// Zustand store at module level and triggers side-effects (reads refs, schedules
// fetches) that crash the JSDOM env.  Only the hook return value is needed here.
jest.mock('../../context/AvailabilityStore', () => ({
  useAvailabilityStore: () => ({
    availability: { openToMeet: false, trips: [] },
    quickStatus:  null,
    refresh:      jest.fn().mockResolvedValue(undefined),
  }),
}));

// ── Lib ───────────────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — resolveAvailabilityChip is pure but its
// module re-exports from context files that pull in Zustand/Supabase.
jest.mock('../../lib/availabilityChip', () => ({
  resolveAvailabilityChip: () => ({ label: null, color: null }),
}));

// ── Passport section/tab utilities ────────────────────────────────────────────

// NOTE: intentionally exhaustive — passportSections/passportTabs are pure but
// their modules transitively import RN components that need native modules.
jest.mock('../passport/passportSections', () => ({
  resolveSectionOrder: () => [],
}));

// NOTE: intentionally exhaustive — see passportSections note above.
jest.mock('../passport/passportTabs', () => ({
  resolveTabOrder: () => [],
  TAB_LABELS:      {},
}));

// ── Sub-component stubs (null renders) ────────────────────────────────────────
// Each component below imports native modules (SVG, maps, camera) unavailable
// in the jest-expo runner — stub as null renders to focus on focus-TTL logic.

const Null = () => null;

// NOTE: intentionally exhaustive — imports native UI/camera modules.
jest.mock('../NotificationBell',  () => ({ NotificationBell:  Null }));
jest.mock('../HighlightViewer',   () => ({ HighlightViewer:   Null }));
jest.mock('../HighlightComposer', () => ({ HighlightComposer: Null }));
jest.mock('../PostcardComposer',  () => ({ PostcardComposer:  Null }));
// NOTE: intentionally exhaustive — imports native UI/camera modules.
jest.mock('../MemoriesTab',           () => ({ MemoriesTab:           Null }));
jest.mock('../TripsTab',              () => ({ TripsTab:              Null }));
jest.mock('../SuggestedMemoryModal',  () => ({ SuggestedMemoryModal:  Null }));
jest.mock('../OwnerActionMenu',       () => ({ OwnerActionMenu:       Null }));
// NOTE: intentionally exhaustive — imports native UI/camera modules.
jest.mock('../ProfileCompletionCard', () => ({ ProfileCompletionCard: Null }));
jest.mock('../PassportShareCard',     () => ({ PassportShareCard:     Null }));
jest.mock('../PostcardsTab',          () => ({ PostcardsTab:          Null }));
jest.mock('../StampsTab',             () => ({ StampsTab:             Null }));
// NOTE: intentionally exhaustive — MapTab imports native map modules.
jest.mock('../MapTab', () => ({ MapTab: Null }));

// NOTE: intentionally exhaustive — passport sub-components import SVG and
// native image libraries that crash under jest-expo.
jest.mock('../passport/PassportIdentityCard',   () => ({ PassportIdentityCard: Null, PassportStatsRow: Null }));
jest.mock('../passport/PassportDivider',         () => ({ PassportDivider:         Null }));
jest.mock('../passport/PassportStampCollection', () => ({ PassportStampCollection: Null }));
// NOTE: intentionally exhaustive — passport sub-components import SVG/native.
jest.mock('../passport/PassportStampsFullView',  () => ({ PassportStampsFullView:  Null }));
jest.mock('../passport/PassportHighlightsStrip', () => ({ PassportHighlightsStrip: Null }));
jest.mock('../passport/PassportAboutSection',    () => ({ PassportAboutSection:    Null }));
jest.mock('../passport/PassportSafetySection',   () => ({ PassportSafetySection:   Null }));
// NOTE: intentionally exhaustive — passport sheet components import native.
jest.mock('../passport/PassportSectionReorderSheet', () => ({ PassportSectionReorderSheet: Null }));
jest.mock('../passport/PassportTabReorderSheet',     () => ({ PassportTabReorderSheet:     Null }));

// NOTE: intentionally exhaustive — compass components import map/location
// native modules that are unavailable in the jest-expo runner.
jest.mock('../compass/CompassStatusCard',          () => ({ CompassStatusCard:          Null }));
jest.mock('../compass/CompassPassportSuggestions', () => ({ CompassPassportSuggestions: Null }));

// ── Typed mock refs ────────────────────────────────────────────────────────────

const { usePassport } = require('../../hooks/usePassport.ts');
const mockUsePassport = usePassport as jest.Mock;

const { getPendingPosts } = require('../../services/posts.ts');
const mockGetPendingPosts = getPendingPosts as jest.Mock;

const { getMyBuddyProfile } = require('../../services/rentABuddy.ts');
const mockGetMyBuddyProfile = getMyBuddyProfile as jest.Mock;

// Stable ref object shared across all tests.  Its .current is updated in each
// beforeEach to the suite's BASE_TIME *after* the Date.now spy is installed,
// so the component sees lastLoadedAt.current === Date.now() on first render and
// correctly suppresses the initial reload.
//
// Using a stable object (not mockImplementation returning a new {current:…} on
// every call) avoids the infinite re-render triggered by passport.tsx's
// `useEffect(() => setLocalPostcards(postcards), [postcards])` — that hook
// fires whenever the postcards reference changes, and a fresh [] on every
// render is a new reference every time.
const mockLastLoadedAt: { current: number } = { current: 0 };

// ── Helpers ────────────────────────────────────────────────────────────────────

function setupPassportMock() {
  mockUsePassport.mockReturnValue({
    profile:      MOCK_PROFILE,
    postcards:    [],
    stamps:       [],
    memories:     [],
    suggestions:  [],
    loading:      false,
    error:        null,
    reload:       mockReload,
    lastLoadedAt: mockLastLoadedAt,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PassportContent — focus TTL guard: reload suppressed within TTL', () => {
  let dateSpy: jest.SpyInstance;
  const BASE_TIME = 1_000_000;

  beforeEach(() => {
    jest.clearAllMocks();
    capturedFocusCallback = null;
    setupPassportMock();

    // Freeze Date.now() at BASE_TIME for the initial mount.
    dateSpy = jest.spyOn(Date, 'now').mockReturnValue(BASE_TIME);

    // Stamp the ref to match the mocked clock so the component sees
    // Date.now() - lastLoadedAt.current === 0 on first render (within TTL).
    mockLastLoadedAt.current = BASE_TIME;

    mockGetPendingPosts.mockResolvedValue({ ok: true, data: [] });
    mockGetMyBuddyProfile.mockResolvedValue({ ok: false });
  });

  afterEach(() => {
    dateSpy.mockRestore();
  });

  it('does NOT call reload() on the first focus — data was just loaded (within TTL)', async () => {
    const { unmount } = await render(<PassportScreen />);

    // Allow the initial useFocusEffect (fired on mount) to settle.
    await act(async () => {});

    // lastPassportLoadedAt is initialised to Date.now() on mount; the focus
    // callback fires at the same mock time, so elapsed = 0 < TTL.
    expect(mockReload).not.toHaveBeenCalled();

    await act(async () => { unmount(); });
  });

  it('does NOT call reload() when refocused while still within the TTL window', async () => {
    const { unmount } = await render(<PassportScreen />);
    await act(async () => {});

    // Advance time by 1 minute — well within the 5-minute TTL.
    dateSpy.mockReturnValue(BASE_TIME + 60_000);

    // Simulate a second tab focus (re-entry without leaving the TTL).
    await act(async () => { capturedFocusCallback?.(); });

    expect(mockReload).not.toHaveBeenCalled();

    await act(async () => { unmount(); });
  });

  it('calls reload() exactly once when refocused after the TTL has expired', async () => {
    const { unmount } = await render(<PassportScreen />);
    await act(async () => {});

    // Advance time past the TTL (5 min + 1 ms).
    dateSpy.mockReturnValue(BASE_TIME + FEED_FOCUS_TTL_MS + 1);

    // Simulate tab re-entry after the TTL has elapsed.
    await act(async () => { capturedFocusCallback?.(); });

    expect(mockReload).toHaveBeenCalledTimes(1);

    await act(async () => { unmount(); });
  });
});

describe('PassportContent — unconditional lightweight calls on every focus', () => {
  let dateSpy: jest.SpyInstance;
  const BASE_TIME = 2_000_000;

  beforeEach(() => {
    jest.clearAllMocks();
    capturedFocusCallback = null;
    setupPassportMock();

    dateSpy = jest.spyOn(Date, 'now').mockReturnValue(BASE_TIME);

    // Stamp the ref to match the mocked clock so Date.now() - lastLoadedAt.current === 0
    // on first render (within TTL) — same pattern as the first suite.
    mockLastLoadedAt.current = BASE_TIME;

    mockGetPendingPosts.mockResolvedValue({ ok: true, data: [] });
    mockGetMyBuddyProfile.mockResolvedValue({ ok: false });
  });

  afterEach(() => {
    dateSpy.mockRestore();
  });

  it('calls getPendingPosts unconditionally on every focus — even within the TTL', async () => {
    const { unmount } = await render(<PassportScreen />);

    // Initial mount focus (within TTL).
    await act(async () => {});
    expect(mockGetPendingPosts).toHaveBeenCalledTimes(1);

    // Second focus, still within TTL.
    dateSpy.mockReturnValue(BASE_TIME + 30_000);
    await act(async () => { capturedFocusCallback?.(); });
    expect(mockGetPendingPosts).toHaveBeenCalledTimes(2);

    await act(async () => { unmount(); });
  });

  it('calls getMyBuddyProfile unconditionally on every focus — even within the TTL', async () => {
    const { unmount } = await render(<PassportScreen />);

    // Initial mount focus (within TTL).
    await act(async () => {});
    expect(mockGetMyBuddyProfile).toHaveBeenCalledTimes(1);

    // Second focus, still within TTL — reload is skipped but buddy profile re-fetches.
    dateSpy.mockReturnValue(BASE_TIME + 30_000);
    await act(async () => { capturedFocusCallback?.(); });
    expect(mockGetMyBuddyProfile).toHaveBeenCalledTimes(2);

    await act(async () => { unmount(); });
  });

  it('calls both getPendingPosts and getMyBuddyProfile on the stale-TTL focus too', async () => {
    const { unmount } = await render(<PassportScreen />);
    await act(async () => {});

    // Focus after TTL expires — reload fires AND lightweight calls re-fire.
    dateSpy.mockReturnValue(BASE_TIME + FEED_FOCUS_TTL_MS + 1);
    await act(async () => { capturedFocusCallback?.(); });

    expect(mockReload).toHaveBeenCalledTimes(1);
    expect(mockGetPendingPosts).toHaveBeenCalledTimes(2);
    expect(mockGetMyBuddyProfile).toHaveBeenCalledTimes(2);

    await act(async () => { unmount(); });
  });
});
