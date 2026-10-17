import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomUUID } from "node:crypto";
import { VideoSegmentNativeSession } from "./memoryVideoSegmentsPostgresFixture.js";

const binary = process.env.PORTAVA_TEST_POSTGRES_BIN;
const admin = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const otherAdmin = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const owner = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const review = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const otherReview = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
const report = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const otherReport = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
const operation = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const migrationUrl = new URL("../migrations/3994_reported_review_audited_removal.sql", import.meta.url);
let root = "";
let socket = "";
let environment: NodeJS.ProcessEnv;
let args: string[];
const sessions = new Set<VideoSegmentNativeSession>();
type Context = { reviewToken: string; reportToken: string; reviewId: string; reportId: string; [key: string]: unknown };

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
function context(actor = admin, reviewId = review, reportId = report): Context {
  return JSON.parse(sql(`SET ROLE service_role; SELECT public.get_reported_review_removal_context(${literal(actor)},${literal(reviewId)},${literal(reportId)});`));
}
function removal(value: Context, overrides: Record<string, unknown> = {}) {
  const input = { actor: admin, review: value.reviewId, report: value.reportId, operation, reason: "Reviewed conduct",
    reviewToken: value.reviewToken, reportToken: value.reportToken, ...overrides };
  return `SELECT public.remove_reported_review(${[input.actor, input.review, input.report, input.operation, input.reason, input.reviewToken, input.reportToken].map(literal).join(",")});`;
}
function execute(value: Context, overrides: Record<string, unknown> = {}) {
  return JSON.parse(sql(`SET ROLE service_role; ${removal(value, overrides)}`));
}
function refused(script: string, expected: RegExp) {
  const result = raw(`SET ROLE service_role; ${script}`);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, expected);
}
function untouched() {
  assert.equal(sql(`SELECT state FROM reviews WHERE id='${review}'`), "published");
  assert.equal(sql("SELECT count(*) FROM moderation_actions"), "0");
}
async function blocked(name: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name=${literal(name)} AND wait_event_type='Lock'`) === "1") return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`No lock barrier for ${name}`);
}

describe("reported-review audited removal: PostgreSQL 17", { skip: !binary ? "PORTAVA_TEST_POSTGRES_BIN missing; mandatory native gate must supply PostgreSQL 17.11" : false }, () => {
  before(() => {
    if (typeof binary !== "string" || !isAbsolute(binary)) throw new Error("PORTAVA_TEST_POSTGRES_BIN must be an absolute PostgreSQL 17.11 bin directory");
    const version = spawnSync(join(binary, "postgres"), ["--version"], { encoding: "utf8" });
    assert.match(version.stdout, /\b17\.11\b/);
    root = realpathSync(mkdtempSync(join(tmpdir(), "reported-review-native-")));
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
      CREATE TABLE public.profiles(id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, role text NOT NULL);
      CREATE TYPE public.review_state AS ENUM ('published','hidden','removed');
      CREATE TYPE public.review_entity_type AS ENUM ('trip','rent_buddy_booking','place');
      CREATE TYPE public.review_visibility AS ENUM ('public','anonymous');
      CREATE TABLE public.reviews(id uuid PRIMARY KEY, reviewer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        entity_type public.review_entity_type NOT NULL, entity_id uuid NOT NULL, rating integer NOT NULL CHECK(rating BETWEEN 1 AND 5),
        body text, tags text[] NOT NULL DEFAULT '{}', photos text[] NOT NULL DEFAULT '{}', visibility public.review_visibility NOT NULL DEFAULT 'public',
        state public.review_state NOT NULL DEFAULT 'published', reported_by uuid[] NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE public.moderation_reports(id uuid PRIMARY KEY, reporter_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
        subject_type text NOT NULL, subject_id text NOT NULL, subject_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
        category text NOT NULL DEFAULT 'harassment', details text, status text NOT NULL DEFAULT 'open', created_at timestamptz NOT NULL DEFAULT now(),
        resolved_at timestamptz, resolver_id uuid REFERENCES auth.users(id) ON DELETE SET NULL, resolver_note text, thread_id uuid, image_url text);
      CREATE TABLE public.moderation_actions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        target_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        performed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
        report_id uuid REFERENCES public.moderation_reports(id) ON DELETE SET NULL,
        action_type text NOT NULL, reason text, metadata jsonb, created_at timestamptz NOT NULL DEFAULT now());
      ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.moderation_reports ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.moderation_actions ENABLE ROW LEVEL SECURITY;
      CREATE POLICY moderation_actions_service_all ON public.moderation_actions TO service_role USING(true) WITH CHECK(true);
      GRANT USAGE ON SCHEMA public TO service_role,anon,authenticated;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO service_role;`);
    if (existsSync(migrationUrl) && process.env.PORTAVA_REVIEW_REMOVAL_BASELINE !== "1") sql(readFileSync(migrationUrl, "utf8"));
  });
  beforeEach(() => {
    sql(`TRUNCATE auth.users CASCADE;
      INSERT INTO auth.users VALUES ('${admin}'),('${otherAdmin}'),('${owner}');
      INSERT INTO profiles VALUES ('${admin}','admin'),('${otherAdmin}','admin'),('${owner}','user');
      INSERT INTO reviews(id,reviewer_id,entity_type,entity_id,rating,body) VALUES
        ('${review}','${owner}','trip','${report}',4,'Live content'),('${otherReview}','${owner}','place','${otherReport}',3,NULL);
      INSERT INTO moderation_reports(id,subject_type,subject_id,subject_user_id) VALUES
        ('${report}','review','${review}','${owner}'),('${otherReport}','review','${otherReview}',NULL);`);
  });
  afterEach(async () => {
    await Promise.all([...sessions].map(connection => connection.close()));
    sessions.clear();
  });
  after(async () => {
    if (root && existsSync(join(root, "data", "postmaster.pid"))) {
      const stopped = spawnSync(join(binary!, "pg_ctl"), ["-D", join(root, "data"), "-m", "immediate", "-w", "-t", "10", "stop"], { env: environment, encoding: "utf8", timeout: 15000 });
      assert.equal(stopped.status, 0, stopped.stderr);
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("synthetic native fixture uses the portable temp root with private permissions, no TCP and no audit", () => {
    assert.equal(dirname(root), realpathSync(tmpdir()));
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(statSync(socket).mode & 0o777, 0o700);
    assert.equal(sql("SHOW listen_addresses"), "");
    assert.equal(sql("SELECT inet_server_addr() IS NULL"), "t");
    untouched();
  });
  test("native context, removal and linked receipt commit exactly once without closing report", () => {
    const view = context();
    const result = execute(view);
    assert.equal(result.ok, true);
    assert.equal(result.stateAtCommit, "removed");
    assert.equal(sql(`SELECT state FROM reviews WHERE id='${review}'`), "removed");
    assert.equal(sql(`SELECT status FROM moderation_reports WHERE id='${report}'`), "open");
    const audit = JSON.parse(sql("SELECT row_to_json(moderation_actions) FROM moderation_actions"));
    assert.equal(audit.report_id, report);
    assert.equal(audit.performed_by, admin);
    assert.equal(audit.target_user_id, owner);
    assert.equal(audit.action_type, "content_removed");
    assert.equal(audit.metadata.target_id, review);
    assert.equal(audit.metadata.operation_id, operation);
    assert.equal(audit.metadata.command, "REMOVE_REPORTED_REVIEW_V1");
    assert.equal(audit.metadata.body, undefined);
    assert.equal(audit.metadata.actor_id, undefined);
    assert.equal(sql(`SELECT reviews.updated_at=moderation_actions.created_at FROM reviews,moderation_actions WHERE reviews.id='${review}'`), "t");
    assert.deepEqual(execute(view), { ...result, replayed: true });
    assert.equal(sql("SELECT count(*) FROM moderation_actions"), "1");
  });
  test("both functions are invoker-only, empty-search-path, UTC and denied to both client roles", () => {
    assert.equal(sql(`SELECT count(*) FROM pg_proc WHERE proname IN ('get_reported_review_removal_context','remove_reported_review')
      AND pronamespace='public'::regnamespace AND NOT prosecdef AND 'search_path=""'=ANY(proconfig) AND 'TimeZone=UTC'=ANY(proconfig)`), "2");
    for (const role of ["anon", "authenticated"]) {
      const denied = raw(`SET ROLE ${role}; SELECT public.get_reported_review_removal_context('${admin}','${review}','${report}')`);
      assert.match(denied.stderr, /42501/);
      const deniedWrite = raw(`SET ROLE ${role}; ${removal({ reviewId: review, reportId: report, reviewToken: "a".repeat(64), reportToken: "a".repeat(64) })}`);
      assert.match(deniedWrite.stderr, /42501/);
    }
    const result = sql(`SET ROLE service_role; SET search_path=pg_temp; SELECT public.get_reported_review_removal_context('${admin}','${review}','${report}')`);
    assert.equal(JSON.parse(result).reviewId, review);
  });
  test("full typed-row tokens are stable across timezones and fence an edit without updated_at", () => {
    const view = context();
    const alternate = JSON.parse(sql(`SET ROLE service_role; SET TIME ZONE 'Pacific/Honolulu'; SELECT public.get_reported_review_removal_context('${admin}','${review}','${report}')`));
    assert.equal(alternate.reviewToken, view.reviewToken);
    assert.equal(alternate.reportToken, view.reportToken);
    assert.equal(sql(`SET TIME ZONE 'UTC'; SELECT encode(sha256(convert_to(to_jsonb(reviews)::text,'UTF8')),'hex') FROM reviews WHERE id='${review}'`), view.reviewToken);
    sql(`UPDATE reviews SET tags=ARRAY['new'] WHERE id='${review}'`);
    refused(removal(view), /PT409/);
    untouched();
  });
  test("legacy null subject owner, uppercase UUID, hidden review and nullable body are eligible", () => {
    sql(`UPDATE reviews SET state='hidden' WHERE id='${otherReview}'; UPDATE moderation_reports SET subject_id=upper(subject_id) WHERE id='${otherReport}'`);
    const view = context(admin, otherReview, otherReport);
    assert.equal((view.review as any).body, null);
    assert.equal(execute(view).stateAtCommit, "removed");
  });
  for (const patch of ["status='actioned'", "status='dismissed'", "status='unknown'", "subject_type='post'", `subject_id='${otherReview}'`, `subject_user_id='${otherAdmin}'`]) {
    test(`rejects exact-pair/state/owner mismatch: ${patch}`, () => {
      const view = context();
      sql(`UPDATE moderation_reports SET ${patch} WHERE id='${report}'`);
      refused(removal(view), /PT409/);
      untouched();
    });
  }
  for (const patch of [{ reason: "Another reason" }, { report: otherReport }, { review: otherReview }, { reviewToken: "b".repeat(64) }, { reportToken: "b".repeat(64) }]) {
    test(`same-key altered intent conflicts: ${Object.keys(patch).join()}`, () => {
      const view = context();
      execute(view);
      refused(removal(view, patch), /PT409/);
      assert.equal(sql("SELECT count(*) FROM moderation_actions"), "1");
    });
  }
  test("code-point bounds and Unicode trim match HTTP semantics", () => {
    const view = context();
    refused(removal(view, { reason: "😀".repeat(1001) }), /PT400/);
    refused(removal(view, { reason: "\t\u00a0\uFEFF" }), /PT400/);
    const result = execute(view, { reason: "\u00a0" + "😀".repeat(1000) + "\uFEFF" });
    assert.equal(sql("SELECT char_length(reason) FROM moderation_actions"), "1000");
    assert.deepEqual(execute(view, { reason: "😀".repeat(1000) }), { ...result, replayed: true });
  });
  test("replay after report deletion tolerates the nullable real FK, not altered intent", () => {
    const view = context();
    const result = execute(view);
    sql(`DELETE FROM moderation_reports WHERE id='${report}'`);
    assert.equal(sql("SELECT report_id IS NULL FROM moderation_actions"), "t");
    assert.deepEqual(execute(view), { ...result, replayed: true });
    refused(removal(view, { report: otherReport }), /PT409/);
    refused(removal(view, { operation: randomUUID() }), /PT404/);
  });
  test("replay after closure or a later legacy state change never restores/removes again", () => {
    const view = context();
    const result = execute(view);
    sql(`UPDATE moderation_reports SET status='actioned' WHERE id='${report}'; UPDATE reviews SET state='hidden' WHERE id='${review}'`);
    assert.deepEqual(execute(view), { ...result, replayed: true });
    assert.equal(sql(`SELECT state FROM reviews WHERE id='${review}'`), "hidden");
  });
  test("different admins can use the same operation UUID on different reviews", () => {
    execute(context());
    const result = execute(context(otherAdmin, otherReview, otherReport), { actor: otherAdmin });
    assert.equal(result.replayed, false);
    assert.equal(sql("SELECT count(*) FROM moderation_actions"), "2");
  });
  test("fresh profile role is required even for a committed receipt replay", () => {
    const view = context();
    execute(view);
    sql(`UPDATE profiles SET role='user' WHERE id='${admin}'`);
    refused(removal(view), /PT403/);
    assert.equal(sql("SELECT count(*) FROM moderation_actions"), "1");
  });
  for (const committed of [false, true]) {
    test(`nullable actor role refuses ${committed ? "receipt replay" : "new removal"} without changing review, report or receipts`, () => {
      const view = context();
      if (committed) execute(view);
      const reviewBefore = sql(`SELECT to_jsonb(reviews) FROM reviews WHERE id='${review}'`);
      const reportBefore = sql(`SELECT to_jsonb(moderation_reports) FROM moderation_reports WHERE id='${report}'`);
      const receiptsBefore = sql("SELECT coalesce(jsonb_agg(to_jsonb(moderation_actions) ORDER BY id),'[]'::jsonb) FROM moderation_actions");
      sql(`ALTER TABLE profiles ALTER COLUMN role DROP NOT NULL; UPDATE profiles SET role=NULL WHERE id='${admin}'`);
      try {
        refused(`SELECT public.get_reported_review_removal_context('${admin}','${review}','${report}')`, /PT403/);
        refused(removal(view), /PT403/);
        assert.equal(sql(`SELECT to_jsonb(reviews) FROM reviews WHERE id='${review}'`), reviewBefore);
        assert.equal(sql(`SELECT to_jsonb(moderation_reports) FROM moderation_reports WHERE id='${report}'`), reportBefore);
        assert.equal(sql("SELECT coalesce(jsonb_agg(to_jsonb(moderation_actions) ORDER BY id),'[]'::jsonb) FROM moderation_actions"), receiptsBefore);
        assert.equal(sql("SELECT count(*) FROM moderation_actions"), committed ? "1" : "0");
      } finally {
        sql(`UPDATE profiles SET role='admin' WHERE id='${admin}'; ALTER TABLE profiles ALTER COLUMN role SET NOT NULL`);
      }
    });
  }
  for (const table of ["reviews", "moderation_actions"]) {
    for (const mode of ["raise", "zero", "alter"]) {
      test(`${table} ${mode} trigger cannot leave partial or false one-row success`, () => {
        const view = context();
        const body = mode === "raise" ? "RAISE EXCEPTION 'synthetic failure';" : mode === "zero" ? "RETURN NULL;"
          : table === "reviews" ? "NEW.state:='hidden'; RETURN NEW;" : "NEW.report_id:=NULL; RETURN NEW;";
        sql(`CREATE FUNCTION public.synthetic_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$;
          CREATE TRIGGER synthetic_failure BEFORE ${table === "reviews" ? "UPDATE" : "INSERT"} ON ${table} FOR EACH ROW EXECUTE FUNCTION public.synthetic_failure();`);
        try {
          const result = raw(`SET ROLE service_role; ${removal(view)}`);
          assert.notEqual(result.status, 0);
          untouched();
        } finally { sql(`DROP TRIGGER synthetic_failure ON ${table}; DROP FUNCTION public.synthetic_failure()`); }
      });
    }
  }
  test("malformed stored receipt never becomes successful replay", () => {
    const view = context();
    execute(view);
    sql("UPDATE moderation_actions SET metadata=metadata-'to_state'");
    refused(removal(view), /PT503/);
  });
  test("actor SET NULL, target CASCADE and missing subject cannot resurrect evidence", () => {
    const view = context();
    execute(view);
    sql(`DELETE FROM auth.users WHERE id='${admin}'`);
    assert.equal(sql("SELECT performed_by IS NULL FROM moderation_actions"), "t");
    refused(removal(view), /PT403/);
    sql(`DELETE FROM auth.users WHERE id='${owner}'`);
    assert.equal(sql("SELECT count(*) FROM moderation_actions"), "0");
    refused(removal(view, { actor: otherAdmin }), /PT404/);
    assert.equal(sql("SELECT count(*) FROM moderation_actions"), "0");
  });
  test("schema removal makes context and mutation unavailable, not fallback writes", () => {
    const view = context();
    const definition = sql("SELECT pg_get_indexdef('moderation_actions_reported_review_operation_uq'::regclass)");
    sql("DROP INDEX moderation_actions_reported_review_operation_uq");
    try {
      refused(`SELECT public.get_reported_review_removal_context('${admin}','${review}','${report}')`, /PT503/);
      refused(removal(view), /PT503/);
      untouched();
    } finally { sql(definition); }
  });
  test("an index with the right name but wrong actor key cannot enable either RPC", () => {
    const view = context();
    const definition = sql("SELECT pg_get_indexdef('moderation_actions_reported_review_operation_uq'::regclass)");
    sql(`DROP INDEX moderation_actions_reported_review_operation_uq;
      CREATE UNIQUE INDEX moderation_actions_reported_review_operation_uq ON moderation_actions(target_user_id,(metadata->>'operation_id'))
      WHERE metadata->>'command'='REMOVE_REPORTED_REVIEW_V1'`);
    try {
      refused(`SELECT public.get_reported_review_removal_context('${admin}','${review}','${report}')`, /PT503/);
      refused(removal(view), /PT503/);
      untouched();
    } finally { sql(`DROP INDEX moderation_actions_reported_review_operation_uq; ${definition}`); }
  });
  test("missing write function or lost execution grant never advertises an available context", () => {
    const signature = "public.remove_reported_review(uuid,uuid,uuid,uuid,text,text,text)";
    sql(`ALTER FUNCTION ${signature} RENAME TO synthetic_missing_removal`);
    try { refused(`SELECT public.get_reported_review_removal_context('${admin}','${review}','${report}')`, /PT503/); }
    finally { sql("ALTER FUNCTION public.synthetic_missing_removal(uuid,uuid,uuid,uuid,text,text,text) RENAME TO remove_reported_review"); }
    sql(`REVOKE EXECUTE ON FUNCTION ${signature} FROM service_role`);
    try { refused(`SELECT public.get_reported_review_removal_context('${admin}','${review}','${report}')`, /PT503/); }
    finally { sql(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role`); }
    untouched();
  });
  for (const prerequisite of [
    "ALTER TABLE moderation_actions DROP CONSTRAINT moderation_actions_performed_by_fkey; ALTER TABLE moderation_actions ADD FOREIGN KEY(performed_by) REFERENCES profiles(id)",
    "ALTER TABLE moderation_actions DISABLE ROW LEVEL SECURITY",
    "CREATE POLICY synthetic_client_policy ON moderation_actions TO authenticated USING(true)",
    "REVOKE INSERT ON moderation_actions FROM service_role",
    "ALTER TABLE moderation_actions ALTER COLUMN reason TYPE integer USING NULL",
    "ALTER TABLE moderation_reports ALTER COLUMN subject_type DROP NOT NULL",
    "ALTER TABLE moderation_reports ALTER COLUMN subject_id DROP NOT NULL",
    "ALTER TABLE moderation_reports ALTER COLUMN status DROP NOT NULL",
    "ALTER TABLE reviews ALTER COLUMN state DROP NOT NULL",
  ]) {
    test(`migration refuses incompatible dependency without installing anything: ${prerequisite.split(';')[0]}`, () => {
      const preflight = readFileSync(migrationUrl, "utf8").split("CREATE UNIQUE INDEX")[0].replace(/^BEGIN;/, "");
      const result = raw(`BEGIN; ${prerequisite}; ${preflight} ROLLBACK;`);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /3994/);
      assert.equal(context().reviewId, review);
      untouched();
    });
  }
  for (const [table, column, id] of [
    ["moderation_reports", "subject_type", report], ["moderation_reports", "subject_id", report],
    ["moderation_reports", "status", report], ["reviews", "state", review],
  ]) {
    test(`post-install nullable drift cannot bypass either RPC: ${table}.${column}`, () => {
      const original = sql(`SELECT ${column} FROM ${table} WHERE id='${id}'`);
      sql(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP NOT NULL; UPDATE ${table} SET ${column}=NULL WHERE id='${id}'`);
      try {
        const view: Context = {
          reviewId: review, reportId: report,
          reviewToken: sql(`SET TIME ZONE 'UTC'; SELECT encode(sha256(convert_to(to_jsonb(reviews)::text,'UTF8')),'hex') FROM reviews WHERE id='${review}'`),
          reportToken: sql(`SET TIME ZONE 'UTC'; SELECT encode(sha256(convert_to(to_jsonb(moderation_reports)::text,'UTF8')),'hex') FROM moderation_reports WHERE id='${report}'`),
        };
        refused(`SELECT public.get_reported_review_removal_context('${admin}','${review}','${report}')`, /PT409/);
        refused(removal(view), /PT409/);
        assert.equal(sql("SELECT count(*) FROM moderation_actions"), "0");
        assert.equal(sql(`SELECT ${column} IS NULL FROM ${table} WHERE id='${id}'`), "t");
      } finally { sql(`UPDATE ${table} SET ${column}=${literal(original)} WHERE id='${id}'; ALTER TABLE ${table} ALTER COLUMN ${column} SET NOT NULL`); }
      untouched();
    });
  }
  test("report full-row changes without a status/timestamp bump invalidate the confirmation", () => {
    const view = context();
    sql(`UPDATE moderation_reports SET resolver_note='Edited context' WHERE id='${report}'`);
    refused(removal(view), /PT409/);
    untouched();
  });
  test("AFTER audit triggers cannot delete the inserted receipt and report false success", () => {
    const view = context();
    sql(`CREATE FUNCTION synthetic_after_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      DELETE FROM public.moderation_actions WHERE id=NEW.id; RETURN NEW; END $$;
      CREATE TRIGGER synthetic_after_audit AFTER INSERT ON moderation_actions FOR EACH ROW EXECUTE FUNCTION synthetic_after_audit();`);
    try { refused(removal(view), /PT503/); untouched(); }
    finally { sql("DROP TRIGGER synthetic_after_audit ON moderation_actions; DROP FUNCTION synthetic_after_audit()"); }
  });
  test("a real deadlock after the review update rolls the command back and the same operation retries", async () => {
    const view = context();
    const legacy = session();
    const command = session();
    sql(`CREATE FUNCTION synthetic_after_review() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM pg_catalog.pg_advisory_xact_lock(3994001); RETURN NEW; END $$;
      CREATE TRIGGER synthetic_after_review AFTER UPDATE ON reviews FOR EACH ROW EXECUTE FUNCTION synthetic_after_review();`);
    try {
      await legacy.query("BEGIN; SET deadlock_timeout='2s'; SELECT pg_advisory_xact_lock(3994001);");
      const pending = command.query(`SET application_name='tv4a-deadlock'; SET deadlock_timeout='100ms'; SET ROLE service_role; ${removal(view)}`);
      const rejected = assert.rejects(pending, /40P01/);
      await blocked("tv4a-deadlock");
      const competing = legacy.query(`SELECT id FROM moderation_reports WHERE id='${report}' FOR UPDATE;`);
      await rejected;
      await competing;
      await legacy.query("ROLLBACK;");
      untouched();
      assert.equal(execute(view).ok, true);
      assert.equal(sql("SELECT count(*) FROM moderation_actions"), "1");
    } finally {
      await legacy.close();
      await command.close();
      sql("DROP TRIGGER synthetic_after_review ON reviews; DROP FUNCTION synthetic_after_review()");
    }
  });
  test("concurrent retry waits then recovers exactly the first committed receipt", async () => {
    const view = context();
    const first = session();
    const second = session();
    await first.query("BEGIN; SET ROLE service_role;");
    const result = JSON.parse(await first.query(removal(view)));
    const pending = second.query(`SET application_name='tv4a-retry'; SET ROLE service_role; ${removal(view)}`);
    await blocked("tv4a-retry");
    await first.query("COMMIT;");
    assert.deepEqual(JSON.parse(await pending), { ...result, replayed: true });
    assert.equal(sql("SELECT count(*) FROM moderation_actions"), "1");
  });
  test("different moderators on one review yield one removal and one conflict", async () => {
    const view = context();
    const first = session();
    const second = session();
    await first.query("BEGIN; SET ROLE service_role;");
    await first.query(removal(view));
    const pending = second.query(`SET application_name='tv4a-moderator'; SET ROLE service_role; ${removal(view, { actor: otherAdmin })}`);
    const rejected = assert.rejects(pending, /PT409/);
    await blocked("tv4a-moderator");
    await first.query("COMMIT;");
    await rejected;
    assert.equal(sql("SELECT count(*) FROM moderation_actions"), "1");
  });
  test("different reports of the same review still serialize on the review, not just the report", async () => {
    sql(`UPDATE moderation_reports SET subject_id='${review}' WHERE id='${otherReport}'`);
    const firstView = context();
    const secondView = context(otherAdmin, review, otherReport);
    const first = session();
    const second = session();
    await first.query(`BEGIN; SET ROLE service_role; ${removal(firstView)}`);
    const pending = second.query(`SET application_name='tv4a-reports'; SET ROLE service_role; ${removal(secondView, { actor: otherAdmin })}`);
    const rejected = assert.rejects(pending, /PT409/);
    await blocked("tv4a-reports");
    await first.query("COMMIT;");
    await rejected;
    assert.equal(sql("SELECT count(*) FROM moderation_actions"), "1");
    assert.equal(sql(`SELECT status FROM moderation_reports WHERE id='${otherReport}'`), "open");
  });
  test("owner discovery is not authority when the owner changes before the review lock", async () => {
    const view = context();
    const writer = session();
    const command = session();
    await writer.query(`BEGIN; SELECT id FROM moderation_reports WHERE id='${report}' FOR UPDATE;`);
    const pending = command.query(`SET application_name='tv4a-owner-change'; SET ROLE service_role; ${removal(view)}`);
    const rejected = assert.rejects(pending, /PT409/);
    await blocked("tv4a-owner-change");
    await writer.query(`UPDATE reviews SET reviewer_id='${otherAdmin}' WHERE id='${review}'; COMMIT;`);
    await rejected;
    untouched();
  });
  for (const change of ["close", "edit", "demote", "erase"]) {
    for (const firstWriter of ["other", "removal"]) {
      test(`${change} concurrent with removal, ${firstWriter} commits first`, async () => {
        const view = context();
        const first = session();
        const second = session();
        const mutation = change === "close" ? `UPDATE moderation_reports SET status='dismissed' WHERE id='${report}'`
          : change === "edit" ? `UPDATE reviews SET body='Edited after preview' WHERE id='${review}'`
          : change === "demote" ? `UPDATE profiles SET role='user' WHERE id='${admin}'`
          : `DELETE FROM auth.users WHERE id='${owner}'`;
        await first.query("BEGIN;");
        if (firstWriter === "other") {
          await first.query(`${mutation};`);
          const pending = second.query(`SET application_name='tv4a-race'; SET ROLE service_role; ${removal(view)}`);
          const rejected = assert.rejects(pending, change === "demote" ? /PT403/ : change === "erase" ? /PT404|PT409/ : /PT409/);
          await blocked("tv4a-race");
          await first.query("COMMIT;");
          await rejected;
          assert.equal(sql("SELECT count(*) FROM moderation_actions"), "0");
          if (change !== "erase") assert.equal(sql(`SELECT state FROM reviews WHERE id='${review}'`), "published");
        } else {
          await first.query(`SET ROLE service_role; ${removal(view)}`);
          const pending = second.query(`SET application_name='tv4a-race'; ${mutation};`);
          await blocked("tv4a-race");
          await first.query("COMMIT;");
          await pending;
          assert.equal(sql("SELECT count(*) FROM moderation_actions"), change === "erase" ? "0" : "1");
          if (change !== "erase") assert.equal(sql(`SELECT state FROM reviews WHERE id='${review}'`), "removed");
        }
      });
    }
  }
  test("a held advisory lock times out without changes and the same operation can retry", async () => {
    const view = context();
    const holder = session();
    await holder.query(`BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('REMOVE_REPORTED_REVIEW_V1:${admin}:${operation}',0));`);
    const begin = Date.now();
    refused(removal(view), /55P03/);
    assert.ok(Date.now() - begin < 4000, "RPC lock wait must be bounded independently of client timeout");
    untouched();
    await holder.query("ROLLBACK;");
    assert.equal(execute(view).ok, true);
  });
});
