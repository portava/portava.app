import assert from 'node:assert/strict';
import { before, after, beforeEach, describe, test } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const binary=process.env.PORTAVA_TEST_POSTGRES_BIN;
let root=''; let environment:NodeJS.ProcessEnv; let args:string[];
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', Z1='11111111-1111-4111-8111-111111111111', Z2='22222222-2222-4222-8222-222222222222';
function raw(input:string) { return spawnSync(join(binary!,'psql'),args,{input,env:environment,encoding:'utf8',timeout:10000}); }
function sql(input:string) { const r=raw(input); assert.equal(r.status,0,String(r.stderr)); return r.stdout.trim(); }
const service=(input:string)=>sql(`SET ROLE service_role; ${input}`);
const protect=(owner=A)=>`SELECT public.set_map_personal_protected_place('${owner}','home',16.123456,108.123456,1500);`;
const grant=(enabled=true)=>`SELECT public.set_map_route_flow_consent('${A}',${enabled},'reviewed-v1');`;
const navigation=(lat=16.5,lng=108.5)=>`SELECT public.record_map_navigation_contribution('${A}','reviewed-v1','${Z1}','${Z2}',${lat},${lng},17,109);`;
describe('Maps private controls: PostgreSQL17', {skip:!binary?'PORTAVA_TEST_POSTGRES_BIN required':false},()=>{
 before(()=>{
  assert.ok(binary&&isAbsolute(binary)); assert.match(spawnSync(join(binary!,'postgres'),['--version'],{encoding:'utf8'}).stdout,/17\.11/);
  root=realpathSync(mkdtempSync(join(tmpdir(),'map-privacy-native-'))); const socket=join(root,'socket'); mkdirSync(socket,{mode:0o700}); environment={PATH:'/usr/bin:/bin',HOME:root,LC_ALL:'C'};
  for(const [program,options] of [['initdb',['-D',join(root,'data'),'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8']],['pg_ctl',['-D',join(root,'data'),'-l',join(root,'postgres.log'),'-w','-t','10','-o',`-F -h '' -k '${socket}' -p 55433 -c unix_socket_permissions=0700`,'start']]] as const){const r:ReturnType<typeof spawnSync>=spawnSync(join(binary!,program),[...options],{env:environment,encoding:'utf8',timeout:20000});assert.equal(r.status,0,String(r.stderr));}
  args=['-X','--no-password','-qAt','-v','ON_ERROR_STOP=1','-h',socket,'-p','55433','-U','postgres','-d','postgres']; assert.equal(sql('SHOW listen_addresses'),'');
  sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; GRANT USAGE ON SCHEMA auth,public TO authenticated,service_role; CREATE TABLE profiles(id uuid PRIMARY KEY); CREATE TABLE geo_zones(id uuid PRIMARY KEY); CREATE TABLE feature_flags(flag text PRIMARY KEY,enabled boolean); CREATE TABLE route_flow_contribution_consent(user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,enabled boolean,consent_version text,consented_at timestamptz,withdrawn_at timestamptz,updated_at timestamptz); GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;`);
  sql(readFileSync(new URL('../migrations/4008_map_private_controls.sql',import.meta.url),'utf8'));
 });
 beforeEach(()=>{sql(`TRUNCATE profiles CASCADE; INSERT INTO profiles VALUES('${A}'),('${B}'); INSERT INTO geo_zones VALUES('${Z1}'),('${Z2}') ON CONFLICT DO NOTHING; UPDATE feature_flags SET enabled=true WHERE flag='map_route_flow_consent_enabled';`);});
 after(()=>{if(root&&existsSync(join(root,'data','postmaster.pid'))){const r=spawnSync(join(binary!,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','-w','-t','10','stop'],{env:environment,encoding:'utf8',timeout:15000});assert.equal(r.status,0,String(r.stderr));}if(root)rmSync(root,{recursive:true,force:true});});
 test('protection keeps only a coarse point and same-category replacement is bounded',()=>{service(protect());service(protect());assert.equal(sql('SELECT count(*)||\':\'||max(center_lat)||\':\'||max(center_lng) FROM map_personal_protected_places'),'1:16.12:108.12');});
 test('RLS reads own protections only; clients cannot forge owner writes',()=>{service(protect());service(protect(B));assert.equal(sql(`SET ROLE authenticated; SET request.jwt.claim.sub='${A}'; SELECT count(*) FROM map_personal_protected_places;`),'1');assert.notEqual(raw(`SET ROLE authenticated; ${protect(B)}`).status,0);});
 test('no consent means no navigation contribution',()=>{assert.equal(service(navigation()),'f');assert.equal(sql('SELECT count(*) FROM map_navigation_contributions'),'0');});
 test('one current hop replaces its predecessor and has bounded expiry',()=>{service(grant());assert.equal(service(navigation()),'t');assert.equal(service(navigation(18,110)),'t');assert.equal(sql("SELECT count(*)||':'||bool_and(expires_at<=observed_at+interval '15 minutes') FROM map_navigation_contributions"),'1:true');});
 test('withdrawal erases the retained hop and prevents the next write',()=>{service(grant());service(navigation());service(grant(false));assert.equal(sql('SELECT count(*) FROM map_navigation_contributions'),'0');assert.equal(service(navigation()),'f');});
 test('a protected origin refuses navigation and protection atomically erases a previous hop',()=>{service(grant());service(navigation());service(protect());assert.equal(sql('SELECT count(*) FROM map_navigation_contributions'),'0');assert.equal(service(navigation(16.12,108.12)),'f');});
 test('a disabled flag or mismatched disclosure refuses writes',()=>{service(grant());sql("UPDATE feature_flags SET enabled=false");assert.equal(service(navigation()),'f');sql("UPDATE feature_flags SET enabled=true; UPDATE route_flow_contribution_consent SET consent_version='older'");assert.equal(service(navigation()),'f');});
 test('profile erasure cascades both privacy records and transient intent',()=>{service(grant());service(protect());service(navigation());sql(`DELETE FROM profiles WHERE id='${A}'`);assert.equal(sql('SELECT (SELECT count(*) FROM map_personal_protected_places)+(SELECT count(*) FROM map_navigation_contributions)'),'0');});
 test('expiry sweep removes only expired rows and remains runnable with collection off',()=>{service(grant());service(navigation());sql("UPDATE map_navigation_contributions SET observed_at=now()-interval '20 minutes',expires_at=now()-interval '5 minutes'; UPDATE feature_flags SET enabled=false");assert.equal(service('SELECT public.purge_expired_map_navigation_contributions(500)'),'1');assert.equal(service('SELECT public.purge_expired_map_navigation_contributions(500)'),'0');});
 test('no anonymous or authenticated role can inspect another owner navigation',()=>{service(grant());service(navigation());assert.notEqual(raw('SET ROLE authenticated; SELECT * FROM map_navigation_contributions').status,0);assert.notEqual(raw('SET ROLE anon; SELECT * FROM map_personal_protected_places').status,0);});
});
