import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomUUID } from "node:crypto";
import { VideoSegmentNativeSession } from "./memoryVideoSegmentsPostgresFixture.js";
import { EVENT_STATES, decideEventTransition } from '../lib/eventLifecycle.js';

const binary = process.env.PORTAVA_TEST_POSTGRES_BIN;
const admin = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const otherAdmin = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const owner = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const review = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const otherReview = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
const report = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const otherReport = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
const operation = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const migrationUrl = new URL("../migrations/4005_telegraph_sequence_receipts.sql", import.meta.url);
let root = "";
let socket = "";
let environment: NodeJS.ProcessEnv;
let args: string[];
const sessions = new Set<VideoSegmentNativeSession>();
function literal(value: unknown): string { return value == null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`; }
function raw(script: string) {
  return spawnSync(join(binary!, "psql"), args, { input: `SET statement_timeout='7s'; ${script}`, env: environment, encoding: "utf8", timeout: 10000 });
}
function sql(script: string): string {
  const result = raw(script);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function session() {
  const connection = new VideoSegmentNativeSession(join(binary!, "psql"), socket, environment);
  sessions.add(connection);
  return connection;
}

const thread='11111111-1111-4111-8111-111111111111';
const first='22222222-2222-4222-8222-222222222221';
const second='22222222-2222-4222-8222-222222222222';
const third='22222222-2222-4222-8222-222222222223';
function ack(target=first,kind='seen',actor=owner) { return `SELECT telegraph_ack_message('${thread}','${actor}','${target}','${kind}')`; }
function runAck(target=first,kind='seen',actor=owner) { return JSON.parse(sql(`SET ROLE service_role; ${ack(target,kind,actor)}`)); }
function unsend(target=first) { return `SELECT telegraph_unsend_message_before_seen('${target}','${admin}','${thread}')`; }
function ready() { sql(`SELECT telegraph_backfill_message_sequences('${thread}'); UPDATE feature_flags SET enabled=true WHERE flag='telegraph_sequence_state_enabled';`); }
async function blocked(name: string) {
 for(let i=0;i<100;i++) { if(sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name=${literal(name)} AND wait_event_type='Lock'`)==='1') return; await new Promise(r=>setTimeout(r,10)); }
 assert.fail('Expected lock barrier '+name);
}
describe('Telegraph durable sequence state: real PostgreSQL 17', {skip:!binary ? 'PORTAVA_TEST_POSTGRES_BIN is required for the native gate' : false},()=>{
  before(() => {
    if (typeof binary !== "string" || !isAbsolute(binary)) throw new Error("PORTAVA_TEST_POSTGRES_BIN must be an absolute PostgreSQL 17.11 bin directory");
    const version = spawnSync(join(binary, "postgres"), ["--version"], { encoding: "utf8" });
    assert.match(version.stdout, /\b17\.11\b/);
    root = realpathSync(mkdtempSync(join("/tmp", "tg-seq-")));
    socket = join(root, "socket");
    mkdirSync(socket, { mode: 0o700 });
    environment = { PATH: "/usr/bin:/bin", HOME: root, LC_ALL: "C" };
    for (const [program, options] of [
      ["initdb", ["-D", join(root, "data"), "-U", "postgres", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8"]],
      ["pg_ctl", ["-D", join(root, "data"), "-l", join(root, "postgres.log"), "-w", "-t", "10", "-o",
        `-F -h '' -k '${socket}' -p 55433 -c unix_socket_permissions=0700 -c deadlock_timeout=100ms`, "start"]],
    ] as const) {
      const result: SpawnSyncReturns<string> = spawnSync(join(binary, program), [...options], { env: environment, encoding: "utf8", timeout: 20000 });
      assert.equal(result.status, 0, result.stderr + (existsSync(join(root,"postgres.log")) ? readFileSync(join(root,"postgres.log"),"utf8") : ""));
    }
    args = ["-X", "--no-password", "-qAt", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-h", socket, "-p", "55433", "-U", "postgres", "-d", "postgres"];
    assert.equal(sql("SHOW listen_addresses"), "");
    assert.equal(sql("SELECT inet_server_addr() IS NULL"), "t");
    assert.equal(sql("SHOW server_version_num"), "170011");

    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE feature_flags(flag text PRIMARY KEY, enabled boolean NOT NULL, description text);
      INSERT INTO feature_flags VALUES ('telegraph_message_kernel_enabled',true,'');
      CREATE TABLE message_threads(id uuid PRIMARY KEY,last_sequence bigint NOT NULL DEFAULT 0);
      CREATE TABLE messages(id uuid PRIMARY KEY,thread_id uuid REFERENCES message_threads(id),sender_id uuid,body text,sequence bigint,created_at timestamptz NOT NULL,edited_at timestamptz,deleted_at timestamptz,unsent_at timestamptz,lifecycle_state text);
      CREATE UNIQUE INDEX messages_thread_sequence_uniq ON messages(thread_id,sequence) WHERE sequence IS NOT NULL;
      CREATE TABLE message_thread_members(thread_id uuid REFERENCES message_threads(id),user_id uuid,last_read_at timestamptz,left_at timestamptz,visible_from_at timestamptz,visible_from_sequence bigint,visible_until_sequence bigint,delivered_sequence bigint,seen_sequence bigint,PRIMARY KEY(thread_id,user_id));
      CREATE TABLE blocks(blocker_id uuid,blocked_id uuid);
      GRANT USAGE ON SCHEMA public TO service_role,anon,authenticated;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO service_role;`);
    sql(readFileSync(migrationUrl,'utf8'));
  });
  beforeEach(()=>{
    sql(`UPDATE feature_flags SET enabled=false WHERE flag='telegraph_sequence_state_enabled';
      TRUNCATE message_threads,messages,message_thread_members,blocks CASCADE;
      INSERT INTO message_threads(id) VALUES ('${thread}');
      INSERT INTO message_thread_members(thread_id,user_id) VALUES ('${thread}','${admin}'),('${thread}','${owner}');
      INSERT INTO messages(id,thread_id,sender_id,body,created_at) VALUES
       ('${first}','${thread}','${admin}','one','2026-11-05T01:00:00Z'),
       ('${second}','${thread}','${admin}','two','2026-11-05T01:00:00Z'),
       ('${third}','${thread}','${admin}','three','2026-11-05T01:00:01Z');`);
  });
  afterEach(async () => { await Promise.all([...sessions].map(connection=>connection.close())); sessions.clear(); });
  after(() => {
    if (root && existsSync(join(root,'data','postmaster.pid'))) {
      const result=spawnSync(join(binary!,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','-w','-t','10','stop'],{env:environment,encoding:'utf8',timeout:15000});
      assert.equal(result.status,0,result.stderr);
    }
    if(root) rmSync(root,{recursive:true,force:true});
  });
 test('backfill preserves assigned cursors and reruns without writes',()=>{
   sql(`UPDATE messages SET sequence=7 WHERE id='${second}'; UPDATE message_threads SET last_sequence=7;`);
   assert.equal(sql(`SELECT telegraph_backfill_message_sequences('${thread}')`),'2');
   assert.equal(sql(`SELECT string_agg(sequence::text,',' ORDER BY id) FROM messages`),'8,7,9');
   assert.equal(sql(`SELECT telegraph_backfill_message_sequences('${thread}')`),'0');
   assert.equal(sql('SELECT last_sequence FROM message_threads'),'9');
 });
 test('cutover preserves previously seen messages and closes their unsend window',()=>{
   sql(`UPDATE message_thread_members SET last_read_at='2026-11-05T01:00:00Z' WHERE user_id='${owner}'`);
   ready();
   assert.equal(sql(`SELECT seen_sequence||':'||delivered_sequence FROM message_thread_members WHERE user_id='${owner}'`),'2:2');
   assert.equal(JSON.parse(sql(unsend(second))).outcome,'seen');
 });
 test('cutover refuses incomplete history and allocator shutdown',()=>{
   assert.match(raw("UPDATE feature_flags SET enabled=true WHERE flag='telegraph_sequence_state_enabled'").stderr,/telegraph_sequence_backfill_required/);
   ready(); assert.match(raw("UPDATE feature_flags SET enabled=false WHERE flag='telegraph_message_kernel_enabled'").stderr,/disable_sequence_state_before_kernel/);
 });
 test('delivery is durable, seen is distinct, and both watermarks only advance',()=>{
   ready(); assert.equal(runAck(second,'delivered').sequence,'2');
   assert.equal(sql(`SELECT seen_sequence IS NULL FROM message_thread_members WHERE user_id='${owner}'`),'t');
   runAck(first); runAck(third); assert.equal(runAck(first).advanced,false);
   assert.equal(sql(`SELECT seen_sequence||':'||delivered_sequence FROM message_thread_members WHERE user_id='${owner}'`),'3:3');
 });
 test('same timestamp messages have distinct seen and unsend state',()=>{
   ready(); runAck(first);
   assert.equal(JSON.parse(sql(unsend(first))).outcome,'seen');
   assert.equal(JSON.parse(sql(unsend(second))).outcome,'unsent');
   assert.equal(runAck(second).outcome,'not_found');
 });
 test('foreign, departed, blocked and pre-join targets cannot advance receipts',()=>{
   ready(); assert.equal(runAck(first,'seen',otherAdmin).outcome,'not_found');
   sql(`UPDATE message_thread_members SET visible_from_at='2026-11-05T02:00:00Z' WHERE user_id='${owner}'`);
   assert.equal(runAck(first).outcome,'not_found');
   sql(`UPDATE message_thread_members SET visible_from_at=NULL WHERE user_id='${owner}'; INSERT INTO blocks VALUES ('${admin}','${owner}')`);
   assert.equal(runAck(first).outcome,'not_found');
   sql(`TRUNCATE blocks; UPDATE message_thread_members SET left_at=now() WHERE user_id='${owner}'`);
   assert.equal(runAck(first).outcome,'not_found');
   assert.equal(sql(`SELECT seen_sequence IS NULL FROM message_thread_members WHERE user_id='${owner}'`),'t');
 });
 test('join and leave store sequence bounds and explicit history grants remain unbounded',()=>{
   ready(); sql(`INSERT INTO message_thread_members(thread_id,user_id,visible_from_at) VALUES ('${thread}','${otherAdmin}',now())`);
   assert.equal(sql(`SELECT visible_from_sequence FROM message_thread_members WHERE user_id='${otherAdmin}'`),'4');
   sql(`UPDATE message_thread_members SET left_at=now() WHERE user_id='${otherAdmin}'`);
   assert.equal(sql(`SELECT visible_until_sequence FROM message_thread_members WHERE user_id='${otherAdmin}'`),'3');
   sql(`UPDATE message_thread_members SET left_at=NULL,visible_from_at=NULL WHERE user_id='${otherAdmin}'`);
   assert.equal(sql(`SELECT visible_from_sequence IS NULL AND visible_until_sequence IS NULL FROM message_thread_members WHERE user_id='${otherAdmin}'`),'t');
 });
 test('client roles cannot impersonate a receipt or run a backfill',()=>{
   ready(); for(const role of ['anon','authenticated']) {
     assert.match(raw(`SET ROLE ${role}; ${ack()}`).stderr,/permission denied/);
     assert.match(raw(`SET ROLE ${role}; SELECT telegraph_backfill_message_sequences('${thread}')`).stderr,/permission denied/);
   }
 });
 test('concurrent seen commits before unsend and closes the window',async()=>{
   ready(); const a=session(),b=session();
   await a.query(`BEGIN; SET application_name='seen-first'; ${ack()};`);
   const pending=b.query(`SET application_name='unsend-after-seen'; ${unsend()};`);
   await blocked('unsend-after-seen'); await a.query('COMMIT;');
   assert.match(await pending,/"outcome": "seen"/);
 });
 test('concurrent unsend commits before seen and leaves no receipt',async()=>{
   ready(); const a=session(),b=session();
   await a.query(`BEGIN; SET application_name='unsend-first'; ${unsend()};`);
   const pending=b.query(`SET application_name='seen-after-unsend'; ${ack()};`);
   await blocked('seen-after-unsend'); await a.query('COMMIT;');
   assert.match(await pending,/"outcome": "not_found"/);
   assert.equal(sql(`SELECT seen_sequence IS NULL FROM message_thread_members WHERE user_id='${owner}'`),'t');
 });
 test('two reversed concurrent seen requests cannot regress the watermark',async()=>{
   ready(); const a=session(),b=session(); await a.query(`BEGIN; ${ack(third)};`);
   const pending=b.query(`SET application_name='older-seen'; ${ack(first)};`);
   await blocked('older-seen'); await a.query('COMMIT;'); await pending;
   assert.equal(sql(`SELECT seen_sequence FROM message_thread_members WHERE user_id='${owner}'`),'3');
 });
});
