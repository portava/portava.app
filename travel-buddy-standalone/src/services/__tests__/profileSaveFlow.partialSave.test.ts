/**
 * Edit-profile save-flow tests — main app
 *
 * The service-level contract (profilePartialSave.test.ts) guarantees that a
 * 200 + unsavedFields response becomes ok:false / errorKind:'partial_save'.
 * These tests close the loop on the SCREEN side: every edit-profile screen
 * routes its updateMyProfile result through resolveProfileSaveOutcome (or,
 * for identity.tsx, classifyIdentitySaveFailure), so we assert that a
 * partial_save result produces the visible warning message — never a
 * success state.
 *
 * Run:
 *   cd travel-buddy-standalone
 *   node --import tsx --test src/services/__tests__/profileSaveFlow.partialSave.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { _setTestAuthToken, updateMyProfile } from '../profile.ts';
import {
  resolveProfileSaveOutcome,
  classifyIdentitySaveFailure,
} from '../profileSaveFlow.ts';

const FAKE_TOKEN = 'fake-test-token-save-flow';
const WARNING = "Some fields couldn't be saved: travelPace, budgetStyle";

function mockFetch(status: number, body: unknown): typeof fetch {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response;
}

let savedFetch: typeof fetch;

beforeEach(() => {
  savedFetch = globalThis.fetch;
  _setTestAuthToken(FAKE_TOKEN);
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  _setTestAuthToken(null);
});

describe('resolveProfileSaveOutcome — partial save end-to-end', () => {
  it('a real partial-save response surfaces as an error outcome with the warning message', async () => {
    globalThis.fetch = mockFetch(200, {
      id: 'u1',
      displayName: 'Ada',
      unsavedFields: ['travelPace', 'budgetStyle'],
      warning: WARNING,
    });

    const res = await updateMyProfile({ displayName: 'Ada', travelPace: 'slow' });
    const outcome = resolveProfileSaveOutcome(res);

    // The save flow must show the warning — never a success state.
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.kind === 'error' && outcome.message, WARNING);
  });

  it('a clean save resolves to the saved outcome', async () => {
    globalThis.fetch = mockFetch(200, { id: 'u1', displayName: 'Ada' });
    const res = await updateMyProfile({ displayName: 'Ada' });
    assert.deepEqual(resolveProfileSaveOutcome(res), { kind: 'saved' });
  });

  it('generates a fallback message when the failure carries no message', () => {
    const outcome = resolveProfileSaveOutcome({ ok: false });
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.kind === 'error' && outcome.message, 'Failed to save profile');

    const custom = resolveProfileSaveOutcome({ ok: false }, 'Please try again.');
    assert.equal(custom.kind === 'error' && custom.message, 'Please try again.');
  });
});

describe('classifyIdentitySaveFailure — identity screen routing', () => {
  it('routes partial_save to the form-level save error with the warning message', async () => {
    globalThis.fetch = mockFetch(200, {
      id: 'u1',
      unsavedFields: ['travelPace', 'budgetStyle'],
      warning: WARNING,
    });

    const res = await updateMyProfile({ displayName: 'Ada' });
    assert.equal(res.ok, false);
    const failure = classifyIdentitySaveFailure(res);

    // partial_save must never be swallowed by the username/DOB banners.
    assert.equal(failure.field, 'form');
    assert.equal(failure.message, WARNING);
  });

  it('still routes username and DOB failures to their field banners', () => {
    assert.deepEqual(
      classifyIdentitySaveFailure({ errorKind: 'rate_limited', message: 'Wait 30 days' }),
      { field: 'username', status: 'cooldown', message: 'Wait 30 days' },
    );
    assert.deepEqual(
      classifyIdentitySaveFailure({ errorKind: 'conflict', message: 'Username already taken' }),
      { field: 'username', status: 'taken', message: 'Username already taken' },
    );
    assert.deepEqual(
      classifyIdentitySaveFailure({ errorKind: 'invalid_payload', message: 'dateOfBirth invalid' }),
      { field: 'dob', message: 'dateOfBirth invalid' },
    );
    assert.deepEqual(
      classifyIdentitySaveFailure({ errorKind: 'db_error', message: undefined }),
      { field: 'form', message: 'Failed to save profile' },
    );
  });
});

describe('edit screens actually route through the tested save flow', () => {
  // Guards the wiring: if a screen stops using resolveProfileSaveOutcome /
  // classifyIdentitySaveFailure, the outcome tests above no longer cover it.
  it('every edit-profile screen imports the shared save-flow module', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const screens: Array<[string, string]> = [
      ['about.tsx', 'resolveProfileSaveOutcome'],
      ['photos.tsx', 'resolveProfileSaveOutcome'],
      ['passport-layout.tsx', 'resolveProfileSaveOutcome'],
      ['travel-profile.tsx', 'resolveProfileSaveOutcome'],
      ['identity.tsx', 'classifyIdentitySaveFailure'],
    ];
    for (const [file, symbol] of screens) {
      const src = readFileSync(join('app', 'profile', 'edit', file), 'utf8');
      assert.ok(
        src.includes(`${symbol}`) && src.includes('services/profileSaveFlow'),
        `${file} must use ${symbol} from profileSaveFlow so partial-save warnings are shown`,
      );
    }
  });
});
