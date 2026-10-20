import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { executeAccountDeletion } from '../services/accountDeletion/AccountDeletionService.js';
import { eraseAccountMedia } from '../services/accountDeletion/accountMediaDeletion.js';
import { accountMediaFixture, accountId, otherId, assetId, source, translation, dubbing } from './helpers/accountMediaDeletionFixture.js';

const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Synthetic test forbids network'); };
after(() => { globalThis.fetch = fetchBefore; });
const execute = (fixture: ReturnType<typeof accountMediaFixture>) => executeAccountDeletion(fixture.client, accountId, { actorId: null });

for (const owner of [accountId, otherId]) test(`canonical owner ${owner === accountId ? 'same' : 'different from uploader'} uses actual lifecycle and returned versions`, async () => {
  const fixture = accountMediaFixture({ media_assets: [source(owner)] });
  const outcome = await execute(fixture);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.deletedCounts.media_assets, 1);
  const operations = fixture.operations;
  const withdrawal = operations.findIndex(operation => operation.table === 'media_assets' && operation.values?.purge_status === 'pending');
  const cancellation = operations.findIndex(operation => operation.table === 'media_derivative_cancel_asset');
  const removal = operations.findIndex(operation => operation.action === 'remove');
  const hardDelete = operations.findIndex(operation => operation.table === 'media_assets' && operation.action === 'delete');
  assert.ok(withdrawal >= 0 && cancellation > withdrawal && removal > cancellation && hardDelete > removal);
  assert.deepEqual(operations.filter(operation => operation.action === 'remove').flatMap(operation => operation.paths!).sort(), [source(owner).storage_path, source(owner).thumbnail_path].sort());
  const deletion = operations[hardDelete]!;
  assert.ok(deletion.filters.some(filter => filter[1] === 'id' && filter[2] === assetId));
  assert.ok(deletion.filters.some(filter => filter[1] === 'version' && filter[2] === 10));
  assert.ok(deletion.filters.some(filter => filter[1] === 'owner_user_id' && filter[2] === owner));
});
for (const table of ['media_caption_translation_artifacts', 'media_dubbing_artifacts']) test(`source pending ${table} is withdrawn but never removed or hard-deleted`, async () => {
  const fixture = accountMediaFixture({ media_assets: [source(otherId)], [table]: [table.includes('translation') ? translation('dispatched', otherId) : dubbing('pending', otherId)] });
  assert.equal((await execute(fixture)).ok, false);
  assert.equal(fixture.rows.media_assets![0]!.moderation_status, 'owner_deleted');
  assert.equal(fixture.rows.media_assets![0]!.version, 7);
  assert.equal(fixture.operations.some(operation => operation.action === 'remove'), false);
  assert.equal(fixture.operations.some(operation => operation.table === 'media_assets' && operation.action === 'delete'), false);
  assert.deepEqual(fixture.state.authDeleted, []);
});
for (const phase of ['withdraw', 'complete', 'delete']) test(`${phase} zero-row response preserves the retry subject`, async () => {
  const fixture = accountMediaFixture({ media_assets: [source()] });
  fixture.state.before = operation => operation.table === 'media_assets' &&
    (phase === 'withdraw' ? operation.values?.purge_status === 'pending' : phase === 'complete' ? operation.values?.purge_status === 'completed' : operation.action === 'delete')
    ? { data: [], error: null } : undefined;
  assert.equal((await execute(fixture)).ok, false);
  assert.deepEqual(fixture.state.authDeleted, []);
  assert.equal(fixture.rows.media_assets!.length, 1);
});
test('failed storage leaves withdrawn source; healthy retry reaches the existing canonical purge', async () => {
  const fixture = accountMediaFixture({ media_assets: [source()] });
  fixture.state.before = operation => operation.action === 'remove' ? { data: null, error: new Error('Unavailable') } : undefined;
  assert.equal((await execute(fixture)).ok, false);
  assert.equal(fixture.rows.media_assets![0]!.purge_status, 'failed');
  assert.deepEqual(fixture.state.authDeleted, []);
  fixture.state.before = () => undefined;
  assert.equal((await execute(fixture)).ok, true);
  assert.equal(fixture.rows.media_assets!.length, 0);
});
for (const field of ['owner_user_id', 'version', 'storage_path', 'uploader_user_id']) test(`withdrawal returned ${field} mismatch cannot authorize cleanup`, async () => {
  const fixture = accountMediaFixture({ media_assets: [source()] });
  fixture.state.after = (operation, reply) => {
    if (operation.table === 'media_assets' && operation.values?.purge_status === 'pending') {
      const replacement = { ...source(), version: 7, ...operation.values, [field]: field === 'version' ? 4 : 'changed' };
      return { data: Array.isArray(reply.data) ? [replacement] : replacement, error: null };
    }
    return reply;
  };
  assert.equal((await execute(fixture)).ok, false);
  assert.equal(fixture.operations.some(operation => operation.action === 'remove'), false);
});
test('missing original adaptive volume holds source and account before any remove', async () => {
  const fixture = accountMediaFixture({ media_assets: [source()], media_derivative_jobs: [{ id: assetId, asset_id: assetId, kind: 'adaptive_video' }] });
  assert.equal((await execute(fixture)).ok, false);
  assert.equal(fixture.operations.some(operation => operation.action === 'remove'), false);
  assert.equal(fixture.rows.media_assets!.length, 1);
});
test('unknown cancellation commit does not fall through to storage', async () => {
  const fixture = accountMediaFixture({ media_assets: [source()] });
  fixture.state.before = operation => operation.table === 'media_derivative_cancel_asset' ? { data: null, error: null } : undefined;
  assert.equal((await execute(fixture)).ok, false);
  assert.equal(fixture.operations.some(operation => operation.action === 'remove'), false);
});

for (const phase of ['withdraw', 'delete']) test(`unknown ${phase} reply never completes; retry follows actual committed state`, async () => {
  const fixture = accountMediaFixture({ media_assets: [source()] });
  fixture.state.after = (operation, reply) => operation.table === 'media_assets' &&
    (phase === 'withdraw' ? operation.values?.purge_status === 'pending' : operation.action === 'delete') ? { data: null, error: new Error('Unknown commit') } : reply;
  assert.equal((await execute(fixture)).ok, false);
  assert.deepEqual(fixture.state.authDeleted, []);
  assert.equal(fixture.rows.user_deletion_requests![0]!.user_id, accountId);
  fixture.state.after = (_operation, reply) => reply;
  assert.equal((await execute(fixture)).ok, true);
});
test('completed retry source still receives fresh canonical cleanup before deletion', async () => {
  const fixture = accountMediaFixture({ media_assets: [{ ...source(), deleted_at: '2026-10-16T00:00:00Z', moderation_status: 'owner_deleted', purge_status: 'completed' }] });
  assert.equal((await execute(fixture)).ok, true);
  assert.ok(fixture.operations.some(operation => operation.action === 'remove'));
});
test('unrelated canonical source is not selected by owner-or-uploader', async () => {
  const fixture = accountMediaFixture({ media_assets: [source(otherId, otherId)] });
  assert.equal((await execute(fixture)).ok, true);
  assert.equal(fixture.rows.media_assets!.length, 1);
  assert.equal(fixture.operations.some(operation => operation.action === 'remove'), false);
});
test('owner source with null uploader is supported', async () => {
  const fixture = accountMediaFixture({ media_assets: [source(accountId, null)] });
  assert.equal((await execute(fixture)).ok, true);
});
for (const field of ['id', 'owner_user_id', 'uploader_user_id', 'version', 'storage_path', 'updated_at']) test(`malformed source ${field} refuses without destroying discovery identity`, async () => {
  const fixture = accountMediaFixture({ media_assets: [{ ...source(), [field]: field === 'version' ? 0 : undefined }] });
  assert.equal((await execute(fixture)).ok, false);
  assert.equal(fixture.rows.media_assets!.length, 1);
  assert.equal(fixture.operations.some(operation => operation.action === 'remove'), false);
});
test('page cursor reaches a second source page without skipping deleted rows', async () => {
  const assets = Array.from({ length: 26 }, (_, index) => ({ ...source(), id: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}` }));
  const fixture = accountMediaFixture({ media_assets: assets, feature_flags: [] });
  assert.equal(await eraseAccountMedia(fixture.client, accountId), 26);
  assert.equal(fixture.rows.media_assets!.length, 0);
});
test('bounded full inventory retains remaining sources and request for another pass', async () => {
  const assets = Array.from({ length: 101 }, (_, index) => ({ ...source(), id: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}` }));
  const fixture = accountMediaFixture({ media_assets: assets, feature_flags: [] });
  assert.equal((await execute(fixture)).ok, false);
  assert.equal(fixture.rows.media_assets!.length, 1);
  assert.deepEqual(fixture.state.authDeleted, []);
  assert.equal((await execute(fixture)).ok, true);
});
test('later page read failure does not clear identity after partial cleanup', async () => {
  const assets = Array.from({ length: 26 }, (_, index) => ({ ...source(), id: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}` }));
  const fixture = accountMediaFixture({ media_assets: assets, feature_flags: [] });
  fixture.state.before = operation => operation.table === 'media_assets' && operation.filters.some(filter => filter[0] === 'gt')
    ? { data: null, error: new Error('Later page unavailable') } : undefined;
  assert.equal((await execute(fixture)).ok, false);
  assert.equal(fixture.rows.media_assets!.length, 1);
  assert.deepEqual(fixture.state.authDeleted, []);
});
for (const mode of ['deadline', 'abort']) test(`${mode} settles a noncooperating withdrawal and fences its late continuation`, async () => {
  const fixture = accountMediaFixture({ media_assets: [source()] });
  let release!: (reply: { data: unknown; error: unknown }) => void;
  let reached!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  fixture.state.before = operation => {
    if (operation.values?.purge_status === 'pending') { reached(); return new Promise(resolve => { release = resolve; }); }
    return undefined;
  };
  const controller = new AbortController();
  const pending = eraseAccountMedia(fixture.client, accountId, { signal: controller.signal, operationTimeoutMs: 50, timeoutMs: 1000 });
  await started;
  if (mode === 'abort') controller.abort();
  await assert.rejects(pending);
  release({ data: [{ ...source(), version: 7, deleted_at: '2026-10-16T00:00:00Z', moderation_status: 'owner_deleted', processing_status: 'removed', purge_status: 'pending' }], error: null });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fixture.operations.some(operation => operation.action === 'remove'), false);
  assert.equal(fixture.operations.some(operation => operation.table === 'media_derivative_cancel_asset'), false);
});
