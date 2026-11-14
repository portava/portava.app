import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupCancelledComposerUploads } from '../services/media/CancelledComposerUploadCleanup.js';
import { eraseAccountComposerUploads } from '../services/accountDeletion/composerUploads.js';
import { cleanComposerUpload } from '../routes/composerUploads.js';
type Row = Record<string, any>;
function fixture(rows: Row[]) {
    const tables: Record<string, Row[]> = { composer_upload_intents: rows, posts: [] };
    const removals: string[][] = [];
    let failStorage = false;
    const client: any = {
        storage: { from: () => ({ remove: async (paths: string[]) => {
                    if (failStorage)
                        throw new Error('Storage unavailable');
                    removals.push(paths);
                    return { error: null };
                } }) },
        from(table: string) {
            const filters: Array<(row: Row) => boolean> = [];
            let operation = 'read', patch: Row = {}, single = false;
            const b: any = {
                select: () => b, order: () => b, limit: () => b,
                eq: (key: string, value: unknown) => { filters.push(row => row[key] === value); return b; },
                lt: (key: string, value: string) => { filters.push(row => row[key] < value); return b; },
                update: (value: Row) => { operation = 'update'; patch = value; return b; },
                delete: () => { operation = 'delete'; return b; },
                maybeSingle: () => { single = true; return b; },
                then(resolve: (result: unknown) => unknown, reject: (error: unknown) => unknown) {
                    const matches = (tables[table] ?? []).filter(row => filters.every(filter => filter(row)));
                    if (operation === 'update')
                        matches.forEach(row => Object.assign(row, patch));
                    if (operation === 'delete')
                        tables[table] = tables[table]!.filter(row => !matches.includes(row));
                    return Promise.resolve({ data: single ? matches[0] ?? null : matches, error: null }).then(resolve, reject);
                },
            };
            return b;
        },
    };
    return { client, tables, removals, fail: (value: boolean) => { failStorage = value; } };
}
const row = (state = 'cancelled', id = 'operation', owner = 'owner') => ({ id, owner_id: owner, state, storage_paths: [`${owner}/composer-drafts/${id}.jpg`], updated_at: '2026-01-01', cleanup_pending: true });
test('maintenance deletes only expired cancelled intents, survives failure, and acknowledges once', async () => {
    const f = fixture([row(), row('ready', 'saved'), row('published', 'committed'), { ...row('cancelled', 'recent'), updated_at: '2026-12-01' }]);
    f.fail(true);
    assert.deepEqual(await cleanupCancelledComposerUploads(f.client, '2026-06-01', 200), { cleaned: 0, errors: 1 });
    assert.equal(f.tables.composer_upload_intents![0]!.cleanup_pending, true);
    f.fail(false);
    assert.deepEqual(await cleanupCancelledComposerUploads(f.client, '2026-06-01', 200), { cleaned: 1, errors: 0 });
    assert.deepEqual(await cleanupCancelledComposerUploads(f.client, '2026-06-01', 200), { cleaned: 0, errors: 0 });
    assert.deepEqual(f.removals, [['owner/composer-drafts/operation.jpg']]);
});
test('cleanup refuses foreign paths and committed bytes; missing-row late writes clean only server-known owned paths', async () => {
    const f = fixture([{ ...row(), storage_paths: ['other/private.jpg'] }, row('published', 'committed')]);
    assert.equal(await cleanComposerUpload(f.client, 'owner', 'operation'), false);
    assert.equal(await cleanComposerUpload(f.client, 'owner', 'committed'), false);
    assert.equal(await cleanComposerUpload(f.client, 'owner', 'missing', ['other/private.jpg']), false);
    assert.equal(await cleanComposerUpload(f.client, 'owner', 'missing', ['owner/composer-drafts/missing.jpg']), true);
    assert.deepEqual(f.removals, [['owner/composer-drafts/missing.jpg']]);
});
test('account erasure retains operational records on byte failure, then deletes only that account', async () => {
    const f = fixture([row('published'), row('ready', 'saved'), row('ready', 'foreign', 'other')]);
    f.fail(true);
    await assert.rejects(eraseAccountComposerUploads(f.client, 'owner'));
    assert.equal(f.tables.composer_upload_intents!.length, 3);
    assert.equal(f.tables.composer_upload_intents![0]!.state, 'cancelled');
    f.fail(false);
    assert.equal(await eraseAccountComposerUploads(f.client, 'owner'), 2);
    assert.deepEqual(f.tables.composer_upload_intents!.map(value => value.owner_id), ['other']);
    assert.equal(await eraseAccountComposerUploads(f.client, 'owner'), 0);
});
