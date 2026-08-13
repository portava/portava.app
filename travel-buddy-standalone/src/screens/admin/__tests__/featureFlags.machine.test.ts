/**
 * Machine-layer tests for the Feature Flags admin screen.
 *
 * Tests the pure logic extracted into featureFlags.machine.ts:
 *   - resolveAdminGate: admin guard navigation outcomes for all session states
 *   - applyOptimisticToggle: in-place flag state before server round-trip
 *   - applyToggleResult: server response handling (success, failure / revert)
 *   - applyLoadResult: flags fetch response handling
 *
 * No React Native, no Expo Router, no network — plain node:test only.
 *
 * Run:
 *   node --import tsx/esm --test \
 *     src/screens/admin/__tests__/featureFlags.machine.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAdminGate,
  applyOptimisticToggle,
  applyToggleResult,
  applyLoadResult,
  getActiveKillSwitches,
  KILL_SWITCH_FLAGS,
} from '../featureFlags.machine.ts';
import type { FeatureFlag } from '../featureFlags.machine.ts';
import { KILL_SWITCH_LABELS } from '../../../constants/killSwitches.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FLAG_A: FeatureFlag = {
  flag: 'passport_stamps_enabled',
  enabled: false,
  description: 'Stamp earning',
  updated_at: '2026-01-01T00:00:00Z',
};

const FLAG_B: FeatureFlag = {
  flag: 'location_phase1_gps',
  enabled: true,
  description: 'GPS capture',
  updated_at: '2026-03-10T12:00:00Z',
};

// ── resolveAdminGate ──────────────────────────────────────────────────────────

describe('resolveAdminGate — still loading', () => {
  it('returns pending while adminLoading is true (auth still in flight)', () => {
    assert.equal(
      resolveAdminGate({ adminLoading: true, isAuthed: false, role: null }),
      'pending',
    );
  });

  it('returns pending while adminLoading is true even when role is admin', () => {
    assert.equal(
      resolveAdminGate({ adminLoading: true, isAuthed: true, role: 'admin' }),
      'pending',
    );
  });
});

describe('resolveAdminGate — unauthenticated user', () => {
  it('returns redirect_signin when loading is done and user is not authed', () => {
    assert.equal(
      resolveAdminGate({ adminLoading: false, isAuthed: false, role: null }),
      'redirect_signin',
    );
  });

  it('returns redirect_signin even if role somehow has a value (isAuthed is authoritative)', () => {
    assert.equal(
      resolveAdminGate({ adminLoading: false, isAuthed: false, role: 'admin' }),
      'redirect_signin',
    );
  });
});

describe('resolveAdminGate — authenticated non-admin user', () => {
  it('returns redirect_home for role = "user"', () => {
    assert.equal(
      resolveAdminGate({ adminLoading: false, isAuthed: true, role: 'user' }),
      'redirect_home',
    );
  });

  it('returns redirect_home when role is null (role fetch failed or no profile)', () => {
    assert.equal(
      resolveAdminGate({ adminLoading: false, isAuthed: true, role: null }),
      'redirect_home',
    );
  });

  it('returns redirect_home for any unrecognised role string', () => {
    assert.equal(
      resolveAdminGate({ adminLoading: false, isAuthed: true, role: 'moderator' }),
      'redirect_home',
    );
  });
});

describe('resolveAdminGate — authenticated admin', () => {
  it('returns allow when role is exactly "admin"', () => {
    assert.equal(
      resolveAdminGate({ adminLoading: false, isAuthed: true, role: 'admin' }),
      'allow',
    );
  });
});

// ── applyOptimisticToggle ─────────────────────────────────────────────────────

describe('applyOptimisticToggle — updates target flag', () => {
  it('sets enabled to true for the target flag', () => {
    const result = applyOptimisticToggle([FLAG_A, FLAG_B], 'passport_stamps_enabled', true);
    assert.equal(result.find((f) => f.flag === 'passport_stamps_enabled')?.enabled, true);
  });

  it('sets enabled to false for the target flag', () => {
    const result = applyOptimisticToggle([FLAG_A, FLAG_B], 'location_phase1_gps', false);
    assert.equal(result.find((f) => f.flag === 'location_phase1_gps')?.enabled, false);
  });

  it('does not change any other flags in the list', () => {
    const result = applyOptimisticToggle([FLAG_A, FLAG_B], 'passport_stamps_enabled', true);
    assert.equal(
      result.find((f) => f.flag === 'location_phase1_gps')?.enabled,
      FLAG_B.enabled,
      'unrelated flag must be unchanged',
    );
  });

  it('preserves all other fields on the toggled flag (description, updated_at)', () => {
    const result = applyOptimisticToggle([FLAG_A], 'passport_stamps_enabled', true);
    const updated = result.find((f) => f.flag === 'passport_stamps_enabled');
    assert.equal(updated?.description, FLAG_A.description);
    assert.equal(updated?.updated_at, FLAG_A.updated_at);
  });

  it('returns a new array — does not mutate the input', () => {
    const original = [FLAG_A, FLAG_B];
    const result = applyOptimisticToggle(original, 'passport_stamps_enabled', true);
    assert.notEqual(result, original, 'must return a new array reference');
    assert.equal(FLAG_A.enabled, false, 'original FLAG_A.enabled must not be mutated');
  });

  it('returns the list unchanged when the target flag is not found', () => {
    const result = applyOptimisticToggle([FLAG_A], 'nonexistent_flag', true);
    assert.deepEqual(result, [FLAG_A]);
  });
});

// ── applyToggleResult — success with server data ──────────────────────────────

describe('applyToggleResult — success with server-confirmed row', () => {
  const serverFlag: FeatureFlag = {
    flag: 'passport_stamps_enabled',
    enabled: true,
    description: 'Stamp earning (server-confirmed)',
    updated_at: '2026-07-06T10:00:00Z',
  };

  it('replaces the toggled flag with the confirmed server row', () => {
    const optimistic = applyOptimisticToggle([FLAG_A, FLAG_B], 'passport_stamps_enabled', true);
    const { flags } = applyToggleResult(
      optimistic, 'passport_stamps_enabled', true,
      { ok: true, data: { flag: serverFlag } },
    );
    assert.deepEqual(flags.find((f) => f.flag === 'passport_stamps_enabled'), serverFlag);
  });

  it('returns null error on success', () => {
    const optimistic = applyOptimisticToggle([FLAG_A], 'passport_stamps_enabled', true);
    const { error } = applyToggleResult(
      optimistic, 'passport_stamps_enabled', true,
      { ok: true, data: { flag: serverFlag } },
    );
    assert.equal(error, null);
  });

  it('leaves other flags untouched when syncing server row', () => {
    const optimistic = applyOptimisticToggle([FLAG_A, FLAG_B], 'passport_stamps_enabled', true);
    const { flags } = applyToggleResult(
      optimistic, 'passport_stamps_enabled', true,
      { ok: true, data: { flag: serverFlag } },
    );
    assert.equal(
      flags.find((f) => f.flag === 'location_phase1_gps')?.enabled,
      FLAG_B.enabled,
    );
  });
});

describe('applyToggleResult — success without response data', () => {
  it('returns flags unchanged when ok but data.flag is absent', () => {
    const optimistic = applyOptimisticToggle([FLAG_A], 'passport_stamps_enabled', true);
    const { flags } = applyToggleResult(
      optimistic, 'passport_stamps_enabled', true,
      { ok: true },
    );
    assert.deepEqual(flags, optimistic);
  });

  it('returns null error when ok even without data', () => {
    const optimistic = applyOptimisticToggle([FLAG_A], 'passport_stamps_enabled', true);
    const { error } = applyToggleResult(
      optimistic, 'passport_stamps_enabled', true,
      { ok: true },
    );
    assert.equal(error, null);
  });
});

// ── applyToggleResult — failure (optimistic revert) ───────────────────────────

describe('applyToggleResult — failure reverts optimistic update', () => {
  it('reverts the flag back to false when optimistic true was rejected', () => {
    // FLAG_A.enabled was false; we optimistically set it to true; server rejects
    const optimistic = applyOptimisticToggle([FLAG_A, FLAG_B], 'passport_stamps_enabled', true);
    const { flags } = applyToggleResult(
      optimistic, 'passport_stamps_enabled', true,
      { ok: false, error: 'Server error' },
    );
    assert.equal(
      flags.find((f) => f.flag === 'passport_stamps_enabled')?.enabled,
      false,
      'must revert optimistic true back to false',
    );
  });

  it('reverts the flag back to true when optimistic false was rejected', () => {
    // FLAG_B.enabled was true; we optimistically set it to false; server rejects
    const optimistic = applyOptimisticToggle([FLAG_A, FLAG_B], 'location_phase1_gps', false);
    const { flags } = applyToggleResult(
      optimistic, 'location_phase1_gps', false,
      { ok: false, error: 'Network error' },
    );
    assert.equal(
      flags.find((f) => f.flag === 'location_phase1_gps')?.enabled,
      true,
      'must revert optimistic false back to true',
    );
  });

  it('returns the server error message', () => {
    const optimistic = applyOptimisticToggle([FLAG_A], 'passport_stamps_enabled', true);
    const { error } = applyToggleResult(
      optimistic, 'passport_stamps_enabled', true,
      { ok: false, error: 'Permission denied' },
    );
    assert.equal(error, 'Permission denied');
  });

  it('returns a non-empty fallback error when server provides no message', () => {
    const optimistic = applyOptimisticToggle([FLAG_A], 'passport_stamps_enabled', true);
    const { error } = applyToggleResult(
      optimistic, 'passport_stamps_enabled', true,
      { ok: false },
    );
    assert.ok(
      typeof error === 'string' && error.length > 0,
      'must provide a fallback error string when no message is given',
    );
  });

  it('leaves unrelated flags untouched during revert', () => {
    const optimistic = applyOptimisticToggle([FLAG_A, FLAG_B], 'passport_stamps_enabled', true);
    const { flags } = applyToggleResult(
      optimistic, 'passport_stamps_enabled', true,
      { ok: false, error: 'Server error' },
    );
    assert.equal(
      flags.find((f) => f.flag === 'location_phase1_gps')?.enabled,
      FLAG_B.enabled,
      'sibling flag must not be affected by revert',
    );
  });

  it('preserves all other fields on the reverted flag (description, updated_at)', () => {
    const optimistic = applyOptimisticToggle([FLAG_A], 'passport_stamps_enabled', true);
    const { flags } = applyToggleResult(
      optimistic, 'passport_stamps_enabled', true,
      { ok: false, error: 'Server error' },
    );
    const reverted = flags.find((f) => f.flag === 'passport_stamps_enabled');
    assert.equal(reverted?.description, FLAG_A.description);
    assert.equal(reverted?.updated_at, FLAG_A.updated_at);
  });
});

// ── applyLoadResult ───────────────────────────────────────────────────────────

describe('applyLoadResult — success', () => {
  it('returns the flags array from the response', () => {
    const { flags } = applyLoadResult({ ok: true, data: { flags: [FLAG_A, FLAG_B] } });
    assert.deepEqual(flags, [FLAG_A, FLAG_B]);
  });

  it('returns null error on success', () => {
    const { error } = applyLoadResult({ ok: true, data: { flags: [FLAG_A] } });
    assert.equal(error, null);
  });

  it('returns an empty array when the server returns zero flags', () => {
    const { flags } = applyLoadResult({ ok: true, data: { flags: [] } });
    assert.deepEqual(flags, []);
  });
});

describe('applyLoadResult — failure', () => {
  it('returns null flags on error', () => {
    const { flags } = applyLoadResult({ ok: false, error: 'Network error' });
    assert.equal(flags, null);
  });

  it('returns the server error message', () => {
    const { error } = applyLoadResult({ ok: false, error: 'Unauthorized' });
    assert.equal(error, 'Unauthorized');
  });

  it('returns a non-empty fallback error when no message is provided', () => {
    const { error } = applyLoadResult({ ok: false });
    assert.ok(
      typeof error === 'string' && error.length > 0,
      'must provide a fallback error message when none is given',
    );
  });
});

// ── getActiveKillSwitches ─────────────────────────────────────────────────────

describe('getActiveKillSwitches — no flags', () => {
  it('returns an empty array when the flags list is empty', () => {
    assert.deepEqual(getActiveKillSwitches([]), []);
  });
});

describe('getActiveKillSwitches — non-kill-switch flags are ignored', () => {
  it('does not include an enabled flag whose name is not in KILL_SWITCH_FLAGS', () => {
    const flag: FeatureFlag = {
      flag: 'passport_stamps_enabled',
      enabled: true,
      description: null,
      updated_at: null,
    };
    assert.deepEqual(getActiveKillSwitches([flag]), []);
  });

  it('does not include a disabled non-kill-switch flag', () => {
    const flag: FeatureFlag = {
      flag: 'location_phase1_gps',
      enabled: false,
      description: null,
      updated_at: null,
    };
    assert.deepEqual(getActiveKillSwitches([flag]), []);
  });
});

describe('getActiveKillSwitches — kill switch enabled → appears in result', () => {
  it('returns the flag name when a kill-switch flag is enabled', () => {
    const flag: FeatureFlag = {
      flag: 'disable_posting',
      enabled: true,
      description: null,
      updated_at: null,
    };
    assert.deepEqual(getActiveKillSwitches([flag]), ['disable_posting']);
  });

  it('covers every entry in KILL_SWITCH_FLAGS when all are enabled', () => {
    const allEnabled: FeatureFlag[] = KILL_SWITCH_FLAGS.map((name) => ({
      flag: name,
      enabled: true,
      description: null,
      updated_at: null,
    }));
    const result = getActiveKillSwitches(allEnabled);
    assert.deepEqual(result.sort(), [...KILL_SWITCH_FLAGS].sort());
  });
});

describe('getActiveKillSwitches — kill switch disabled → not listed', () => {
  it('does not include a kill-switch flag that is disabled', () => {
    const flag: FeatureFlag = {
      flag: 'disable_messaging',
      enabled: false,
      description: null,
      updated_at: null,
    };
    assert.deepEqual(getActiveKillSwitches([flag]), []);
  });

  it('excludes disabled kill switches even when other kill switches are enabled', () => {
    const flags: FeatureFlag[] = [
      { flag: 'disable_signups', enabled: true, description: null, updated_at: null },
      { flag: 'disable_messaging', enabled: false, description: null, updated_at: null },
    ];
    const result = getActiveKillSwitches(flags);
    assert.deepEqual(result, ['disable_signups']);
  });
});

describe('getActiveKillSwitches — multiple active kill switches', () => {
  it('returns all enabled kill-switch flag names when several are active', () => {
    const flags: FeatureFlag[] = [
      { flag: 'disable_posting', enabled: true, description: null, updated_at: null },
      { flag: 'disable_signups', enabled: true, description: null, updated_at: null },
      { flag: 'invite_only_beta', enabled: true, description: null, updated_at: null },
      { flag: 'passport_stamps_enabled', enabled: true, description: null, updated_at: null },
    ];
    const result = getActiveKillSwitches(flags);
    assert.deepEqual(result.sort(), ['disable_posting', 'disable_signups', 'invite_only_beta'].sort());
  });

  it('does not include non-kill-switch flags even when the list is mixed', () => {
    const flags: FeatureFlag[] = [
      { flag: 'disable_rent_buddy_booking', enabled: true, description: null, updated_at: null },
      { flag: 'disable_messaging', enabled: true, description: null, updated_at: null },
      { flag: 'some_other_feature', enabled: true, description: null, updated_at: null },
    ];
    const result = getActiveKillSwitches(flags);
    assert.deepEqual(result.sort(), ['disable_messaging', 'disable_rent_buddy_booking'].sort());
  });
});

describe('getActiveKillSwitches — city_launch_mode is retired (2087)', () => {
  // Owner ruling 2026-08-13: a banner-only kill switch with no server-side
  // enforcement is misleading operational machinery. The flag row is deleted
  // by 2087_retire_city_launch_mode.sql; the client must not announce it.
  it('is not in KILL_SWITCH_FLAGS', () => {
    assert.ok(!KILL_SWITCH_FLAGS.includes('city_launch_mode'));
  });

  it('has no banner label', () => {
    assert.ok(!('city_launch_mode' in KILL_SWITCH_LABELS));
  });

  it('an enabled city_launch_mode row does not light the banner', () => {
    const flags: FeatureFlag[] = [
      { flag: 'city_launch_mode', enabled: true, description: null, updated_at: null },
    ];
    assert.deepEqual(getActiveKillSwitches(flags), []);
  });
});
