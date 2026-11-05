import assert from 'node:assert/strict';
import { before, after, beforeEach, describe, it } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { VideoSegmentNativeSession as Session } from './memoryVideoSegmentsPostgresFixture.js';
const run=promisify(execFile), bin=process.env.KEY_PACKAGES_POSTGRES_BIN;
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', D='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const encode=(value:string)=>Buffer.from(value).toString('base64url'), pack=encode('synthetic-public-key-package-1');
const publish=(owner=A,packages=[pack])=>`SELECT row_to_json(r) FROM public.publish_key_packages('${owner}','${D}',ARRAY[${packages.map(value=>`'${value}'`).join(',')}]::text[]) r;`;
const consume=`SELECT key_package_b64 FROM public.consume_key_package('${D}');`;
const attempt=<T>(promise:Promise<T>)=>promise.then(value=>({ok:true as const,value}),error=>({ok:false as const,error:error as Error}));
describe('4014 native PostgreSQL publication, consume and retry transactions',{skip:bin?false:'KEY_PACKAGES_POSTGRES_BIN unset; native concurrency NOT verified',concurrency:false},()=>{
 let root='',a:Session,b:Session,pid:number;
 const environment={PATH:'/usr/bin:/bin',LC_ALL:'C'},sessions=new Set<Session>();
 const session=()=>{const value=new Session(join(bin!,'psql'),join(root,'socket'),environment);sessions.add(value);return value;};
 const counts=async(pool:number,receipts:number)=>{
  assert.equal(await a.query('SELECT count(*) FROM key_packages;'),String(pool));
  assert.equal(await a.query(`SELECT key_package_count FROM devices WHERE id='${D}';`),String(pool));
  assert.equal(await a.query('SELECT count(*) FROM telegraph_crypto_private.key_package_publications;'),String(receipts));
 };
 const blocked=async()=>{const until=Date.now()+1500;while(Date.now()<until){if(await a.query(`SELECT pg_backend_pid() = ANY(pg_blocking_pids(${pid}));`)==='t')return;await new Promise(r=>setTimeout(r,10));}assert.fail('second backend must actually wait on first transaction');};
 before(async()=>{
  root=await mkdtemp('/tmp/Portava-KeyPackages-pg-');await mkdir(join(root,'socket'),{mode:0o700});
  await run(join(bin!,'initdb'),['-D',join(root,'data'),'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'],{env:environment,timeout:20000});
  await run(join(bin!,'pg_ctl'),['-D',join(root,'data'),'-l',join(root,'postgres.log'),'-w','-t','10','-o',`-F -h '' -k '${join(root,'socket')}' -p 55433 -c unix_socket_permissions=0700`,'start'],{env:environment,timeout:15000});
  const setup=session();assert.equal(await setup.query('SHOW listen_addresses;'),'');
  await setup.query('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE TABLE profiles(id uuid PRIMARY KEY);');
  for(const file of ['20260801_e2ee_devices.sql','20260802_e2ee_key_packages.sql','4014_key_package_publish_atomic.sql'])await setup.query(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
  await setup.close();
 });
 beforeEach(async()=>{
  a=session();b=session();pid=Number(await b.query('SELECT pg_backend_pid();'));
  await a.query(`TRUNCATE profiles CASCADE;INSERT INTO profiles VALUES('${A}'),('${B}');INSERT INTO devices(id,user_id,platform) VALUES('${D}','${A}','android');`);
  for(const value of [a,b])await value.query("SET statement_timeout='5s';SET lock_timeout='3s';");
 });
 after(async()=>{await Promise.all([...sessions].map(value=>value.close()));if(root){await run(join(bin!,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','-w','stop'],{env:environment,timeout:15000});await rm(root,{recursive:true,force:true});}});
 it('deduplicates concurrent publication and recounts actual inventory',async()=>{
  await a.query('BEGIN;');assert.equal(JSON.parse(await a.query(publish())).uploaded,1);
  const contender=attempt(b.query(publish()));await blocked();await a.query('COMMIT;');const result=await contender;assert.ok(result.ok);assert.deepEqual(JSON.parse(result.value),{uploaded:0,total_pool:1});await counts(1,1);
 });
 it('cannot reissue a consumed package on response-loss retry or alternate padding',async()=>{
  await a.query(publish());assert.equal(await a.query(consume),pack);
  assert.deepEqual(JSON.parse(await a.query(publish(A,[Buffer.from('synthetic-public-key-package-1').toString('base64')]))),{uploaded:0,total_pool:0});await counts(0,1);
 });
 it('serializes consume with a racing refill without losing the new count',async()=>{
  await a.query(publish());await a.query('BEGIN;');assert.equal(await a.query(consume),pack);
  const contender=attempt(b.query(publish(A,[encode('synthetic-package-2')])));await blocked();await a.query('COMMIT;');const result=await contender;assert.ok(result.ok);assert.deepEqual(JSON.parse(result.value),{uploaded:1,total_pool:1});await counts(1,2);
 });
 it('two concurrent consumers receive a one-use package at most once',async()=>{
  await a.query(publish());await a.query('BEGIN;');assert.equal(await a.query(consume),pack);
  const contender=attempt(b.query(consume));await blocked();await a.query('COMMIT;');const result=await contender;assert.ok(result.ok);assert.equal(result.value,'');await counts(0,1);
 });
 it('rolls back keys and receipts if counter persistence fails',async()=>{
  await a.query(`CREATE FUNCTION reject_counter() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic counter failure';END $$;CREATE TRIGGER reject_counter BEFORE UPDATE ON devices FOR EACH ROW EXECUTE FUNCTION reject_counter();`);
  assert.equal((await attempt(b.query(publish()))).ok,false);await counts(0,0);await a.query('DROP TRIGGER reject_counter ON devices;DROP FUNCTION reject_counter();');
 });
 it('refuses another account and rolls back a partially valid batch',async()=>{
  assert.equal((await attempt(b.query(publish(B)))).ok,false);await counts(0,0);const invalid=session();assert.equal((await attempt(invalid.query(publish(A,[pack,'a==='])))).ok,false);await counts(0,0);
 });
 it('ordinary authenticated callers cannot execute privileged functions or inspect receipts',async()=>{
  assert.equal(await a.query("SELECT has_function_privilege('authenticated','public.publish_key_packages(uuid,uuid,text[])','EXECUTE');"),'f');
  assert.equal(await a.query("SELECT has_function_privilege('authenticated','public.consume_key_package(uuid)','EXECUTE');"),'f');
  assert.equal(await a.query("SELECT has_table_privilege('authenticated','telegraph_crypto_private.key_package_publications','SELECT');"),'f');
 });
});
