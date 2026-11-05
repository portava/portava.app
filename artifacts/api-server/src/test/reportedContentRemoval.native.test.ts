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
const migrationUrl = new URL("../migrations/4004_reported_content_audited_removal.sql", import.meta.url);
let root = "";
let socket = "";
let environment: NodeJS.ProcessEnv;
let args: string[];
const sessions = new Set<VideoSegmentNativeSession>();
type Context = { contentToken: string; reportToken: string; subjectId: string; reportId: string; [key: string]: unknown };

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
let subjectType = "comment";
function context(actor = admin, target = review, reportId = report): Context {
  return JSON.parse(sql(`SET ROLE service_role; SELECT public.get_reported_content_removal_context(${literal(actor)},${literal(subjectType)},${literal(target)},${literal(reportId)});`));
}
function removal(value: Context, overrides: Record<string, unknown> = {}) {
  const input = { actor: admin, type: subjectType, target: value.subjectId, report: value.reportId, operation, reason: "Reviewed conduct",
    contentToken: value.contentToken, reportToken: value.reportToken, ...overrides };
  return `SELECT public.remove_reported_content(${[input.actor, input.type, input.target, input.report, input.operation, input.reason, input.contentToken, input.reportToken].map(literal).join(",")});`;
}
function execute(value: Context, overrides: Record<string, unknown> = {}) {
  return JSON.parse(sql(`SET ROLE service_role; ${removal(value, overrides)}`));
}
function refused(script: string, expected: RegExp) {
  const result = raw(`SET ROLE service_role; ${script}`);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, expected);
}
async function blocked(name: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name=${literal(name)} AND wait_event_type='Lock'`) === "1") return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`No lock barrier for ${name}`);
}

describe("reported-content audited removal: PostgreSQL 17", { skip: !binary ? "PORTAVA_TEST_POSTGRES_BIN missing; mandatory native gate must supply PostgreSQL 17.11" : false }, () => {
  before(() => {
    if (typeof binary !== "string" || !isAbsolute(binary)) throw new Error("PORTAVA_TEST_POSTGRES_BIN must be an absolute PostgreSQL 17.11 bin directory");
    const version = spawnSync(join(binary, "postgres"), ["--version"], { encoding: "utf8" });
    assert.match(version.stdout, /\b17\.11\b/);
    root = realpathSync(mkdtempSync(join(tmpdir(), "reported-content-native-")));
    socket = join(root, "socket");
    mkdirSync(socket, { mode: 0o700 });
    environment = { PATH: "/usr/bin:/bin", HOME: root, LC_ALL: "C" };
    for (const [program, options] of [
      ["initdb", ["-D", join(root, "data"), "-U", "postgres", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8"]],
      ["pg_ctl", ["-D", join(root, "data"), "-l", join(root, "postgres.log"), "-w", "-t", "10", "-o",
        `-F -h '' -k '${socket}' -p 55433 -c unix_socket_permissions=0700 -c deadlock_timeout=100ms`, "start"]],
    ] as const) {
      const result: SpawnSyncReturns<string> = spawnSync(join(binary, program), [...options], { env: environment, encoding: "utf8", timeout: 20000 });
      assert.equal(result.status, 0, result.stderr);
    }
    args = ["-X", "--no-password", "-qAt", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-h", socket, "-p", "55433", "-U", "postgres", "-d", "postgres"];
    assert.equal(sql("SHOW listen_addresses"), "");
    assert.equal(sql("SELECT inet_server_addr() IS NULL"), "t");
    assert.equal(sql("SHOW server_version_num"), "170011");
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE TABLE profiles(id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, role text NOT NULL);
      CREATE TYPE post_status AS ENUM ('active','hidden','reported','deleted');
      CREATE TYPE delayed_post_status AS ENUM ('draft','private','pending_location_exit','pending_delay','pending_safety_review','published','canceled','expired');
      CREATE TABLE posts(id uuid PRIMARY KEY,author_id uuid REFERENCES profiles(id),content text NOT NULL,status post_status NOT NULL DEFAULT 'active',post_status delayed_post_status NOT NULL DEFAULT 'published',deleted_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE posts_comments(id uuid PRIMARY KEY,user_id uuid REFERENCES profiles(id),body text,deleted_at timestamptz);
      CREATE TABLE messages(id uuid PRIMARY KEY,sender_id uuid REFERENCES profiles(id),body text,deleted_at timestamptz);
      CREATE TABLE media_assets(id uuid PRIMARY KEY,owner_user_id uuid REFERENCES profiles(id),caption text,moderation_status text NOT NULL CHECK(moderation_status IN ('processing','active','limited','rejected','removed','owner_deleted','pending','approved','flagged')),version integer NOT NULL DEFAULT 1,storage_bucket text,storage_path text,deleted_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE post_media(id uuid PRIMARY KEY,post_id uuid,moderation_status text NOT NULL CHECK(moderation_status IN ('pending','approved','flagged','rejected')),storage_bucket text,storage_path text,updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TYPE event_state AS ENUM ('draft','open','full','waitlist','started','completed','cancelled','archived');
      CREATE TABLE events(id uuid PRIMARY KEY,host_id uuid REFERENCES profiles(id),title text,state event_state NOT NULL,visibility text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE event_activity_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id uuid REFERENCES events(id),actor_id uuid,action text NOT NULL,metadata jsonb,created_at timestamptz NOT NULL DEFAULT now());
      CREATE TYPE rent_buddy_status AS ENUM ('pending','active','paused','rejected','suspended');
      CREATE TABLE rent_buddy_profiles(id uuid PRIMARY KEY,user_id uuid NOT NULL UNIQUE REFERENCES profiles(id),display_name text,tagline text,status rent_buddy_status NOT NULL DEFAULT 'active',admin_status text NOT NULL DEFAULT 'active',updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE rent_buddy_admin_actions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),admin_id uuid,target_type text NOT NULL,target_id text NOT NULL,action text NOT NULL,notes text);
      CREATE TABLE moderation_reports(id uuid PRIMARY KEY,subject_type text NOT NULL,subject_id text NOT NULL,subject_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,status text NOT NULL DEFAULT 'open',details text);
      CREATE TABLE moderation_actions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),target_user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        performed_by uuid REFERENCES profiles(id) ON DELETE SET NULL,report_id uuid REFERENCES moderation_reports(id) ON DELETE SET NULL,
        action_type text NOT NULL,reason text,metadata jsonb,created_at timestamptz NOT NULL DEFAULT now());
      ALTER TABLE moderation_actions ENABLE ROW LEVEL SECURITY;
      GRANT USAGE ON SCHEMA public TO service_role,anon,authenticated;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO service_role;`);
    sql(readFileSync(migrationUrl, 'utf8'));
  });
  beforeEach(() => {
    subjectType='comment';
    sql(`TRUNCATE auth.users,posts,posts_comments,messages,media_assets,post_media,events,event_activity_log,rent_buddy_profiles,rent_buddy_admin_actions,moderation_reports CASCADE;
      INSERT INTO auth.users VALUES ('${admin}'),('${otherAdmin}'),('${owner}');
      INSERT INTO profiles VALUES ('${admin}','admin'),('${otherAdmin}','admin'),('${owner}','user');
      INSERT INTO posts_comments(id,user_id,body) VALUES ('${review}','${owner}','Reported comment');
      INSERT INTO messages(id,sender_id,body) VALUES ('${review}','${owner}','Reported message');
      INSERT INTO posts(id,author_id,content) VALUES ('${review}','${owner}','Reported post');
      INSERT INTO media_assets(id,owner_user_id,caption,moderation_status,storage_bucket,storage_path) VALUES ('${review}','${owner}','Reported media','active','post-media','owner/file.jpg');
      INSERT INTO post_media(id,post_id,moderation_status,storage_bucket,storage_path) VALUES ('${review}','${review}','approved','post-media','owner/file.jpg');
      INSERT INTO events(id,host_id,title,state,visibility) VALUES ('${review}','${owner}','Reported event','open','friends');
      INSERT INTO rent_buddy_profiles(id,user_id,display_name,tagline) VALUES ('${review}','${owner}','Buddy','Reported listing');
      INSERT INTO moderation_reports(id,subject_type,subject_id,subject_user_id) VALUES ('${report}','comment','${review}','${owner}');`);
  });
  afterEach(async () => { await Promise.all([...sessions].map(connection=>connection.close())); sessions.clear(); });
  after(() => {
    if (root && existsSync(join(root,'data','postmaster.pid'))) {
      const result=spawnSync(join(binary!,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','-w','-t','10','stop'],{env:environment,encoding:'utf8',timeout:15000});
      assert.equal(result.status,0,result.stderr);
    }
    if(root) rmSync(root,{recursive:true,force:true});
  });
  for (const type of ['post','comment','message','buddy_listing','media','event']) {
    test(`${type}: content mutation and linked audit commit once; report remains open`,()=>{
      subjectType=type;
      sql(`UPDATE moderation_reports SET subject_type=${literal(type)}`);
      const view=context();
      assert.equal(view.subjectType,type);
      const result=execute(view);
      assert.equal(result.replayed,false);
      assert.equal(execute(view).replayed,true);
      assert.equal(sql('SELECT count(*) FROM moderation_actions'),'1');
      assert.equal(sql('SELECT status FROM moderation_reports'),'open');
      assert.equal(sql('SELECT report_id FROM moderation_actions'),report);
      assert.equal(sql('SELECT target_user_id FROM moderation_actions'),owner);
      if(type==='buddy_listing') {
        assert.equal(sql('SELECT status||\':\'||admin_status FROM rent_buddy_profiles'),'suspended:disabled');
        assert.equal(sql('SELECT count(*) FROM rent_buddy_admin_actions'),'1');
      } else if(type==='event') {
        assert.equal(sql('SELECT state||\':\'||visibility FROM events'),'archived:invite_only');
        assert.equal(sql("SELECT action||':'||(metadata->>'from_state')||':'||(metadata->>'from_visibility') FROM event_activity_log"),'admin_remove:open:friends');
        assert.equal(sql('SELECT action_type FROM moderation_actions'),'event_remove');
      } else if(type==='media') {
        assert.equal(sql('SELECT moderation_status||\':\'||version FROM media_assets'),'removed:2');
        assert.equal(sql('SELECT moderation_status FROM post_media'),'rejected');
      } else {
        const table=type==='post'?'posts':type==='message'?'messages':'posts_comments';
        assert.equal(sql(`SELECT deleted_at IS NOT NULL FROM ${table}`),'t');
        if(type==='post') assert.equal(sql('SELECT status||\':\'||post_status FROM posts'),'deleted:published');
      }
      assert.ok(!JSON.stringify(result).includes('Reported'));
    });
  }
  test('event archive exactly follows the shared lifecycle vocabulary and keeps prior visibility for appeals',()=>{
    subjectType='event'; sql("UPDATE moderation_reports SET subject_type='event'");
    for (const state of EVENT_STATES) {
      sql(`TRUNCATE moderation_actions,event_activity_log; UPDATE events SET state=${literal(state)},visibility='circle'`);
      if (!decideEventTransition(state,'archived').allowed) {
        refused(`SELECT get_reported_content_removal_context('${admin}','event','${review}','${report}')`,/removal_context_changed/);
      } else {
        execute(context());
        assert.equal(sql("SELECT metadata->>'from_state' FROM event_activity_log"),state);
        assert.equal(sql("SELECT metadata->>'from_visibility' FROM event_activity_log"),'circle');
      }
    }
  });
  test('event activity or audit failure leaves state, visibility and report unchanged',()=>{
    subjectType='event'; sql("UPDATE moderation_reports SET subject_type='event'"); const view=context();
    sql("ALTER TABLE moderation_actions ADD CONSTRAINT synthetic_event_failure CHECK(action_type <> 'event_remove')");
    try { refused(removal(view),/synthetic_event_failure/); }
    finally { sql('ALTER TABLE moderation_actions DROP CONSTRAINT synthetic_event_failure'); }
    assert.equal(sql('SELECT state||\':\'||visibility FROM events'),'open:friends');
    assert.equal(sql('SELECT count(*) FROM event_activity_log'),'0');
    assert.equal(sql('SELECT status FROM moderation_reports'),'open');
  });
  test('a host cannot widen or resurrect an administratively removed event by direct row write',()=>{
    subjectType='event'; sql("UPDATE moderation_reports SET subject_type='event'"); execute(context());
    sql('GRANT SELECT,UPDATE,DELETE ON events TO authenticated; GRANT SELECT ON event_activity_log TO authenticated');
    for(const mutation of ["UPDATE events SET visibility='public'", "UPDATE events SET state='open'", 'DELETE FROM events']) {
      const result=raw(`SET ROLE authenticated; ${mutation}`);
      assert.notEqual(result.status,0); assert.match(result.stderr,/event_under_moderation/);
    }
  });
  test('canonical media removal refuses resurrection through a legacy approval or direct client write',()=>{
    subjectType='media'; sql("UPDATE moderation_reports SET subject_type='media'"); execute(context());
    refused("UPDATE post_media SET moderation_status='approved'",/canonical_media_removal_is_terminal/);
    sql('GRANT SELECT,UPDATE ON media_assets TO authenticated');
    const direct=raw("SET ROLE authenticated; UPDATE media_assets SET moderation_status='active'");
    assert.notEqual(direct.status,0); assert.match(direct.stderr,/media_moderation_is_server_owned/);
    assert.equal(sql('SELECT moderation_status FROM media_assets'),'removed');
    sql('ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY; GRANT SELECT,UPDATE ON post_media TO authenticated');
    try {
      const hidden=raw("SET ROLE authenticated; UPDATE post_media SET moderation_status='approved'");
      assert.notEqual(hidden.status,0); assert.match(hidden.stderr,/canonical_media_removal_is_terminal/);
    } finally { sql('ALTER TABLE media_assets DISABLE ROW LEVEL SECURITY'); }
  });
  test('media audit failure rolls back canonical and legacy changes together',()=>{
    subjectType='media'; sql("UPDATE moderation_reports SET subject_type='media'"); const view=context();
    sql("ALTER TABLE moderation_actions ADD CONSTRAINT synthetic_media_failure CHECK(reason <> 'reject')");
    try { refused(removal(view,{reason:'reject'}),/synthetic_media_failure/); }
    finally { sql('ALTER TABLE moderation_actions DROP CONSTRAINT synthetic_media_failure'); }
    assert.equal(sql('SELECT moderation_status||\':\'||version FROM media_assets'),'active:1');
    assert.equal(sql('SELECT moderation_status FROM post_media'),'approved');
  });
  test('stale content or report is refused without mutation',()=>{
    const view=context();
    sql("UPDATE posts_comments SET body='Edited after preview'");
    refused(removal(view),/removal_context_changed/);
    const refreshed=context();
    sql("UPDATE moderation_reports SET status='dismissed'");
    refused(removal(refreshed),/removal_context_changed/);
    assert.equal(sql('SELECT deleted_at IS NULL FROM posts_comments'),'t');
    assert.equal(sql('SELECT count(*) FROM moderation_actions'),'0');
  });
  test('audit insert failure rolls the content change back',()=>{
    const view=context();
    sql("ALTER TABLE moderation_actions ADD CONSTRAINT synthetic_failure CHECK(reason <> 'reject')");
    try { refused(removal(view,{reason:'reject'}),/synthetic_failure/); }
    finally { sql('ALTER TABLE moderation_actions DROP CONSTRAINT synthetic_failure'); }
    assert.equal(sql('SELECT deleted_at IS NULL FROM posts_comments'),'t');
    assert.equal(sql('SELECT count(*) FROM moderation_actions'),'0');
  });
  test('receipt replay refuses a changed intent and freshly rechecks admin role',()=>{
    const view=context(); execute(view);
    refused(removal(view,{reason:'Different reason'}),/removal_intent_conflict/);
    sql(`UPDATE profiles SET role='user' WHERE id='${admin}'`);
    refused(removal(view),/admin_role_required/);
    assert.equal(sql('SELECT count(*) FROM moderation_actions'),'1');
  });
  test('reported accountable owner must match and unsupported target cannot mutate',()=>{
    const view=context();
    refused(removal(view,{type:'place'}),/invalid_removal_intent/);
    sql(`UPDATE moderation_reports SET subject_user_id='${otherAdmin}'`);
    refused(removal(view),/removal_context_changed/);
    assert.equal(sql('SELECT count(*) FROM moderation_actions'),'0');
  });
  test('client roles cannot invoke any helper or mutation',()=>{
    assert.equal(sql(`SELECT bool_and(NOT prosecdef AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE')) FROM pg_proc WHERE proname IN ('read_reported_content_target','get_reported_content_removal_context','remove_reported_content')`),'t');
  });
  test('an unchanged retry after report deletion returns the existing receipt',()=>{
    const view=context(); execute(view);
    sql(`DELETE FROM moderation_reports WHERE id='${report}'`);
    assert.equal(execute(view).replayed,true);
    assert.equal(sql('SELECT count(*) FROM moderation_actions'),'1');
  });
  test('Buddy reports may use owner ID and still audit the resolved listing',()=>{
    subjectType='buddy_listing';
    sql(`UPDATE moderation_reports SET subject_type='buddy_listing',subject_id='${owner}'`);
    const result=execute(context(admin,owner));
    assert.equal(result.subjectId,owner);
    assert.equal(sql("SELECT metadata->>'resolved_target_id' FROM moderation_actions"),review);
  });
  test('two simultaneous identical commands share one committed receipt',async()=>{
    const view=context(); const first=session(); const second=session();
    await first.query('BEGIN; SET ROLE service_role;');
    const committed=JSON.parse(await first.query(removal(view)));
    await second.query("SET application_name='content-removal-retry'; SET ROLE service_role;");
    const retry=second.query(removal(view));
    await blocked('content-removal-retry');
    await first.query('COMMIT;');
    assert.deepEqual(JSON.parse(await retry),{...committed,replayed:true});
    assert.equal(sql('SELECT count(*) FROM moderation_actions'),'1');
  });
  test('direct client writes cannot restore or recreate tombstoned content',()=>{
    execute(context());
    sql('GRANT SELECT,UPDATE,DELETE ON posts_comments TO authenticated');
    for(const statement of ['UPDATE posts_comments SET deleted_at=NULL','DELETE FROM posts_comments']) {
      const result=raw(`SET ROLE authenticated; ${statement}`);
      assert.notEqual(result.status,0);
      assert.match(result.stderr,/removed_content_cannot_be_restored_by_client/);
    }
    assert.equal(sql('SELECT deleted_at IS NOT NULL FROM posts_comments'),'t');
    // Canonical deletion/restoration services retain authority.
    sql('SET ROLE service_role; UPDATE posts_comments SET deleted_at=NULL');
  });
  test('direct client writes cannot lift or delete a suspended Buddy listing',()=>{
    subjectType='buddy_listing'; sql("UPDATE moderation_reports SET subject_type='buddy_listing'"); execute(context());
    sql('GRANT SELECT,UPDATE,DELETE ON rent_buddy_profiles TO authenticated');
    for(const statement of ["UPDATE rent_buddy_profiles SET admin_status='active',status='active'",'DELETE FROM rent_buddy_profiles']) {
      const result=raw(`SET ROLE authenticated; ${statement}`);
      assert.notEqual(result.status,0); assert.match(result.stderr,/listing_under_moderation/);
    }
    sql("SET ROLE service_role; UPDATE rent_buddy_profiles SET admin_status='active',status='active'");
  });
  test('a report closed concurrently cannot be removed from its old preview',async()=>{
    const view=context(); const closer=session(); const remover=session();
    await closer.query(`BEGIN; UPDATE moderation_reports SET status='dismissed' WHERE id='${report}';`);
    await remover.query("SET application_name='content-removal-stale'; SET ROLE service_role;");
    const removalResult=remover.query(removal(view)).then(value=>({value,error:null}),error=>({value:null,error}));
    await blocked('content-removal-stale');
    await closer.query('COMMIT;');
    assert.match(String((await removalResult).error),/removal_context_changed/);
    assert.equal(sql('SELECT deleted_at IS NULL FROM posts_comments'),'t');
    assert.equal(sql('SELECT count(*) FROM moderation_actions'),'0');
  });
});
