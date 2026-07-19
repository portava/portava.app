/**
 * Shared test utilities for component tests in this directory.
 *
 * Helpers here fill two roles:
 *  1. Provide canonical mock factories whose shape exactly matches the real hook
 *     return values, so a missing field can't silently trigger an infinite
 *     re-render (OOM) in the jest-expo runner.
 *  2. Give future test authors a single place to update when the hook shape
 *     changes — update here, TypeScript will flag every test that breaks.
 */

import type { MutableRefObject } from 'react';
import type { OwnProfile, PassportPostcard, PassportStamp } from '../../types/models.ts';
import type { PassportMemory } from '../../services/passportStamps.ts';
import type { PassportState } from '../../hooks/usePassport.ts';

// ── Minimal OwnProfile ────────────────────────────────────────────────────────
// All nullable fields default to null / empty so callers only have to specify
// the subset they care about.

export const MINIMAL_OWN_PROFILE: OwnProfile = {
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

// ── makePassportMock ──────────────────────────────────────────────────────────
//
// Returns a value that matches the full PassportState interface.
//
// WARNING: always include `lastLoadedAt` in the mock — omitting it causes the
// focus-TTL guard inside passport.tsx to compare Date.now() against `undefined`,
// which evaluates to NaN and makes `elapsed` always appear stale, triggering an
// infinite reload() → re-render loop that OOMs the jest-expo runner.
//
// The factory provides a sensible default (`{ current: 0 }`) so callers that
// don't need to customise the ref still get a valid shape.  Tests that exercise
// the focus-TTL logic should pass a shared stable ref object and update its
// `.current` after installing a Date.now() spy:
//
//   const mockLastLoadedAt = { current: 0 };
//   mockUsePassport.mockReturnValue(makePassportMock({ lastLoadedAt: mockLastLoadedAt }));
//   const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(BASE_TIME);
//   mockLastLoadedAt.current = BASE_TIME; // within TTL on first render

export interface PassportMockOverrides {
  profile?:      OwnProfile | null;
  postcards?:    PassportPostcard[];
  stamps?:       PassportStamp[];
  memories?:     PassportMemory[];
  suggestions?:  PassportMemory[];
  loading?:      boolean;
  error?:        string | null;
  /** Pass a jest.fn() spy here so tests can assert call counts on reload(). */
  reload?:       () => void;
  /**
   * Ref stamped with Date.now() after a successful fetch.
   * Provide a stable object (not a new literal on every call) to avoid
   * triggering the `useEffect(() => setLocalPostcards(postcards), [postcards])`
   * re-render loop inside passport.tsx.
   */
  lastLoadedAt?: MutableRefObject<number>;
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

export function makePassportMock(overrides: PassportMockOverrides = {}): PassportState {
  return {
    profile:      overrides.profile      !== undefined ? overrides.profile      : MINIMAL_OWN_PROFILE,
    postcards:    overrides.postcards    ?? [],
    stamps:       overrides.stamps       ?? [],
    memories:     overrides.memories     ?? [],
    suggestions:  overrides.suggestions  ?? [],
    loading:      overrides.loading      ?? false,
    error:        overrides.error        ?? null,
    stampsNew:    [],
    stampsTotal:  0,
    loadingMoreStamps: false,
    loadMoreStamps: noop,
    updateStamp:  noop,
    reload:       overrides.reload       ?? noop,
    // Default to { current: 0 } — represents "never loaded", which makes the
    // focus-TTL guard treat the first focus as stale.  Tests that want
    // "just loaded" behaviour should pass a ref stamped to match Date.now().
    lastLoadedAt: overrides.lastLoadedAt ?? { current: 0 },
  };
}
