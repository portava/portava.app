import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { writeMediaViewReceipt, mediaViewReceiptId, type MediaViewObservation } from '../lib/mediaViewReceipt.js';

const viewer = 'a0000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const item = 'b0000000-0000-4000-8000-000000000001';
const session = 'c0000000-0000-4000-8000-000000000001';
const observation: MediaViewObservation = { viewerId: viewer, itemId: item, sessionId: session, eventId: 'd0000000-0000-4000-8000-000000000001', type: 'qualified_view', watchedMs: 3000 };

async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
    CREATE TABLE auth.users(id uuid PRIMARY KEY); INSERT INTO auth.users VALUES('${viewer}'),('${other}');`);
  for (const file of ['0153_add_rank_events', '0197_rank_events_analytics_columns', '0202_rank_events_living_page_watch_feed_surfaces']) {
    await db.exec(readFileSync(new URL(`../migrations/${file}.sql`, import.meta.url), 'utf8'));
  }
  await db.query(`INSERT INTO rank_events(user_id,item_id,item_kind,position,surface,session_id) VALUES($1,$2,'post',2,'watch_feed',$3)`, [viewer,item,session]);
  let failInsert = false;
  let ambiguousInsert = false;
  const sc = { from(table: string) {
    assert.equal(table, 'rank_events');
    let filters: [string, unknown][] = [], row: any = null, nullColumn: string | null = null;
    const execute = async () => {
      try {
        if (row) {
          if (failInsert) return { data: null, error: { code: 'XX000' } };
          const keys = Object.keys(row);
          const result = await db.query<any>(`INSERT INTO rank_events(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`, Object.values(row));
          return { data: ambiguousInsert ? null : result.rows[0], error: null };
        }
        const clauses = filters.map(([key], i) => `${key}=$${i+1}`);
        if (nullColumn) clauses.push(`${nullColumn} IS NULL`);
        const result = await db.query<any>(`SELECT * FROM rank_events WHERE ${clauses.join(' AND ')} LIMIT 1`, filters.map(([, value]) => value));
        return { data: result.rows[0] ?? null, error: null };
      } catch (error) { return { data: null, error }; }
    };
    const builder = {
      select() { return builder; }, eq(key: string, value: unknown) { filters.push([key,value]); return builder; },
      is(key: string, value: unknown) { assert.equal(value,null); nullColumn=key; return builder; }, limit() { return builder; },
      insert(value: any) { row=value; return builder; }, single: execute, maybeSingle: execute,
    };
    return builder;
  } };
  return { db, sc, fail(value: boolean) { failInsert=value; }, ambiguous(value: boolean) { ambiguousInsert=value; } };
}

test('actual rank_events primary key admits one concurrent event and recognizes retry after response loss', async () => {
  const f=await fixture(); try {
    const results=await Promise.all([writeMediaViewReceipt(f.sc,observation),writeMediaViewReceipt(f.sc,observation)]);
    assert.deepEqual(results.map(r=>r.status).sort(),['duplicate','inserted']);
    assert.equal((await writeMediaViewReceipt(f.sc,observation)).status,'duplicate');
    assert.equal((await writeMediaViewReceipt(f.sc,{...observation,viewerId:viewer.toUpperCase(),itemId:item.toUpperCase(),sessionId:session.toUpperCase(),eventId:observation.eventId.toUpperCase()})).status,'duplicate');
    assert.equal((await f.db.query<any>("SELECT count(*)::int n FROM rank_events WHERE event_type IS NOT NULL")).rows[0].n,1);
  } finally { await f.db.close(); }
});
test('failed write reserves nothing; ambiguous success is not acknowledged until a durable retry confirms it', async () => {
  const f=await fixture(); try {
    f.fail(true); assert.equal((await writeMediaViewReceipt(f.sc,observation)).status,'failed');
    f.fail(false); f.ambiguous(true); assert.equal((await writeMediaViewReceipt(f.sc,observation)).status,'failed');
    f.ambiguous(false); assert.equal((await writeMediaViewReceipt(f.sc,observation)).status,'duplicate');
  } finally { await f.db.close(); }
});
test('session/item/owner binding and exact payload conflicts cannot fabricate or mutate an event', async () => {
  const f=await fixture(); try {
    for (const change of [{viewerId:other},{sessionId:other},{itemId:other}]) {
      assert.equal((await writeMediaViewReceipt(f.sc,{...observation,...change})).status,'unserved');
    }
    assert.equal((await writeMediaViewReceipt(f.sc,observation)).status,'inserted');
    for (const change of [{watchedMs:9000},{type:'completion' as const}]) {
      assert.equal((await writeMediaViewReceipt(f.sc,{...observation,...change})).status,'conflict');
    }
    assert.notEqual(mediaViewReceiptId(viewer,observation.eventId),mediaViewReceiptId(other,observation.eventId));
    await f.db.exec('DELETE FROM rank_events WHERE event_type IS NULL');
    assert.equal((await writeMediaViewReceipt(f.sc,{...observation,eventId:other})).status,'unserved','a view cannot bootstrap its own serve receipt');
  } finally { await f.db.close(); }
});
