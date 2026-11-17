/** Independent PostgreSQL sessions against the one leased fixture. No cloned DB. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, type QueryResult } from 'pg';
import { openPressedLayoverDb } from './pressedLayoverDb.js';
import { makeBridge, lit } from './postgrestSqlBridge.js';
import { recordMediaAssetDetailed, type RecordAssetInput } from '../../lib/mediaAssets.js';
import { _markPostgrestBackedForTest } from '../../lib/supabase.js';

const last = (result: QueryResult | QueryResult[]) => Array.isArray(result) ? result[result.length - 1]! : result;
function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; }

describe('canonical upload retries preserve one immutable receipt', { skip: process.env.LOCAL_DB_URL ? false : 'independent sessions require the designated LOCAL_DB_URL PostgreSQL fixture' }, () => {
  let db: Awaited<ReturnType<typeof openPressedLayoverDb>>;
  const connections: Client[] = [];
  let owner: string, other: string;
  before(async () => {
    db = await openPressedLayoverDb();
    assert.ok(db.databaseUrl);
    owner = (await db.seedUser('asset-retry')).id;
    other = (await db.seedUser('asset-retry-other')).id;
    await db.setFlag('media_canonical_enabled', true);
    await db.setFlag('media_canonical_schema_fallback_enabled', false);
  });
  after(async () => { await Promise.all(connections.map(client => client.end())); await db?.close(); });
  const input = (path: string): RecordAssetInput => ({
    ownerUserId: owner, storageBucket: 'posts', storagePath: path, publicUrl: `posts/${path}`,
    mediaType: 'image', mimeType: 'image/jpeg', sizeBytes: 100, width: 64, height: 48,
    sourceType: 'user', capturedAt: '2026-03-04T03:06:07.000Z', preserveExisting: true,
  });
  async function independent(afterInsert?: () => Promise<void>) {
    const client = new Client({ connectionString: db.databaseUrl! });
    await client.connect(); connections.push(client);
    const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const bridge = makeBridge({
      query: async sql => (await client.query(sql)).rows,
      request: async (statements, role, claims) => {
        await client.query('BEGIN');
        try {
          await client.query(`SET LOCAL ROLE ${role}; SET LOCAL TIME ZONE 'UTC'; SELECT set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true), set_config('request.jwt.claim.role', ${lit(role)}, true)`);
          let result: QueryResult | undefined;
          for (const statement of statements) result = last(await client.query(statement));
          if (statements.some(sql => /INSERT INTO.*media_assets/i.test(sql))) await afterInsert?.();
          await client.query('COMMIT');
          const value = result?.rows[0] ? Object.values(result.rows[0])[0] : null;
          return typeof value === 'string' ? value : JSON.stringify(value ?? null);
        } catch (error) { await client.query('ROLLBACK'); throw error; }
      },
    }, { url: `http://asset-retry-${pid}.invalid`, tokens: () => ({}) });
    _markPostgrestBackedForTest(bridge.client);
    return { client: bridge.client, pid };
  }
  it('concurrent first requests wait on the same unique key and return the winning ID/version without overwriting capture time', { timeout: 20_000 }, async () => {
    const inserted = gate(), release = gate();
    const first = await independent(async () => { inserted.open(); await release.promise; });
    const second = await independent();
    const path = `${owner}/${randomUUID()}.jpg`;
    const winner = recordMediaAssetDetailed(first.client, input(path));
    let loser: ReturnType<typeof recordMediaAssetDetailed> | undefined;
    try {
      await Promise.race([inserted.promise, winner.then(result => { throw new Error(`First insert did not reach transaction barrier: ${JSON.stringify(result)}`); })]);
      loser = recordMediaAssetDetailed(second.client, { ...input(path), capturedAt: '2026-03-05T03:06:07.000Z' });
      let blocked = false;
      for (let n = 0; n < 100; n++) {
        const rows = await db.query<{ blocked: boolean }>(`SELECT ${first.pid} = ANY(pg_blocking_pids(${second.pid})) AS blocked`);
        if (rows[0].blocked) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(blocked, true, 'second independent backend must actually wait on the first insert');
    } finally { release.open(); }
    const [a, b] = await Promise.all([winner, loser!]);
    assert.equal(a.outcome, 'written'); assert.ok(a.assetId); assert.equal(a.reused, undefined);
    assert.equal(b.outcome, 'written');
    assert.equal(b.assetId, a.assetId); assert.equal(b.assetVersion, a.assetVersion);
    assert.equal(b.reused, true);
    const rows = await db.query<{ id: string; version: number; captured_at: string }>(`SELECT id,version,captured_at::text FROM media_assets WHERE storage_path=${lit(path)}`);
    assert.equal(rows.length, 1); assert.equal(rows[0].id, a.assetId); assert.equal(rows[0].version, a.assetVersion);
    assert.equal(new Date(rows[0].captured_at).toISOString(), input(path).capturedAt);
  });
  it('retries preserve richer provenance and a moderation hold and reject an owner mismatch', async () => {
    const path = `${owner}/${randomUUID()}.jpg`;
    const created = await recordMediaAssetDetailed(db.client, input(path)); assert.ok(created.assetId);
    await db.exec(`UPDATE media_assets SET moderation_status='limited', provenance=provenance || '{"retainedEvidence":"synthetic"}'::jsonb WHERE id=${lit(created.assetId)}`);
    const snapshot = await db.query(`SELECT * FROM media_assets WHERE id=${lit(created.assetId)}`);
    const retry = await recordMediaAssetDetailed(db.client, { ...input(path), capturedAt: null, sourceType: 'generated' });
    assert.equal(retry.reused, true); assert.equal(retry.moderationStatus, 'limited');
    assert.equal(retry.assetId, created.assetId);
    assert.deepEqual(await db.query(`SELECT * FROM media_assets WHERE id=${lit(created.assetId)}`), snapshot);
    const wrongOwner = await recordMediaAssetDetailed(db.client, { ...input(path), ownerUserId: other });
    assert.equal(wrongOwner.outcome, 'failed'); assert.equal(wrongOwner.assetId, null);
    assert.deepEqual(await db.query(`SELECT * FROM media_assets WHERE id=${lit(created.assetId)}`), snapshot);
  });
  it('a retry refuses a retired receipt without clearing its tombstone or purge state', async () => {
    const path = `${owner}/${randomUUID()}.jpg`;
    const created = await recordMediaAssetDetailed(db.client, input(path)); assert.ok(created.assetId);
    await db.exec(`UPDATE media_assets SET processing_status='removed', moderation_status='owner_deleted', deleted_at=now(), purge_status='pending' WHERE id=${lit(created.assetId)}`);
    const snapshot = await db.query(`SELECT * FROM media_assets WHERE id=${lit(created.assetId)}`);
    const retry = await recordMediaAssetDetailed(db.client, input(path));
    assert.equal(retry.outcome, 'failed'); assert.equal(retry.assetId, null);
    assert.deepEqual(await db.query(`SELECT * FROM media_assets WHERE id=${lit(created.assetId)}`), snapshot);
  });
});
