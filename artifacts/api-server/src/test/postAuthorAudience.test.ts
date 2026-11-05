import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterCurrentPostAuthors } from '../lib/postAuthorAudience.js';

test('strict author audience distinguishes private/restricted sources from unreadable inputs', async () => {
  let fail: string | null = null;
  let profile = { id: 'author', is_private: true, account_status: 'active', user_account_states: [] as unknown };
  const sc = { from(table: string) {
    const q: any = { select: () => q, in: () => q, eq: () => q,
      then(resolve: any, reject: any) { return Promise.resolve(table === fail ? { data: null, error: {} } : { data: table === 'profiles' ? [profile] : [], error: null }).then(resolve, reject); } };
    return q;
  } };
  const rows = [{ author_id: 'author' }];
  assert.deepEqual(await filterCurrentPostAuthors(sc, 'viewer', rows, { throwOnUnavailable: true }), []);
  for (const table of ['profiles', 'user_follows']) {
    fail = table;
    assert.deepEqual(await filterCurrentPostAuthors(sc, 'viewer', rows), []);
    await assert.rejects(filterCurrentPostAuthors(sc, 'viewer', rows, { throwOnUnavailable: true }), /unavailable/);
  }
  fail = null; profile.user_account_states = null;
  await assert.rejects(filterCurrentPostAuthors(sc, 'viewer', rows, { throwOnUnavailable: true }), /unavailable/);
  profile = { ...profile, is_private: false, user_account_states: [{ state: 'banned', expires_at: null }] };
  assert.deepEqual(await filterCurrentPostAuthors(sc, 'viewer', rows, { throwOnUnavailable: true }), []);
});
