/**
 * Onboarding → Passport flow tests
 *
 * Verifies that homeCity / homeCountry flow correctly through:
 *   1. The onboarding handleFinish patch-building logic — imported from the
 *      shared `profilePatchBuilder.ts` that onboarding.tsx also calls.
 *   2. The PassportSettingsSheet handleSave patch-building logic — imported
 *      from the same shared module used by the component.
 *   3. The updateMyProfile service — correct fields are sent in the PATCH body.
 *   4. The profile not-found copy constants — imported from the same module
 *      used by app/u/[username].tsx so copy cannot drift silently.
 *
 * Run:
 *   cd travel-buddy-standalone
 *   node --import tsx --test src/test/onboardingPassportFlow.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOnboardingPatch,
  buildPassportSettingsPatch,
} from '../services/profilePatchBuilder.ts';
import {
  _setTestAuthToken,
  updateMyProfile,
} from '../services/profile.ts';
import {
  PROFILE_NOT_FOUND_TITLE,
  PROFILE_NOT_FOUND_SUB,
} from '../constants/profileScreenCopy.ts';

const FAKE_TOKEN = 'fake-test-token-onboarding-flow';

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockFetch(status: number, body: unknown): typeof fetch {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response;
}

/**
 * Returns a fetch mock that captures the JSON body of the PATCH /api/me/profile
 * call and responds with 200.
 */
function capturingFetch(): { fetch: typeof fetch; getBody: () => unknown } {
  let captured: unknown = undefined;
  const f: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? '';
    if (url.includes('/api/me/profile') && (init?.method ?? 'GET').toUpperCase() === 'PATCH') {
      captured = JSON.parse(init?.body as string ?? '{}');
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: 'test-user-id',
        displayName: 'Test User',
        username: 'testuser',
        homeCity: (captured as any)?.homeCity ?? null,
        homeCountry: (captured as any)?.homeCountry ?? null,
      }),
    } as unknown as Response;
  };
  return { fetch: f, getBody: () => captured };
}

// ── Suite 1: Onboarding patch-building logic ──────────────────────────────────
//
// Calls `buildOnboardingPatch` from `src/services/profilePatchBuilder.ts`,
// the same function imported by app/(auth)/onboarding.tsx handleFinish.
// Tests here are coupled to real production logic — any refactor of the
// shared function will be caught immediately.

describe('buildOnboardingPatch — homeCity / homeCountry field handling', () => {
  it('includes homeCity and homeCountry when both are set', () => {
    const patch = buildOnboardingPatch({
      displayName: 'Drae', handle: 'drae', homeCity: 'Cebu', homeCountry: 'Philippines',
      travelStyle: 'solo', interests: [],
    });
    assert.equal(patch.homeCity, 'Cebu', 'homeCity must be included in patch');
    assert.equal(patch.homeCountry, 'Philippines', 'homeCountry must be included in patch');
  });

  it('includes homeCity alone when only homeCity is set', () => {
    const patch = buildOnboardingPatch({
      displayName: 'Drae', handle: '', homeCity: 'Manila', homeCountry: '',
      travelStyle: 'solo', interests: [],
    });
    assert.equal(patch.homeCity, 'Manila', 'homeCity must be included when set alone');
    assert.ok(!('homeCountry' in patch), 'homeCountry must be absent when empty');
  });

  it('excludes homeCity and homeCountry when empty string', () => {
    const patch = buildOnboardingPatch({
      displayName: 'Drae', handle: '', homeCity: '', homeCountry: '',
      travelStyle: 'solo', interests: [],
    });
    assert.ok(!('homeCity' in patch), 'homeCity must not appear when empty');
    assert.ok(!('homeCountry' in patch), 'homeCountry must not appear when empty');
  });

  it('trims whitespace from homeCity and homeCountry', () => {
    const patch = buildOnboardingPatch({
      displayName: '', handle: '', homeCity: '  Davao  ', homeCountry: '  Philippines  ',
      travelStyle: 'solo', interests: [],
    });
    assert.equal(patch.homeCity, 'Davao', 'homeCity must be trimmed');
    assert.equal(patch.homeCountry, 'Philippines', 'homeCountry must be trimmed');
  });

  it('excludes homeCity when only whitespace', () => {
    const patch = buildOnboardingPatch({
      displayName: '', handle: '', homeCity: '   ', homeCountry: '   ',
      travelStyle: 'solo', interests: [],
    });
    assert.ok(!('homeCity' in patch), 'whitespace-only homeCity must be excluded');
    assert.ok(!('homeCountry' in patch), 'whitespace-only homeCountry must be excluded');
  });

  it('always includes interests and travelStyle in patch', () => {
    const patch = buildOnboardingPatch({
      displayName: '', handle: '', homeCity: 'Cebu', homeCountry: 'Philippines',
      travelStyle: 'group', interests: ['beach', 'food'],
    });
    assert.deepEqual(patch.interests, ['beach', 'food']);
    assert.equal(patch.travelStyle, 'group');
  });

  it('strips leading @ from handle before including', () => {
    const patch = buildOnboardingPatch({
      displayName: '', handle: '@traveler', homeCity: '', homeCountry: '',
      travelStyle: 'solo', interests: [],
    });
    assert.equal(patch.username, 'traveler', 'leading @ must be stripped from handle');
  });

  it('excludes username when handle is empty', () => {
    const patch = buildOnboardingPatch({
      displayName: '', handle: '', homeCity: '', homeCountry: '',
      travelStyle: 'solo', interests: [],
    });
    assert.ok(!('username' in patch), 'username must be absent when handle is empty');
  });
});

// ── Suite 2: PassportSettingsSheet patch-building logic ───────────────────────
//
// Calls `buildPassportSettingsPatch` from `src/services/profilePatchBuilder.ts`,
// the same function imported by PassportSettingsSheet.tsx handleSave.

describe('buildPassportSettingsPatch — homeCity / homeCountry field handling', () => {
  const base = {
    displayName: 'Drae', bio: '', homeCity: '', homeCountry: '',
    passportPublic: true, interests: [], spokenLanguages: [],
    defaultLanguage: '', travelStyles: [], travelPace: null, budgetStyle: null,
    travelGroupStyle: [], lookingFor: [], comfortLevel: null,
    availabilityTags: [], planningStyle: null,
    currentUsername: 'alice', newUsername: 'alice', usernameStatus: 'idle',
  };

  it('includes homeCity and homeCountry when both are set', () => {
    const patch = buildPassportSettingsPatch({ ...base, homeCity: 'Cebu', homeCountry: 'Philippines' });
    assert.equal(patch.homeCity, 'Cebu', 'homeCity must be included in passport settings patch');
    assert.equal(patch.homeCountry, 'Philippines', 'homeCountry must be included in passport settings patch');
  });

  it('sets homeCity to undefined (excluded from JSON) when empty string', () => {
    const patch = buildPassportSettingsPatch({ ...base, homeCity: '', homeCountry: '' });
    assert.equal(patch.homeCity, undefined, 'empty homeCity becomes undefined, stripped by JSON.stringify');
    assert.equal(patch.homeCountry, undefined, 'empty homeCountry becomes undefined, stripped by JSON.stringify');
    const serialized = JSON.parse(JSON.stringify(patch));
    assert.ok(!('homeCity' in serialized), 'homeCity must not appear in serialized PATCH body when empty');
    assert.ok(!('homeCountry' in serialized), 'homeCountry must not appear in serialized PATCH body when empty');
  });

  it('trims homeCity before including', () => {
    const patch = buildPassportSettingsPatch({ ...base, homeCity: '  Manila  ', homeCountry: '  Philippines  ' });
    assert.equal(patch.homeCity, 'Manila');
    assert.equal(patch.homeCountry, 'Philippines');
  });

  it('sets passportVisibility to private when passportPublic is false', () => {
    const patch = buildPassportSettingsPatch({ ...base, passportPublic: false });
    assert.equal(patch.passportVisibility, 'private');
  });

  it('sets passportVisibility to public when passportPublic is true', () => {
    const patch = buildPassportSettingsPatch({ ...base, passportPublic: true });
    assert.equal(patch.passportVisibility, 'public');
  });

  it('excludes username when new username equals current username', () => {
    const patch = buildPassportSettingsPatch({
      ...base, currentUsername: 'alice', newUsername: 'alice', usernameStatus: 'available',
    });
    assert.ok(!('username' in patch), 'username must be excluded when unchanged');
  });

  it('excludes username when usernameStatus is unavailable', () => {
    const patch = buildPassportSettingsPatch({
      ...base, currentUsername: 'alice', newUsername: 'taken_name', usernameStatus: 'unavailable',
    });
    assert.ok(!('username' in patch), 'username must be excluded when status is unavailable');
  });

  it('includes username when it changed and status is available', () => {
    const patch = buildPassportSettingsPatch({
      ...base, currentUsername: 'alice', newUsername: 'alice_v2', usernameStatus: 'available',
    });
    assert.equal(patch.username, 'alice_v2');
  });
});

// ── Suite 3: updateMyProfile service — PATCH body reaches the API ─────────────
//
// Uses _setTestAuthToken to bypass Supabase auth and mocks globalThis.fetch
// to capture the actual JSON body sent to PATCH /api/me/profile.

describe('updateMyProfile — homeCity / homeCountry sent in PATCH body', () => {
  let _savedFetch: typeof fetch;

  before(() => {
    _savedFetch = globalThis.fetch;
    _setTestAuthToken(FAKE_TOKEN);
  });

  after(() => {
    globalThis.fetch = _savedFetch;
    _setTestAuthToken(null);
  });

  it('sends homeCity and homeCountry in the PATCH body when both provided', async () => {
    const { fetch: f, getBody } = capturingFetch();
    globalThis.fetch = f;
    await updateMyProfile({ homeCity: 'Cebu', homeCountry: 'Philippines', interests: [] });
    const body = getBody() as any;
    assert.ok(body, 'fetch must have been called');
    assert.equal(body.homeCity, 'Cebu', 'homeCity must be in the PATCH body');
    assert.equal(body.homeCountry, 'Philippines', 'homeCountry must be in the PATCH body');
  });

  it('sends homeCity without homeCountry when only homeCity provided', async () => {
    const { fetch: f, getBody } = capturingFetch();
    globalThis.fetch = f;
    await updateMyProfile({ homeCity: 'Manila', interests: [] });
    const body = getBody() as any;
    assert.ok(body, 'fetch must have been called');
    assert.equal(body.homeCity, 'Manila', 'homeCity must be in the PATCH body');
    assert.ok(!('homeCountry' in body), 'homeCountry must be absent when not provided');
  });

  it('returns ok=true when API responds 200', async () => {
    const { fetch: f } = capturingFetch();
    globalThis.fetch = f;
    const result = await updateMyProfile({ homeCity: 'Cebu', homeCountry: 'Philippines', interests: [] });
    assert.equal(result.ok, true, 'updateMyProfile must return ok=true on 200 response');
  });

  it('returns ok=false when API responds 400', async () => {
    globalThis.fetch = mockFetch(400, { error: 'invalid_payload', message: 'Bad request' });
    const result = await updateMyProfile({ homeCity: 'Cebu', interests: [] });
    assert.equal(result.ok, false, 'updateMyProfile must return ok=false on 400 response');
  });

  it('returns ok=false and errorKind=network_unreachable on network throw', async () => {
    globalThis.fetch = async () => { throw new Error('Network request failed'); };
    const result = await updateMyProfile({ homeCity: 'Cebu', interests: [] });
    assert.equal(result.ok, false, 'updateMyProfile must return ok=false on network error');
    assert.equal(result.errorKind, 'network_unreachable', 'errorKind must be network_unreachable');
  });
});

// ── Suite 4: Profile not-found copy constants ─────────────────────────────────
//
// Imports PROFILE_NOT_FOUND_TITLE and PROFILE_NOT_FOUND_SUB from
// `src/constants/profileScreenCopy.ts` — the same module imported by
// app/u/[username].tsx. This confirms the rendered copy cannot silently drift
// to the old "No one here" placeholder or any other stale string.

describe('Profile not-found screen — copy strings', () => {
  it('PROFILE_NOT_FOUND_TITLE is "Profile not available"', () => {
    assert.equal(PROFILE_NOT_FOUND_TITLE, 'Profile not available');
  });

  it('PROFILE_NOT_FOUND_SUB is "This profile is no longer available." — not old "No one here" copy', () => {
    assert.equal(PROFILE_NOT_FOUND_SUB, 'This profile is no longer available.');
    assert.ok(!PROFILE_NOT_FOUND_SUB.includes('No one here'), '"No one here" must not appear in the not-found subtitle');
  });

  it('PROFILE_NOT_FOUND_SUB does not use the old "No one here" phrasing', () => {
    assert.notEqual(PROFILE_NOT_FOUND_SUB, 'No one here', 'old "No one here" copy must have been replaced');
  });
});
