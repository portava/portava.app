import assert from 'node:assert/strict';
import { describe, before, after, beforeEach, afterEach, it } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { VideoSegmentNativeSession as Session } from './memoryVideoSegmentsPostgresFixture.js';
const bin = process.env.INPUT_OUTCOME_POSTGRES_BIN, run = promisify(execFile);
const actor = '10000000-0000-4000-8000-000000000029', grant = '2026-11-13T12:00:00Z';
const admission = `SELECT input_record_outcome('${actor}','city_picker','city','test-city','${grant}');`;
const aggregate = `SELECT input_record_task_outcome('${actor}','${grant}','city_picker','trip_created',true);`;
const withdrawal = `UPDATE input_outcome_consent SET enabled=false,withdrawn_at=now() WHERE user_id='${actor}'; DELETE FROM input_outcome_counters WHERE user_id='${actor}';`;
const observe = <T>(promise: Promise<T>) => promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
describe('4029 PostgreSQL two-connection consent races (isolated socket-only database)', {
  skip: bin ? false : 'INPUT_OUTCOME_POSTGRES_BIN unset; true concurrency remains unverified', concurrency: false,
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
    root = await mkdtemp('/tmp/Rumazi-InputConsent-pg-'); await mkdir(join(root,'socket'), { mode: 0o700 });
    await run(join(bin!,'initdb'), ['-D',join(root,'data'),'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'], { env: environment, timeout:20000 });
    await run(join(bin!,'pg_ctl'), ['-D',join(root,'data'),'-l',join(root,'postgres.log'),'-w','-t','10','-o',`-F -h '' -k '${join(root,'socket')}' -p 55433 -c unix_socket_permissions=0700 -c shared_buffers=16MB -c max_connections=10`,'start'], { env: environment, timeout:15000 }); started = true;
    const setup = session(); assert.equal(await setup.query('SHOW listen_addresses;'),'');
    await setup.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE TABLE feature_flags(flag text PRIMARY KEY,enabled boolean,description text);
      INSERT INTO auth.users VALUES('${actor}');`);
    for (const file of ['3780_input_outcome_learning.sql','3783_input_outcome_task_aggregate.sql','4029_input_outcome_consent_fence.sql']) await setup.query(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
    await setup.close();
  });
  beforeEach(async () => {
    a = session(); b = session(); contenderPid = Number(await b.query('SELECT pg_backend_pid();'));
    assert.notEqual(Number(await a.query('SELECT pg_backend_pid();')), contenderPid);
    await a.query(`TRUNCATE input_outcome_counters,input_outcome_task_daily; UPDATE feature_flags SET enabled=true; INSERT INTO input_outcome_consent(user_id,enabled,consent_version,consented_at,withdrawn_at) VALUES('${actor}',true,'input_outcome_learning_v1','${grant}',NULL)
      ON CONFLICT(user_id) DO UPDATE SET enabled=true,consented_at=EXCLUDED.consented_at,withdrawn_at=NULL;`);
    for (const s of [a,b]) await s.query("SET lock_timeout='3s'; SET statement_timeout='5s'; SET idle_in_transaction_session_timeout='10s';");
  });
  afterEach(async () => { await Promise.all([a?.close(),b?.close()]); });
  after(async () => {
    await Promise.all([...sessions].map(s => s.close()));
    if (started) await run(join(bin!,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','-w','stop'],{env:environment,timeout:15000});
    if (root) await rm(root,{recursive:true,force:true});
  });
  for (const [name, sql, table] of [['counter',admission,'input_outcome_counters'],['aggregate',aggregate,'input_outcome_task_daily']]) {
    it(`${name}: withdrawal wins, waiting admission observes the committed withdrawal`, async () => {
      await a.query(`BEGIN; ${withdrawal}`); const next = observe(b.query(sql!)); await blocked();
      await a.query('COMMIT;'); assert.deepEqual(await next,{ok:true,value:'f'});
      assert.equal(await a.query(`SELECT count(*) FROM ${table};`),'0');
    });
  }
  it('counter admission wins: withdrawal waits, then erases all admitted counters', async () => {
    await a.query('BEGIN;'); assert.equal(await a.query(admission),'t');
    const next = observe(b.query(withdrawal)); await blocked(); await a.query('COMMIT;'); assert.equal((await next).ok,true);
    assert.equal(await a.query(admission),'f'); assert.equal(await a.query('SELECT count(*) FROM input_outcome_counters;'),'0');
  });
  it('regrant wins: previous-grant work is refused after the lock releases', async () => {
    await a.query(`BEGIN; UPDATE input_outcome_consent SET consented_at='2026-11-13T14:00:00Z' WHERE user_id='${actor}';`);
    const next = observe(b.query(admission)); await blocked(); await a.query('COMMIT;'); assert.deepEqual(await next,{ok:true,value:'f'});
    assert.equal(await a.query(aggregate),'f');
    assert.equal(await a.query('SELECT count(*) FROM input_outcome_counters;'),'0');
  });
  it('flag revocation wins: waiting writers cannot use an earlier enabled snapshot', async () => {
    await a.query('BEGIN; UPDATE feature_flags SET enabled=false;');
    const next = observe(b.query(admission)); await blocked(); await a.query('COMMIT;'); assert.deepEqual(await next,{ok:true,value:'f'});
    assert.equal(await a.query(aggregate),'f');
  });
});
