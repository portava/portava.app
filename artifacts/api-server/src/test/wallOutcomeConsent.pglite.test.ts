import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const actor = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const grant = '2026-11-13T12:00:00.123Z';
const payload = { objectId: 'place-1', objectType: 'place', outcome: 'see_place' };
async function setup() {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
    CREATE TABLE profiles(id uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE);
    CREATE TABLE feature_flags(flag text,enabled boolean); INSERT INTO feature_flags VALUES('wall_enabled',true);
    INSERT INTO auth.users VALUES('${actor}'),('${other}'); INSERT INTO profiles SELECT id FROM auth.users;`);
  for (const file of ['2172_intel_contribution_consent.sql','2308_wall_telemetry_events.sql','3702_wall_telemetry_retention_30_days.sql','4030_wall_outcome_consent_boundary.sql']) {
    await db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  return db;
}
async function admit(db: PGlite, at: string | null = grant, who = actor) {
  return (await db.query<{n:number}>('SELECT insert_wall_telemetry_outcomes($1,$2,$3) n', [who, JSON.stringify([{ schema_version:'1.0', payload }]), at])).rows[0]!.n;
}
async function allow(db: PGlite, at = grant) {
  await db.query(`INSERT INTO intel_contribution_consent(user_id,enabled,consent_version,consented_at,withdrawn_at)
    VALUES($1,true,'intel_contributions_v1',$2,NULL) ON CONFLICT(user_id) DO UPDATE
    SET enabled=true,consented_at=EXCLUDED.consented_at,withdrawn_at=NULL`,[actor,at]);
}
test('actual migrations: default-deny, grant binding, withdrawal and regrant, service-only authority', async () => {
  const db = await setup();
  try {
    assert.equal(await admit(db),0); await allow(db);
    assert.equal(await admit(db,null),0); assert.equal(await admit(db,grant,other),0);
    await db.exec('SET ROLE service_role'); assert.equal(await admit(db),1); await db.exec('RESET ROLE');
    await db.exec(`UPDATE intel_contribution_consent SET enabled=false,withdrawn_at=now() WHERE user_id='${actor}'`);
    assert.equal(await admit(db),0);
    const newer = '2026-11-13T13:00:00.456Z'; await allow(db,newer);
    assert.equal(await admit(db),0); assert.equal(await admit(db,newer),1);
    const rows = (await db.query<any>('SELECT * FROM wall_telemetry_events ORDER BY id')).rows;
    assert.equal(rows.length,2); assert.deepEqual(rows[0].payload,payload);
    assert.equal(new Date(rows[0].expires_at).getTime()-new Date(rows[0].occurred_at).getTime(),30*86400000);
    const permissions = (await db.query<any>(`SELECT has_function_privilege('authenticated','insert_wall_telemetry_outcomes(uuid,jsonb,timestamptz)','EXECUTE') client,
      has_function_privilege('anon','insert_wall_telemetry_outcomes(uuid,jsonb,timestamptz)','EXECUTE') anon,
      has_function_privilege('service_role','insert_wall_telemetry_outcomes(uuid,jsonb,timestamptz)','EXECUTE') service`)).rows[0];
    assert.deepEqual(permissions,{client:false,anon:false,service:true});
    await db.exec(`DELETE FROM auth.users WHERE id='${actor}'`);
    assert.equal((await db.query('SELECT * FROM wall_telemetry_events')).rows.length,0);
  } finally { await db.close(); }
});
test('trigger protects direct writers and old clients; ordinary events and expiry remain compatible', async () => {
  const db = await setup();
  try {
    await allow(db);
    await db.query(`INSERT INTO wall_telemetry_events(viewer_id,event_name,payload) VALUES($1,'wall_real_world_outcome',$2)`,[actor,JSON.stringify(payload)]);
    assert.equal((await db.query('SELECT * FROM wall_telemetry_events')).rows.length,0);
    await db.query(`INSERT INTO wall_telemetry_events(viewer_id,event_name,payload) VALUES($1,'wall_feed_open','{"mode":"for_you"}')`,[actor]);
    assert.equal((await db.query('SELECT * FROM wall_telemetry_events')).rows.length,1);
    assert.equal(await admit(db),1);
    await db.exec(`UPDATE intel_contribution_consent SET enabled=false,withdrawn_at=now()`);
    await db.exec(`UPDATE wall_telemetry_events SET expires_at=now()-interval '1 day'; DELETE FROM wall_telemetry_events WHERE expires_at < now()`);
    assert.equal((await db.query('SELECT * FROM wall_telemetry_events')).rows.length,0);
    // Assert the deployed function includes the PostgreSQL lock mode that
    // conflicts with UPDATE, not FOR KEY SHARE (which permits non-key updates).
    const fn = (await db.query<{body:string}>(`SELECT pg_get_functiondef('guard_wall_outcome_consent()'::regprocedure) body`)).rows[0]!.body;
    assert.match(fn,/FOR SHARE/); assert.doesNotMatch(fn,/FOR KEY SHARE/);
  } finally { await db.close(); }
});
