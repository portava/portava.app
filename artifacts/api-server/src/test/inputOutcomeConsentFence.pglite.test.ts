import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const actor = '10000000-0000-4000-8000-000000000001';
const grant = '2026-11-13T10:00:00.000Z';
const nextGrant = '2026-11-13T11:00:00.000Z';
async function database() {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${actor}');
    CREATE TABLE feature_flags(flag text PRIMARY KEY, enabled boolean, description text);
    GRANT SELECT,UPDATE ON feature_flags TO service_role;`);
  for (const migration of ['3780_input_outcome_learning', '3783_input_outcome_task_aggregate', '4029_input_outcome_consent_fence']) {
    await db.exec(readFileSync(new URL(`../migrations/${migration}.sql`, import.meta.url), 'utf8'));
  }
  return db;
}
async function allow(db: PGlite, at = grant) {
  await db.exec("UPDATE feature_flags SET enabled=true WHERE flag='input_outcome_learning_enabled'");
  await db.query(`INSERT INTO input_outcome_consent(user_id,enabled,consent_version,consented_at)
    VALUES($1,true,'input_outcome_learning_v1',$2) ON CONFLICT(user_id)
    DO UPDATE SET enabled=true,withdrawn_at=null,consented_at=excluded.consented_at`, [actor, at]);
}
async function record(db: PGlite, at: string | null = grant) {
  return (await db.query<{ok: boolean}>(
    "SELECT input_record_outcome($1,'city_picker','city','canonical-city',$2) ok", [actor, at],
  )).rows[0]!.ok;
}
async function aggregate(db: PGlite, at: string | null = grant) {
  return (await db.query<{ok: boolean}>(
    "SELECT input_record_task_outcome($1,$2,'city_picker','trip_created',true) ok", [actor, at],
  )).rows[0]!.ok;
}

test('exact migration: flag/absent consent/missing or superseded grant refuse both writers', async () => {
  const db = await database();
  try {
    assert.equal(await record(db), false);
    assert.equal(await aggregate(db), false);
    await allow(db);
    assert.equal(await record(db, null), false);
    assert.equal(await aggregate(db, nextGrant), false);
    assert.equal(await record(db), true);
    assert.equal(await aggregate(db), true);
    await db.exec("UPDATE feature_flags SET enabled=false");
    assert.equal(await record(db), false);
    assert.equal(await aggregate(db), false);
    assert.equal((await db.query<{n: number}>('SELECT completed_count n FROM input_outcome_counters')).rows[0]!.n, 1);
  } finally { await db.close(); }
});

test('withdrawal erase cannot be undone by delayed work; regrant rejects the previous grant', async () => {
  const db = await database();
  try {
    await allow(db);
    assert.equal(await record(db), true);
    await db.exec(`UPDATE input_outcome_consent SET enabled=false,withdrawn_at=now(); DELETE FROM input_outcome_counters;`);
    assert.equal(await record(db), false);
    assert.equal(await aggregate(db), false);
    await allow(db, nextGrant);
    assert.equal(await record(db), false);
    assert.equal(await aggregate(db), false);
    assert.equal((await db.query('SELECT * FROM input_outcome_counters')).rows.length, 0);
    assert.equal(await record(db, nextGrant), true);
    assert.equal(await aggregate(db, nextGrant), true);
    const row = (await db.query<Record<string, unknown>>('SELECT * FROM input_outcome_task_daily')).rows[0]!;
    assert.deepEqual(Object.keys(row).sort(), ['completed_count','context','day','ok','task']);
    assert.ok(!JSON.stringify(row).includes(actor));
  } finally { await db.close(); }
});

test('legacy admission fails closed and both new functions remain service-only', async () => {
  const db = await database();
  try {
    await allow(db);
    const old = await db.query<{a:boolean;b:boolean}>(
      "SELECT input_record_outcome($1,'city_picker','city','canonical-city') a, input_record_task_outcome('city_picker','trip_created',true) b", [actor]);
    assert.deepEqual(old.rows[0], {a:false,b:false});
    await db.exec('SET ROLE authenticated');
    await assert.rejects(record(db), /permission denied/);
    await assert.rejects(aggregate(db), /permission denied/);
    await db.exec('RESET ROLE; SET ROLE service_role');
    assert.equal(await record(db), true);
    assert.equal(await aggregate(db), true);
  } finally { await db.close(); }
});

// PGlite is one connection: these are real SQL behavior tests, not a claim of
// cross-connection race proof. Hosted CI must verify both lock orderings.
