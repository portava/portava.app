/**
 * Machine-layer tests for the FlagHistorySheet data-loading path.
 *
 * Tests the pure logic in featureFlags.machine.ts:
 *   - applyHistoryLoadResult: maps GET /api/admin/feature-flags/:flag/history
 *     responses to { entries, error } for the FlagHistorySheet component.
 *
 * Covers:
 *   - Successful fetch with entries → populates entries, clears error
 *   - Successful fetch with empty history → empty entries, clears error
 *   - Fetch failure → empty entries, sets error string
 *   - old_enabled / new_enabled values are preserved as-is
 *
 * No React Native, no Expo Router, no network — plain node:test only.
 *
 * Run:
 *   node --import tsx/esm --test \
 *     src/screens/admin/__tests__/flagHistory.machine.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyHistoryLoadResult,
} from '../featureFlags.machine.ts';
import type { FlagHistoryEntry } from '../featureFlags.machine.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ENTRY_A: FlagHistoryEntry = {
  id: 'a1b2c3d4-0000-0000-0000-000000000001',
  flag: 'passport_stamps_enabled',
  old_enabled: false,
  new_enabled: true,
  changed_at: '2026-06-01T10:00:00Z',
  changed_by_user_id: 'user-uuid-1',
  changed_by_name: 'Alice Admin',
};

const ENTRY_B: FlagHistoryEntry = {
  id: 'a1b2c3d4-0000-0000-0000-000000000002',
  flag: 'passport_stamps_enabled',
  old_enabled: true,
  new_enabled: false,
  changed_at: '2026-06-15T14:30:00Z',
  changed_by_user_id: 'user-uuid-2',
  changed_by_name: 'Bob Admin',
};

const ENTRY_NO_ACTOR: FlagHistoryEntry = {
  id: 'a1b2c3d4-0000-0000-0000-000000000003',
  flag: 'location_phase1_gps',
  old_enabled: false,
  new_enabled: true,
  changed_at: '2026-07-01T08:00:00Z',
  changed_by_user_id: null,
  changed_by_name: null,
};

// ── applyHistoryLoadResult — success with entries ─────────────────────────────

describe('applyHistoryLoadResult — success with entries', () => {
  it('returns the history array from the response', () => {
    const { entries } = applyHistoryLoadResult({
      ok: true,
      data: { flag: 'passport_stamps_enabled', history: [ENTRY_A, ENTRY_B] },
    });
    assert.deepEqual(entries, [ENTRY_A, ENTRY_B]);
  });

  it('returns null error on success', () => {
    const { error } = applyHistoryLoadResult({
      ok: true,
      data: { flag: 'passport_stamps_enabled', history: [ENTRY_A] },
    });
    assert.equal(error, null);
  });

  it('preserves old_enabled false → new_enabled true on an entry', () => {
    const { entries } = applyHistoryLoadResult({
      ok: true,
      data: { flag: 'passport_stamps_enabled', history: [ENTRY_A] },
    });
    assert.equal(entries[0]?.old_enabled, false);
    assert.equal(entries[0]?.new_enabled, true);
  });

  it('preserves old_enabled true → new_enabled false on an entry', () => {
    const { entries } = applyHistoryLoadResult({
      ok: true,
      data: { flag: 'passport_stamps_enabled', history: [ENTRY_B] },
    });
    assert.equal(entries[0]?.old_enabled, true);
    assert.equal(entries[0]?.new_enabled, false);
  });

  it('preserves a null changed_by_name when the actor is unknown', () => {
    const { entries } = applyHistoryLoadResult({
      ok: true,
      data: { flag: 'location_phase1_gps', history: [ENTRY_NO_ACTOR] },
    });
    assert.equal(entries[0]?.changed_by_name, null);
    assert.equal(entries[0]?.changed_by_user_id, null);
  });

  it('preserves the changed_at timestamp verbatim', () => {
    const { entries } = applyHistoryLoadResult({
      ok: true,
      data: { flag: 'passport_stamps_enabled', history: [ENTRY_A] },
    });
    assert.equal(entries[0]?.changed_at, '2026-06-01T10:00:00Z');
  });
});

// ── applyHistoryLoadResult — success with empty history ───────────────────────

describe('applyHistoryLoadResult — success with empty history array', () => {
  it('returns an empty entries array', () => {
    const { entries } = applyHistoryLoadResult({
      ok: true,
      data: { flag: 'passport_stamps_enabled', history: [] },
    });
    assert.deepEqual(entries, []);
  });

  it('returns null error for an empty history', () => {
    const { error } = applyHistoryLoadResult({
      ok: true,
      data: { flag: 'passport_stamps_enabled', history: [] },
    });
    assert.equal(error, null);
  });
});

// ── applyHistoryLoadResult — fetch failure ────────────────────────────────────

describe('applyHistoryLoadResult — fetch failure', () => {
  it('returns an empty entries array on error', () => {
    const { entries } = applyHistoryLoadResult({
      ok: false,
      error: 'Network error',
    });
    assert.deepEqual(entries, []);
  });

  it('returns the server error message', () => {
    const { error } = applyHistoryLoadResult({
      ok: false,
      error: 'Unauthorized',
    });
    assert.equal(error, 'Unauthorized');
  });

  it('returns a non-empty fallback error when the server provides no message', () => {
    const { error } = applyHistoryLoadResult({ ok: false });
    assert.ok(
      typeof error === 'string' && error.length > 0,
      'must provide a fallback error string when no message is given',
    );
  });

  it('returns an empty entries array when ok is false even if data is somehow present', () => {
    const { entries } = applyHistoryLoadResult({
      ok: false,
      data: { flag: 'passport_stamps_enabled', history: [ENTRY_A] },
      error: 'Server error',
    });
    assert.deepEqual(entries, []);
  });

  it('returns the error string when ok is false even if data is somehow present', () => {
    const { error } = applyHistoryLoadResult({
      ok: false,
      data: { flag: 'passport_stamps_enabled', history: [ENTRY_A] },
      error: 'Server error',
    });
    assert.equal(error, 'Server error');
  });
});

// ── applyHistoryLoadResult — multiple entries ordering ────────────────────────

describe('applyHistoryLoadResult — multiple entries preserve order', () => {
  it('returns entries in the same order they arrive from the server', () => {
    const { entries } = applyHistoryLoadResult({
      ok: true,
      data: { flag: 'passport_stamps_enabled', history: [ENTRY_B, ENTRY_A] },
    });
    assert.equal(entries[0]?.id, ENTRY_B.id);
    assert.equal(entries[1]?.id, ENTRY_A.id);
  });
});
