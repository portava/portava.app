/**
 * usePassport — snapshot rejection tests
 *
 * Confirms that when a snapshot pre-populates the hook and the subsequent
 * API call then rejects (401 / session expired) or returns a different user,
 * the hook ends up in the correct state so the screen renders the right branch.
 *
 * Coverage:
 *   1. Snapshot pre-populates profile → API returns 401 → hook sets `error`;
 *      the screen's `if (error || !profile)` guard evaluates true, meaning the
 *      error UI is shown rather than the stale snapshot identity card.
 *   2. Snapshot pre-populates profile (userId A) → API returns a profile for
 *      userId B → hook's `profile` is replaced with the incoming profile, no
 *      error is set, and the screen renders PassportContent with the new data.
 *
 * Strategy:
 *   usePassport is exercised in isolation via renderHook. useSnapshotCache is
 *   mocked to return a pre-built snapshot immediately (synchronous React state)
 *   so the snapshot effect fires on the first render. The five API service
 *   functions are mocked to resolve with controlled responses. isSupabaseConfigured
 *   is set to true so the real Promise.all fetch path runs.
 *
 * Run with: pnpm test:component
 */

import { renderHook, waitFor } from '@testing-library/react-native';
import { usePassport } from '../usePassport.ts';
import type { OwnProfile } from '../../types/models.ts';

// ── useSnapshotCache ──────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — reads AsyncStorage and calls useSession;
// the stub returns a fully-controlled snapshot so we drive the two-phase load
// without touching native storage or auth.
jest.mock('../useSnapshotCache.ts', () => ({
  useSnapshotCache: jest.fn(),
}));

// ── services/profile ──────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — imports Supabase and the API token stack;
// pulling requireActual would trigger live network requests in the test runner.
jest.mock('../../services/profile.ts', () => ({
  getMyProfile:           jest.fn(),
  getMyPassportPostcards: jest.fn(),
}));

// ── services/passportStamps ───────────────────────────────────────────────────
// NOTE: intentionally exhaustive — imports Supabase; requireActual would OOM
// the jest-expo runner with the full native module graph.
jest.mock('../../services/passportStamps.ts', () => ({
  getMyPassportMemories:    jest.fn(),
  getMyPassportSuggestions: jest.fn(),
  getMyPassportStamps:      jest.fn(),
}));

// ── lib/supabase — isSupabaseConfigured = true ────────────────────────────────
// NOTE: intentionally exhaustive — lib/supabase imports the native Supabase
// client which requires native networking modules unavailable in jest-expo.
// Setting isSupabaseConfigured to true forces usePassport to take the real
// Promise.all path instead of the mock-data fallback.
jest.mock('../../lib/supabase.ts', () => ({
  isSupabaseConfigured: true,
}));

// ── data/passport ─────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — the data file re-exports from __fixtures__
// which transitively imports media assets that fail under jest-expo. The mock
// data path in usePassport is unreachable here (isSupabaseConfigured = true)
// but the module is still evaluated at import time, so we stub it.
jest.mock('../../data/passport.ts', () => ({
  mockPassport: { user: {}, stamps: [] },
}));

// ── Typed mock handles ────────────────────────────────────────────────────────

const { useSnapshotCache }         = require('../useSnapshotCache.ts');
const mockUseSnapshotCache         = useSnapshotCache as jest.Mock;

const { getMyProfile, getMyPassportPostcards } =
  require('../../services/profile.ts');

const { getMyPassportMemories, getMyPassportSuggestions, getMyPassportStamps } =
  require('../../services/passportStamps.ts');

// ── Shared fixture data ───────────────────────────────────────────────────────

/** Profile stored in AsyncStorage from the previous successful session. */
const SNAPSHOT_PROFILE: OwnProfile = {
  id:                    'snap-user-1',
  username:              'snapuser',
  handle:                'snapuser',
  name:                  'Snap User',
  displayName:           'Snap User',
  bio:                   null,
  avatarUrl:             null,
  homeCity:              null,
  homeCountry:           null,
  currentCity:           null,
  travelStyle:           null,
  interests:             [],
  verified:              false,
  verificationStatus:    'unverified',
  verifiedAt:            null,
  openToMeet:            false,
  isPrivate:             false,
  passportVisibility:    'public',
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
  verificationLevel:     'none',
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

/** Fresh profile returned by the API — different userId to simulate a cross-user replacement. */
const FRESH_PROFILE: OwnProfile = {
  ...SNAPSHOT_PROFILE,
  id:          'fresh-user-2',
  username:    'freshuser',
  handle:      'freshuser',
  name:        'Fresh User',
  displayName: 'Fresh User',
};

/** Snapshot shape stored in AsyncStorage (mirrors PassportSnapshot in usePassport.ts). */
const SNAPSHOT_DATA = {
  profile:   SNAPSHOT_PROFILE,
  postcards: [],
  stamps:    [],
  memories:  [],
};

// ── Helper: configure snapshot mock ──────────────────────────────────────────

function setupSnapshotMock() {
  mockUseSnapshotCache.mockReturnValue({
    snapshot: SNAPSHOT_DATA,
    isStale:  false,
    save:     jest.fn(),
    clear:    jest.fn(),
  });
}

/** Stub subsidiary calls with empty success so they don't affect assertions. */
function setupSubsidiaryMocks() {
  (getMyPassportPostcards  as jest.Mock).mockResolvedValue({ ok: true, data: [] });
  (getMyPassportStamps     as jest.Mock).mockResolvedValue({ ok: true, data: [], total: 0 });
  (getMyPassportMemories   as jest.Mock).mockResolvedValue({ ok: true, data: [] });
  (getMyPassportSuggestions as jest.Mock).mockResolvedValue({ ok: true, data: [] });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('usePassport — snapshot pre-populates, API returns 401', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupSnapshotMock();
    setupSubsidiaryMocks();

    // Profile fetch returns Unauthorized — simulates a session expiry.
    (getMyProfile as jest.Mock).mockResolvedValue({
      ok:      false,
      message: 'Unauthorized',
    });
  });

  it('sets error after the 401 — loading is false, profile retains the snapshot value', async () => {
    const { result } = await renderHook(() => usePassport());

    // Wait for the API call to resolve and error to be set.
    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.error).toBe('Unauthorized');
    // Profile is not cleared — avoids a blank flash while the error state is committed.
    expect(result.current.profile).not.toBeNull();
    // No spinner is shown alongside the error.
    expect(result.current.loading).toBe(false);
  });

  it('screen condition (error || !profile) evaluates true — error UI is rendered, not stale content', async () => {
    const { result } = await renderHook(() => usePassport());

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    // passport.tsx renders `if (error || !profile)` to choose the error branch.
    // Verify the exact guard evaluates true so the error UI appears.
    const { error, profile } = result.current;
    expect(!!(error || !profile)).toBe(true);
  });
});

describe('usePassport — snapshot pre-populates, API returns a different userId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupSnapshotMock();
    setupSubsidiaryMocks();

    // Profile fetch returns a profile for a different user (defensive case).
    (getMyProfile as jest.Mock).mockResolvedValue({
      ok:   true,
      data: FRESH_PROFILE,
    });
  });

  it('replaces the snapshot profile with the API-returned profile', async () => {
    const { result } = await renderHook(() => usePassport());

    // Wait for the incoming profile to land.
    await waitFor(() => {
      expect(result.current.profile?.id).toBe('fresh-user-2');
    });

    expect(result.current.profile?.id).toBe('fresh-user-2');
    expect(result.current.profile?.username).toBe('freshuser');
  });

  it('sets no error and clears loading — screen renders PassportContent with the new profile', async () => {
    const { result } = await renderHook(() => usePassport());

    await waitFor(() => {
      expect(result.current.profile?.id).toBe('fresh-user-2');
    });

    // No error — this is a legitimate data replacement, not an auth failure.
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);

    // passport.tsx renders PassportContent only when this guard is false.
    const { error, profile } = result.current;
    expect(!!(error || !profile)).toBe(false);
  });
});
