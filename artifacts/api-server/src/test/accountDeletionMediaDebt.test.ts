import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { executeAccountDeletion } from '../services/accountDeletion/AccountDeletionService.js';
import { accountMediaFixture, accountId, otherId, translation, dubbing, source } from './helpers/accountMediaDeletionFixture.js';

const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Synthetic test forbids network'); };
after(() => { globalThis.fetch = fetchBefore; });
const execute = (fixture: ReturnType<typeof accountMediaFixture>) => executeAccountDeletion(fixture.client, accountId, { actorId: null });
function pending(fixture: ReturnType<typeof accountMediaFixture>) {
  assert.deepEqual(fixture.state.authDeleted, []);
  assert.equal(fixture.state.rows.profiles![0]!.account_status, 'active');
  assert.equal(fixture.state.rows.user_deletion_requests![0]!.status, 'pending');
  assert.equal(fixture.state.rows.user_deletion_requests![0]!.user_id, accountId);
}

test('known empty installed schemas with flags OFF complete', async () => {
  const fixture = accountMediaFixture();
  assert.equal((await execute(fixture)).ok, true);
  assert.deepEqual(fixture.state.authDeleted, [accountId]);
});
test('known uninstalled schemas preserve empty-account compatibility', async () => {
  const fixture = accountMediaFixture({ feature_flags: [] });
  assert.equal((await execute(fixture)).ok, true);
});
for (const state of ['reserved', 'dispatched']) test(`orphan translation ${state} retains retry identity and does not erase bytes`, async () => {
  const fixture = accountMediaFixture({ media_caption_translation_artifacts: [translation(state)] });
  assert.equal((await execute(fixture)).ok, false); pending(fixture);
  assert.equal(fixture.operations.filter(operation => operation.action === 'remove').length, 0);
});
test('orphan pending dubbing retains retry identity', async () => {
  const fixture = accountMediaFixture({ media_dubbing_artifacts: [dubbing()] });
  assert.equal((await execute(fixture)).ok, false); pending(fixture);
});
for (const table of ['media_assets', 'media_caption_translation_artifacts', 'media_dubbing_artifacts', 'feature_flags']) {
  for (const kind of ['null', 'error', 'object', 'undefined']) test(`${table} ${kind} inventory never becomes known empty`, async () => {
    const fixture = accountMediaFixture();
    fixture.state.before = operation => operation.table === table && operation.action === 'select'
      ? { data: kind === 'object' ? {} : kind === 'undefined' ? undefined : null, error: kind === 'error' ? new Error('Unavailable') : null } : undefined;
    if (table === 'feature_flags' && kind === 'null') return assert.equal((await execute(fixture)).ok, true);
    assert.equal((await execute(fixture)).ok, false); pending(fixture);
  });
}
test('settled orphan dubbing uses exact retained cleanup before completion', async () => {
  const fixture = accountMediaFixture({ media_dubbing_artifacts: [dubbing('uploaded')] });
  assert.equal((await execute(fixture)).ok, true);
  assert.equal(fixture.rows.media_dubbing_artifacts!.length, 0);
  assert.deepEqual(fixture.operations.filter(operation => operation.action === 'remove').flatMap(operation => operation.paths!), [dubbing('uploaded').storage_path]);
});
test('unrelated retained owner is neither erased nor used as deleting-owner debt', async () => {
  const fixture = accountMediaFixture({ media_dubbing_artifacts: [dubbing('pending', otherId)], media_caption_translation_artifacts: [translation('dispatched', otherId)] });
  assert.equal((await execute(fixture)).ok, true);
  assert.equal(fixture.rows.media_dubbing_artifacts!.length, 1);
  assert.equal(fixture.operations.some(operation => operation.action === 'remove'), false);
});
test('fresh final inventory catches debt arriving during unrelated account work', async () => {
  const fixture = accountMediaFixture();
  fixture.state.before = operation => {
    if (operation.table === 'post_media') fixture.rows.media_dubbing_artifacts = [dubbing()];
    return undefined;
  };
  assert.equal((await execute(fixture)).ok, false); pending(fixture);
});
test('late source inventory cannot be consumed by an unchecked broad delete', async () => {
  const fixture = accountMediaFixture();
  fixture.state.before = operation => {
    if (operation.table === 'post_media') fixture.rows.media_assets = [source(otherId, accountId)];
    return undefined;
  };
  assert.equal((await execute(fixture)).ok, false); pending(fixture);
  assert.equal(fixture.rows.media_assets!.length, 1);
});
test('post-auth observed debt keeps request subject pending without claiming auth rollback', async () => {
  const fixture = accountMediaFixture();
  fixture.state.before = operation => {
    if (operation.table === 'auth.users') fixture.rows.media_dubbing_artifacts = [dubbing()];
    return undefined;
  };
  assert.equal((await execute(fixture)).ok, false);
  assert.deepEqual(fixture.state.authDeleted, [accountId]);
  assert.equal(fixture.rows.user_deletion_requests![0]!.status, 'pending');
  assert.equal(fixture.rows.user_deletion_requests![0]!.user_id, accountId);
});

for (const state of ['uploaded', 'never_dispatched']) test(`settled orphan translation ${state} follows exact retirement and forget`, async () => {
  const fixture = accountMediaFixture({ media_caption_translation_artifacts: [translation(state)] });
  assert.equal((await execute(fixture)).ok, true);
  assert.equal(fixture.rows.media_caption_translation_artifacts!.length, 0);
  assert.equal(fixture.operations.filter(operation => operation.action === 'remove').length, state === 'uploaded' ? 1 : 0);
});
test('post-profile observed debt withholds auth deletion without pretending profile rollback', async () => {
  const fixture = accountMediaFixture();
  fixture.state.before = operation => {
    if (operation.table === 'profiles' && operation.action === 'update') fixture.rows.media_dubbing_artifacts = [dubbing()];
    return undefined;
  };
  assert.equal((await execute(fixture)).ok, false);
  assert.deepEqual(fixture.state.authDeleted, []);
  assert.equal(fixture.rows.profiles![0]!.account_status, 'deleted');
  assert.equal(fixture.rows.user_deletion_requests![0]!.user_id, accountId);
});
test('full orphan pass is retryable rather than a truncated empty witness', async () => {
  const rows = Array.from({ length: 51 }, (_, index) => { const id = `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`;
    return { ...dubbing('uploaded'), id, storage_path: `synthetic-dubbing/${id}.wav` }; });
  const fixture = accountMediaFixture({ media_dubbing_artifacts: rows });
  assert.equal((await execute(fixture)).ok, false); pending(fixture);
  assert.equal(fixture.rows.media_dubbing_artifacts!.length, 1);
  assert.equal((await execute(fixture)).ok, true);
});
test('successful reconciliation cannot bypass an unread final empty witness', async () => {
  const fixture = accountMediaFixture({ media_dubbing_artifacts: [dubbing('uploaded')] });
  let forgotten = false;
  fixture.state.before = operation => {
    if (operation.table === 'media_dubbing_forget') forgotten = true;
    if (forgotten && operation.table === 'media_dubbing_artifacts' && operation.action === 'select') return { data: null, error: new Error('Fresh read unavailable') };
    return undefined;
  };
  assert.equal((await execute(fixture)).ok, false); pending(fixture);
});
test('marker present but schema RPC unavailable refuses actual source cleanup', async () => {
  const fixture = accountMediaFixture({ media_assets: [source()] });
  fixture.state.before = operation => operation.table === 'media_derivative_schema_status' ? { data: null, error: null } : undefined;
  assert.equal((await execute(fixture)).ok, false); pending(fixture);
  assert.equal(fixture.operations.some(operation => operation.action === 'remove'), false);
});
