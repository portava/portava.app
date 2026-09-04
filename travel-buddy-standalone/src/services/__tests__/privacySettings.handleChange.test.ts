/**
 * Unit tests for applyPrivacyChange — the optimistic-update + rollback logic
 * used by the Privacy settings screen (app/profile/edit/privacy.tsx).
 *
 * Tests verify:
 *   1. No-op guard: when privacy is null (load failed or not yet complete),
 *      updateFn is never called and state is not mutated.
 *   2. Success path: updateFn is called with the correct single-key patch,
 *      and the optimistic state is kept after the update resolves.
 *   3. Optimistic update: state is changed *before* updateFn resolves.
 *   4. Rollback on failure: when updateFn returns ok:false, state is restored
 *      to the previous value and onError is fired with the server message.
 *   5. Fallback message: when ok:false has no message, the generic fallback
 *      string is used.
 *   6. Saving flag: cleared after both success and failure.
 *
 * Run via:
 *   node --import tsx/esm --test \
 *     src/services/__tests__/privacySettings.handleChange.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyPrivacyChange } from '../privacySettingsLogic.ts';
import type { PrivacySettings, ProfileResult } from '../profile.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function baseSettings(): PrivacySettings {
  return {
    profile_visibility: 'public',
    show_current_city: true,
    show_home_country: true,
    show_visited_places: true,
    show_upcoming_trips: true,
    show_past_trips: true,
    show_posts: true,
    show_stamps: true,
    show_friends: true,
    show_followers: true,
    allow_messages_from: 'everyone',
    allow_friend_requests: true,
    allow_follow: true,
    allow_tagging: true,
    allow_profile_discovery: true,
    delayed_posting_default: false,
    precise_location_visible: false,
    show_profile_picture_publicly: true,
    show_real_name: true,
  };
}

interface Tracker {
  readonly state: PrivacySettings | null;
  readonly isSaving: boolean;
  readonly errors: string[];
  setPrivacy(p: PrivacySettings | null): void;
  setSaving(s: boolean): void;
  onError(msg: string): void;
}

function makeTracker(initial: PrivacySettings | null = null): Tracker {
  let privacyState = initial;
  let saving = false;
  const errors: string[] = [];
  return {
    get state() { return privacyState; },
    get isSaving() { return saving; },
    get errors() { return errors; },
    setPrivacy(p: PrivacySettings | null) { privacyState = p; },
    setSaving(s: boolean) { saving = s; },
    onError(msg: string) { errors.push(msg); },
  };
}

function ok(patch: Partial<PrivacySettings> = {}): (p: Partial<PrivacySettings>) => Promise<ProfileResult<PrivacySettings>> {
  return async (p) => ({ ok: true, data: { ...baseSettings(), ...patch, ...p } });
}

function fail(message?: string): (p: Partial<PrivacySettings>) => Promise<ProfileResult<PrivacySettings>> {
  return async () => ({ ok: false, data: null, message });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('applyPrivacyChange', () => {
  it('is a no-op when privacy is null — updateFn never called', async () => {
    const tracker = makeTracker(null);
    let called = false;

    await applyPrivacyChange(null, 'show_upcoming_trips', false, tracker, async (p) => {
      called = true;
      return ok()(p);
    });

    assert.strictEqual(called, false, 'updateFn must not be called when privacy is null');
    assert.strictEqual(tracker.state, null, 'privacy state must remain null');
    assert.strictEqual(tracker.isSaving, false, 'saving must not be set');
    assert.deepStrictEqual(tracker.errors, [], 'no errors must be emitted');
  });

  it('calls updateFn with the correct single-key patch', async () => {
    const settings = baseSettings();
    const tracker = makeTracker();
    const patches: Partial<PrivacySettings>[] = [];

    await applyPrivacyChange(settings, 'profile_visibility', 'private', tracker, async (patch) => {
      patches.push(patch);
      return ok(patch)({});
    });

    assert.strictEqual(patches.length, 1, 'updateFn must be called exactly once');
    assert.deepStrictEqual(patches[0], { profile_visibility: 'private' },
      'patch must contain only the changed key');
  });

  it('applies the optimistic update before updateFn resolves', async () => {
    const settings = baseSettings(); // show_upcoming_trips: true
    const tracker = makeTracker();
    let stateAtCallTime: PrivacySettings | null = null;

    await applyPrivacyChange(settings, 'show_upcoming_trips', false, tracker, async (patch) => {
      stateAtCallTime = tracker.state;
      return ok(patch)({});
    });

    assert.ok(stateAtCallTime !== null, 'state must be set before updateFn returns');
    assert.strictEqual((stateAtCallTime as PrivacySettings).show_upcoming_trips, false,
      'optimistic value must be applied before network call returns');
    assert.strictEqual((tracker.state as PrivacySettings | null)?.show_upcoming_trips, false,
      'state must stay updated after a successful save');
  });

  it('rolls back to the previous state when updateFn returns ok:false', async () => {
    const settings = baseSettings(); // show_friends: true
    const tracker = makeTracker();

    await applyPrivacyChange(settings, 'show_friends', false, tracker, fail('Server error'));

    assert.deepStrictEqual(tracker.state, settings,
      'state must be restored to the original after a failed update');
    assert.strictEqual(tracker.errors.length, 1, 'onError must be called once');
    assert.strictEqual(tracker.errors[0], 'Server error');
  });

  it('uses the fallback message when updateFn returns ok:false with no message', async () => {
    const settings = baseSettings();
    const tracker = makeTracker();

    await applyPrivacyChange(settings, 'allow_follow', false, tracker, fail(undefined));

    assert.strictEqual(tracker.errors[0], 'Could not update setting. Try again.',
      'fallback message must be used when server provides none');
  });

  it('clears the saving flag after success', async () => {
    const settings = baseSettings();
    const tracker = makeTracker();

    await applyPrivacyChange(settings, 'allow_tagging', false, tracker, ok());

    assert.strictEqual(tracker.isSaving, false, 'saving must be false after a successful update');
  });

  it('clears the saving flag after failure', async () => {
    const settings = baseSettings();
    const tracker = makeTracker();

    await applyPrivacyChange(settings, 'allow_tagging', false, tracker, fail('err'));

    assert.strictEqual(tracker.isSaving, false, 'saving must be false after a failed update');
  });

  it('does not mutate other keys when patching a single boolean', async () => {
    const settings = baseSettings();
    const tracker = makeTracker();

    await applyPrivacyChange(settings, 'show_stamps', false, tracker, ok({ show_stamps: false }));

    const updated = tracker.state as PrivacySettings;
    assert.strictEqual(updated.show_stamps, false, 'target key must be updated');
    assert.strictEqual(updated.show_friends, settings.show_friends,
      'unrelated keys must not change');
    assert.strictEqual(updated.profile_visibility, settings.profile_visibility,
      'profile_visibility must not change');
  });
});
