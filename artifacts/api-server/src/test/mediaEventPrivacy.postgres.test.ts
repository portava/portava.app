import assert from 'node:assert/strict';
import { describe, before, after, beforeEach, afterEach, it } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { VideoSegmentNativeSession as Session } from './memoryVideoSegmentsPostgresFixture.js';
const bin = process.env.MEDIA_EVENT_POSTGRES_BIN, run = promisify(execFile);
const actor = '10000000-0000-4000-8000-000000000030';
const admission = `WITH inserted AS (INSERT INTO media_events(event_type,payload) VALUES('impression','{"viewer_id":"${actor}"}') RETURNING id) SELECT count(*) FROM inserted;`;
const erasure = `SELECT erase_media_events_for_actor('${actor}',500);`;
const observe = <T>(promise: Promise<T>) => promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
describe('4031 PostgreSQL two-connection erasure races (isolated socket-only database)', {
  skip: bin ? false : 'MEDIA_EVENT_POSTGRES_BIN unset; true concurrency remains unverified', concurrency: false,
}, () => {
  let root = '', started = false, a: Session, b: Session, contenderPid: number;
  const environment = { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, sessions = new Set<Session>();
  function session() { const s = new Session(join(bin!, 'psql'), join(root, 'socket'), environment); sessions.add(s); return s; }
  async function blocked() {
    const until = Date.now() + 1500;
    while (Date.now() < until) {
      if (await a.query(`SELECT pg_backend_pid() = ANY(pg_blocking_pids(${contenderPid}));`) === 't') return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('the contender must demonstrably wait on the first backend');
  }
  before(async () => {
    root = await mkdtemp('/tmp/Rumazi-MediaEvents-pg-'); await mkdir(join(root,'socket'), { mode: 0o700 });
    await run(join(bin!,'initdb'), ['-D',join(root,'data'),'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'], { env: environment, timeout:20000 });
    await run(join(bin!,'pg_ctl'), ['-D',join(root,'data'),'-l',join(root,'postgres.log'),'-w','-t','10','-o',`-F -h '' -k '${join(root,'socket')}' -p 55433 -c unix_socket_permissions=0700 -c shared_buffers=16MB -c max_connections=10`,'start'], { env: environment, timeout:15000 }); started = true;
    const setup = session(); assert.equal(await setup.query('SHOW listen_addresses;'),'');
    await setup.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE profiles(id uuid PRIMARY KEY,account_status text); INSERT INTO profiles VALUES('${actor}','active');
      CREATE TABLE posts(id uuid PRIMARY KEY,author_id uuid,created_by uuid);
      CREATE TABLE media_assets(id uuid PRIMARY KEY,owner_user_id uuid,uploader_user_id uuid);
      CREATE TABLE hidden_gems(id uuid PRIMARY KEY,submitted_by uuid);
      CREATE TABLE feature_flags(flag text PRIMARY KEY,enabled boolean,description text,metadata jsonb);`);
    for (const file of ['2039_media_events.sql','4031_media_event_erasure_and_retention.sql']) await setup.query(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
    await setup.close();
  });
  beforeEach(async () => {
    a = session(); b = session(); contenderPid = Number(await b.query('SELECT pg_backend_pid();'));
    assert.notEqual(Number(await a.query('SELECT pg_backend_pid();')), contenderPid);
    await a.query(`TRUNCATE media_events,media_event_erasure_fences; UPDATE profiles SET account_status='active'; UPDATE feature_flags SET enabled=false;`);
    for (const s of [a,b]) await s.query("SET lock_timeout='3s'; SET statement_timeout='5s'; SET idle_in_transaction_session_timeout='10s';");
  });
  afterEach(async () => { await Promise.all([a?.close(),b?.close()]); });
  after(async () => {
    await Promise.all([...sessions].map(s => s.close()));
    if (started) await run(join(bin!,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','-w','stop'],{env:environment,timeout:15000});
    if (root) await rm(root,{recursive:true,force:true});
  });
  it('erasure wins: a queued writer waits for the fence and stores nothing', async () => {
    await a.query(`BEGIN; ${erasure}`); const next = observe(b.query(admission)); await blocked();
    await a.query('COMMIT;'); assert.deepEqual(await next,{ok:true,value:'0'});
    assert.equal(await a.query('SELECT count(*) FROM media_events;'),'0');
  });
  it('writer wins: erasure waits, deletes the committed event, and rejects retries', async () => {
    await a.query('BEGIN;'); assert.equal(await a.query(admission),'1');
    const next = observe(b.query(erasure)); await blocked(); await a.query('COMMIT;');
    const result=await next;assert.equal(result.ok,true);if(result.ok)assert.deepEqual(JSON.parse(result.value),{deleted:1,more:false});
    assert.equal(await a.query(admission),'0'); assert.equal(await a.query('SELECT count(*) FROM media_events;'),'0');
  });
  it('creator-only reference is fenced even when another viewer starts the delayed write', async () => {
    const other='10000000-0000-4000-8000-000000000031',post='20000000-0000-4000-8000-000000000031';
    await a.query(`INSERT INTO profiles VALUES('${other}','active') ON CONFLICT DO NOTHING;INSERT INTO posts VALUES('${post}','${actor}','${actor}') ON CONFLICT DO NOTHING;BEGIN;${erasure}`);
    const next=observe(b.query(`WITH inserted AS (INSERT INTO media_events(event_type,payload) VALUES('impression','{"viewer_id":"${other}","media_id":"${post}"}') RETURNING id) SELECT count(*) FROM inserted;`));
    await blocked();await a.query('COMMIT;');assert.deepEqual(await next,{ok:true,value:'0'});
  });
  it('erasure wins before composer admission: transient actor authorization blocks the delayed unlinked write', async()=>{
    await a.query(`BEGIN; ${erasure}`);
    const row={id:'30000000-0000-4000-8000-000000000030',event_type:'composer_outcome',payload:{version:1,surface:'post',outcome:'published'}};
    const next=observe(b.query(`SELECT admit_composer_outcomes('${actor}','${JSON.stringify([row])}');`));
    await blocked();await a.query('COMMIT;');assert.deepEqual(await next,{ok:true,value:'f'});
    assert.equal(await a.query('SELECT count(*) FROM media_events;'),'0');
  });
  it('composer admission first: erasure waits; historical unlinked rows stay explicitly outside account enumeration', async()=>{
    const row={id:'30000000-0000-4000-8000-000000000031',event_type:'composer_outcome',payload:{version:1,surface:'post',outcome:'published'}};
    await a.query('BEGIN;');assert.equal(await a.query(`SELECT admit_composer_outcomes('${actor}','${JSON.stringify([row])}');`),'t');
    const next=observe(b.query(erasure));await blocked();await a.query('COMMIT;');
    const result=await next;assert.equal(result.ok,true);if(result.ok)assert.deepEqual(JSON.parse(result.value),{deleted:0,more:false});
    assert.equal(await a.query(`SELECT admit_composer_outcomes('${actor}','${JSON.stringify([row])}');`),'f');
    assert.equal(await a.query('SELECT count(*) FROM media_events;'),'1');
  });
  it('retention does not mistake a locked expired row for a completed sweep',async()=>{
    await a.query(`UPDATE feature_flags SET enabled=true,metadata=metadata||'{"policy_status":"approved_after_legal_review"}'::jsonb WHERE flag='media_event_retention_enabled';INSERT INTO media_events(event_type,payload,occurred_at) VALUES('composer_outcome','{"version":1,"surface":"post","outcome":"published"}',now()-interval '31 days');BEGIN;SELECT id FROM media_events FOR UPDATE;`);
    const skipped=JSON.parse(await b.query('SELECT purge_expired_media_events(500);'));
    assert.deepEqual(skipped,{enabled:true,deleted:0,more:true});await a.query('COMMIT;');
    assert.deepEqual(JSON.parse(await b.query('SELECT purge_expired_media_events(500);')),{enabled:true,deleted:1,more:false});
  });
});
