/**
 * Partial-save warning tests — main app
 *
 * PATCH /api/me/profile can return 200 with `unsavedFields` + `warning` when
 * database schema drift forces the server to drop some requested fields.
 * updateMyProfile must surface this as a `partial_save` failure (ok:false,
 * message from `warning`, unsavedFields populated) so every save screen shows
 * the "some fields couldn't be saved" message instead of plain success.
 *
 * Run:
 *   cd travel-buddy-standalone
 *   node --import tsx --test src/services/__tests__/profilePartialSave.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { _setTestAuthToken, updateMyProfile } from '../profile.ts';

const FAKE_TOKEN = 'fake-test-token-partial-save';

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

describe('updateMyProfile — partial save (schema drift)', () => {
  it('returns ok:false with partial_save when unsavedFields is non-empty', async () => {
    globalThis.fetch = mockFetch(200, {
      id: 'u1',
      displayName: 'Ada',
      unsavedFields: ['travelPace', 'budgetStyle'],
      warning: "Some fields couldn't be saved: travelPace, budgetStyle",
    });

    const res = await updateMyProfile({ displayName: 'Ada', travelPace: 'slow' });
    assert.equal(res.ok, false);
    assert.equal(res.errorKind, 'partial_save');
    assert.deepEqual(res.unsavedFields, ['travelPace', 'budgetStyle']);
    assert.equal(res.message, "Some fields couldn't be saved: travelPace, budgetStyle");
    // Data must still be returned so screens can refresh what DID save.
    assert.ok(res.data);
  });

  it('falls back to a generated message when the server omits warning', async () => {
    globalThis.fetch = mockFetch(200, {
      id: 'u1',
      unsavedFields: ['bio'],
    });

    const res = await updateMyProfile({ bio: 'hello' });
    assert.equal(res.ok, false);
    assert.equal(res.errorKind, 'partial_save');
    assert.match(res.message ?? '', /bio/);
  });

  it('returns plain success when unsavedFields is empty or absent', async () => {
    globalThis.fetch = mockFetch(200, { id: 'u1', displayName: 'Ada', unsavedFields: [] });
    const emptyRes = await updateMyProfile({ displayName: 'Ada' });
    assert.equal(emptyRes.ok, true);
    assert.equal(emptyRes.errorKind, undefined);

    globalThis.fetch = mockFetch(200, { id: 'u1', displayName: 'Ada' });
    const absentRes = await updateMyProfile({ displayName: 'Ada' });
    assert.equal(absentRes.ok, true);
  });
});
